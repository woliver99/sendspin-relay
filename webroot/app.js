import { SendspinPlayer } from "./sendspin.js";

const connectBtn = document.getElementById("connectBtn");
const statusText = document.getElementById("statusText");
const iosUnlocker = document.getElementById("iosUnlocker");

let player = null;
let isNetworkConnected = false;
let keepAliveContext = null;

connectBtn.addEventListener("click", async () => {
    // Disconnect any lingering socket
    if (player) {
        try { player.disconnect(); } catch (e) { }
    }

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
            baseUrl: "https://" + window.location.hostname + "/ws",
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

    } catch (error) {
        console.log("Error: " + error);
        statusText.textContent = "Connection Failed. Check network connection.";
        statusText.className = "status disconnected";
        connectBtn.disabled = false;
        connectBtn.textContent = "Connect";
    }
});
