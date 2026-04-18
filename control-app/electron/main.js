import { app, BrowserWindow, dialog, ipcMain } from "electron";
import path from "path";
import { fileURLToPath } from "url";
import { startServer } from "../server/index.js";
import { serverConfig } from "../server/config.js";

app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let backendServer = null;
let mainWindow = null;
let newsWindow = null;
let workAppWindow = null;
let projectAppWindow = null;
let musicAppWindow = null;

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

  newsWindow.on("closed", () => {
    newsWindow = null;
  });
}

function openWorkAppWindow() {
  if (workAppWindow && !workAppWindow.isDestroyed()) {
    workAppWindow.focus();
    return;
  }

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

  workAppWindow.on("closed", () => {
    workAppWindow = null;
  });
}

function openProjectAppWindow() {
  if (projectAppWindow && !projectAppWindow.isDestroyed()) {
    projectAppWindow.focus();
    return;
  }

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

  projectAppWindow.on("closed", () => {
    projectAppWindow = null;
  });
}

function openMusicAppWindow() {
  if (musicAppWindow && !musicAppWindow.isDestroyed()) {
    musicAppWindow.focus();
    return;
  }

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

  musicAppWindow.on("closed", () => {
    musicAppWindow = null;
  });
}

async function ensureBackendServer() {
  try {
    backendServer = await startServer();
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
    createMainWindow();
    ipcMain.handle("news-app:open", () => {
      openNewsAppWindow();
      return { ok: true };
    });

    ipcMain.handle("work-app:open", () => {
      openWorkAppWindow();
      return { ok: true };
    });

    ipcMain.handle("project-app:open", () => {
      openProjectAppWindow();
      return { ok: true };
    });

    ipcMain.handle("music-app:open", () => {
      openMusicAppWindow();
      return { ok: true };
    });

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
  ipcMain.removeHandler("news-app:open");
  ipcMain.removeHandler("work-app:open");
  ipcMain.removeHandler("project-app:open");
  ipcMain.removeHandler("music-app:open");
  ipcMain.removeHandler("dialog:choose-directory");

  if (backendServer) {
    backendServer.close();
  }
});
