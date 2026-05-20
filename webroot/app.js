import { SendspinPlayer } from "./sendspin.js";

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

connectBtn.addEventListener("click", async () => {
    // Disconnect any lingering socket
    if (player) {
        try { player.disconnect(); } catch (e) { }
    }

    // Stop sync visualizer animations
    if (syncUpdateInterval) window.clearInterval(syncUpdateInterval);
    syncGraph.stop();
    syncGraph.reset();
    syncPanel.setAttribute("aria-hidden", "true");

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
            wakeLockAudio.play().catch(e => console.log("Wake-lock promise rejected:", e));

            if (keepAliveContext.state === 'suspended') {
                keepAliveContext.resume();
            }
            console.log("Background HTMLAudio MediaStream Wake-Lock spun up successfully!");
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

            if (!player.isPlaying || syncMs === null) {
                resetSyncDisplay();
                return;
            }

            renderSyncDisplay({
                label: formatSyncValue(syncMs),
                tone: getSyncTone(syncMs),
                syncMs,
            });
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
        connectBtn.textContent = "Speaker Live";
        console.log("Ready and listening on Sendspin Engine.");

        // Unleash the Sync Engine Canvas animations!
        syncPanel.setAttribute("aria-hidden", "false");
        syncGraph.start();

    } catch (error) {
        console.log("Error: " + error);
        statusText.textContent = "Connection Failed. Check network connection.";
        statusText.className = "status disconnected";
        connectBtn.disabled = false;
        connectBtn.textContent = "Connect";
    }
});
