// CommonJS on purpose: Electron runs preload scripts in a sandbox that can't
// load ES modules. (The old preload.js used `import`, so it never loaded and
// window.controlCenterDesktop was always missing.)
const { contextBridge, ipcRenderer } = require("electron");

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

const desktopBridge = {
  runtime: "electron",
  closeAllAppWindows: () => ipcRenderer.invoke("apps:close-all"),
  chooseDirectory: (defaultPath) => {
    const normalizedPath = typeof defaultPath === "string" ? defaultPath.trim() : "";
    return ipcRenderer.invoke("dialog:choose-directory", {
      defaultPath: normalizedPath || undefined
    });
  },
  chooseFile: (defaultPath) => {
    const normalizedPath = typeof defaultPath === "string" ? defaultPath.trim() : "";
    return ipcRenderer.invoke("dialog:choose-file", {
      defaultPath: normalizedPath || undefined
    });
  }
};

Object.entries(WINDOW_APP_BRIDGE_NAMES).forEach(([appId, bridgeName]) => {
  desktopBridge[`open${bridgeName}Window`] = () => ipcRenderer.invoke(`${appId}:open`);
  desktopBridge[`close${bridgeName}Window`] = () => ipcRenderer.invoke(`${appId}:close`);
});

contextBridge.exposeInMainWorld("controlCenterDesktop", desktopBridge);
