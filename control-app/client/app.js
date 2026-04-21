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
  }
};

import { initVoice, stopVoice, getVoiceState, isVoiceActive } from "./voice.js";

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
const appView = document.getElementById("view-app");
const currentModePill = document.getElementById("current-mode-pill");
const modeDesktopBtn = document.getElementById("mode-desktop-btn");
const modeMobileBtn = document.getElementById("mode-mobile-btn");
const startupSplash = document.getElementById("startup-splash");
const appShell = document.getElementById("app-shell");

async function loadApps() {
  const res = await fetch("/api/apps");
  const data = await res.json();
  state.apps = data.apps ?? [];
}

async function loadSystem() {
  const res = await fetch("/api/system");
  return res.json();
}

async function loadEvents() {
  const res = await fetch("/api/events?limit=120");
  const data = await res.json();
  state.events = data.events ?? [];
}

async function loadSettings() {
  const res = await fetch("/api/settings");
  const data = await res.json();
  state.settings = data.settings;
  state.settingsOptions = data.options;
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
  if (window.controlCenterDesktop?.runtime === "electron" && window.controlCenterDesktop.openNewsAppWindow) {
    await window.controlCenterDesktop.openNewsAppWindow();
    return;
  }

  window.open("/news-app/", "_blank", "noopener");
}

async function openCalendarAppWindow() {
  if (window.controlCenterDesktop?.runtime === "electron" && window.controlCenterDesktop.openCalendarAppWindow) {
    await window.controlCenterDesktop.openCalendarAppWindow();
    return;
  }

  window.open("/calendar-app/", "_blank", "noopener");
}

async function openWorkAppWindow() {
  if (window.controlCenterDesktop?.runtime === "electron" && window.controlCenterDesktop.openWorkAppWindow) {
    await window.controlCenterDesktop.openWorkAppWindow();
    return;
  }

  window.open("/work-app/", "_blank", "noopener");
}

async function openProjectAppWindow() {
  if (window.controlCenterDesktop?.runtime === "electron" && window.controlCenterDesktop.openProjectAppWindow) {
    await window.controlCenterDesktop.openProjectAppWindow();
    return;
  }

  window.open("/project-app/", "_blank", "noopener");
}

async function openMusicAppWindow() {
  if (window.controlCenterDesktop?.runtime === "electron" && window.controlCenterDesktop.openMusicAppWindow) {
    await window.controlCenterDesktop.openMusicAppWindow();
    return;
  }

  window.open("/music-app/", "_blank", "noopener");
}

async function lmStudioStart() {
  const res = await fetch("/api/lmstudio/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({})
  });
  return res.json();
}

async function lmStudioStop() {
  const res = await fetch("/api/lmstudio/stop", {
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
  return `
    <li>
      <div class="event-row">
        <div class="event-meta">
          <span>${event.appId} | ${event.type}</span>
          <span>${new Date(event.timestamp).toLocaleTimeString()}</span>
        </div>
        <div class="event-message">${event.message}</div>
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
        ${appStatusPill(app)}
      </div>
    </article>
  `;
}

function renderLmStudioCard(system) {
  const lm = system.lmStudio || {};
  const status = String(lm.status || "not_connected");
  const model = String(lm.model || "");
  const isConnected = status === "connected";
  const statusClass = isConnected ? "ready" : (status === "error" ? "wip" : "muted");
  const statusLabel = isConnected ? "Connected" : (status === "error" ? "Error" : "Offline");
  const errorHtml = lm.lastError ? `<li class="muted" style="font-size:0.78em">Last error: ${lm.lastError}</li>` : "";
  const modelHtml = model ? `<li>Model: <span class="muted">${model}</span></li>` : "";

  return `
    <article class="card stack">
      <h3>LMStudio</h3>
      <ul class="list">
        <li>Status: <span class="status ${statusClass}">${statusLabel}</span></li>
        ${modelHtml}
        ${errorHtml}
      </ul>
      <div class="event-controls">
        <button class="action-btn" data-action="lmstudio-start" ${isConnected ? "disabled" : ""}>Start Model</button>
        <button class="action-btn" data-action="lmstudio-stop" ${!isConnected ? "disabled" : ""}>Stop Model</button>
      </div>
      <p class="muted" id="lmstudio-feedback" style="font-size:0.8em;min-height:1.2em"></p>
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

      ${renderLmStudioCard(system)}
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
    <article class="card stack">
      <h3>Agent Text Chat</h3>
      <p class="muted">Use this channel to interact with your agent through text while in Desktop Mode.</p>
      <p class="muted">Agent responses are processed through a command filter and tool runtime before being returned.</p>

      <div class="chat-panel" id="chat-panel">
        <ul class="list chat-list">
          ${state.chatMessages.length ? state.chatMessages.map(chatMessageItem).join("") : "<li>No messages yet.</li>"}
        </ul>
      </div>

      <form id="chat-form" class="settings-form">
        <label class="settings-field">
          <span>Message</span>
          <textarea id="chat-input" name="chatInput" rows="3" placeholder="Type a message to your agent..."></textarea>
        </label>
        <div class="event-controls">
          <button type="submit" class="action-btn">Send Message</button>
        </div>
      </form>
    </article>
  `;

  bindChatPanelState();
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

  const capHtml = app.capabilities.map((cap) => `<li>${cap}</li>`).join("");
  const launchButton = ["calendar-app", "news-app", "work-app", "project-app", "music-app"].includes(app.id)
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
  [overviewView, settingsView, chatbotView, eventBusView, agentCoreView, integrationHubView, appView].forEach((view) => {
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
    return;
  }

  if (tab === "agent-core") {
    setVisibleView("view-agent-core");
    return;
  }

  if (tab === "settings") {
    renderSettings();
    setVisibleView("view-settings");
    return;
  }

  if (tab === "chatbot") {
    renderChatbot();
    setVisibleView("view-chatbot");
    return;
  }

  if (tab === "event-bus") {
    renderEventBus();
    setVisibleView("view-event-bus");
    return;
  }

  if (tab === "integration-hub") {
    setVisibleView("view-integration-hub");
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
  document.addEventListener("click", (event) => {
    const lmStartButton = event.target.closest("[data-action='lmstudio-start']");
    if (lmStartButton && !lmStartButton.disabled) {
      lmStartButton.disabled = true;
      lmStartButton.textContent = "Loading...";
      const feedback = document.getElementById("lmstudio-feedback");
      if (feedback) feedback.textContent = "Starting model — this may take a moment...";
      lmStudioStart()
        .then(async (result) => {
          await refreshSystemStatus();
          const fb = document.getElementById("lmstudio-feedback");
          if (fb) fb.textContent = result.ok ? "Model loaded." : (result.message || "Failed to start.");
        })
        .catch(async () => {
          await refreshSystemStatus();
        });
      return;
    }

    const lmStopButton = event.target.closest("[data-action='lmstudio-stop']");
    if (lmStopButton && !lmStopButton.disabled) {
      lmStopButton.disabled = true;
      lmStopButton.textContent = "Stopping...";
      const feedback = document.getElementById("lmstudio-feedback");
      if (feedback) feedback.textContent = "Unloading model...";
      lmStudioStop()
        .then(async (result) => {
          await refreshSystemStatus();
          const fb = document.getElementById("lmstudio-feedback");
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

      if (appId === "calendar-app") {
        openCalendarAppWindow().catch(() => {
          // Ignore launch failures for now.
        });
        return;
      }

      if (appId === "news-app") {
        openNewsAppWindow().catch(() => {
          // Ignore launch failures for now.
        });
        return;
      }

      if (appId === "work-app") {
        openWorkAppWindow().catch(() => {
          // Ignore launch failures for now.
        });
        return;
      }

      if (appId === "project-app") {
        openProjectAppWindow().catch(() => {
          // Ignore launch failures for now.
        });
        return;
      }

      if (appId === "music-app") {
        openMusicAppWindow().catch(() => {
          // Ignore launch failures for now.
        });
        return;
      }

      activateTab(`app:${appId}`);
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

    if (target.dataset.tab === "app:news-app") {
      openNewsAppWindow().catch(() => {
        // Ignore launch failures for now.
      });
      return;
    }

    if (target.dataset.tab === "app:work-app") {
      openWorkAppWindow().catch(() => {
        // Ignore launch failures for now.
      });
      return;
    }

    if (target.dataset.tab === "app:project-app") {
      openProjectAppWindow().catch(() => {
        // Ignore launch failures for now.
      });
      return;
    }

    if (target.dataset.tab === "app:music-app") {
      openMusicAppWindow().catch(() => {
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

        if (payload.event.type === "open-app" && payload.event.meta?.tab) {
          const targetTab = String(payload.event.meta.tab);
          if (targetTab === "app:calendar-app") {
            openCalendarAppWindow().catch(() => {
              // Ignore launch failures for now.
            });
          } else if (targetTab === "app:news-app") {
            openNewsAppWindow().catch(() => {
              // Ignore launch failures for now.
            });
          } else if (targetTab === "app:work-app") {
            openWorkAppWindow().catch(() => {
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
          } else {
            activateTab(targetTab);
          }
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

      if (state.activeTab.startsWith("app:") && state.activeTab !== "app:news-app") {
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
  await loadApps();
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