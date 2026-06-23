import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const controlAppRoot = path.join(__dirname, "..");
const workspaceRoot = path.join(controlAppRoot, "..");

export function isPackagedElectronRuntime() {
  return Boolean(process.versions?.electron) && !process.defaultApp;
}

export function getWorkspaceRoot() {
  return workspaceRoot;
}

export function getResourceRoot() {
  if (isPackagedElectronRuntime()) {
    return process.resourcesPath;
  }

  return workspaceRoot;
}

export function getRuntimeDataRoot() {
  if (!isPackagedElectronRuntime()) {
    return workspaceRoot;
  }

  return path.join(getPlatformAppDataRoot(), "Control Center");
}

export function getBundledAppDirectory(appId) {
  if (isPackagedElectronRuntime()) {
    return path.join(getResourceRoot(), "apps", appId);
  }

  return path.join(workspaceRoot, appId);
}

export function getBundledDocumentPath(...segments) {
  return path.join(getResourceRoot(), ...segments);
}

export function getRuntimeLogsDirectory() {
  return path.join(getRuntimeDataRoot(), "logs");
}

export function getAgentRuntimeDirectory() {
  if (isPackagedElectronRuntime()) {
    return path.join(getRuntimeDataRoot(), "agent");
  }

  return path.join(workspaceRoot, "control-app", "agent");
}

export function getVoiceDirectory() {
  if (isPackagedElectronRuntime()) {
    return path.join(getResourceRoot(), "voice");
  }

  return path.join(controlAppRoot, "voice");
}

function getPlatformAppDataRoot() {
  if (process.platform === "win32") {
    return process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  }

  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support");
  }

  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
}