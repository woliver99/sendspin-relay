import asyncio
import json
import struct
import time
import websockets

HAOS_URL = "ws://haos.lan.maplenetwork.ca:8927/sendspin"
BIND_IP = "0.0.0.0"
BIND_PORT = 8095

connected_clients = set()
server_offset = 0  # Relay clock minus HAOS clock in microseconds
latest_state = {
    "server/state": None,
    "group/update": None,
    "stream/start": None
}

async def upstream_client():
    global server_offset
    while True:
        try:
            async with websockets.connect(HAOS_URL) as ws:
                print(f"[Upstream] Connected to HAOS Sendspin Server")
                
                # Send client/hello to register as a player
                client_hello = {
                    "type": "client/hello",
                    "payload": {
                        "client_id": "relay-server-master",
                        "name": "Public Relay",
                        "version": 1,
                        "supported_roles": ["player@v1", "metadata@v1"],
                        "player@v1_support": {
                            "supported_formats": [
                                {"codec": "opus", "channels": 2, "sample_rate": 48000, "bit_depth": 16},
                                {"codec": "pcm", "channels": 2, "sample_rate": 48000, "bit_depth": 16}
                            ],
                            "buffer_capacity": 5000000,
                            "supported_commands": []
                        }
                    }
                }
                await ws.send(json.dumps(client_hello))
                
                asyncio.create_task(sync_clock(ws))
                
                # Switch to active group automatically 
                await ws.send(json.dumps({"type": "client/command", "payload": {"controller": {"command": "switch"}}}))
                
                async for message in ws:
                    if isinstance(message, str):
                        msg_data = json.loads(message)
                        if msg_data.get("type") == "server/time":
                            st = msg_data["payload"]
                            rx_time = time.time_ns() // 1000
                            round_trip = rx_time - st["client_transmitted"]
                            server_offset = (rx_time - (round_trip // 2)) - st["server_transmitted"]
                            continue
                            
                        # Cache important lifecycle packets for new guests
                        mtype = msg_data.get("type")
                        if mtype in latest_state:
                            latest_state[mtype] = message
                            
                        # Immediately rebroadcast string JSON messages
                        if connected_clients:
                            websockets.broadcast(connected_clients, message)
                            
                    elif isinstance(message, bytes):
                        # Audio binary message: Type (1 byte) + Timestamp (8 bytes Big-Endian)
                        if len(message) > 9:
                            # Read original timestamp
                            orig_ts = struct.unpack(">q", message[1:9])[0]
                            
                            # Re-encode timestamp against our internal relay clock
                            new_ts = orig_ts + server_offset
                            new_message = bytearray(message)
                            new_message[1:9] = struct.pack(">q", new_ts)
                            
                            if connected_clients:
                                websockets.broadcast(connected_clients, new_message)

        except Exception as e:
            print(f"[Upstream] Disconnected: {e}. Reconnecting in 2s...")
            await asyncio.sleep(2)

async def sync_clock(ws):
    while True:
        try:
            req = {
                "type": "client/time",
                "payload": {
                    "client_transmitted": time.time_ns() // 1000
                }
            }
            await ws.send(json.dumps(req))
            await asyncio.sleep(5)
        except Exception:
            break

async def downstream_server(websocket):
    print(f"[Downstream] Public client connected: {websocket.remote_address}")
    connected_clients.add(websocket)
    try:
        async for message in websocket:
            if isinstance(message, str):
                msg_data = json.loads(message)
                mtype = msg_data.get("type")
                
                if mtype == "client/hello":
                    await websocket.send(json.dumps({
                        "type": "server/hello",
                        "payload": {
                            "server_id": "relay-server",
                            "name": "Party Relay",
                            "version": 1,
                            "active_roles": ["player@v1", "metadata@v1"]
                        }
                    }))
                    
                    # Flush cached upstream state to the new client so it doesn't crash
                    for state_msg in latest_state.values():
                        if state_msg:
                            await websocket.send(state_msg)
                            
                elif mtype == "client/time":
                    rx_time = time.time_ns() // 1000
                    req = msg_data.get("payload", {})
                    tx_time = time.time_ns() // 1000
                    await websocket.send(json.dumps({
                        "type": "server/time",
                        "payload": {
                            "client_transmitted": req.get("client_transmitted", 0),
                            "server_received": rx_time,
                            "server_transmitted": tx_time
                        }
                    }))
    except websockets.exceptions.ConnectionClosed:
        pass
    except Exception as e:
        print(f"[Downstream] Client error: {e}")
    finally:
        print(f"[Downstream] Public client disconnected: {websocket.remote_address}")
        connected_clients.discard(websocket)

async def main():
    print(f"Starting Sendspin Relay on ws://{BIND_IP}:{BIND_PORT}")
    server = await websockets.serve(downstream_server, BIND_IP, BIND_PORT)
    upstream = asyncio.create_task(upstream_client())
    await asyncio.gather(server.wait_closed(), upstream)

if __name__ == "__main__":
    asyncio.run(main())
