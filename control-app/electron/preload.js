import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("controlCenterDesktop", {
  runtime: "electron",
  openNewsAppWindow: () => ipcRenderer.invoke("news-app:open"),
  openWorkAppWindow: () => ipcRenderer.invoke("work-app:open"),
  openProjectAppWindow: () => ipcRenderer.invoke("project-app:open"),
  openMusicAppWindow: () => ipcRenderer.invoke("music-app:open"),
  chooseDirectory: (defaultPath) => {
    const normalizedPath = typeof defaultPath === "string" ? defaultPath.trim() : "";
    return ipcRenderer.invoke("dialog:choose-directory", {
      defaultPath: normalizedPath || undefined
    });
  }
});
