const tabMeta = {
  overview: {
    title: "Overview",
    subtitle: "System readiness and app status"
  },
  settings: {
    title: "Settings",
    subtitle: "Desktop mode audio and voice preferences"
  },
  chatbot: {
    title: "Chatbot",
    subtitle: "Desktop text chat channel with your local agent"
  },
  "event-bus": {
    title: "Event Bus",
    subtitle: "Scrollable system and app events with bounded panel size"
  },
  "agent-core": {
    title: "Agent Core",
    subtitle: "AI orchestration shell and tool gateway stubs"
  },
  "integration-hub": {
    title: "Integration Hub",
    subtitle: "Backend integration surfaces prepared for app connectors"
  },
  skills: {
    title: "Skills",
    subtitle: "Create, manage, and read AI agent skills"
  }
};

import { initVoice, stopVoice, getVoiceState, isVoiceActive } from "./voice.js";
import { initializeNeuralNetwork, setNeuralSpeaking } from "./neural-network.js";

const state = {
  apps: [],
  activeTab: "overview",
  system: null,
  mode: "desktop",
  events: [],
  settings: null,
  settingsOptions: null,
  chatMessages: [],
  chatDraft: "",
  chatStickToBottom: true,
  chatSessionStartedAt: Date.now(),
  chatInputShouldRefocus: false,
  queueStatus: null,
  skills: [],
  selectedSkillId: null,
  skillsViewMode: "list", // "list" or "editor"
  skillsEditorContent: "",
  skillsEditorName: "",
  musicNowPlaying: {
    trackTitle: "No track selected",
    isPlaying: false,
    currentTime: 0,
    duration: 0,
    queueCount: 0,
    updatedAt: Date.now()
  },
  voiceStatus: "off",
  voiceTranscript: "",
  voiceAgentText: ""
};

const musicStateChannel = typeof BroadcastChannel !== "undefined"
  ? new BroadcastChannel("control-center-music-state")
  : null;
const musicCommandChannel = typeof BroadcastChannel !== "undefined"
  ? new BroadcastChannel("control-center-music-command")
  : null;

const appTabsContainer = document.getElementById("app-tabs");
const viewTitle = document.getElementById("view-title");
const viewSubtitle = document.getElementById("view-subtitle");
const overviewView = document.getElementById("view-overview");
const settingsView = document.getElementById("view-settings");
const chatbotView = document.getElementById("view-chatbot");
const eventBusView = document.getElementById("view-event-bus");
const agentCoreView = document.getElementById("view-agent-core");
const integrationHubView = document.getElementById("view-integration-hub");
const skillsView = document.getElementById("view-skills");
const appView = document.getElementById("view-app");
const currentModePill = document.getElementById("current-mode-pill");
const modeDesktopBtn = document.getElementById("mode-desktop-btn");
const modeMobileBtn = document.getElementById("mode-mobile-btn");
const startupSplash = document.getElementById("startup-splash");
const appShell = document.getElementById("app-shell");
const alarmOverlay = document.getElementById("alarm-overlay");
const alarmOverlayLabel = document.getElementById("alarm-overlay-label");
const alarmStopBtn = document.getElementById("alarm-stop-btn");

let ringingAlarmId = null;
const alarmAudioEl = new Audio("/assets/alarm-sound.mp3");
alarmAudioEl.loop = true;

function startAlarmSound() {
  alarmAudioEl.currentTime = 0;
  alarmAudioEl.play().catch(() => {
    // Autoplay may be blocked before any user gesture; the overlay's Stop
    // button click (a real gesture) will unblock it for the next alarm.
  });
}

function stopAlarmSound() {
  alarmAudioEl.pause();
  alarmAudioEl.currentTime = 0;
}

function showAlarmOverlay(meta) {
  ringingAlarmId = meta?.alarmId || ringingAlarmId;
  alarmOverlayLabel.textContent = meta?.label || "Alarm";
  alarmOverlay.classList.remove("is-hidden");
  alarmOverlay.setAttribute("aria-hidden", "false");
  startAlarmSound();
}

function hideAlarmOverlay() {
  ringingAlarmId = null;
  alarmOverlay.classList.add("is-hidden");
  alarmOverlay.setAttribute("aria-hidden", "true");
  stopAlarmSound();
}

async function checkRingingAlarms() {
  try {
    const res = await fetch("/api/alarms/ringing");
    const data = await res.json();
    // Alarms set from a paired phone ring on that phone, not here.
    const alarms = (data.alarms ?? []).filter((alarm) => !alarm.deviceId);
    if (alarms.length) {
      showAlarmOverlay({ alarmId: alarms[0].id, label: alarms[0].label });
    }
  } catch {
    // Ignore — overlay simply won't show until the next alarm-fired event.
  }
}

async function loadApps() {
  const res = await fetch("/api/apps");
  const data = await res.json();
  state.apps = data.apps ?? [];
}

async function loadSkills() {
  const res = await fetch("/api/skills");
  const data = await res.json();
  state.skills = data.skills ?? [];
  state.selectedSkillId = null;
}

async function loadSystem() {
  const res = await fetch("/api/system");
  return res.json();
}

async function loadEvents() {
  const res = await fetch("/api/events?includeConsole=true");
  const data = await res.json();
  state.events = (data.events ?? []).concat(data.consoleLogs ?? []);
  // Sort by timestamp
  state.events.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
}

async function loadSettings() {
  const res = await fetch("/api/settings");
  const data = await res.json();
  state.settings = data.settings;
  state.settingsOptions = data.options;
}

/* Paired devices (Settings > Devices) for the mobile app. */

async function loadDevices() {
  try {
    const [devicesRes, accessRes] = await Promise.all([
      fetch("/api/devices"),
      fetch("/api/devices/remote-access?fresh=1")
    ]);
    state.devices = (await devicesRes.json()).devices ?? [];
    state.remoteAccess = (await accessRes.json()).remoteAccess ?? null;
  } catch {
    state.devices = state.devices ?? [];
  }
}

async function startPairing() {
  const res = await fetch("/api/devices/pairing-codes", { method: "POST" });
  const data = await res.json();
  if (!data.ok) {
    return;
  }
  state.pairing = data;
  state.remoteAccess = data.remoteAccess ?? state.remoteAccess;
  startPairingCountdown();
}

async function cancelPairing() {
  state.pairing = null;
  stopPairingCountdown();
  await fetch("/api/devices/pairing-codes", { method: "DELETE" }).catch(() => {});
}

async function removeDevice(deviceId) {
  await fetch(`/api/devices/${encodeURIComponent(deviceId)}`, { method: "DELETE" });
  await loadDevices();
}

function startPairingCountdown() {
  stopPairingCountdown();
  const tick = () => {
    const remainingMs = state.pairing ? Date.parse(state.pairing.expiresAt) - Date.now() : 0;
    if (remainingMs <= 0) {
      state.pairing = null;
      stopPairingCountdown();
      if (state.activeTab === "settings") {
        renderSettings();
      }
      return;
    }
    const countdown = document.getElementById("pairing-countdown");
    if (countdown) {
      const seconds = Math.ceil(remainingMs / 1000);
      countdown.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
    }
  };
  tick();
  state.pairingTimer = setInterval(tick, 1000);
}

function stopPairingCountdown() {
  clearInterval(state.pairingTimer);
  state.pairingTimer = null;
}

function formatLastSeen(isoTime) {
  const minutes = Math.round((Date.now() - Date.parse(isoTime)) / 60000);
  if (!Number.isFinite(minutes)) return "never";
  if (minutes < 2) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)} h ago`;
  return new Date(isoTime).toLocaleDateString();
}

function renderDevicesCard() {
  const access = state.remoteAccess;
  const steps = access
    ? [
        ["Tailscale installed", access.installed],
        ["Signed in to Tailscale", access.signedIn],
        ["HTTPS certificates on", access.httpsCertificates],
        ["Control Center published (tailscale serve)", access.serveConfigured]
      ]
    : [];
  const checklist = steps
    .map(([label, done]) => `<li>${label} <span class="status ${done ? "ready" : "wip"}">${done ? "Done" : "To do"}</span></li>`)
    .join("");

  const devices = state.devices ?? [];
  const deviceRows = devices.length
    ? devices
        .map(
          (device) => `
          <li>
            <span>${escapeHtml(device.name)} <span class="muted">· last seen ${formatLastSeen(device.lastSeenAt)}</span></span>
            <button type="button" class="action-btn remove-device-btn" data-device-id="${escapeHtml(device.id)}">Remove</button>
          </li>`
        )
        .join("")
    : `<li class="muted">No paired devices yet.</li>`;

  const pairing = state.pairing;
  const pairingPanel = pairing
    ? `
      <div class="pairing-panel">
        <div class="pairing-qr">${pairing.qrSvg}</div>
        <div class="stack">
          <p>Scan this with the Control Center app on your phone. On a laptop, enter the address and code in Control Center Remote.</p>
          <p class="pairing-code">${escapeHtml(pairing.code.replace(/(.{4})/, "$1 "))}</p>
          <p class="muted">Or enter the code manually. Expires in <span id="pairing-countdown"></span>.</p>
          ${pairing.url ? `<p class="muted">Address: ${escapeHtml(pairing.url)}</p>` : `<p class="status wip">Remote access isn't set up yet, so the phone won't be able to connect. See the checklist above.</p>`}
          <div class="event-controls"><button type="button" class="action-btn" id="cancel-pairing-btn">Cancel</button></div>
        </div>
      </div>`
    : `<div class="event-controls"><button type="button" class="action-btn" id="pair-device-btn">Pair a device</button></div>`;

  return `
    <article class="card stack" id="devices-card">
      <h3>Devices</h3>
      <p class="muted">Phones and laptops paired here can use Control Center from anywhere over Tailscale.</p>
      ${access?.nextStep ? `<p class="status wip">Next step: ${escapeHtml(access.nextStep)}</p>` : ""}
      ${checklist ? `<ul class="list">${checklist}</ul>` : ""}
      <h4>Paired devices</h4>
      <ul class="list device-list">${deviceRows}</ul>
      ${pairingPanel}
    </article>
  `;
}

async function loadChatMessages() {
  const res = await fetch("/api/chat/messages?limit=120");
  const data = await res.json();
  const sessionStart = Number(state.chatSessionStartedAt) || Date.now();
  const serverMessages = (data.messages ?? []).filter((message) => {
    const timestamp = Date.parse(String(message?.timestamp || ""));
    return Number.isFinite(timestamp) && timestamp >= sessionStart;
  });
  const pendingMessages = state.chatMessages.filter((message) => message.meta?.pending);
  state.chatMessages = [...serverMessages, ...pendingMessages].slice(-120);
}

async function switchModeRequest(targetMode) {
  const res = await fetch("/api/mode/switch", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ targetMode, source: "control-ui" })
  });
  return res.json();
}

async function publishAppStatusEvent(appId) {
  const app = state.apps.find((item) => item.id === appId);
  const appName = app?.name || appId;

  const res = await fetch("/api/events", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      appId,
      source: "app-ui",
      type: "status",
      message: `${appName} posted a status update (WIP module heartbeat).`,
      meta: {
        route: app?.routeKey || appId
      }
    })
  });

  return res.json();
}

async function saveDesktopSettings(payload) {
  const res = await fetch("/api/settings/desktop", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  return res.json();
}

async function runVoiceTest(sampleText) {
  const res = await fetch("/api/settings/desktop/test-voice", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ sampleText })
  });

  return res.json();
}

async function postChatMessage(text) {
  const res = await fetch("/api/chat/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ text })
  });

  return res.json();
}

async function postAppMessageToAgent(appId, message, meta = {}) {
  const res = await fetch(`/api/apps/${appId}/agent-message`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ message, meta })
  });

  return res.json();
}

async function openNewsAppWindow() {
  await openWindowApp("news-app");
}

async function openCalendarAppWindow() {
  await openWindowApp("calendar-app");
}

async function openProjectAppWindow() {
  await openWindowApp("project-app");
}

async function openMusicAppWindow() {
  await openWindowApp("music-app");
}

const WINDOW_APP_IDS = ["calendar-app", "news-app", "project-app", "music-app", "drawing-app", "movie-app", "server-manager-app", "wikipedia-app", "file-system-app"];

const WINDOW_APP_BRIDGE_NAMES = {
  "calendar-app": "CalendarApp",
  "news-app": "NewsApp",
  "project-app": "ProjectApp",
  "music-app": "MusicApp",
  "drawing-app": "DrawingApp",
  "movie-app": "MovieApp",
  "server-manager-app": "ServerManagerApp",
  "wikipedia-app": "WikipediaApp",
  "file-system-app": "FileSystemApp"
};

// Window apps whose window is a native process launched by the backend
// (fileSystemService.js) instead of a web page. In Electron the regular
// <appId>:open/close IPC already launches/stops it; in a plain browser the
// equivalent is the app's launch/stop endpoint rather than window.open().
const NATIVE_WINDOW_APP_IDS = ["file-system-app"];

function getDesktopWindowMethod(appId, action) {
  const bridgeName = WINDOW_APP_BRIDGE_NAMES[appId];
  if (!bridgeName) {
    return null;
  }

  return `${action}${bridgeName}Window`;
}

async function openWindowApp(appId) {
  const methodName = getDesktopWindowMethod(appId, "open");
  if (window.controlCenterDesktop?.runtime === "electron" && methodName && typeof window.controlCenterDesktop[methodName] === "function") {
    await window.controlCenterDesktop[methodName]();
    return;
  }

  if (NATIVE_WINDOW_APP_IDS.includes(appId)) {
    await fetch(`/api/apps/${appId}/launch`, { method: "POST" });
    return;
  }

  window.open(`/${appId}/`, "_blank", "noopener");
}

async function closeWindowApp(appId) {
  const methodName = getDesktopWindowMethod(appId, "close");
  if (window.controlCenterDesktop?.runtime === "electron" && methodName && typeof window.controlCenterDesktop[methodName] === "function") {
    await window.controlCenterDesktop[methodName]();
    return;
  }

  if (NATIVE_WINDOW_APP_IDS.includes(appId)) {
    await fetch(`/api/apps/${appId}/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ process: "all" })
    });
  }
}

async function openDrawingAppWindow() {
  await openWindowApp("drawing-app");
}

async function openMovieAppWindow() {
  await openWindowApp("movie-app");
}

async function openServerManagerAppWindow() {
  await openWindowApp("server-manager-app");
}

async function openWikipediaAppWindow() {
  await openWindowApp("wikipedia-app");
}

async function closeCalendarAppWindow() {
  await closeWindowApp("calendar-app");
}

async function closeNewsAppWindow() {
  await closeWindowApp("news-app");
}

async function closeProjectAppWindow() {
  await closeWindowApp("project-app");
}

async function closeMusicAppWindow() {
  await closeWindowApp("music-app");
}

async function closeDrawingAppWindow() {
  await closeWindowApp("drawing-app");
}

async function closeMovieAppWindow() {
  await closeWindowApp("movie-app");
}

async function closeServerManagerAppWindow() {
  await closeWindowApp("server-manager-app");
}

async function closeWikipediaAppWindow() {
  await closeWindowApp("wikipedia-app");
}

async function openFileSystemAppWindow() {
  await openWindowApp("file-system-app");
}

async function closeFileSystemAppWindow() {
  await closeWindowApp("file-system-app");
}

async function closeKnownAppWindow(appId) {
  if (appId === "all-apps") {
    if (window.controlCenterDesktop?.runtime === "electron" && window.controlCenterDesktop.closeAllAppWindows) {
      await window.controlCenterDesktop.closeAllAppWindows();
    }
    // Also deactivate if any of these apps is the current tab
    if (WINDOW_APP_IDS.some((id) => state.activeTab === `app:${id}`)) {
      activateTab("overview");
    }
    return true;
  }

  // Close the Electron window if it exists
  if (appId === "calendar-app") {
    await closeCalendarAppWindow();
  } else if (appId === "news-app") {
    await closeNewsAppWindow();
  } else if (appId === "project-app") {
    await closeProjectAppWindow();
  } else if (appId === "music-app") {
    await closeMusicAppWindow();
  } else if (appId === "drawing-app") {
    await closeDrawingAppWindow();
  } else if (appId === "movie-app") {
    await closeMovieAppWindow();
  } else if (appId === "server-manager-app") {
    await closeServerManagerAppWindow();
  } else if (appId === "wikipedia-app") {
    await closeWikipediaAppWindow();
  } else if (appId === "file-system-app") {
    await closeFileSystemAppWindow();
  } else {
    return false;
  }

  // If this app is also open as the active inline tab, deactivate it
  if (state.activeTab === `app:${appId}`) {
    activateTab("overview");
  }

  return true;
}

async function openKnownAppWindow(appId) {
  if (WINDOW_APP_IDS.includes(appId)) {
    await openWindowApp(appId);
    // Native apps open their own OS window; returning false also brings up
    // their tab, whose content is the status/recorder panel.
    return !NATIVE_WINDOW_APP_IDS.includes(appId);
  }

  return false;
}

async function ollamaStart() {
  const res = await fetch("/api/ollama/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({})
  });
  return res.json();
}

async function ollamaStop() {
  const res = await fetch("/api/ollama/stop", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({})
  });
  return res.json();
}

async function refreshSystemStatus() {
  state.system = await loadSystem();
  if (state.activeTab === "overview") {
    renderOverview(state.system);
  }
}

function addPendingUserMessage(text) {
  const pendingId = `pending-${Date.now()}`;
  state.chatMessages = [
    ...state.chatMessages,
    {
      id: pendingId,
      role: "user",
      text,
      timestamp: new Date().toISOString(),
      meta: {
        pending: true
      }
    }
  ].slice(-120);

  return pendingId;
}

function removePendingUserMessage(pendingId) {
  state.chatMessages = state.chatMessages.filter((message) => message.id !== pendingId);
}

function ensureChatInputFocus(retryCount = 0) {
  if (state.activeTab !== "chatbot") {
    return;
  }

  const input = document.getElementById("chat-input");
  if (!input) {
    if (retryCount < 3) {
      window.setTimeout(() => ensureChatInputFocus(retryCount + 1), 60);
    }
    return;
  }

  input.focus();
  const valueLength = String(input.value || "").length;
  input.setSelectionRange(valueLength, valueLength);
}

function bindChatPanelState() {
  const panel = document.getElementById("chat-panel");
  const input = document.getElementById("chat-input");

  if (input) {
    input.value = state.chatDraft;
    input.addEventListener("input", (event) => {
      state.chatDraft = event.target.value;
    });

    if (state.chatInputShouldRefocus && state.activeTab === "chatbot") {
      window.requestAnimationFrame(() => {
        ensureChatInputFocus();
      });
      state.chatInputShouldRefocus = false;
    }
  }

  if (!panel) {
    return;
  }

  panel.addEventListener("scroll", () => {
    const distanceFromBottom = panel.scrollHeight - panel.scrollTop - panel.clientHeight;
    state.chatStickToBottom = distanceFromBottom < 28;
  });

  if (state.chatStickToBottom) {
    window.requestAnimationFrame(() => {
      panel.scrollTop = panel.scrollHeight;
    });
  }
}

let _queuePollId = null;

async function loadQueueStatus() {
  try {
    const res = await fetch('/api/agent/queue/status');
    if (!res.ok) return;
    const data = await res.json();
    state.queueStatus = data.queue || null;
    renderQueueBox();
  } catch (e) {
    // ignore fetch errors silently
  }
}

function renderQueueBox() {
  const el = document.getElementById('queue-box');
  if (!el) return;

  const q = state.queueStatus;
  if (!q || q.isEmpty) {
    el.innerHTML = `<div class="queue-header">Queue: 0</div><div class="queue-empty">No tasks queued</div>`;
    return;
  }

  const items = (q.tasks || []).slice(0,5).map(t => `<div class="queue-item"><strong>${t.task_id}</strong> <span class="queue-meta">${t.priority}</span> <div class="queue-content">${escapeHtml(t.content)}</div></div>`).join('');

  el.innerHTML = `
    <div class="queue-header">Queue: ${q.queueLength}</div>
    <div class="queue-list">${items}</div>
  `;
}

function startQueuePolling() {
  if (_queuePollId) return;
  loadQueueStatus();
  _queuePollId = window.setInterval(loadQueueStatus, 30000);
}

function stopQueuePolling() {
  if (_queuePollId) {
    clearInterval(_queuePollId);
    _queuePollId = null;
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/[&<>"']/g, function (s) {
    return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[s]);
  });
}

function modeButtonsActiveState() {
  modeDesktopBtn.classList.toggle("is-active", state.mode === "desktop");
  modeMobileBtn.classList.toggle("is-active", state.mode === "mobile");
  currentModePill.textContent = `Mode: ${state.mode}`;
}

function formatDuration(seconds) {
  const safeSeconds = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const minutes = Math.floor(safeSeconds / 60);
  const remaining = Math.floor(safeSeconds % 60);
  return `${minutes}:${String(remaining).padStart(2, "0")}`;
}

function renderMusicMiniPlayer() {
  const music = state.musicNowPlaying || {};
  const trackTitle = String(music.trackTitle || "No track selected");
  const status = music.isPlaying ? "Playing" : "Paused";
  const progress = `${formatDuration(music.currentTime)} / ${formatDuration(music.duration)}`;
  const queueCount = Number(music.queueCount) || 0;

  return `
    <article class="card stack">
      <h3>Mini Player</h3>
      <p class="muted">${status} | Queue: ${queueCount} | ${progress}</p>
      <p><strong>${trackTitle}</strong></p>
      <div class="event-controls">
        <button class="action-btn" data-action="music-open">Open Music App</button>
        <button class="action-btn" data-action="music-control" data-control="prev">Prev</button>
        <button class="action-btn" data-action="music-control" data-control="play-pause">Play/Pause</button>
        <button class="action-btn" data-action="music-control" data-control="next">Next</button>
      </div>
    </article>
  `;
}

function eventItem(event) {
  const isDebug = event.type === 'debug' || event.source === 'debug' || event.source === 'console';
  const isThought = event.isAIThought || event.type === 'thought';
  const isConsole = event.source === 'console';
  
  let levelClass = '';
  let levelLabel = '';
  
  if (isConsole) {
    levelClass = `console-${event.level || 'log'}`;
    levelLabel = `[${(event.level || 'log').toUpperCase()}]`;
  }
  
  const metaDisplay = event.meta && Object.keys(event.meta).length > 0 
    ? `<div class="event-meta-details">${JSON.stringify(event.meta, null, 2)}</div>` 
    : '';
  
  const thoughtDisplay = event.thoughts 
    ? `<div class="event-thoughts"><strong>Thought:</strong> ${event.thoughts}</div>` 
    : '';
  
  const stackDisplay = event.meta?.stack && Array.isArray(event.meta.stack) && event.meta.stack.length > 0
    ? `<div class="event-stack"><small>${event.meta.stack.join('\n')}</small></div>`
    : '';

  const typeClass = `event-type-${event.type}`;
  const sourceClass = `event-source-${event.source}`;

  return `
    <li class="event-item ${typeClass} ${sourceClass} ${isDebug ? 'is-debug' : ''} ${isThought ? 'is-thought' : ''} ${isConsole ? 'is-console' : ''}">
      <div class="event-row">
        <div class="event-header">
          <span class="event-source">${event.source}</span>
          <span class="event-app-id">${event.appId}</span>
          <span class="event-type">${event.type}</span>
          ${levelLabel ? `<span class="event-level ${levelClass}">${levelLabel}</span>` : ''}
          <span class="event-time">${new Date(event.timestamp).toLocaleTimeString()}</span>
        </div>
        <div class="event-message">${event.message}</div>
        ${thoughtDisplay}
        ${metaDisplay}
        ${stackDisplay}
      </div>
    </li>
  `;
}

function getRecentOverviewEvents() {
  return state.events.slice(0, 5);
}

function isAppOnline(app) {
  const status = String(app?.status || "").toLowerCase();
  return status === "live" || status === "online" || status === "ready";
}

function appTabBadge(app) {
  if (isAppOnline(app)) {
    return '<span class="online-badge">ONLINE</span>';
  }

  return '<span class="wip-badge">WIP</span>';
}

function appStatusPill(app) {
  if (isAppOnline(app)) {
    return '<span class="status ready">Online</span>';
  }

  return '<span class="status wip">Work In Progress</span>';
}

function renderAppTabs() {
  appTabsContainer.innerHTML = "";

  state.apps.forEach((app) => {
    const btn = document.createElement("button");
    btn.className = "nav-tab app-tab";
    btn.dataset.tab = `app:${app.id}`;
    btn.innerHTML = `<span>${app.name}</span>${appTabBadge(app)}`;
    appTabsContainer.appendChild(btn);
  });
}

function appCard(app) {
  const capHtml = app.capabilities
    .map((cap) => `<span class="cap">${cap}</span>`)
    .join("");

  return `
    <article class="card app-module-card" data-action="open-app" data-app-id="${app.id}" role="button" tabindex="0" aria-label="Open ${app.name}">
      <h3>${app.name}</h3>
      <p>${app.description}</p>
      <div class="caps">${capHtml}</div>
      <div style="margin-top: 10px">
        ${appStatusPill(app)}${app.version ? ` <span class="cap">v${app.version}</span>` : ""}
      </div>
    </article>
  `;
}

function renderOllamaCard(system) {
  const ollama = system.ollama || {};
  const status = String(ollama.status || "not_connected");
  const model = String(ollama.model || "");
  const isConnected = status === "connected";
  const statusClass = isConnected ? "ready" : (status === "error" ? "wip" : "muted");
  const statusLabel = isConnected ? "Connected" : (status === "error" ? "Error" : "Offline");
  const errorHtml = ollama.lastError ? `<li class="muted" style="font-size:0.78em">Last error: ${ollama.lastError}</li>` : "";
  const modelHtml = model ? `<li>Model: <span class="muted">${model}</span></li>` : "";

  return `
    <article class="card stack">
      <h3>Ollama</h3>
      <ul class="list">
        <li>Status: <span class="status ${statusClass}">${statusLabel}</span></li>
        ${modelHtml}
        ${errorHtml}
      </ul>
      <div class="event-controls">
        <button class="action-btn" data-action="ollama-start" ${isConnected ? "disabled" : ""}>Start Model</button>
        <button class="action-btn" data-action="ollama-stop" ${!isConnected ? "disabled" : ""}>Stop Model</button>
      </div>
      <p class="muted" id="ollama-feedback" style="font-size:0.8em;min-height:1.2em"></p>
    </article>
  `;
}

function renderVoiceCard(system) {
  const voice = system.voice || {};
  const whisperOk = voice.whisperReady;
  const piperOk = voice.piperReady;
  const allReady = whisperOk && piperOk;
  const vs = state.voiceStatus;
  const isActive = vs !== "off" && vs !== "error";

  const statusLabels = {
    off: "Off",
    connecting: "Connecting...",
    ready: "Ready",
    listening: "Listening",
    recording: "Recording...",
    processing: "Processing...",
    speaking: "Speaking...",
    error: "Error"
  };

  const statusClasses = {
    off: "muted",
    connecting: "wip",
    ready: "ready",
    listening: "ready",
    recording: "wip",
    processing: "wip",
    speaking: "wip",
    error: "wip"
  };

  const statusLabel = statusLabels[vs] || vs;
  const statusClass = statusClasses[vs] || "muted";

  const setupWarning = !allReady
    ? `<li class="muted" style="font-size:0.78em">Run voice/setup-voice.ps1 to install Whisper &amp; Piper</li>`
    : "";

  const transcriptHtml = state.voiceTranscript
    ? `<li class="muted" style="font-size:0.78em">You: "${state.voiceTranscript}"</li>`
    : "";
  const agentHtml = state.voiceAgentText
    ? `<li class="muted" style="font-size:0.78em">Jarvis: "${state.voiceAgentText}"</li>`
    : "";

  return `
    <article class="card stack">
      <h3>Voice Assistant</h3>
      <ul class="list">
        <li>Status: <span class="status ${statusClass}">${statusLabel}</span></li>
        <li>Whisper: <span class="status ${whisperOk ? "ready" : "muted"}">${whisperOk ? "Ready" : "Not installed"}</span></li>
        <li>Piper TTS: <span class="status ${piperOk ? "ready" : "muted"}">${piperOk ? "Ready" : "Not installed"}</span></li>
        ${setupWarning}
        ${transcriptHtml}
        ${agentHtml}
      </ul>
      <div class="event-controls">
        <button class="action-btn" data-action="voice-toggle" ${!allReady ? "disabled" : ""}>
          ${isActive ? "Stop Listening" : "Start Listening"}
        </button>
      </div>
      <p class="muted" id="voice-feedback" style="font-size:0.8em;min-height:1.2em"></p>
    </article>
  `;
}

function renderOverview(system) {
  overviewView.innerHTML = `
    <div class="grid">
      <article class="card stack">
        <h3>Core Status</h3>
        <ul class="list">
          <li>Control Core: <span class="status ready">${system.orchestrator.controlCore}</span></li>
          <li>App Registry: <span class="status ready">${system.orchestrator.appRegistry}</span></li>
          <li>Tool Gateway: <span class="status wip">${system.orchestrator.toolGateway}</span></li>
          <li>Integration Layer: <span class="status wip">${system.orchestrator.integrationLayer}</span></li>
        </ul>
      </article>

      <article class="card stack">
        <h3>Runtime</h3>
        <ul class="list">
          <li>System: ${system.name} v${system.version}</li>
          <li>Mode: <span class="muted">${state.mode}</span></li>
          <li>Server: <span class="muted">${system.server.status}</span></li>
        </ul>
      </article>

      ${renderOllamaCard(system)}
      ${renderVoiceCard(system)}
      ${renderMusicMiniPlayer()}
    </div>

    <article class="card stack">
      <h3>Recent Events</h3>
      <ul class="list">
        ${getRecentOverviewEvents().length ? getRecentOverviewEvents().map(eventItem).join("") : "<li>No events yet.</li>"}
      </ul>
      <div class="event-controls">
        <button class="action-btn" id="refresh-events-btn">Refresh Events</button>
      </div>
    </article>

    <article class="card">
      <h3>App Modules</h3>
      <div class="grid">
        ${state.apps.map(appCard).join("")}
      </div>
    </article>
  `;
}

function renderEventBus() {
  eventBusView.innerHTML = `
    <article class="card stack">
      <h3>Event Stream</h3>
      <p class="muted">
        Event panel size is fixed so the app layout remains stable. Scroll to browse older events.
      </p>
      <div class="event-bus-panel">
        <ul class="list">
          ${state.events.length ? state.events.map(eventItem).join("") : "<li>No events yet.</li>"}
        </ul>
      </div>
      <div class="event-controls">
        <button class="action-btn" id="refresh-event-bus-btn">Refresh Event Bus</button>
      </div>
    </article>
  `;
}

function renderSkills() {
  if (state.skillsViewMode === "editor") {
    renderSkillsEditor();
  } else {
    renderSkillsList();
  }
}

function renderSkillsList() {
  const skillsListHtml = state.skills.length
    ? state.skills
        .map(
          (skill) => `
      <div class="skill-item" data-skill-id="${skill.id}">
        <div class="skill-header">
          <h4>${skill.name}</h4>
          <span class="skill-size">${skill.sizeFormatted}</span>
        </div>
        <p class="skill-description">${skill.description || "No description"}</p>
        <div class="skill-meta">
          <span>${skill.lineCount} lines</span>
          <span>Modified: ${new Date(skill.modified).toLocaleString()}</span>
        </div>
        <div class="skill-actions">
          <button class="action-btn sm" data-action="skill-read" data-skill-id="${skill.id}">Read</button>
          <button class="action-btn sm" data-action="skill-edit" data-skill-id="${skill.id}">Edit</button>
          <button class="action-btn sm delete" data-action="skill-delete" data-skill-id="${skill.id}">Delete</button>
        </div>
      </div>
    `
        )
        .join("")
    : "<p class='muted'>No skills yet. Create one to get started.</p>";

  skillsView.innerHTML = `
    <article class="card stack">
      <div class="skills-header">
        <div>
          <h3>Agent Skills</h3>
          <p class="muted">Create and manage skills to extend your AI agent's capabilities.</p>
        </div>
        <button class="action-btn" id="skill-create-btn">+ New Skill</button>
      </div>

      <div class="skills-list">
        ${skillsListHtml}
      </div>
    </article>
  `;
}

function renderSkillsEditor() {
  const isNew = !state.selectedSkillId;
  skillsView.innerHTML = `
    <article class="card stack">
      <div class="skill-editor-header">
        <button class="action-btn sm back" id="skill-editor-back">← Back</button>
        <h3>${isNew ? "New Skill" : `Edit: ${state.selectedSkillId}`}</h3>
      </div>

      <form id="skill-editor-form" class="skill-editor-form">
        <label class="editor-field">
          <span>Skill Name</span>
          <input type="text" name="skillName" value="${state.skillsEditorName}" placeholder="e.g., FILE_READER_SKILL" ${isNew ? "" : "disabled"} required />
        </label>

        <label class="editor-field full">
          <span>Skill Content (Markdown)</span>
          <textarea name="content" placeholder="# Skill Title&#10;&#10;Skill description..." required>${state.skillsEditorContent}</textarea>
        </label>

        <div class="skill-editor-actions">
          <button type="submit" class="action-btn">${isNew ? "Create" : "Update"} Skill</button>
          <button type="button" class="action-btn secondary" id="skill-editor-cancel">Cancel</button>
        </div>
      </form>
    </article>
  `;
}

function renderSettings() {
  if (!state.settings || !state.settingsOptions) {
    settingsView.innerHTML = `
      <article class="card stack">
        <h3>Settings Unavailable</h3>
        <p class="muted">Settings are still loading.</p>
      </article>
    `;
    return;
  }

  const desktop = state.settings.desktop;
  const options = state.settingsOptions.desktop;

  const audioOptionsHtml = options.audioDeviceOptions
    .map((opt) => `<option value="${opt.id}" ${desktop.audioDevice === opt.id ? "selected" : ""}>${opt.label}</option>`)
    .join("");

  const voiceOptionsHtml = options.voiceOptions
    .map((opt) => `<option value="${opt.id}" ${desktop.voice === opt.id ? "selected" : ""}>${opt.label}</option>`)
    .join("");

  const speedOptionsHtml = options.voiceSpeedOptions
    .map((speed) => `<option value="${speed}" ${desktop.voiceSpeed === speed ? "selected" : ""}>${speed}</option>`)
    .join("");

  settingsView.innerHTML = `
    <article class="card stack">
      <h3>Desktop Mode Settings</h3>
      <p class="muted">Configure audio device and voice behavior for desktop interactions.</p>

      <form id="desktop-settings-form" class="settings-form">
        <label class="settings-field">
          <span>Audio Device</span>
          <select name="audioDevice">${audioOptionsHtml}</select>
        </label>

        <label class="settings-field">
          <span>Voice</span>
          <select name="voice">${voiceOptionsHtml}</select>
        </label>

        <label class="settings-field">
          <span>Voice Speed</span>
          <select name="voiceSpeed">${speedOptionsHtml}</select>
        </label>

        <div class="event-controls">
          <button type="button" class="action-btn" id="test-voice-btn">Test Voice</button>
          <button type="submit" class="action-btn">Save Desktop Settings</button>
        </div>
      </form>
    </article>

    ${renderDevicesCard()}

    <article class="card stack">
      <h3>Mode Notice</h3>
      <p class="muted">
        ${state.mode === "desktop"
          ? "Desktop Mode is active. Settings changes apply immediately to the desktop runtime."
          : "Mobile Mode is active. Desktop settings are still editable and will apply when Desktop Mode is active."}
      </p>
    </article>
  `;
}

function chatMessageItem(message) {
  const roleLabel = message.role === "agent" ? "Agent" : "You";
  const roleClass = message.role === "agent" ? "role-agent" : "role-user";
  const pendingClass = message.meta?.pending ? "is-pending" : "";
  return `
    <li class="chat-item ${roleClass} ${pendingClass}">
      <div class="event-meta">
        <span>${roleLabel}</span>
        <span>${new Date(message.timestamp).toLocaleTimeString()}</span>
      </div>
      <div class="event-message">${message.text}</div>
    </li>
  `;
}

function renderChatbot() {
  if (state.mode !== "desktop") {
    chatbotView.innerHTML = `
      <article class="card stack">
        <h3>Desktop Mode Required</h3>
        <p class="muted">
          Text chat with the agent is available in Desktop Mode. Switch modes using the controls in the header.
        </p>
      </article>
    `;
    return;
  }

  chatbotView.innerHTML = `
    <div class="chatbot-container">
      <div class="chatbot-content">
        <h2 class="chatbot-title">Agent Text Chat</h2>
        <p class="chatbot-subtitle">Neural Interface Active</p>
        
        <div class="chat-panel" id="chat-panel">
          <ul class="list chat-list">
            ${state.chatMessages.length ? state.chatMessages.map(chatMessageItem).join("") : "<li class='no-messages'>No messages yet.</li>"}
          </ul>
        </div>

        <form id="chat-form" class="chatbot-form">
          <div class="chat-input-group">
            <textarea id="chat-input" name="chatInput" rows="3" placeholder="Type a message to your agent..."></textarea>
          </div>
          <div class="chat-button-group">
            <button type="submit" class="action-btn">Send Message</button>
          </div>
        </form>
      </div>
        <div id="queue-box" class="queue-box" aria-live="polite"></div>
    </div>
  `;

  bindChatPanelState();
    startQueuePolling();
}

function renderAgentCore() {
  agentCoreView.innerHTML = `
    <div class="grid">
      <article class="card stack">
        <h3>Agent Pipeline</h3>
        <ul class="list">
          <li>Conversation Manager <span class="status wip">Planned</span></li>
          <li>Prompt Builder <span class="status wip">Planned</span></li>
          <li>Tool Policy Engine <span class="status wip">Planned</span></li>
          <li>Response Formatter <span class="status wip">Planned</span></li>
        </ul>
      </article>

      <article class="card stack">
        <h3>First Build Priority</h3>
        <p>
          GUI and navigation are active now. Agent internals are scaffolded so each app connector can be added without breaking the shell.
        </p>
      </article>
    </div>
  `;
}

function renderIntegrationHub() {
  integrationHubView.innerHTML = `
    <div class="grid">
      <article class="card stack">
        <h3>Ready Endpoints</h3>
        <ul class="list">
          <li>GET /api/health</li>
          <li>GET /api/system</li>
          <li>GET /api/mode</li>
          <li>POST /api/mode/switch</li>
          <li>GET /api/apps</li>
          <li>GET /api/apps/:appId</li>
          <li>POST /api/apps/:appId/connect</li>
          <li>GET /api/settings</li>
          <li>PUT /api/settings/desktop</li>
          <li>POST /api/settings/desktop/test-voice</li>
          <li>GET /api/chat/messages</li>
          <li>POST /api/chat/messages</li>
          <li>GET /api/agent/context</li>
          <li>GET /api/agent/tools</li>
          <li>POST /api/agent/respond</li>
          <li>GET /api/events</li>
          <li>POST /api/events</li>
          <li>GET /api/events/stream</li>
        </ul>
      </article>

      <article class="card stack">
        <h3>Integration Strategy</h3>
        <p>
          Each app will plug into the backend through isolated connectors. The orchestrator currently returns connector stubs so module development can proceed independently.
        </p>
      </article>
    </div>
  `;
}

function renderSingleApp(appId) {
  const app = state.apps.find((item) => item.id === appId);

  if (!app) {
    appView.innerHTML = "<article class=\"card\"><h3>Unknown app</h3><p>App module not found in registry.</p></article>";
    return;
  }

  if (NATIVE_WINDOW_APP_IDS.includes(app.id)) {
    appView.innerHTML = `
      <article class="card stack">
        <h3>${app.name}${app.version ? ` <span class="cap">v${app.version}</span>` : ""}</h3>
        <p>${app.description}</p>
        <div><button class="action-btn" data-action="open-app" data-app-id="${app.id}">Open ${app.name}</button></div>
      </article>
      <iframe class="card" src="/${app.routeKey}/" title="${app.name} panel"
        style="width: 100%; min-height: 760px; border: 0; padding: 0; background: transparent"></iframe>
    `;
    return;
  }

  const capHtml = app.capabilities.map((cap) => `<li>${cap}</li>`).join("");
  const launchButton = WINDOW_APP_IDS.includes(app.id)
    ? `<div><button class="action-btn" data-action="open-app" data-app-id="${app.id}">Open ${app.name}</button></div>`
    : "";

  appView.innerHTML = `
    <article class="card stack">
      <h3>${app.name}</h3>
      <p>${app.description}</p>
      <div><span class="status wip">Work In Progress</span></div>
      ${launchButton}
    </article>

    <article class="card stack">
      <h3>Planned Capabilities</h3>
      <ul class="list">${capHtml}</ul>
    </article>

    <article class="card stack">
      <h3>Connector Status</h3>
      <p>
        Backend connector contract is prepared. Implementation is intentionally deferred while core UI and navigation are stabilized.
      </p>
      <div>
        <button class="action-btn" data-action="publish-event" data-app-id="${app.id}">Publish Status Update</button>
      </div>
    </article>
  `;
}

function setVisibleView(viewId) {
  [overviewView, settingsView, chatbotView, eventBusView, agentCoreView, integrationHubView, skillsView, appView].forEach((view) => {
    view.classList.remove("is-visible");
  });

  document.getElementById(viewId).classList.add("is-visible");
}

function activateTab(tab) {
  state.activeTab = tab;

  document.querySelectorAll(".nav-tab").forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.tab === tab);
  });

  if (tabMeta[tab]) {
    viewTitle.textContent = tabMeta[tab].title;
    viewSubtitle.textContent = tabMeta[tab].subtitle;
  }

  if (tab === "overview") {
    setVisibleView("view-overview");
    stopQueuePolling();
    return;
  }

  if (tab === "agent-core") {
    setVisibleView("view-agent-core");
    stopQueuePolling();
    return;
  }

  if (tab === "settings") {
    renderSettings();
    setVisibleView("view-settings");
    stopQueuePolling();
    loadDevices()
      .then(() => {
        if (state.activeTab === "settings") {
          renderSettings();
        }
      })
      .catch(() => {});
    return;
  }

  if (tab === "chatbot") {
    renderChatbot();
    setVisibleView("view-chatbot");
    return;
  }
  // For all other tabs, ensure queue polling is stopped
  stopQueuePolling();

  if (tab === "event-bus") {
    renderEventBus();
    setVisibleView("view-event-bus");
    return;
  }

  if (tab === "integration-hub") {
    setVisibleView("view-integration-hub");
    return;
  }

  if (tab === "skills") {
    renderSkills();
    setVisibleView("view-skills");
    return;
  }

  if (tab.startsWith("app:")) {
    const appId = tab.replace("app:", "");
    const app = state.apps.find((item) => item.id === appId);
    viewTitle.textContent = app?.name || "App";
    viewSubtitle.textContent = "Module shell and integration-ready backend contract";
    renderSingleApp(appId);
    setVisibleView("view-app");
  }
}

function wireNavigation() {
  alarmStopBtn.addEventListener("click", () => {
    const idToStop = ringingAlarmId;
    hideAlarmOverlay();
    if (idToStop) {
      fetch(`/api/alarms/${idToStop}/stop`, { method: "POST" }).catch(() => {
        // Overlay is already hidden client-side; a failed stop call here just
        // means the server-side state may briefly disagree until next sync.
      });
    }
  });

  document.addEventListener("click", (event) => {
    const lmStartButton = event.target.closest("[data-action='ollama-start']");
    if (lmStartButton && !lmStartButton.disabled) {
      lmStartButton.disabled = true;
      lmStartButton.textContent = "Loading...";
      const feedback = document.getElementById("ollama-feedback");
      if (feedback) feedback.textContent = "Starting model — this may take a moment...";
      ollamaStart()
        .then(async (result) => {
          await refreshSystemStatus();
          const fb = document.getElementById("ollama-feedback");
          if (fb) fb.textContent = result.ok ? "Model loaded." : (result.message || "Failed to start.");
        })
        .catch(async () => {
          await refreshSystemStatus();
        });
      return;
    }

    const lmStopButton = event.target.closest("[data-action='ollama-stop']");
    if (lmStopButton && !lmStopButton.disabled) {
      lmStopButton.disabled = true;
      lmStopButton.textContent = "Stopping...";
      const feedback = document.getElementById("ollama-feedback");
      if (feedback) feedback.textContent = "Unloading model...";
      ollamaStop()
        .then(async (result) => {
          await refreshSystemStatus();
          const fb = document.getElementById("ollama-feedback");
          if (fb) fb.textContent = result.ok ? "Model unloaded." : (result.message || "Failed to stop.");
        })
        .catch(async () => {
          await refreshSystemStatus();
        });
      return;
    }

    const voiceToggleButton = event.target.closest("[data-action='voice-toggle']");
    if (voiceToggleButton && !voiceToggleButton.disabled) {
      const voiceState = getVoiceState();
      if (voiceState.status === "off" || voiceState.status === "error") {
        initVoice({
          onStatusChange: (status) => {
            state.voiceStatus = status;
            setNeuralSpeaking(status === "speaking");
            if (state.activeTab === "overview" && state.system) {
              renderOverview(state.system);
            }
          },
          onTranscript: (text) => {
            state.voiceTranscript = text;
            if (state.activeTab === "overview" && state.system) {
              renderOverview(state.system);
            }
          },
          onAgentText: (text) => {
            state.voiceAgentText = text;
            if (state.activeTab === "overview" && state.system) {
              renderOverview(state.system);
            }
            // Also reload chat messages so voice commands appear in chatbot
            loadChatMessages().then(() => {
              if (state.activeTab === "chatbot") renderChatbot();
            }).catch(() => {});
          },
          onWake: () => {
            state.voiceTranscript = "";
            state.voiceAgentText = "";
          },
          onError: (msg) => {
            const fb = document.getElementById("voice-feedback");
            if (fb) fb.textContent = msg;
          }
        });
      } else {
        stopVoice();
        state.voiceStatus = "off";
        setNeuralSpeaking(false);
        state.voiceTranscript = "";
        state.voiceAgentText = "";
        if (state.activeTab === "overview" && state.system) {
          renderOverview(state.system);
        }
      }
      return;
    }

    const openMusicButton = event.target.closest("[data-action='music-open']");
    if (openMusicButton) {
      openMusicAppWindow().catch(() => {
        // Ignore launch failures for now.
      });
      return;
    }

    const musicControlButton = event.target.closest("[data-action='music-control']");
    if (musicControlButton) {
      const action = musicControlButton.dataset.control;
      if (musicCommandChannel) {
        musicCommandChannel.postMessage({
          type: "music-command",
          payload: { action }
        });
      }
      return;
    }

    const openAppButton = event.target.closest("[data-action='open-app']");
    if (openAppButton) {
      const appId = openAppButton.dataset.appId;

      openKnownAppWindow(appId).then((opened) => {
        if (!opened) {
          activateTab(`app:${appId}`);
        }
      }).catch(() => {
        // Ignore launch failures for now.
      });

      return;
    }

    const actionButton = event.target.closest("[data-action='publish-event']");
    if (actionButton) {
      const appId = actionButton.dataset.appId;
      publishAppStatusEvent(appId)
        .then(async () => {
          await loadEvents();
          if (state.system) {
            renderOverview(state.system);
          }
        })
        .catch(() => {
          // Keep the UI responsive even if the event post fails.
        });
      return;
    }

    const refreshButton = event.target.closest("#refresh-events-btn");
    if (refreshButton) {
      loadEvents()
        .then(() => {
          if (state.system) {
            renderOverview(state.system);
            if (state.activeTab === "event-bus") {
              renderEventBus();
            }
          }
        })
        .catch(() => {
          // Ignore refresh failures for now.
        });
      return;
    }

    const refreshEventBusButton = event.target.closest("#refresh-event-bus-btn");
    if (refreshEventBusButton) {
      loadEvents()
        .then(() => {
          renderEventBus();
          if (state.system) {
            renderOverview(state.system);
          }
        })
        .catch(() => {
          // Ignore refresh failures for now.
        });
      return;
    }

    const pairButton = event.target.closest("#pair-device-btn");
    if (pairButton) {
      startPairing()
        .then(() => renderSettings())
        .catch(() => {});
      return;
    }

    const cancelPairingButton = event.target.closest("#cancel-pairing-btn");
    if (cancelPairingButton) {
      cancelPairing()
        .then(() => renderSettings())
        .catch(() => {});
      return;
    }

    const removeDeviceButton = event.target.closest(".remove-device-btn");
    if (removeDeviceButton) {
      const device = (state.devices ?? []).find((entry) => entry.id === removeDeviceButton.dataset.deviceId);
      if (window.confirm(`Remove ${device?.name || "this device"}? It will need to pair again to connect.`)) {
        removeDevice(removeDeviceButton.dataset.deviceId)
          .then(() => renderSettings())
          .catch(() => {});
      }
      return;
    }

    const testVoiceButton = event.target.closest("#test-voice-btn");
    if (testVoiceButton) {
      runVoiceTest("This is a local desktop voice test.")
        .then(async () => {
          await loadEvents();
          if (state.system) {
            renderOverview(state.system);
          }
          if (state.activeTab === "event-bus") {
            renderEventBus();
          }
        })
        .catch(() => {
          // Keep UI responsive if the voice test request fails.
        });
      return;
    }

    const settingsForm = event.target.closest("#desktop-settings-form");
    if (settingsForm) {
      return;
    }

    const target = event.target.closest(".nav-tab");
    if (!target) {
      return;
    }

    if (target.dataset.tab.startsWith("app:")) {
      const appId = target.dataset.tab.replace("app:", "");
      openKnownAppWindow(appId).then((opened) => {
        if (!opened) {
          activateTab(target.dataset.tab);
        }
      }).catch(() => {
        // Ignore launch failures for now.
      });
      return;
    }

    activateTab(target.dataset.tab);
  });

  document.addEventListener("submit", (event) => {
    const form = event.target.closest("#desktop-settings-form");
    if (!form) {
      return;
    }

    event.preventDefault();
    const formData = new FormData(form);
    const payload = {
      audioDevice: String(formData.get("audioDevice") || ""),
      voice: String(formData.get("voice") || ""),
      voiceSpeed: String(formData.get("voiceSpeed") || "")
    };

    saveDesktopSettings(payload)
      .then(async (result) => {
        if (!result.ok) {
          return;
        }

        await loadSettings();
        await loadEvents();
        renderSettings();
        if (state.system) {
          renderOverview(state.system);
        }
      })
      .catch(() => {
        // Keep UI responsive when settings update fails.
      });

    return;
  });

  document.addEventListener("submit", (event) => {
    const form = event.target.closest("#chat-form");
    if (!form) {
      return;
    }

    event.preventDefault();
    const chatInput = form.querySelector("#chat-input");
    const text = String(chatInput?.value || "").trim();
    if (!text) {
      return;
    }

    const pendingId = addPendingUserMessage(text);
    state.chatDraft = "";
    state.chatStickToBottom = true;
    state.chatInputShouldRefocus = true;
    renderChatbot();
    ensureChatInputFocus();

    postChatMessage(text)
      .then(async (result) => {
        removePendingUserMessage(pendingId);

        if (!result.ok) {
          renderChatbot();
          return;
        }

        await loadChatMessages();
        await loadEvents();
        renderChatbot();
        ensureChatInputFocus();
        if (state.system) {
          renderOverview(state.system);
        }
      })
      .catch(() => {
        removePendingUserMessage(pendingId);
        state.chatInputShouldRefocus = true;
        renderChatbot();
        ensureChatInputFocus();
        // Keep UI responsive when chat send fails.
      });
  });

  // Skills event handlers
  document.addEventListener("click", (event) => {
    const skillCreateBtn = event.target.closest("#skill-create-btn");
    if (skillCreateBtn) {
      state.skillsViewMode = "editor";
      state.selectedSkillId = null;
      state.skillsEditorName = "";
      state.skillsEditorContent = "# Skill Title\n\n## Purpose\n\nDescribe what this skill does.\n\n## Usage\n\nProvide instructions on how to use this skill.";
      renderSkills();
      return;
    }

    const skillReadBtn = event.target.closest("[data-action='skill-read']");
    if (skillReadBtn) {
      const skillId = skillReadBtn.dataset.skillId;
      fetch(`/api/skills/${skillId}`)
        .then(r => r.json())
        .then(data => {
          if (data.skill) {
            const content = data.skill.content;
            skillsView.innerHTML = `
              <article class="card stack">
                <div class="skill-reader-header">
                  <button class="action-btn sm back" id="skill-reader-back">← Back</button>
                  <h3>${data.skill.name}</h3>
                </div>
                <div class="skill-content markdown">
                  ${content.split('\n').map(line => {
                    if (line.startsWith('#')) {
                      const level = line.match(/^#+/)[0].length;
                      const text = line.replace(/^#+\s+/, '');
                      return `<h${level+1}>${text}</h${level+1}>`;
                    } else if (line.trim()) {
                      return `<p>${line}</p>`;
                    }
                    return '';
                  }).join('')}
                </div>
                <div class="skill-reader-actions">
                  <button class="action-btn" id="skill-reader-edit">Edit</button>
                  <button class="action-btn secondary" id="skill-reader-back-btn">Back</button>
                </div>
              </article>
            `;
          }
        })
        .catch(() => {});
      return;
    }

    const skillEditBtn = event.target.closest("[data-action='skill-edit']");
    if (skillEditBtn) {
      const skillId = skillEditBtn.dataset.skillId;
      fetch(`/api/skills/${skillId}`)
        .then(r => r.json())
        .then(data => {
          if (data.skill) {
            state.skillsViewMode = "editor";
            state.selectedSkillId = data.skill.id;
            state.skillsEditorName = data.skill.name;
            state.skillsEditorContent = data.skill.content;
            renderSkills();
          }
        })
        .catch(() => {});
      return;
    }

    const skillDeleteBtn = event.target.closest("[data-action='skill-delete']");
    if (skillDeleteBtn) {
      const skillId = skillDeleteBtn.dataset.skillId;
      if (confirm(`Delete skill "${skillId}"?`)) {
        fetch(`/api/skills/${skillId}`, { method: "DELETE" })
          .then(r => r.json())
          .then(() => {
            loadSkills().then(() => renderSkills());
          })
          .catch(() => {});
      }
      return;
    }

    const skillEditorBackBtn = event.target.closest("#skill-editor-back");
    if (skillEditorBackBtn) {
      state.skillsViewMode = "list";
      renderSkills();
      return;
    }

    const skillReaderBackBtn = event.target.closest("#skill-reader-back");
    if (skillReaderBackBtn) {
      state.skillsViewMode = "list";
      renderSkills();
      return;
    }
  });

  document.addEventListener("submit", (event) => {
    const form = event.target.closest("#skill-editor-form");
    if (!form) {
      return;
    }

    event.preventDefault();
    const formData = new FormData(form);
    const skillName = String(formData.get("skillName") || "").trim();
    const content = String(formData.get("content") || "").trim();

    if (!skillName || !content) {
      alert("Skill name and content are required");
      return;
    }

    const isNew = !state.selectedSkillId;
    const method = isNew ? "POST" : "PUT";
    const url = isNew ? "/api/skills" : `/api/skills/${state.selectedSkillId}`;
    const payload = isNew ? { skillName, content } : { content };

    fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    })
      .then(r => r.json())
      .then(data => {
        if (data.success) {
          alert(`Skill ${isNew ? 'created' : 'updated'} successfully`);
          loadSkills().then(() => {
            state.skillsViewMode = "list";
            renderSkills();
          });
        } else {
          alert(`Error: ${data.error}`);
        }
      })
      .catch(err => {
        alert(`Failed to save skill: ${err.message}`);
      });
  });

  document.addEventListener("keydown", (event) => {
    const chatInput = event.target.closest("#chat-input");
    if (!chatInput) {
      return;
    }

    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      chatInput.closest("form")?.requestSubmit();
    }
  });
}

function initMusicBridge() {
  if (!musicStateChannel) {
    return;
  }

  musicStateChannel.onmessage = (event) => {
    if (event?.data?.type !== "music-state") {
      return;
    }

    state.musicNowPlaying = {
      ...state.musicNowPlaying,
      ...(event.data.payload || {}),
      updatedAt: Date.now()
    };

    if (state.activeTab === "overview" && state.system) {
      renderOverview(state.system);
    }
  };
}

function wireModeControls() {
  modeDesktopBtn.addEventListener("click", async () => {
    await switchModeAndRefresh("desktop");
  });

  modeMobileBtn.addEventListener("click", async () => {
    await switchModeAndRefresh("mobile");
  });
}

async function switchModeAndRefresh(targetMode) {
  const result = await switchModeRequest(targetMode);
  if (!result.ok) {
    return;
  }

  state.mode = result.mode.currentMode;
  modeButtonsActiveState();

  await loadEvents();
  await loadSettings();
  await loadChatMessages();
  if (state.system) {
    renderOverview(state.system);
    renderSettings();
    renderChatbot();
  }
}

function startEventStream() {
  const stream = new EventSource("/api/events/stream");

  stream.onmessage = (msg) => {
    try {
      const payload = JSON.parse(msg.data);
      if (payload.type === "snapshot" && Array.isArray(payload.events)) {
        state.events = payload.events;
      }

      if (payload.type === "event" && payload.event) {
        state.events = [payload.event, ...state.events].slice(0, 120);

        if (
          payload.event.appId === "music-app" &&
          payload.event.type === "music-command" &&
          musicCommandChannel
        ) {
          musicCommandChannel.postMessage({
            type: "music-command",
            payload: {
              ...(payload.event.meta || {}),
              __eventId: payload.event.id,
              __eventTimestamp: payload.event.timestamp
            }
          });
        }

        // Open/close events carrying targetDeviceId were asked for from a
        // paired phone and are meant for that phone, not for this desktop.
        const targetedElsewhere = Boolean(payload.event.meta?.targetDeviceId);

        if (payload.event.type === "open-app" && payload.event.meta?.tab && !targetedElsewhere) {
          const targetTab = String(payload.event.meta.tab);
          if (targetTab === "app:calendar-app") {
            openCalendarAppWindow().catch(() => {
              // Ignore launch failures for now.
            });
          } else if (targetTab === "app:news-app") {
            openNewsAppWindow().catch(() => {
              // Ignore launch failures for now.
            });
          } else if (targetTab === "app:project-app") {
            openProjectAppWindow().catch(() => {
              // Ignore launch failures for now.
            });
          } else if (targetTab === "app:music-app") {
            openMusicAppWindow().catch(() => {
              // Ignore launch failures for now.
            });
          } else if (targetTab === "app:drawing-app") {
            openDrawingAppWindow().catch(() => {
              // Ignore launch failures for now.
            });
          } else if (targetTab === "app:movie-app") {
            openMovieAppWindow().catch(() => {
              // Ignore launch failures for now.
            });
          } else if (targetTab === "app:server-manager-app") {
            openServerManagerAppWindow().catch(() => {
              // Ignore launch failures for now.
            });
          } else if (targetTab === "app:wikipedia-app") {
            openWikipediaAppWindow().catch(() => {
              // Ignore launch failures for now.
            });
          } else if (targetTab === "app:file-system-app") {
            openFileSystemAppWindow().catch(() => {
              // Ignore launch failures for now.
            });
          } else {
            activateTab(targetTab);
          }
        }

        if (payload.event.type === "close-app" && !targetedElsewhere) {
          const closeTarget = String(payload.event.meta?.target || "").trim();
          closeKnownAppWindow(closeTarget).catch(() => {
            // Ignore close failures for now.
          });
        }

        if (payload.event.type === "device-paired" || payload.event.type === "device-revoked") {
          if (payload.event.type === "device-paired") {
            state.pairing = null;
            stopPairingCountdown();
          }
          loadDevices()
            .then(() => {
              if (state.activeTab === "settings") {
                renderSettings();
              }
            })
            .catch(() => {});
        }

        if (payload.event.type === "alarm-fired" && !targetedElsewhere) {
          showAlarmOverlay(payload.event.meta || {});
        }

        if (payload.event.type === "alarm-stopped" && !targetedElsewhere) {
          hideAlarmOverlay();
        }

        if (payload.event.source === "chat" || String(payload.event.type || "").startsWith("chat")) {
          loadChatMessages()
            .then(() => {
              if (state.activeTab === "chatbot") {
                renderChatbot();
              }
            })
            .catch(() => {
              // Ignore chat refresh failures from the event stream.
            });
        }
      }

      if (state.activeTab === "overview" && state.system) {
        renderOverview(state.system);
      }

      if (state.activeTab === "event-bus") {
        renderEventBus();
      }

      if (state.activeTab === "settings") {
        renderSettings();
      }

      if (state.activeTab === "chatbot") {
        renderChatbot();
      }

      // Skip the native app's tab too: re-rendering it would reload its panel iframe on every event.
      if (state.activeTab.startsWith("app:") && state.activeTab !== "app:news-app" && !NATIVE_WINDOW_APP_IDS.includes(state.activeTab.replace("app:", ""))) {
        const appId = state.activeTab.replace("app:", "");
        renderSingleApp(appId);
      }
    } catch (error) {
      // Ignore malformed stream events.
    }
  };
}

function runStartupSequence() {
  if (!startupSplash || !appShell) {
    return;
  }

  appShell.classList.add("is-ready");

  window.setTimeout(() => {
    startupSplash.classList.add("is-hidden");
  }, 3600);
}

function autoStartVoice() {
  const voice = state.system?.voice;
  if (!voice?.whisperReady || !voice?.piperReady) return;

  initVoice({
    onStatusChange: (status) => {
      state.voiceStatus = status;
      setNeuralSpeaking(status === "speaking");
      if (state.activeTab === "overview" && state.system) {
        renderOverview(state.system);
      }
    },
    onTranscript: (text) => {
      state.voiceTranscript = text;
      if (state.activeTab === "overview" && state.system) {
        renderOverview(state.system);
      }
    },
    onAgentText: (text) => {
      state.voiceAgentText = text;
      if (state.activeTab === "overview" && state.system) {
        renderOverview(state.system);
      }
      loadChatMessages().then(() => {
        if (state.activeTab === "chatbot") renderChatbot();
      }).catch(() => {});
    },
    onWake: () => {
      state.voiceTranscript = "";
      state.voiceAgentText = "";
    },
    onError: (msg) => {
      const fb = document.getElementById("voice-feedback");
      if (fb) fb.textContent = msg;
    }
  });
}

async function init() {
  initializeNeuralNetwork("app-neural-canvas");

  await loadApps();
  await loadSkills();
  state.system = await loadSystem();
  state.mode = state.system.modeState?.currentMode || state.system.mode || "desktop";
  await loadEvents();
  await loadSettings();
  await loadChatMessages();

  renderAppTabs();
  renderOverview(state.system);
  renderSettings();
  renderChatbot();
  renderEventBus();
  renderAgentCore();
  renderIntegrationHub();

  wireNavigation();
  wireModeControls();
  initMusicBridge();
  modeButtonsActiveState();
  startEventStream();
  activateTab("overview");
  runStartupSequence();
  autoStartVoice();
  checkRingingAlarms();
}

init().catch((error) => {
  overviewView.innerHTML = `
    <article class="card">
      <h3>Initialization Error</h3>
      <p class="muted">${error.message}</p>
    </article>
  `;
  setVisibleView("view-overview");
});