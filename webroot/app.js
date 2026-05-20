import { SendspinPlayer } from "./sendspin.js";

const connectBtn = document.getElementById("connectBtn");
const statusText = document.getElementById("statusText");
const iosUnlocker = document.getElementById("iosUnlocker");

let player = null;
let isNetworkConnected = false;

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
        // ---- iOS UNLOCK SEQUENCE ----
        // For iOS we must fire the silent unlocking track immediately in the synchronous 
        // click handler, before jumping the event loop with awaits!
        iosUnlocker.play().catch((e) => console.log("Unlocker bypassed: " + e));

        const guestId = "guest-" + Math.random().toString(36).substring(2, 7);
        console.log(`Generated guest ID: ${guestId}`);

        // Create the core Audio node now so it is locked strictly inside Apple's gesture stack
        const sendspinAudio = document.createElement("audio");
        sendspinAudio.muted = false;
        sendspinAudio.play().catch(e => console.log("Unlocker pre-warmed: " + e));

        player = new SendspinPlayer({
            playerId: guestId,
            clientName: `Guest Speaker (${guestId})`,
            baseUrl: "https://" + window.location.hostname + "/ws",
            correctionMode: "sync",
            audioElement: sendspinAudio,
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
        statusText.textContent = "Connected";
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
