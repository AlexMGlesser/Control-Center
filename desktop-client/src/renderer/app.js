import { icon } from "./icons.js";
import { api, el, esc, toast } from "./lib.js";
import { player } from "./player.js";

// The shell: pairing, the rail (Apps / Jarvis / Settings), the open app, the
// connection banner and the mini player. Views live in views/*.js; each
// exports render(root, ctx) and may return a cleanup function.

const APP_VIEWS = {
  "project-app": "./views/projects.js",
  "calendar-app": "./views/calendar.js",
  "news-app": "./views/news.js",
  "wikipedia-app": "./views/wikipedia.js",
  "file-system-app": "./views/files.js",
  "music-app": "./views/music.js",
  "movie-app": "./views/movies.js",
  "server-manager-app": "./views/servers.js",
  "drawing-app": "./views/drawing.js"
};

const APP_ICONS = {
  "project-app": "folder-git-2",
  "calendar-app": "calendar-days",
  "news-app": "newspaper",
  "music-app": "music",
  "drawing-app": "pen-tool",
  "movie-app": "clapperboard",
  "server-manager-app": "server",
  "wikipedia-app": "book-open-text",
  "file-system-app": "folder-tree"
};

export const appIcon = (id) => APP_ICONS[id] || "app-window";
export const shortName = (name) => String(name || "").replace(/ App$/, "") || name;

const state = {
  session: null,
  connection: { status: "idle" },
  apps: [],
  tab: "apps",
  openApp: null,
  /** Opened by Jarvis while the chat was in front: a chip instead of a jump. */
  openedByJarvis: null
};

const root = document.getElementById("root");
const eventListeners = new Set();
let viewCleanup = null;
let renderToken = 0;

window.cc.onServerEvent((event) => {
  for (const listener of eventListeners) listener(event);
  const myId = state.session?.deviceId;
  const meta = event.meta || {};
  if (event.type === "open-app" && meta.targetDeviceId === myId) {
    const app = state.apps.find((item) => item.id === meta.target);
    if (!app) return;
    if (state.tab === "jarvis") {
      state.openedByJarvis = app;
      document.dispatchEvent(new CustomEvent("opened-by-jarvis"));
    } else openApp(app.id);
  }
  if (event.type === "close-app" && meta.targetDeviceId === myId && state.openApp) closeApp();
});

window.cc.connection.onState((connection) => {
  const wasOnline = state.connection.status === "connected";
  state.connection = connection;
  updateStatus();
  if (connection.status === "connected" && !wasOnline) loadApps();
});

window.cc.session.onChange((info) => applySession(info));

window.cc.onNavigate((target) => {
  if (target?.app) openApp(target.app);
  else if (target?.tab) selectTab(target.tab);
});

/* ---------------- Session ---------------- */

async function applySession(info) {
  if (info.state === "paired") {
    state.session = info.session;
    state.tokenEncrypted = info.tokenEncrypted;
    renderShell();
    await loadApps();
  } else if (info.state === "removed") {
    renderRemoved();
  } else {
    state.session = null;
    player.stop();
    renderConnect();
  }
}

async function loadApps() {
  try {
    const { apps } = await api("/api/apps");
    state.apps = apps;
    if (state.tab === "apps" && !state.openApp) renderView();
  } catch {
    // The banner already says the PC can't be reached.
  }
}

/* ---------------- Connect ---------------- */

async function renderConnect() {
  cleanupView();
  const info = await window.cc.info().catch(() => ({ hostname: "" }));
  root.replaceChildren(
    el(`
    <div class="connect">
      <form class="connect-card chamfer" id="pair-form">
        <h1>Connect to your PC</h1>
        <p class="muted">Control Center Remote works with Control Center on your home PC, over Tailscale.</p>
        <ol>
          <li>On the PC, open Control Center: Settings &gt; Devices &gt; <b>Pair a device</b>.</li>
          <li>Enter the address and the 8-character code it shows.</li>
        </ol>
        <label class="field"><span>PC address</span><input name="address" placeholder="my-pc.tailnet.ts.net" required /></label>
        <label class="field"><span>Pairing code</span><input name="code" class="code-input" maxlength="9" placeholder="ABCD 1234" required /></label>
        <label class="field"><span>Name for this computer</span><input name="name" value="${esc(info.hostname)}" /></label>
        <p class="danger-text small" id="pair-error" hidden></p>
        <button class="btn primary" type="submit">Pair</button>
      </form>
    </div>`)
  );
  const form = document.getElementById("pair-form");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = form.querySelector("button");
    const error = document.getElementById("pair-error");
    button.disabled = true;
    error.hidden = true;
    try {
      const values = Object.fromEntries(new FormData(form));
      const info = await window.cc.session.pair(values.address, values.code.replace(/\s+/g, ""), values.name);
      await applySession(info);
    } catch (failure) {
      error.textContent = failure.message;
      error.hidden = false;
    } finally {
      button.disabled = false;
    }
  });
}

function renderRemoved() {
  cleanupView();
  player.stop();
  root.replaceChildren(
    el(`
    <div class="connect">
      <div class="connect-card chamfer">
        <h1>Removed from Control Center</h1>
        <p class="muted">This computer was removed on the PC, so it can't connect any more. Pair it again to keep using it.</p>
        <button class="btn primary" id="pair-again">Pair again</button>
      </div>
    </div>`)
  );
  document.getElementById("pair-again").addEventListener("click", async () => applySession(await window.cc.session.forget()));
}

/* ---------------- Shell ---------------- */

function renderShell() {
  root.replaceChildren(
    el(`
    <div class="shell">
      <nav class="rail">
        <button class="rail-item" data-tab="apps">${icon("layout-grid")}Apps</button>
        <button class="rail-item" data-tab="jarvis">${icon("message-circle")}Jarvis</button>
        <div class="rail-spacer"></div>
        <button class="rail-item" data-tab="settings">${icon("settings")}Settings</button>
      </nav>
      <section class="main">
        <div id="banner" class="banner" hidden></div>
        <div id="view" style="display:contents"></div>
      </section>
      <footer id="player" class="player" hidden></footer>
    </div>`)
  );
  root.querySelector(".rail").addEventListener("click", (event) => {
    const tab = event.target.closest("[data-tab]")?.dataset.tab;
    if (tab) selectTab(tab);
  });
  player.mount(document.getElementById("player"));
  updateStatus();
  renderView();
}

function selectTab(tab) {
  state.tab = tab;
  if (tab === "apps") state.openApp = null;
  renderView();
}

export function openApp(appId) {
  state.tab = "apps";
  state.openApp = appId;
  state.openedByJarvis = null;
  renderView();
}

export function closeApp() {
  state.openApp = null;
  renderView();
}

function cleanupView() {
  try {
    viewCleanup?.();
  } catch {
    // A view's cleanup failing shouldn't block navigation.
  }
  viewCleanup = null;
  eventListeners.clear();
}

async function renderView() {
  const host = document.getElementById("view");
  if (!host) return;
  cleanupView();
  const token = ++renderToken;
  for (const item of root.querySelectorAll(".rail-item")) item.classList.toggle("active", item.dataset.tab === state.tab);

  const ctx = {
    state,
    onEvent: (listener) => eventListeners.add(listener),
    openApp,
    closeApp,
    selectTab,
    statusPill
  };

  let module;
  if (state.tab === "jarvis") module = await import("./views/jarvis.js");
  else if (state.tab === "settings") module = await import("./views/settings.js");
  else if (state.openApp) module = APP_VIEWS[state.openApp] ? await import(APP_VIEWS[state.openApp]) : { render: renderGenericApp };
  else module = { render: renderHome };
  if (token !== renderToken) return;

  host.replaceChildren();
  viewCleanup = (await module.render(host, ctx)) || null;
}

/* ---------------- Status ---------------- */

function statusPill() {
  const status = state.connection.status;
  if (status === "connected") return `<span class="pill online">ONLINE</span>`;
  if (status === "connecting" || status === "reconnecting") return `<span class="pill waiting">RECONNECTING</span>`;
  return `<span class="pill offline">OFFLINE</span>`;
}

function updateStatus() {
  for (const pill of root.querySelectorAll("[data-status-pill]")) pill.innerHTML = statusPill();
  const banner = document.getElementById("banner");
  if (!banner) return;
  const connection = state.connection;
  if (connection.status === "disconnected" || connection.status === "unauthorized") {
    banner.hidden = false;
    banner.innerHTML = `${icon("wifi-off")}<span>${esc(connection.cause || "Not connected to your PC.")}</span><button class="btn small" id="retry">Retry</button>`;
    banner.querySelector("#retry").addEventListener("click", () => window.cc.connection.retry());
  } else {
    banner.hidden = true;
  }
}

/* ---------------- Home ---------------- */

function renderHome(host) {
  const online = state.connection.status === "connected";
  const view = el(`
    <div style="display:contents">
      <header class="topbar"><h1>${esc(state.session?.serverName || "Control Center")}</h1><span data-status-pill>${statusPill()}</span></header>
      <div class="content">
        <div class="grid" id="tiles"></div>
        ${state.apps.length ? "" : `<p class="note">${online ? "Loading apps…" : "Apps appear once the PC is reachable."}</p>`}
      </div>
    </div>`);
  const tiles = view.querySelector("#tiles");
  for (const app of state.apps) {
    const tile = el(`<button class="tile ${app.status === "online" ? "" : "offline"}" title="${esc(app.description)}">${icon(appIcon(app.id))}<span>${esc(shortName(app.name))}</span></button>`);
    tile.addEventListener("click", () => openApp(app.id));
    tiles.append(tile);
  }
  host.append(view);
}

/** Apps without a view here: the generic card (mobile design 3.6). */
function renderGenericApp(host) {
  const app = state.apps.find((item) => item.id === state.openApp) || { name: state.openApp, description: "" };
  host.append(
    el(`
    <div style="display:contents">
      <header class="topbar"><button class="icon-btn" data-back>${icon("arrow-left")}</button><h1>${esc(shortName(app.name))}</h1></header>
      <div class="content">
        <div class="panel chamfer" style="max-width:520px;text-align:center">
          <div style="font-size:44px;color:var(--cyan)">${icon(appIcon(app.id), "icon")}</div>
          <h2>${esc(app.name)}</h2>
          <p class="muted">${esc(app.description)}</p>
          <p class="muted small">Open this app on the PC to use it.</p>
        </div>
      </div>
    </div>`)
  );
  host.querySelector("[data-back]").addEventListener("click", closeApp);
}

/* ---------------- Start ---------------- */

Promise.all([window.cc.session.get(), window.cc.connection.get()])
  .then(([info, connection]) => {
    state.connection = connection;
    return applySession(info);
  })
  .catch((error) => toast(error.message, { tone: "error" }));
