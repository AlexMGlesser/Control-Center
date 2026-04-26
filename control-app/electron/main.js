import { app, BrowserWindow, dialog, ipcMain } from "electron";
import path from "path";
import { fileURLToPath } from "url";
import { startServer, stopServer } from "../server/index.js";
import { serverConfig } from "../server/config.js";
import { onShutdownRequested } from "../server/routes/api.js";
import { registerWindowControlHandler } from "../server/services/windowControlBridge.js";

app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let backendServer = null;
let mainWindow = null;
let isShuttingDown = false;
let shutdownPromise = null;
const APP_WINDOW_CONFIGS = {
  "calendar-app": { title: "Calendar App", backgroundColor: "#0d1417" },
  "news-app": { title: "News App", backgroundColor: "#070f13" },
  "work-app": { title: "Work App", backgroundColor: "#070f13" },
  "project-app": { title: "Personal Projects", backgroundColor: "#070f13" },
  "music-app": { title: "Music App", backgroundColor: "#070f13" },
  "drawing-app": { title: "Drawing App", backgroundColor: "#070f13" },
  "movie-app": { title: "Movie App", backgroundColor: "#160b0e" },
  "server-manager-app": { title: "Server Manager App", backgroundColor: "#0e1216" }
};

const appWindows = Object.fromEntries(Object.keys(APP_WINDOW_CONFIGS).map((appId) => [appId, null]));
const appWindowPending = Object.fromEntries(Object.keys(APP_WINDOW_CONFIGS).map((appId) => [appId, false]));

function createMainWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1050,
    minHeight: 700,
    backgroundColor: "#081114",
    title: "Control Center",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.loadURL(`http://localhost:${serverConfig.port}`);
  mainWindow = win;

  win.on("closed", () => {
    mainWindow = null;
  });
}

function openAppWindow(appId) {
  const existingWindow = appWindows[appId];
  if (existingWindow && !existingWindow.isDestroyed()) {
    existingWindow.focus();
    return;
  }

  if (appWindowPending[appId]) {
    return;
  }

  const config = APP_WINDOW_CONFIGS[appId];
  if (!config) {
    return;
  }

  appWindowPending[appId] = true;
  const appWindow = new BrowserWindow({
    width: 1560,
    height: 980,
    minWidth: 1200,
    minHeight: 760,
    backgroundColor: config.backgroundColor,
    title: config.title,
    parent: mainWindow || undefined,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  appWindows[appId] = appWindow;
  appWindow.loadURL(`http://localhost:${serverConfig.port}/${appId}/`);

  appWindow.once("ready-to-show", () => {
    appWindowPending[appId] = false;
  });

  appWindow.on("closed", () => {
    appWindows[appId] = null;
    appWindowPending[appId] = false;
  });
}

function closeAppWindow(appId) {
  const appWindow = appWindows[appId];
  if (!appWindow || appWindow.isDestroyed()) {
    return false;
  }

  appWindow.close();
  return true;
}

function closeAllAppWindows() {
  const closed = Object.keys(APP_WINDOW_CONFIGS)
    .map((appId) => closeAppWindow(appId))
    .filter(Boolean).length;

  return closed;
}

function destroyAllWindows() {
  BrowserWindow.getAllWindows().forEach((windowInstance) => {
    if (!windowInstance.isDestroyed()) {
      windowInstance.destroy();
    }
  });
}

function removeIpcHandlers() {
  Object.keys(APP_WINDOW_CONFIGS).forEach((appId) => {
    ipcMain.removeHandler(`${appId}:open`);
    ipcMain.removeHandler(`${appId}:close`);
  });
  ipcMain.removeHandler("apps:close-all");
  ipcMain.removeHandler("dialog:choose-directory");
  ipcMain.removeHandler("dialog:choose-file");
}

async function shutdownRuntime() {
  if (shutdownPromise) {
    return shutdownPromise;
  }

  shutdownPromise = (async () => {
    registerWindowControlHandler(null);
    removeIpcHandlers();
    closeAllAppWindows();
    destroyAllWindows();

    if (backendServer) {
      const serverToStop = backendServer;
      backendServer = null;
      await stopServer(serverToStop);
    }
  })();

  return shutdownPromise;
}

function closeAppWindowByTarget(target) {
  if (target === "all-apps" || target === "all" || target === "apps") {
    return {
      ok: true,
      closeAll: true,
      closedCount: closeAllAppWindows()
    };
  }

  if (!APP_WINDOW_CONFIGS[target]) {
    return {
      ok: false,
      code: "UNKNOWN_WINDOW_TARGET",
      message: `Unknown window target '${target}'.`
    };
  }

  const closed = closeAppWindow(target);

  return {
    ok: true,
    closeAll: false,
    target,
    closed
  };
}

async function ensureBackendServer() {
  try {
    backendServer = await startServer();
    onShutdownRequested(() => app.quit());
    return;
  } catch (error) {
    if (error?.code !== "EADDRINUSE") {
      throw error;
    }

    const existingServerHealthy = await isExistingServerHealthy();
    if (!existingServerHealthy) {
      throw error;
    }

    const shutDown = await shutdownExistingServer();
    if (!shutDown) {
      throw new Error(`Control Center backend port ${serverConfig.port} is already in use by another process.`);
    }

    backendServer = await startServer();
    onShutdownRequested(() => app.quit());
  }
}

async function isExistingServerHealthy() {
  try {
    const response = await fetch(`http://localhost:${serverConfig.port}/api/health`);
    return response.ok;
  } catch {
    return false;
  }
}

async function shutdownExistingServer() {
  try {
    await fetch(`http://localhost:${serverConfig.port}/api/shutdown`, { method: "POST" });
  } catch {
    return false;
  }

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const stillHealthy = await isExistingServerHealthy();
    if (!stillHealthy) {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  return false;
}

app.whenReady()
  .then(async () => {
    await ensureBackendServer();
    registerWindowControlHandler({ closeAppWindow: closeAppWindowByTarget });
    createMainWindow();
    Object.keys(APP_WINDOW_CONFIGS).forEach((appId) => {
      ipcMain.handle(`${appId}:open`, () => {
        openAppWindow(appId);
        return { ok: true };
      });

      ipcMain.handle(`${appId}:close`, () => ({ ok: true, closed: closeAppWindow(appId) }));
    });

    ipcMain.handle("apps:close-all", () => ({ ok: true, closed: closeAllAppWindows() }));

    ipcMain.handle("dialog:choose-directory", async (event, options = {}) => {
      const parentWindow = BrowserWindow.fromWebContents(event.sender) || mainWindow;
      const rawDefaultPath = typeof options.defaultPath === "string" ? options.defaultPath.trim() : "";

      try {
        const result = await dialog.showOpenDialog(parentWindow || undefined, {
          title: "Choose destination folder",
          properties: ["openDirectory", "createDirectory", "promptToCreate"],
          defaultPath: rawDefaultPath || undefined
        });

        if (result.canceled || !result.filePaths?.length) {
          return { ok: true, canceled: true, path: null };
        }

        return { ok: true, canceled: false, path: result.filePaths[0] };
      } catch (error) {
        return {
          ok: false,
          canceled: false,
          code: "DIRECTORY_PICKER_ERROR",
          message: error?.message || "Could not open directory picker.",
          path: null
        };
      }
    });

    ipcMain.handle("dialog:choose-file", async (event, options = {}) => {
      const parentWindow = BrowserWindow.fromWebContents(event.sender) || mainWindow;
      const rawDefaultPath = typeof options.defaultPath === "string" ? options.defaultPath.trim() : "";

      try {
        const result = await dialog.showOpenDialog(parentWindow || undefined, {
          title: "Choose file",
          properties: ["openFile"],
          defaultPath: rawDefaultPath || undefined
        });

        if (result.canceled || !result.filePaths?.length) {
          return { ok: true, canceled: true, path: null };
        }

        return { ok: true, canceled: false, path: result.filePaths[0] };
      } catch (error) {
        return {
          ok: false,
          canceled: false,
          code: "FILE_PICKER_ERROR",
          message: error?.message || "Could not open file picker.",
          path: null
        };
      }
    });

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow();
      }
    });
  })
  .catch((error) => {
    console.error("Failed to initialize Control Center desktop app:", error.message);
    app.quit();
  });

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", (event) => {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;
  event.preventDefault();
  shutdownRuntime()
    .catch((error) => {
      console.error("Failed to fully shut down Control Center runtime:", error?.message || error);
    })
    .finally(() => {
      app.exit(0);
    });
});
