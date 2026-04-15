import { contextBridge } from "electron";

contextBridge.exposeInMainWorld("controlCenterDesktop", {
  runtime: "electron"
});
