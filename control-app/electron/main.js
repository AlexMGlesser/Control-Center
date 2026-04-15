import { app, BrowserWindow } from "electron";
import path from "path";
import { fileURLToPath } from "url";
import { startServer } from "../server/index.js";
import { serverConfig } from "../server/config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let backendServer = null;

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
}

app.whenReady().then(async () => {
  backendServer = await startServer();
  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  if (backendServer) {
    backendServer.close();
  }
});
