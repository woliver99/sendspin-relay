const APP_VERSION = "v1.4.18";
const versionEl = document.getElementById("app-version");
if (versionEl) versionEl.textContent = APP_VERSION;

import { SILENT_AUDIO_SRC } from "./silent-audio.js";
import { SendspinPlayer } from "./sendspin.js";

// Global AudioContext singleton to survive violent Sendspin teardowns on iOS
let globalAudioContextSingleton = null;
const OriginalAudioContext = window.AudioContext || window.webkitAudioContext;
if (OriginalAudioContext) {
  window.AudioContext = class extends OriginalAudioContext {
    constructor(...args) {
      if (globalAudioContextSingleton) {
        return globalAudioContextSingleton;
      }
      super(...args);
      globalAudioContextSingleton = this;

      // Monkey patch close so player.disconnect() doesn't actually sever the lockscreen hardware node
      const realClose = super.close.bind(this);
      this.hardwareClose = async () => {
        await realClose();
        globalAudioContextSingleton = null;
      };
      this.close = async () => {
        console.log(
          "[AudioContext Sandbox] Swallowed a violent SDK close request to preserve iOS session limits.",
        );
      };
    }
  };
  window.webkitAudioContext = window.AudioContext;
}

// Global WebSocket interceptor for stalling diagnostics
let lastPacketTime = Date.now();
const activeSockets = new Set();
const OriginalWebSocket = window.WebSocket;
window.WebSocket = class extends OriginalWebSocket {
  constructor(...args) {
    super(...args);
    activeSockets.add(this);
    this.addEventListener("message", () => {
      lastPacketTime = Date.now();
    });
    this.addEventListener("close", () => {
      activeSockets.delete(this);
    });
  }
};

// Global MediaSession interceptor to block Sendspin from hijacking the notification
let originalSetActionHandler = null;
let originalMetadataSet = null;
let originalPlaybackStateSet = null;
let originalSetPositionState = null;

if (window.MediaSession) {
  // 1. Store the original, working browser methods
  originalSetActionHandler = MediaSession.prototype.setActionHandler;
  const metadataDesc = Object.getOwnPropertyDescriptor(
    MediaSession.prototype,
    "metadata",
  );
  originalMetadataSet = metadataDesc ? metadataDesc.set : null;
  const playbackDesc = Object.getOwnPropertyDescriptor(
    MediaSession.prototype,
    "playbackState",
  );

  if (playbackDesc && playbackDesc.set) {
    originalPlaybackStateSet = playbackDesc.set;
  }

  // 2. Overwrite the public methods with duds to block external libraries
  MediaSession.prototype.setActionHandler = function (action, handler) {
    console.warn(
      `[Media Lock] Blocked Sendspin from overwriting '${action}' action.`,
    );
  };

  if (originalMetadataSet) {
    Object.defineProperty(MediaSession.prototype, "metadata", {
      set: function (val) {
        console.warn(
          `[Media Lock] Blocked Sendspin from overwriting metadata.`,
        );
      },
      get: metadataDesc.get,
    });
  }

  // Also block playbackState overwrites from the SDK
  if (originalPlaybackStateSet) {
    Object.defineProperty(MediaSession.prototype, "playbackState", {
      set: function (val) {
        console.warn(
          `[Media Lock] Blocked Sendspin from overwriting playbackState to '${val}'.`,
        );
      },
      get: playbackDesc.get,
      configurable: true,
    });
  }

  originalSetPositionState = MediaSession.prototype.setPositionState;
  if (originalSetPositionState) {
    MediaSession.prototype.setPositionState = function (state) {
      console.warn(
        `[Media Lock] Blocked Sendspin from overwriting positionState.`,
      );
    };
  }
}

// 3. Create private bypass functions exclusively for YOUR code to use
function setMyMediaAction(action, handler) {
  if (originalSetActionHandler && navigator.mediaSession) {
    originalSetActionHandler.call(navigator.mediaSession, action, handler);
  }
}

function setMyMediaMetadata(config) {
  if (originalMetadataSet && navigator.mediaSession) {
    originalMetadataSet.call(navigator.mediaSession, new MediaMetadata(config));
  }
}

function setMyPlaybackState(state) {
  if (originalPlaybackStateSet && navigator.mediaSession) {
    originalPlaybackStateSet.call(navigator.mediaSession, state);
  } else if ("mediaSession" in navigator) {
    navigator.mediaSession.playbackState = state;
  }
}

function setMyPositionState(state) {
  if (originalSetPositionState && navigator.mediaSession) {
    originalSetPositionState.call(navigator.mediaSession, state);
  }
}

let lastKnownMediaState = "disconnected";
let lastMediaSessionRefresh = 0;

function setMediaSessionStateDisconnected() {
  lastKnownMediaState = "disconnected";
  lastMediaSessionRefresh = Date.now();
  if ("mediaSession" in navigator) {
    setMyMediaMetadata({
      title: "Public Audio Sync",
      artist: "Stream - Disconnected",
    });
    setMyPlaybackState("none");
    setMyMediaAction("pause", () => stopApplication(false));
    setMyMediaAction("play", () => null);
    setMyMediaAction("stop", () => stopApplication(false));
    try {
      setMyPositionState({ duration: Infinity, position: 0, playbackRate: 1 });
    } catch (e) {}
  }
}

function setMediaSessionStatePlaying() {
  lastKnownMediaState = "playing";
  lastMediaSessionRefresh = Date.now();
  if ("mediaSession" in navigator) {
    setMyMediaMetadata({
      title: "Public Audio Sync",
      artist: "Stream - Playing",
    });
    setMyPlaybackState("playing");
    setMyMediaAction("pause", () => stopApplication(false));
    setMyMediaAction("play", () => null);
    setMyMediaAction("stop", () => stopApplication(false));
    try {
      setMyPositionState({ duration: Infinity, position: 0, playbackRate: 1 });
    } catch (e) {}
  }
}

function setMediaSessionStateMuted() {
  lastKnownMediaState = "muted";
  lastMediaSessionRefresh = Date.now();
  if ("mediaSession" in navigator) {
    setMyMediaMetadata({
      title: "Public Audio Sync",
      artist: "Stream - Muted",
    });
    setMyPlaybackState("playing");
    setMyMediaAction("pause", () => stopApplication(false));
    setMyMediaAction("play", () => null);
    setMyMediaAction("stop", () => stopApplication(false));
    try {
      setMyPositionState({ duration: Infinity, position: 0, playbackRate: 1 });
    } catch (e) {}
  }
}

function refreshMediaSessionState() {
  if (Date.now() - lastMediaSessionRefresh < 5000) return;
  if (lastKnownMediaState === "playing") setMediaSessionStatePlaying();
  else if (lastKnownMediaState === "muted") setMediaSessionStateMuted();
}

setMediaSessionStateDisconnected();

import {
  createSyncGraph,
  applySyncToneClass,
  formatSyncValue,
  getSyncTone,
} from "./sync-graph.js";
const connectBtn = document.getElementById("connectBtn");
const muteBtn = document.getElementById("muteBtn");
const statusText = document.getElementById("statusText");

// Sync Visualization DOM mappings
const syncPanel = document.getElementById("sendspin-demo-sync-panel");
const syncStatus = document.getElementById("sendspin-demo-sync-status");
const syncGraphShell = document.getElementById(
  "sendspin-demo-sync-graph-shell",
);
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
let iosWakeLockAudio = null;
let androidMediaElement = null;
let isPlayerReconnecting = false;
const syncDriftWindow = [];

function startApplication() {
  // Disconnect any lingering socket
  if (player) {
    try {
      player.disconnect();
    } catch (e) {}
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
    if ("mediaSession" in navigator) {
      setMediaSessionStatePlaying();
    }

    if (!keepAliveContext) {
      keepAliveContext = new (
        window.AudioContext || window.webkitAudioContext
      )();

      // Background wake-lock oscillator (silent, routed through MediaStream only)
      const oscillator = keepAliveContext.createOscillator();
      const gainNode = keepAliveContext.createGain();

      oscillator.type = "triangle";
      oscillator.frequency.value = 50;
      gainNode.gain.value = 0.001;

      const dest = keepAliveContext.createMediaStreamDestination();
      oscillator.connect(gainNode);
      gainNode.connect(dest);
      oscillator.start();

      iosWakeLockAudio = document.createElement("audio");
      iosWakeLockAudio.srcObject = dest.stream;
      iosWakeLockAudio.loop = true;
      iosWakeLockAudio.style.display = "none";
      document.body.appendChild(iosWakeLockAudio);

      if (keepAliveContext.state === "suspended") {
        keepAliveContext.resume();
      }
      console.log(
        "Background HTMLAudio MediaStream Wake-Lock spun up successfully!",
      );
    }

    if (iosWakeLockAudio)
      iosWakeLockAudio
        .play()
        .catch((e) => console.log("Oscillator Wake-lock promise rejected:", e));

    // Native media-element mode to reliably satisfy MediaSession OS restrictions globally.
    if (!androidMediaElement) {
      androidMediaElement = document.createElement("audio");
      androidMediaElement.loop = true;
      androidMediaElement.preload = "auto";
      androidMediaElement.setAttribute("playsinline", "");
      androidMediaElement.src = SILENT_AUDIO_SRC;
      androidMediaElement.style.display = "none";
      document.body.appendChild(androidMediaElement);
      androidMediaElement.addEventListener("pause", () => {
        console.warn(
          "[Android Audio Lock] The native looping audio element was forcefully paused by the OS! Attempting instant auto-resume...",
        );
        if (isAppStarted && androidMediaElement) {
          androidMediaElement
            .play()
            .catch((e) =>
              console.warn(
                "[Android Audio Lock] Instant auto-resume rejected by OS:",
                e,
              ),
            );
        }
      });
      androidMediaElement.addEventListener("play", () =>
        console.log(
          "[Android Audio Lock] Hardware audio element is playing natively.",
        ),
      );
      androidMediaElement
        .play()
        .catch((e) =>
          console.log("Android native Wake-lock promise rejected:", e),
        );
    }

    bootSendspinEngine();
    isNetworkConnected = true;

    // Direct automated success
    statusText.textContent = "Syncing";
    statusText.className = "status connected";

    // Transform the Connect button into a Stop button
    connectBtn.disabled = false;
    connectBtn.textContent = "Disconnect";
    connectBtn.classList.add("btn-disconnect");
    muteBtn.style.display = "inline-block";
    muteBtn.textContent = "Mute";
    isAppStarted = true;
    isLocalMuted = false;

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

async function bootSendspinEngine() {
  const guestId = "guest-" + Math.random().toString(36).substring(2, 7);
  console.log(`Generated guest ID: ${guestId}`);

  const relayUrl =
    (window.location.protocol === "https:" ? "https://" : "http://") +
    window.location.hostname +
    (window.location.port ? ":" + window.location.port : "");
  console.log("[DEBUG] Generated Relay URL:", relayUrl);

  player = new SendspinPlayer({
    playerId: guestId,
    clientName: `Guest Speaker (${guestId})`,
    baseUrl: relayUrl,
    correctionMode: "sync",
    outputMode: "direct",
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
        // In an offline-restart scenario, the player might reconnect arbitrarily. We must re-arm the relay.
        try {
          player.sendCommand("switch");
        } catch (e) {
          console.error("Failed to re-arm switch:", e);
        }
      },
    },
    onStateChange: (state) => {
      if (!isNetworkConnected) return;

      if (state.groupState && state.groupState.group_id) {
        console.log(
          `Group updated: ${state.groupState.group_name} (${state.groupState.group_id})`,
        );
      } else if (state.playerState === "synchronized") {
        console.log("Player synchronized but not in a group.");
      }
    },
  });

  let badReadingCount = 0;
  let engineStartTime = Date.now();

  // Set up the visualization updater
  syncUpdateInterval = window.setInterval(() => {
    if (!player || !player.isConnected) return;

    refreshMediaSessionState(); // This only happens every 5 seconds

    // CHECK OS AUDIO FOCUS LOSS: If iOS/Android violently revokes background audio authorization (e.g. another tab plays a video)
    // Give the OS 3 seconds of grace period during boot to allow the AudioContext resume() promise to fully resolve natively.
    if (
      Date.now() - engineStartTime > 3000 &&
      globalAudioContextSingleton &&
      (globalAudioContextSingleton.state === "suspended" ||
        globalAudioContextSingleton.state === "interrupted")
    ) {
      console.warn(
        "[OS-WATCHDOG] Hardware audio focus was entirely revoked by the host OS! Gracefully shutting down application.",
      );
      stopApplication(false);

      statusText.textContent = "Interrupted by another app";
      statusText.className = "status disconnected";
      return;
    }

    const syncInfo = player.syncInfo ?? {};
    const syncMs =
      typeof syncInfo.syncErrorMs === "number" &&
      Number.isFinite(syncInfo.syncErrorMs)
        ? syncInfo.syncErrorMs
        : null;

    const WATCHDOG_MAX_DRIFT_MS = 50;
    const WATCHDOG_WINDOW_SIZE = 120;
    const WATCHDOG_VIOLATION_LIMIT = 40;

    // Sync Watchdog: Over a sliding sample window, if X+ readings exceed ±MAX_MS, force restart.
    if (syncMs !== null) {
      const isBad = Math.abs(syncMs) > WATCHDOG_MAX_DRIFT_MS;

      if (syncDriftWindow.length >= WATCHDOG_WINDOW_SIZE) {
        const popped = syncDriftWindow.shift();
        if (popped > WATCHDOG_MAX_DRIFT_MS) badReadingCount--;
      }

      syncDriftWindow.push(Math.abs(syncMs));
      if (isBad) badReadingCount++;

      if (
        syncDriftWindow.length === WATCHDOG_WINDOW_SIZE &&
        badReadingCount >= WATCHDOG_VIOLATION_LIMIT
      ) {
        console.warn(
          `[SYNC-WATCHDOG] ${badReadingCount}/${WATCHDOG_WINDOW_SIZE} readings exceeded ${WATCHDOG_MAX_DRIFT_MS}ms. Forcing Engine restart...`,
        );
        syncDriftWindow.length = 0;
        badReadingCount = 0;
        teardownSendspinEngine();
        setTimeout(() => bootSendspinEngine(), 1000);
        return;
      }
    }

    // Debugging staleness readout
    const secondsSincePacket = ((Date.now() - lastPacketTime) / 1000).toFixed(
      1,
    );
    if (!player.isPlaying || syncMs === null) {
      resetSyncDisplay();
      if (isPlayerReconnecting) {
        statusText.textContent = `Reconnecting... (${secondsSincePacket}s dead)`;
        statusText.className = "status connecting";
      } else {
        statusText.textContent = player.isConnected
          ? `Connected (Idle: ${secondsSincePacket}s)`
          : "Disconnected";
      }
    } else {
      isPlayerReconnecting = false;
      statusText.textContent = `Syncing (${secondsSincePacket}s)`;
      renderSyncDisplay({
        label: formatSyncValue(syncMs),
        tone: getSyncTone(syncMs),
        syncMs,
      });
    }

    // Forceful reconnection on dead OS-level socket suspend (iOS/Desktop sleep)
    if (player.isConnected && Date.now() - lastPacketTime > 15000) {
      console.warn(
        `[CONNECTION-WATCHDOG] Connection stalled for >30s. Triggering synthetic protocol teardown...`,
      );

      for (const ws of activeSockets) {
        try {
          ws.close();
          if (typeof ws.onclose === "function") {
            ws.onclose(new Event("close"));
          }
        } catch (e) {
          console.error(e);
        }
      }
      activeSockets.clear();
    }
  }, 250);

  console.log("Waiting for network backend (await connect)...");
  try {
    await player.connect();
    console.log("Websocket Network Connected! Issuing Initial Switch...");
    player.sendCommand("switch");
  } catch (e) {
    console.warn(
      "[NETWORK] Initial Sendspin config stalled (e.g. offline). Handed over to auto-reconnect fallback loop.",
    );
  }
}

let isAppStarted = false;
let isLocalMuted = false;

async function toggleMuteState(forceMute = null) {
  if (!player) return;

  const nowMuted = forceMute !== null ? forceMute : !isLocalMuted;
  isLocalMuted = nowMuted;

  player.setVolume(nowMuted ? 1 : 100);

  muteBtn.textContent = nowMuted ? "Unmute" : "Mute";

  if (nowMuted) {
    muteBtn.classList.add("btn-muted");
    setMediaSessionStateMuted();
  } else {
    muteBtn.classList.remove("btn-muted");
    setMediaSessionStatePlaying();
  }
}

muteBtn.addEventListener("click", () => toggleMuteState());

function teardownSendspinEngine() {
  if (!player) return;

  try {
    player.disconnect();
  } catch (e) {}

  for (const ws of activeSockets) {
    try {
      ws.close();
    } catch (e) {}
  }
  activeSockets.clear();

  if (syncUpdateInterval) {
    window.clearInterval(syncUpdateInterval);
    syncUpdateInterval = null;
  }

  resetSyncDisplay();

  player = null;
  isNetworkConnected = false;
  isPlayerReconnecting = false;
}

function stopApplication(requireConfirm = false) {
  if (!player && !isAppStarted) return;

  /*
    if (requireConfirm && !confirm("Are you sure you want to disconnect? The audio session will be dropped.")) {
        return;
    }
    */

  if ("mediaSession" in navigator) {
    setMediaSessionStateDisconnected();
  }

  teardownSendspinEngine();

  syncGraph.stop();
  syncGraph.reset();
  syncPanel.setAttribute("aria-hidden", "true");

  // Teardown the specific OS wake-locks to force a hard user restart upon next Connect
  if (iosWakeLockAudio) {
    iosWakeLockAudio.pause();
    iosWakeLockAudio.srcObject = null;
    iosWakeLockAudio = null;
  }

  if (keepAliveContext) {
    if (typeof keepAliveContext.hardwareClose === "function") {
      keepAliveContext.hardwareClose().catch(() => {});
    } else {
      keepAliveContext.close().catch(() => {});
    }
    keepAliveContext = null;
  }
  globalAudioContextSingleton = null;

  if (androidMediaElement) {
    androidMediaElement.pause();
    androidMediaElement.src = "";
    androidMediaElement.remove();
    androidMediaElement = null;
  }

  player = null;
  isNetworkConnected = false;
  isPlayerReconnecting = false;
  isAppStarted = false;

  connectBtn.disabled = false;
  connectBtn.textContent = "Connect";
  connectBtn.classList.remove("btn-disconnect");
  muteBtn.classList.remove("btn-muted");
  muteBtn.style.display = "none";
  statusText.textContent = "Disconnected";
  statusText.className = "status disconnected";

  console.log("Application stopped.");
}

// A lock to prevent mobile browsers from firing touchstart AND click sequentially
let buttonLock = false;

function handleConnectAction(e) {
  // If the button is locked from a recent tap, ignore this event
  if (buttonLock) return;

  // Lock the button for 400ms to block the upcoming "ghost click" on mobile
  buttonLock = true;
  setTimeout(() => {
    buttonLock = false;
  }, 400);

  // Execute your actual logic
  if (!isAppStarted) {
    startApplication();
  } else {
    stopApplication(true);
  }
}

// Bind the exact same function to both events
connectBtn.addEventListener("touchstart", handleConnectAction);
connectBtn.addEventListener("click", handleConnectAction);
