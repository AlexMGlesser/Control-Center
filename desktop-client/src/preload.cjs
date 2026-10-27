// CommonJS on purpose: sandboxed preloads can't load ES modules.
// The page gets these calls and nothing else; the device token never reaches it.
const { contextBridge, ipcRenderer } = require("electron");

/** Unwraps main's { ok, value } / { ok: false, message }. */
async function call(channel, ...args) {
  const result = await ipcRenderer.invoke(channel, ...args);
  if (!result.ok) {
    const error = new Error(result.message || "Something went wrong.");
    error.code = result.code;
    throw error;
  }
  return result.value;
}

function subscribe(channel) {
  return (callback) => {
    const listener = (event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  };
}

contextBridge.exposeInMainWorld("cc", {
  session: {
    get: () => call("session:get"),
    pair: (address, code, deviceName) => call("session:pair", { address, code, deviceName }),
    signOut: () => call("session:sign-out"),
    forget: () => call("session:forget"),
    onChange: subscribe("session")
  },
  connection: {
    get: () => call("connection:get"),
    retry: () => call("connection:retry"),
    onState: subscribe("connection-state")
  },
  onServerEvent: subscribe("server-event"),
  onNavigate: subscribe("navigate"),
  settings: {
    get: () => call("settings:get"),
    update: (patch) => call("settings:update", patch)
  },
  lock: {
    unlock: (pin) => call("lock:unlock", pin === undefined ? {} : { pin }),
    setPin: (pin) => call("lock:set-pin", pin)
  },
  files: {
    download: (file) => call("files:download", file),
    onProgress: subscribe("download-progress")
  },
  openExternal: (url) => call("shell:open-external", url),
  openSsh: (server) => call("ssh:open", server),
  stopAlarm: (alarmId) => call("alarm:stop", alarmId),
  info: () => call("app:info")
});
