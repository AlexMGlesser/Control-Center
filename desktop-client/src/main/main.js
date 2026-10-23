import { app, BrowserWindow, ipcMain, Menu, nativeImage, net, Notification, protocol, shell, Tray } from "electron";
import { hostname } from "os";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { api, ApiError, normalizeBaseUrl, pair, proxyApi, setUnauthorizedHandler } from "./api.js";
import { ConnectionManager, OutageNotifier } from "./connection.js";
import { clearSchedules, closeAlarm, refreshReminders, ringAlarm, startSchedules, stopAlarm, syncAlarms } from "./schedules.js";
import {
  checkPin,
  clearSession,
  currentSession,
  getSettings,
  loadSession,
  publicSettings,
  saveSession,
  setPin,
  tokenEncrypted,
  updateSettings
} from "./store.js";
import { APP_ID, downloadFile, ICON, installShortcuts, openSsh, removeShortcuts, setStartAtLogin, windowsHello } from "./system.js";

// Control Center Remote: the phone app's features on a laptop or another
// desktop. Stays running in the tray so the connection, alarms, reminders
// and notifications keep working with the window closed.

const RENDERER_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "renderer");
const PRELOAD = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "preload.cjs");

// Install-script hooks: shortcuts (Windows), start at login, or removing
// both; then exit without opening a window.
if (["--install-shortcuts", "--remove-shortcuts", "--start-at-login"].some((flag) => process.argv.includes(flag))) {
  app.whenReady().then(() => {
    if (process.argv.includes("--install-shortcuts")) installShortcuts();
    if (process.argv.includes("--start-at-login")) {
      updateSettings({ startAtLogin: true });
      setStartAtLogin(true);
    }
    if (process.argv.includes("--remove-shortcuts")) removeShortcuts();
    app.quit();
  });
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  run();
}

function run() {
  if (process.platform === "win32") app.setAppUserModelId(APP_ID);

  // The page and its API calls share one private origin, so media players,
  // images and fetch() all go through proxyApi() and never see the token.
  protocol.registerSchemesAsPrivileged([
    { scheme: "cc", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }
  ]);

  let mainWindow = null;
  let tray = null;
  let quitting = false;
  let removed = false;
  const connection = new ConnectionManager();
  const outages = new OutageNotifier();

  const send = (channel, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
  };

  function showWindow(navigate) {
    if (!mainWindow || mainWindow.isDestroyed()) createWindow();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    if (navigate) send("navigate", navigate);
  }

  function notify(title, body, navigate) {
    if (!Notification.isSupported()) return;
    const notification = new Notification({ title, body, icon: ICON });
    notification.on("click", () => showWindow(navigate));
    notification.show();
  }

  function createWindow({ hidden = false } = {}) {
    mainWindow = new BrowserWindow({
      width: 1180,
      height: 780,
      minWidth: 720,
      minHeight: 520,
      show: !hidden,
      title: "Control Center Remote",
      backgroundColor: "#07070d",
      icon: ICON,
      autoHideMenuBar: true,
      webPreferences: {
        preload: PRELOAD,
        contextIsolation: true,
        sandbox: true,
        // Music keeps playing with the window hidden in the tray.
        backgroundThrottling: false
      }
    });
    mainWindow.loadURL("cc://app/index.html");
    // Links to the web (news stories) open in the browser, never in the app.
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
      return { action: "deny" };
    });
    mainWindow.webContents.on("will-navigate", (event, url) => {
      if (!url.startsWith("cc://app/")) {
        event.preventDefault();
        if (/^https?:\/\//i.test(url)) shell.openExternal(url);
      }
    });
    mainWindow.on("close", (event) => {
      if (!quitting && getSettings().keepRunningInTray) {
        event.preventDefault();
        mainWindow.hide();
      }
    });
    mainWindow.on("closed", () => {
      mainWindow = null;
    });
  }

  function createTray() {
    const image = nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 });
    tray = new Tray(image);
    tray.setToolTip("Control Center Remote");
    const refreshMenu = () => {
      const state = connection.state;
      const status = {
        connected: "● Connected",
        connecting: "Connecting…",
        reconnecting: "Reconnecting…",
        disconnected: state.cause || "Disconnected",
        unauthorized: "Removed on the PC",
        idle: currentSession() ? "Not connected" : "Not paired"
      }[state.status];
      tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: status, enabled: false },
          { type: "separator" },
          { label: "Open Control Center Remote", click: () => showWindow() },
          { label: "Jarvis", click: () => showWindow({ tab: "jarvis" }) },
          { type: "separator" },
          { label: "Quit", click: () => quit() }
        ])
      );
    };
    connection.on("state", refreshMenu);
    refreshMenu();
    tray.on("click", () => showWindow());
  }

  function quit() {
    quitting = true;
    app.quit();
  }

  function onRemoved() {
    if (removed) return;
    removed = true;
    connection.stop();
    send("session", sessionInfo());
  }

  function sessionInfo() {
    const session = currentSession();
    if (removed) return { state: "removed" };
    if (!session) return { state: "not-paired" };
    const { token, ...visible } = session;
    return { state: "paired", session: visible, tokenEncrypted: tokenEncrypted() };
  }

  function startConnection() {
    removed = false;
    connection.start();
    syncAlarms();
    refreshReminders();
  }

  setUnauthorizedHandler(onRemoved);
  connection.on("unauthorized", onRemoved);

  connection.on("state", (state) => {
    send("connection-state", state);
    if (state.status === "connected") {
      syncAlarms();
      refreshReminders();
    }
    const action = outages.onState(state);
    if (!action || !getSettings().connectionAlerts) return;
    const server = currentSession()?.serverName || "your PC";
    if (action.lost) notify(`Lost connection to ${server}`, action.lost, { tab: "settings" });
    else notify(`Reconnected to ${server}`, "", null);
  });

  connection.on("event", async (event) => {
    send("server-event", event);
    const myId = currentSession()?.deviceId;
    const meta = event.meta || {};
    switch (event.type) {
      case "data-changed":
        if (event.appId === "alarms") syncAlarms();
        if (event.appId === "calendar-app") refreshReminders();
        break;
      // Backup path: the PC fired this computer's alarm.
      case "alarm-fired":
        if (meta.targetDeviceId === myId) ringAlarm(meta.alarmId, meta.label || "Alarm", Date.parse(meta.firedFor) || Date.now());
        break;
      case "alarm-stopped":
        if (meta.targetDeviceId === myId) closeAlarm(meta.alarmId);
        break;
      case "device-revoked":
        if (meta.deviceId === myId) onRemoved();
        break;
      case "chat": {
        // A reply to something asked from here, while the window isn't in front.
        if (meta.origin?.device?.id !== myId || !getSettings().jarvisReplies) break;
        if (mainWindow?.isVisible() && mainWindow.isFocused()) break;
        const messages = await api("/api/chat/messages?limit=10").catch(() => null);
        const reply = messages?.messages?.filter((message) => message.role === "agent").pop();
        if (reply) notify("Jarvis", reply.text.slice(0, 300), { tab: "jarvis" });
        break;
      }
      default:
        break;
    }
  });

  /* ---------------- IPC for the page ---------------- */

  const handle = (channel, fn) =>
    ipcMain.handle(channel, async (event, ...args) => {
      try {
        return { ok: true, value: await fn(event, ...args) };
      } catch (error) {
        return { ok: false, message: error.message, code: error instanceof ApiError ? error.code : undefined };
      }
    });

  handle("session:get", () => sessionInfo());
  handle("connection:get", () => connection.state);
  handle("connection:retry", () => connection.reconnectNow());

  handle("session:pair", async (event, { address, code, deviceName }) => {
    const baseUrl = normalizeBaseUrl(address);
    if (!baseUrl) throw new Error("Enter the address shown on the PC, like my-pc.tailnet.ts.net.");
    const name = String(deviceName || "").trim() || hostname();
    const result = await pair(baseUrl, code, name);
    saveSession({
      baseUrl,
      deviceId: result.deviceId,
      deviceName: name,
      serverName: result.serverName || "PC",
      token: result.token,
      pairedAt: Date.now()
    });
    startConnection();
    return sessionInfo();
  });

  handle("session:sign-out", async () => {
    await api("/api/devices/self", { method: "DELETE" }).catch(() => {});
    connection.stop();
    clearSchedules();
    clearSession();
    removed = false;
    return sessionInfo();
  });

  handle("session:forget", () => {
    connection.stop();
    clearSchedules();
    clearSession();
    removed = false;
    return sessionInfo();
  });

  handle("settings:get", () => publicSettings());
  handle("settings:update", (event, patch) => {
    const before = getSettings();
    const after = updateSettings(patch);
    if (before.startAtLogin !== after.startAtLogin) setStartAtLogin(after.startAtLogin);
    return publicSettings();
  });

  handle("lock:unlock", async (event, { pin } = {}) => {
    if (pin !== undefined) return checkPin(pin) ? "Verified" : "WrongPin";
    return windowsHello();
  });
  handle("lock:set-pin", (event, pin) => {
    if (!/^\d{4,12}$/.test(String(pin))) throw new Error("Use 4 to 12 digits.");
    setPin(pin);
    return publicSettings();
  });

  handle("files:download", (event, file) =>
    downloadFile(BrowserWindow.fromWebContents(event.sender), file, (received, total) =>
      event.sender.send("download-progress", { path: file.path || file.url, received, total })
    )
  );
  handle("shell:open-external", (event, url) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });
  handle("ssh:open", (event, server) => openSsh(server));
  handle("alarm:stop", (event, alarmId) => stopAlarm(alarmId));
  handle("app:info", () => ({ platform: process.platform, version: app.getVersion(), hostname: hostname() }));

  /* ---------------- Start ---------------- */

  app.on("second-instance", () => showWindow());
  app.on("before-quit", () => {
    quitting = true;
  });
  app.on("window-all-closed", () => {
    if (!getSettings().keepRunningInTray) quit();
  });

  app.whenReady().then(() => {
    protocol.handle("cc", async (request) => {
      const url = new URL(request.url);
      if (url.host !== "app") return new Response("Not found", { status: 404 });
      if (url.pathname.startsWith("/api/")) return proxyApi(request, url);
      // The page's own files, from src/renderer only.
      const relative = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
      const file = path.normalize(path.join(RENDERER_DIR, relative));
      if (!file.startsWith(RENDERER_DIR + path.sep)) return new Response("Not found", { status: 404 });
      return net.fetch(pathToFileURL(file).toString());
    });

    loadSession();
    createWindow({ hidden: process.argv.includes("--hidden") });
    createTray();
    startSchedules({ openCalendar: () => showWindow({ app: "calendar-app" }) });
    if (currentSession()) startConnection();
  });
}
