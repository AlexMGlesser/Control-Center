import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("controlCenterDesktop", {
  runtime: "electron",
  openCalendarAppWindow: () => ipcRenderer.invoke("calendar-app:open"),
  closeCalendarAppWindow: () => ipcRenderer.invoke("calendar-app:close"),
  openNewsAppWindow: () => ipcRenderer.invoke("news-app:open"),
  closeNewsAppWindow: () => ipcRenderer.invoke("news-app:close"),
  openWorkAppWindow: () => ipcRenderer.invoke("work-app:open"),
  closeWorkAppWindow: () => ipcRenderer.invoke("work-app:close"),
  openProjectAppWindow: () => ipcRenderer.invoke("project-app:open"),
  closeProjectAppWindow: () => ipcRenderer.invoke("project-app:close"),
  openMusicAppWindow: () => ipcRenderer.invoke("music-app:open"),
  closeMusicAppWindow: () => ipcRenderer.invoke("music-app:close"),
  openDrawingAppWindow: () => ipcRenderer.invoke("drawing-app:open"),
  closeDrawingAppWindow: () => ipcRenderer.invoke("drawing-app:close"),
  closeAllAppWindows: () => ipcRenderer.invoke("apps:close-all"),
  chooseDirectory: (defaultPath) => {
    const normalizedPath = typeof defaultPath === "string" ? defaultPath.trim() : "";
    return ipcRenderer.invoke("dialog:choose-directory", {
      defaultPath: normalizedPath || undefined
    });
  }
});
