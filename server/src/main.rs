use axum::{
    extract::{
        ws::{Message as WsMessage, WebSocket, WebSocketUpgrade},
        State, ConnectInfo
    },
    http::HeaderMap,
    response::IntoResponse,
    routing::get,
    Router,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    net::SocketAddr,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::sync::broadcast;
use tower_http::{
    cors::{Any, CorsLayer},
    services::ServeDir,
};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message as TungsteniteMessage;
use std::sync::atomic::{AtomicUsize, Ordering};

#[derive(Clone)]
struct AppState {
    tx: broadcast::Sender<WsMessage>,
    server_offset: Arc<Mutex<i64>>,
    latest_state: Arc<Mutex<HashMap<String, String>>>,
    active_connections: Arc<AtomicUsize>,
}

fn current_time_micros() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_micros() as i64
}

#[tokio::main]
async fn main() {
    let (tx, _rx) = broadcast::channel(1000);
    let app_state = AppState {
        tx,
        server_offset: Arc::new(Mutex::new(0)),
        latest_state: Arc::new(Mutex::new(HashMap::new())),
        active_connections: Arc::new(AtomicUsize::new(0)),
    };

    let sendspin_url = std::env::var("SENDSPIN_URL").expect("FATAL: SENDSPIN_URL environment variable is missing and strictly required to start.");
    let bind_ip = std::env::var("BIND_IP").unwrap_or_else(|_| "0.0.0.0".to_string());
    let bind_port = std::env::var("SERVER_PORT").unwrap_or_else(|_| "8000".to_string());

    let state_clone = app_state.clone();
    tokio::spawn(async move {
        loop {
            match connect_async(&sendspin_url).await {
                Ok((upstream_ws, _)) => {
                    println!("[Upstream] Connected to Sendspin Server");

                    let (mut write, mut read) = upstream_ws.split();

                    let client_hello = json!({
                        "type": "client/hello",
                        "payload": {
                            "client_id": "relay-server-master",
                            "name": "Public Relay",
                            "version": 1,
                            "supported_roles": ["player@v1", "metadata@v1"],
                            "device_info": {
                                "product_name": "Public Relay",
                                "manufacturer": "Maple Network",
                                "software_version": "1.1.0"
                            },
                            "player@v1_support": {
                                "supported_formats": [
                                    {"codec": "opus", "channels": 2, "sample_rate": 48000, "bit_depth": 16}
                                ],
                                "buffer_capacity": 2500000,
                                "supported_commands": []
                            }
                        }
                    });
                    let _ = write.send(TungsteniteMessage::Text(client_hello.to_string().into())).await;

                    let client_state = json!({
                        "type": "client/state",
                        "payload": {
                            "state": "synchronized",
                            "player": {
                                "static_delay_ms": 0
                            }
                        }
                    });
                    let _ = write.send(TungsteniteMessage::Text(client_state.to_string().into())).await;
                    let _ = write.send(TungsteniteMessage::Text(json!({"type": "client/command", "payload": {"controller": {"command": "switch"}}}).to_string().into())).await;

                    let mut clock_interval = tokio::time::interval(std::time::Duration::from_secs(5));
                    let (_tx_upstream, mut rx_upstream) = tokio::sync::mpsc::channel(100);
                    
                    let write_task = tokio::spawn(async move {
                        loop {
                            tokio::select! {
                                _ = clock_interval.tick() => {
                                    let req = json!({
                                        "type": "client/time",
                                        "payload": {
                                            "client_transmitted": current_time_micros()
                                        }
                                    });
                                    if write.send(TungsteniteMessage::Text(req.to_string().into())).await.is_err() {
                                        break;
                                    }
                                }
                                Some(msg) = rx_upstream.recv() => {
                                    if write.send(msg).await.is_err() {
                                        break;
                                    }
                                }
                            }
                        }
                    });

                    while let Some(msg_result) = read.next().await {
                        if let Ok(msg) = msg_result {
                            match msg {
                                TungsteniteMessage::Text(text) => {
                                    let text_str = text.to_string();
                                    if let Ok(parsed) = serde_json::from_str::<Value>(&text_str) {
                                        if let Some(mtype) = parsed.get("type").and_then(|t| t.as_str()) {
                                            if mtype == "server/time" {
                                                if let Some(payload) = parsed.get("payload") {
                                                    let rx_time = current_time_micros();
                                                    let client_transmitted = payload.get("client_transmitted").and_then(|v| v.as_i64()).unwrap_or(0);
                                                    let server_transmitted = payload.get("server_transmitted").and_then(|v| v.as_i64()).unwrap_or(0);
                                                    let round_trip = rx_time - client_transmitted;
                                                    let offset = (rx_time - (round_trip / 2)) - server_transmitted;
                                                    *state_clone.server_offset.lock().unwrap() = offset;
                                                }
                                                continue;
                                            }
                                            if mtype == "server/state" || mtype == "group/update" || mtype == "stream/start" {
                                                state_clone.latest_state.lock().unwrap().insert(mtype.to_string(), text_str.clone());
                                            }
                                        }
                                    }
                                    let _ = state_clone.tx.send(WsMessage::Text(text_str.into()));
                                }
                                TungsteniteMessage::Binary(bin) => {
                                    if bin.len() > 9 {
                                        let orig_ts = i64::from_be_bytes(bin[1..9].try_into().unwrap());
                                        let offset = *state_clone.server_offset.lock().unwrap();
                                        let new_ts = orig_ts + offset;
                                        
                                        let mut new_bin = bin.to_vec();
                                        new_bin[1..9].copy_from_slice(&new_ts.to_be_bytes());
                                        let _ = state_clone.tx.send(WsMessage::Binary(new_bin.into()));
                                    }
                                }
                                _ => {}
                            }
                        } else {
                            break;
                        }
                    }
                    write_task.abort();
                }
                Err(e) => {
                    println!("[Upstream] Connection error: {}. Retrying...", e);
                }
            }
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        }
    });

    let cors = CorsLayer::new().allow_origin(Any);
    
    let webroot_path = std::env::var("WEBROOT_PATH").unwrap_or_else(|_| "../webroot".to_string());

    let app = Router::new()
        .fallback_service(ServeDir::new(webroot_path))
        .route("/sendspin", get(ws_handler))
        .route("/api/stats", get(stats_handler))
        .layer(cors)
        .with_state(app_state);

    let addr_str = format!("{}:{}", bind_ip, bind_port);
    let listener = tokio::net::TcpListener::bind(&addr_str).await.unwrap();
    println!("Started Rust WebSockets & Static Proxy on {}", addr_str);
    
    axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())
        .with_graceful_shutdown(shutdown_signal())
        .await
        .unwrap();
}

async fn stats_handler(State(state): State<AppState>) -> impl IntoResponse {
    let totals = state.active_connections.load(Ordering::SeqCst);
    axum::Json(json!({
        "total_connected": totals
    }))
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to install signal handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    println!("\nSIGTERM / CTRL-C received, shutting down gracefully...");
}

async fn ws_handler(ws: WebSocketUpgrade, State(state): State<AppState>, headers: HeaderMap, ConnectInfo(addr): ConnectInfo<SocketAddr>) -> impl IntoResponse {
    let mut real_ip = addr.ip().to_string();
    let trusted_proxy_str = std::env::var("TRUSTED_PROXY_IP").unwrap_or_else(|_| "".to_string());

    let mut is_trusted = false;
    if let Ok(socket_ip) = real_ip.parse::<std::net::IpAddr>() {
        // Try parsing CIDR (e.g. 10.10.10.0/24)
        if let Ok(network) = trusted_proxy_str.parse::<ipnet::IpNet>() {
            is_trusted = network.contains(&socket_ip);
        } else if real_ip == trusted_proxy_str {
            // Try exact exact string match if not a valid CIDR
            is_trusted = true;
        }
    } else if real_ip == trusted_proxy_str {
        is_trusted = true;
    }

    if is_trusted {
        if let Some(x_real) = headers.get("x-real-ip") {
            if let Ok(ip_str) = x_real.to_str() {
                real_ip = ip_str.to_string();
            }
        } else if let Some(x_forwarded) = headers.get("x-forwarded-for") {
            if let Ok(ip_str) = x_forwarded.to_str() {
                real_ip = ip_str.split(',').next().unwrap_or(&real_ip).trim().to_string();
            }
        }
    }

    ws.on_upgrade(move |socket| handle_socket(socket, state, real_ip))
}

async fn handle_socket(socket: WebSocket, state: AppState, addr: String) {
    state.active_connections.fetch_add(1, Ordering::SeqCst);
    println!("[Downstream] Socket opened: {}", addr);
    let (mut sender, mut receiver) = socket.split();
    let mut broadcast_rx = state.tx.subscribe();

    let (tx_user, mut rx_user) = tokio::sync::mpsc::channel::<WsMessage>(10);
    
    let mut send_task = tokio::spawn(async move {
        loop {
            tokio::select! {
                Ok(msg) = broadcast_rx.recv() => {
                    if sender.send(msg).await.is_err() { break; }
                }
                Some(msg) = rx_user.recv() => {
                    if sender.send(msg).await.is_err() { break; }
                }
            }
        }
    });

    let addr_clone = addr.clone();
    let mut recv_task = tokio::spawn(async move {
        while let Some(Ok(msg)) = receiver.next().await {
            if let WsMessage::Text(text) = msg {
                let text_str = text.to_string();
                if let Ok(parsed) = serde_json::from_str::<Value>(&text_str) {
                    if let Some(mtype) = parsed.get("type").and_then(|t| t.as_str()) {
                        if mtype == "client/hello" {
                            let name = parsed.get("payload").and_then(|p| p.get("name")).and_then(|n| n.as_str()).unwrap_or("Unknown");
                            println!("[Downstream] Registered: {} ({})", name, addr_clone);

                            let hello = json!({
                                "type": "server/hello",
                                "payload": {
                                    "server_id": "relay-server-rs",
                                    "name": "Party Relay",
                                    "version": 1,
                                    "active_roles": ["player@v1", "metadata@v1"]
                                }
                            });
                            let _ = tx_user.send(WsMessage::Text(hello.to_string().into())).await;
                            
                            let cache = state.latest_state.lock().unwrap().clone();
                            for (_, state_msg) in cache {
                                let _ = tx_user.send(WsMessage::Text(state_msg.into())).await;
                            }
                        } else if mtype == "client/time" {
                            let rx_time = current_time_micros();
                            let client_transmitted = parsed.get("payload").and_then(|p| p.get("client_transmitted")).and_then(|v| v.as_i64()).unwrap_or(0);
                            let tx_time = current_time_micros();
                            
                            let resp = json!({
                                "type": "server/time",
                                "payload": {
                                    "client_transmitted": client_transmitted,
                                    "server_received": rx_time,
                                    "server_transmitted": tx_time
                                }
                            });
                            let _ = tx_user.send(WsMessage::Text(resp.to_string().into())).await;
                        }
                    }
                }
            }
        }
    });

    tokio::select! {
        _ = (&mut send_task) => recv_task.abort(),
        _ = (&mut recv_task) => send_task.abort(),
    };

    state.active_connections.fetch_sub(1, Ordering::SeqCst);
    println!("[Downstream] Public client disconnected: {}", addr);
}
