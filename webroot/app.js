import { SendspinPlayer } from "./sendspin.js";

// Global WebSocket interceptor for stalling diagnostics
let lastPacketTime = Date.now();
const activeSockets = new Set();
const OriginalWebSocket = window.WebSocket;
window.WebSocket = class extends OriginalWebSocket {
    constructor(...args) {
        super(...args);
        activeSockets.add(this);
        this.addEventListener('message', () => {
            lastPacketTime = Date.now();
        });
        this.addEventListener('close', () => {
            activeSockets.delete(this);
        });
    }
};

// Lock the mediaSession handlers BEFORE sendspin-js can override them.
// We monkey-patch setActionHandler so the SDK can never steal pause/stop/play.
if ('mediaSession' in navigator) {
    const lockedActions = {};
    const originalSetActionHandler = navigator.mediaSession.setActionHandler.bind(navigator.mediaSession);

    // Register our handlers first
    lockedActions['pause'] = () => { if (typeof stopApplication === 'function') stopApplication(); };
    lockedActions['stop'] = () => { if (typeof stopApplication === 'function') stopApplication(); };
    lockedActions['play'] = () => { if (typeof startApplication === 'function' && !isAppStarted) startApplication(); };

    originalSetActionHandler('pause', lockedActions['pause']);
    originalSetActionHandler('stop', lockedActions['stop']);
    originalSetActionHandler('play', lockedActions['play']);

    // Block sendspin-js from overwriting our handlers
    navigator.mediaSession.setActionHandler = (action, handler) => {
        if (action in lockedActions) return; // silently swallow
        originalSetActionHandler(action, handler);
    };
}

import { createSyncGraph, applySyncToneClass, formatSyncValue, getSyncTone } from "./sync-graph.js";
const connectBtn = document.getElementById("connectBtn");
const statusText = document.getElementById("statusText");
const iosUnlocker = document.getElementById("iosUnlocker");

// Sync Visualization DOM mappings
const syncPanel = document.getElementById("sendspin-demo-sync-panel");
const syncStatus = document.getElementById("sendspin-demo-sync-status");
const syncGraphShell = document.getElementById("sendspin-demo-sync-graph-shell");
const syncCanvas = document.getElementById("sendspin-demo-sync-graph");

const syncGraph = createSyncGraph({
    canvas: syncCanvas,
    shell: syncGraphShell,
});

function renderSyncDisplay({ label, tone = "sync-idle", syncMs = null }) {
    syncStatus.textContent = label;
    applySyncToneClass(syncStatus, tone);
    syncGraph.updateSample({ syncMs, tone });
}

function resetSyncDisplay() {
    renderSyncDisplay({ label: "--.- ms", tone: "sync-idle", syncMs: null });
}

let syncUpdateInterval = null;
let player = null;
let isNetworkConnected = false;
let keepAliveContext = null;
let isPlayerReconnecting = false;

async function startApplication() {
    // Disconnect any lingering socket
    if (player) {
        try { player.disconnect(); } catch (e) { }
    }

    // Stop sync visualizer animations
    if (syncUpdateInterval) window.clearInterval(syncUpdateInterval);
    syncGraph.stop();
    syncGraph.reset();
    syncPanel.setAttribute("aria-hidden", "true");

    lastPacketTime = Date.now();

    // Disable button and UI instantly
    connectBtn.disabled = true;
    statusText.textContent = "Connecting...";
    statusText.className = "status connecting";

    try {
        // ---- iOS SILENCE WAKE-LOCK ----
        // iOS kills raw AudioContext oscillators. But if we pump the oscillator mathematically 
        // into a RAW HTML5 MediaStream Element, Apple's hardware locks onto the raw pipe and holds
        // the background process alive indefinitely as if we were streaming a real Spotify radio!
        if (!keepAliveContext) {
            keepAliveContext = new (window.AudioContext || window.webkitAudioContext)();
            const oscillator = keepAliveContext.createOscillator();
            const gainNode = keepAliveContext.createGain();

            oscillator.type = 'triangle'; // Complex geometry prevents zero-optimizations
            oscillator.frequency.value = 50;
            gainNode.gain.value = 0.001; // Ultra quiet 

            const dest = keepAliveContext.createMediaStreamDestination();
            oscillator.connect(gainNode);
            gainNode.connect(dest);
            oscillator.start();

            // The magical hardware lock
            const wakeLockAudio = document.createElement("audio");
            wakeLockAudio.srcObject = dest.stream;
            wakeLockAudio.loop = true;
            wakeLockAudio.play().catch(e => console.log("iOS Wake-lock promise rejected:", e));


            if (keepAliveContext.state === 'suspended') {
                keepAliveContext.resume();
            }
            console.log("Background HTMLAudio MediaStream Wake-Lock spun up successfully!");
        }

        // The magical Android MediaSession hardware lock
        const androidAudio = document.getElementById("androidWakeLockAudio");
        if (androidAudio) {
            androidAudio.play().catch(e => console.log("Android Wake-lock promise rejected:", e));
        }

        const guestId = "guest-" + Math.random().toString(36).substring(2, 7);
        console.log(`Generated guest ID: ${guestId}`);

        player = new SendspinPlayer({
            playerId: guestId,
            clientName: `Guest Speaker (${guestId})`,
            baseUrl: "https://sendspin.maplenetwork.ca/ws",
            correctionMode: "sync",
            outputMode: "direct", // Bypass iOS HTMLAudio tag blocking
            reconnect: {
                baseDelayMs: 1000,
                maxDelayMs: 15000,
                maxAttempts: Infinity,
                onReconnecting: (attempt) => {
                    isPlayerReconnecting = true;
                    statusText.className = "status connecting";
                },
                onReconnected: () => {
                    isPlayerReconnecting = false;
                    statusText.className = "status connected";
                    lastPacketTime = Date.now();
                }
            },
            onStateChange: (state) => {
                if (!isNetworkConnected) return;

                if (state.groupState && state.groupState.group_id) {
                    console.log(`Group updated: ${state.groupState.group_name} (${state.groupState.group_id})`);
                } else if (state.playerState === 'synchronized') {
                    console.log("Player synchronized but not in a group.");
                }
            }
        });

        // Set up the visualization updater
        syncUpdateInterval = window.setInterval(() => {
            if (!player || !player.isConnected) return;

            const syncInfo = player.syncInfo ?? {};
            const syncMs = typeof syncInfo.syncErrorMs === "number" && Number.isFinite(syncInfo.syncErrorMs)
                ? syncInfo.syncErrorMs
                : null;

            // Debugging staleness readout
            const secondsSincePacket = ((Date.now() - lastPacketTime) / 1000).toFixed(1);
            if (!player.isPlaying || syncMs === null) {
                resetSyncDisplay();
                if (isPlayerReconnecting) {
                    statusText.textContent = `Reconnecting... (${secondsSincePacket}s dead)`;
                    statusText.className = "status connecting";
                } else {
                    statusText.textContent = player.isConnected ? `Connected (Idle: ${secondsSincePacket}s)` : "Disconnected";
                }
            } else {
                isPlayerReconnecting = false;
                statusText.textContent = `Syncing (Last message: ${secondsSincePacket}s ago)`;
                renderSyncDisplay({
                    label: formatSyncValue(syncMs),
                    tone: getSyncTone(syncMs),
                    syncMs,
                });
            }

            // Forceful reconnection on dead OS-level socket suspend (iOS/Desktop sleep)
            if (player.isConnected && (Date.now() - lastPacketTime) > 30000) {
                console.warn(`[WATCHDOG] Connection stalled for >30s. Triggering synthetic protocol teardown...`);

                for (const ws of activeSockets) {
                    try {
                        ws.close();
                        // iOS Safari WebKit BUG: If a socket is physically dead, ws.close() blocks 
                        // infinitely and NEVER dispatches the onclose event to JS.
                        // We must synthetically fire it so SendspinPlayer starts its backoff protocol.
                        if (typeof ws.onclose === "function") {
                            ws.onclose(new Event("close"));
                        }
                    } catch (e) { console.error(e); }
                }
                activeSockets.clear();
            }
        }, 250);

        console.log("Waiting for network backend (await connect)...");

        // Network Call yields event loop (AudioContext is permanently granted by now)
        await player.connect();

        console.log("Websocket Network Connected! Issuing Switch...");
        await player.sendCommand("switch");

        isNetworkConnected = true;

        // Direct automated success
        statusText.textContent = "Syncing";
        statusText.className = "status connected";

        // Transform the Connect button into a Stop button
        connectBtn.disabled = false;
        connectBtn.textContent = "Stop";
        isAppStarted = true;

        console.log("Ready and listening on Sendspin Engine.");

        // Unleash the Sync Engine Canvas animations!
        syncPanel.setAttribute("aria-hidden", "false");
        syncGraph.start();

    } catch (error) {
        console.log("Error: " + error);

        // We do not re-enable the connectBtn or alter SendspinPlayer's state because 
        // the native SDK background reconnect-cycler continues spinning even when 
        // the initial connect promise rejects. This honors the persistent 1-click requirement.
    }
}

let isAppStarted = false;

function stopApplication() {
    if (!player) return;

    try { player.disconnect(); } catch (e) { }

    for (const ws of activeSockets) {
        try { ws.close(); } catch (e) { }
    }
    activeSockets.clear();

    if (syncUpdateInterval) {
        window.clearInterval(syncUpdateInterval);
        syncUpdateInterval = null;
    }
    syncGraph.stop();
    syncGraph.reset();
    syncPanel.setAttribute("aria-hidden", "true");
    resetSyncDisplay();

    // Pause the Android wake-lock audio so the lockscreen clears
    const androidAudio = document.getElementById("androidWakeLockAudio");
    if (androidAudio) androidAudio.pause();

    player = null;
    isNetworkConnected = false;
    isPlayerReconnecting = false;
    isAppStarted = false;

    connectBtn.disabled = false;
    connectBtn.textContent = "Connect";
    statusText.textContent = "Disconnected";
    statusText.className = "status disconnected";

    console.log("Application stopped.");
}

connectBtn.addEventListener("click", () => {
    if (!isAppStarted) {
        startApplication();
    } else {
        stopApplication();
    }
});
