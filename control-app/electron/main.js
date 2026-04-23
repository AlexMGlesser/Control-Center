import { app, BrowserWindow, dialog, ipcMain } from "electron";
import path from "path";
import { fileURLToPath } from "url";
import { startServer } from "../server/index.js";
import { serverConfig } from "../server/config.js";
import { onShutdownRequested } from "../server/routes/api.js";
import { registerWindowControlHandler } from "../server/services/windowControlBridge.js";

app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let backendServer = null;
let mainWindow = null;
let calendarAppWindow = null;
let newsWindow = null;
let workAppWindow = null;
let projectAppWindow = null;
let musicAppWindow = null;
let drawingAppWindow = null;
let calendarAppWindowPending = false;
let newsAppWindowPending = false;
let workAppWindowPending = false;
let projectAppWindowPending = false;
let musicAppWindowPending = false;
let drawingAppWindowPending = false;

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

function openNewsAppWindow() {
  if (newsWindow && !newsWindow.isDestroyed()) {
    newsWindow.focus();
    return;
  }

  if (newsAppWindowPending) {
    return;
  }

  newsAppWindowPending = true;
  newsWindow = new BrowserWindow({
    width: 1560,
    height: 980,
    minWidth: 1200,
    minHeight: 760,
    backgroundColor: "#070f13",
    title: "News App",
    parent: mainWindow || undefined,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  newsWindow.loadURL(`http://localhost:${serverConfig.port}/news-app/`);

  newsWindow.once("ready-to-show", () => {
    newsAppWindowPending = false;
  });

  newsWindow.on("closed", () => {
    newsWindow = null;
    newsAppWindowPending = false;
  });
}

function openCalendarAppWindow() {
  if (calendarAppWindow && !calendarAppWindow.isDestroyed()) {
    calendarAppWindow.focus();
    return;
  }

  if (calendarAppWindowPending) {
    return;
  }

  calendarAppWindowPending = true;
  calendarAppWindow = new BrowserWindow({
    width: 1560,
    height: 980,
    minWidth: 1200,
    minHeight: 760,
    backgroundColor: "#0d1417",
    title: "Calendar App",
    parent: mainWindow || undefined,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  calendarAppWindow.loadURL(`http://localhost:${serverConfig.port}/calendar-app/`);

  calendarAppWindow.once("ready-to-show", () => {
    calendarAppWindowPending = false;
  });

  calendarAppWindow.on("closed", () => {
    calendarAppWindow = null;
    calendarAppWindowPending = false;
  });
}

function openWorkAppWindow() {
  if (workAppWindow && !workAppWindow.isDestroyed()) {
    workAppWindow.focus();
    return;
  }

  if (workAppWindowPending) {
    return;
  }

  workAppWindowPending = true;
  workAppWindow = new BrowserWindow({
    width: 1560,
    height: 980,
    minWidth: 1200,
    minHeight: 760,
    backgroundColor: "#070f13",
    title: "Work App",
    parent: mainWindow || undefined,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  workAppWindow.loadURL(`http://localhost:${serverConfig.port}/work-app/`);

  workAppWindow.once("ready-to-show", () => {
    workAppWindowPending = false;
  });

  workAppWindow.on("closed", () => {
    workAppWindow = null;
    workAppWindowPending = false;
  });
}

function openProjectAppWindow() {
  if (projectAppWindow && !projectAppWindow.isDestroyed()) {
    projectAppWindow.focus();
    return;
  }

  if (projectAppWindowPending) {
    return;
  }

  projectAppWindowPending = true;
  projectAppWindow = new BrowserWindow({
    width: 1560,
    height: 980,
    minWidth: 1200,
    minHeight: 760,
    backgroundColor: "#070f13",
    title: "Personal Projects",
    parent: mainWindow || undefined,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  projectAppWindow.loadURL(`http://localhost:${serverConfig.port}/project-app/`);

  projectAppWindow.once("ready-to-show", () => {
    projectAppWindowPending = false;
  });

  projectAppWindow.on("closed", () => {
    projectAppWindow = null;
    projectAppWindowPending = false;
  });
}

function openMusicAppWindow() {
  if (musicAppWindow && !musicAppWindow.isDestroyed()) {
    musicAppWindow.focus();
    return;
  }

  if (musicAppWindowPending) {
    return;
  }

  musicAppWindowPending = true;
  musicAppWindow = new BrowserWindow({
    width: 1560,
    height: 980,
    minWidth: 1200,
    minHeight: 760,
    backgroundColor: "#070f13",
    title: "Music App",
    parent: mainWindow || undefined,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  musicAppWindow.loadURL(`http://localhost:${serverConfig.port}/music-app/`);

  musicAppWindow.once("ready-to-show", () => {
    musicAppWindowPending = false;
  });

  musicAppWindow.on("closed", () => {
    musicAppWindow = null;
    musicAppWindowPending = false;
  });
}

function openDrawingAppWindow() {
  if (drawingAppWindow && !drawingAppWindow.isDestroyed()) {
    drawingAppWindow.focus();
    return;
  }

  if (drawingAppWindowPending) {
    return;
  }

  drawingAppWindowPending = true;
  drawingAppWindow = new BrowserWindow({
    width: 1560,
    height: 980,
    minWidth: 1200,
    minHeight: 760,
    backgroundColor: "#070f13",
    title: "Drawing App",
    parent: mainWindow || undefined,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  drawingAppWindow.loadURL(`http://localhost:${serverConfig.port}/drawing-app/`);

  drawingAppWindow.once("ready-to-show", () => {
    drawingAppWindowPending = false;
  });

  drawingAppWindow.on("closed", () => {
    drawingAppWindow = null;
    drawingAppWindowPending = false;
  });
}

function closeCalendarAppWindow() {
  if (!calendarAppWindow || calendarAppWindow.isDestroyed()) {
    return false;
  }
  calendarAppWindow.close();
  return true;
}

function closeNewsAppWindow() {
  console.log("[Main] closeNewsAppWindow called, newsWindow:", newsWindow ? (newsWindow.isDestroyed() ? "destroyed" : "open") : "null");
  if (!newsWindow || newsWindow.isDestroyed()) {
    return false;
  }
  newsWindow.close();
  return true;
}

function closeWorkAppWindow() {
  if (!workAppWindow || workAppWindow.isDestroyed()) {
    return false;
  }
  workAppWindow.close();
  return true;
}

function closeProjectAppWindow() {
  if (!projectAppWindow || projectAppWindow.isDestroyed()) {
    return false;
  }
  projectAppWindow.close();
  return true;
}

function closeMusicAppWindow() {
  if (!musicAppWindow || musicAppWindow.isDestroyed()) {
    return false;
  }
  musicAppWindow.close();
  return true;
}

function closeDrawingAppWindow() {
  if (!drawingAppWindow || drawingAppWindow.isDestroyed()) {
    return false;
  }
  drawingAppWindow.close();
  return true;
}

function closeAllAppWindows() {
  const closed = [
    closeCalendarAppWindow(),
    closeNewsAppWindow(),
    closeWorkAppWindow(),
    closeProjectAppWindow(),
    closeMusicAppWindow(),
    closeDrawingAppWindow()
  ].filter(Boolean).length;

  return closed;
}

function closeAppWindowByTarget(target) {
  console.log("[Main] closeAppWindowByTarget called, target:", target);
  if (target === "all-apps" || target === "all" || target === "apps") {
    return {
      ok: true,
      closeAll: true,
      closedCount: closeAllAppWindows()
    };
  }

  let closed = false;
  if (target === "calendar-app") {
    closed = closeCalendarAppWindow();
  } else if (target === "news-app") {
    closed = closeNewsAppWindow();
  } else if (target === "work-app") {
    closed = closeWorkAppWindow();
  } else if (target === "project-app") {
    closed = closeProjectAppWindow();
  } else if (target === "music-app") {
    closed = closeMusicAppWindow();
  } else if (target === "drawing-app") {
    closed = closeDrawingAppWindow();
  } else {
    return {
      ok: false,
      code: "UNKNOWN_WINDOW_TARGET",
      message: `Unknown window target '${target}'.`
    };
  }

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

    backendServer = null;
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

app.whenReady()
  .then(async () => {
    await ensureBackendServer();
    registerWindowControlHandler({ closeAppWindow: closeAppWindowByTarget });
    createMainWindow();
    ipcMain.handle("calendar-app:open", () => {
      openCalendarAppWindow();
      return { ok: true };
    });

    ipcMain.handle("calendar-app:close", () => ({ ok: true, closed: closeCalendarAppWindow() }));

    ipcMain.handle("news-app:open", () => {
      openNewsAppWindow();
      return { ok: true };
    });

    ipcMain.handle("news-app:close", () => ({ ok: true, closed: closeNewsAppWindow() }));

    ipcMain.handle("work-app:open", () => {
      openWorkAppWindow();
      return { ok: true };
    });

    ipcMain.handle("work-app:close", () => ({ ok: true, closed: closeWorkAppWindow() }));

    ipcMain.handle("project-app:open", () => {
      openProjectAppWindow();
      return { ok: true };
    });

    ipcMain.handle("project-app:close", () => ({ ok: true, closed: closeProjectAppWindow() }));

    ipcMain.handle("music-app:open", () => {
      openMusicAppWindow();
      return { ok: true };
    });

    ipcMain.handle("music-app:close", () => ({ ok: true, closed: closeMusicAppWindow() }));

    ipcMain.handle("drawing-app:open", () => {
      openDrawingAppWindow();
      return { ok: true };
    });

    ipcMain.handle("drawing-app:close", () => ({ ok: true, closed: closeDrawingAppWindow() }));

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

app.on("before-quit", () => {
  registerWindowControlHandler(null);
  ipcMain.removeHandler("calendar-app:open");
  ipcMain.removeHandler("calendar-app:close");
  ipcMain.removeHandler("news-app:open");
  ipcMain.removeHandler("news-app:close");
  ipcMain.removeHandler("work-app:open");
  ipcMain.removeHandler("work-app:close");
  ipcMain.removeHandler("project-app:open");
  ipcMain.removeHandler("project-app:close");
  ipcMain.removeHandler("music-app:open");
  ipcMain.removeHandler("music-app:close");
  ipcMain.removeHandler("drawing-app:open");
  ipcMain.removeHandler("drawing-app:close");
  ipcMain.removeHandler("apps:close-all");
  ipcMain.removeHandler("dialog:choose-directory");

  if (backendServer) {
    backendServer.close();
  }
});
