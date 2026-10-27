import { app, dialog, net, Notification, shell } from "electron";
import { execFile, spawn } from "child_process";
import { createWriteStream, existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { currentSession } from "./store.js";

// Things that touch this computer: the File System lock, SSH in a terminal,
// downloads, start-at-login and shortcuts.

export const APP_ID = "com.alexmglesser.controlcenter.remote";
const APP_ROOT = app.getAppPath();
const ICON = path.join(APP_ROOT, "assets", process.platform === "win32" ? "icon.ico" : "icon.png");

/* ---------------- File System lock ---------------- */

// Windows Hello (fingerprint, face or PIN) through the WinRT consent API.
const HELLO_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' } | Select-Object -First 1
function Await($op, [Type]$type) { $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $task.Wait(-1) | Out-Null; $task.Result }
$verifier = [Windows.Security.Credentials.UI.UserConsentVerifier, Windows.Security.Credentials.UI, ContentType = WindowsRuntime]
$availability = Await ($verifier::CheckAvailabilityAsync()) ([Windows.Security.Credentials.UI.UserConsentVerifierAvailability])
if ($availability -ne 'Available') { 'Unavailable'; exit }
$result = Await ($verifier::RequestVerificationAsync('Unlock File System on Control Center Remote')) ([Windows.Security.Credentials.UI.UserConsentVerificationResult])
$result.ToString()
`;

/** "Verified", "Unavailable" (use the PIN instead) or a failure reason. */
export function windowsHello() {
  if (process.platform !== "win32") return Promise.resolve("Unavailable");
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", HELLO_SCRIPT],
      { windowsHide: true, timeout: 120_000 },
      (error, stdout) => resolve(String(stdout || "").trim().split(/\r?\n/).pop() || (error ? "Unavailable" : "Canceled"))
    );
  });
}

/* ---------------- SSH ---------------- */

const SAFE = /^[A-Za-z0-9._@:-]+$/;

function commandExists(command) {
  return new Promise((resolve) => {
    execFile(process.platform === "win32" ? "where" : "which", [command], { windowsHide: true }, (error) => resolve(!error));
  });
}

/** Opens ssh user@host -p port in this computer's terminal. Keys and passwords are the terminal's business. */
export async function openSsh({ host, username, port }) {
  const target = username ? `${username}@${host}` : host;
  const portText = String(Number(port) || 22);
  // Only plain host/user names reach the command line, and nothing that ssh
  // would read as an option ("-oProxyCommand…").
  if (!host || !SAFE.test(target) || target.startsWith("-") || host.startsWith("-")) {
    throw new Error("That server's host or user name has characters SSH can't use.");
  }
  const args = ["-p", portText, target];

  if (process.platform === "win32") {
    if (await commandExists("wt.exe")) {
      spawn("wt.exe", ["ssh", ...args], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("cmd.exe", ["/c", "start", "", "ssh.exe", ...args], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    }
    return;
  }

  const terminals = [
    ["x-terminal-emulator", ["-e", "ssh", ...args]],
    ["gnome-terminal", ["--", "ssh", ...args]],
    ["konsole", ["-e", "ssh", ...args]],
    ["xfce4-terminal", ["-x", "ssh", ...args]],
    ["kitty", ["ssh", ...args]],
    ["alacritty", ["-e", "ssh", ...args]],
    ["xterm", ["-e", "ssh", ...args]]
  ];
  for (const [command, commandArgs] of terminals) {
    if (await commandExists(command)) {
      spawn(command, commandArgs, { detached: true, stdio: "ignore" }).unref();
      return;
    }
  }
  throw new Error("No terminal app found. Install one (for example gnome-terminal or konsole).");
}

/* ---------------- Downloads ---------------- */

/** Saves a file from the PC wherever the user picks. onProgress(received, total). */
export async function downloadFile(parentWindow, { path: remotePath, name, url: apiPath }, onProgress) {
  const session = currentSession();
  if (!session) throw new Error("This computer isn't paired.");
  const choice = await dialog.showSaveDialog(parentWindow, {
    title: "Save from your PC",
    defaultPath: path.join(app.getPath("downloads"), name)
  });
  if (choice.canceled || !choice.filePath) return { canceled: true };

  const source = apiPath || `/api/files/content?path=${encodeURIComponent(remotePath)}&download=1`;
  const res = await net.fetch(`${session.baseUrl}${source}`, { headers: { Authorization: `Bearer ${session.token}` } });
  if (!res.ok || !res.body) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message || `Download failed (${res.status}).`);
  }
  const total = Number(res.headers.get("content-length")) || 0;
  let received = 0;
  const counted = Readable.fromWeb(res.body).on("data", (chunk) => {
    received += chunk.length;
    onProgress?.(received, total);
  });
  try {
    await pipeline(counted, createWriteStream(choice.filePath));
  } catch (error) {
    rmSync(choice.filePath, { force: true });
    throw error;
  }
  if (Notification.isSupported()) {
    const done = new Notification({ title: `Downloaded ${path.basename(choice.filePath)}`, body: "Click to show it in its folder." });
    done.on("click", () => shell.showItemInFolder(choice.filePath));
    done.show();
  }
  return { canceled: false, filePath: choice.filePath };
}

/* ---------------- Start at login ---------------- */

const LINUX_AUTOSTART = path.join(os.homedir(), ".config", "autostart", "control-center-remote.desktop");

function linuxDesktopEntry(extraArgs = "") {
  const start = path.join(APP_ROOT, "start.sh");
  return `[Desktop Entry]
Type=Application
Name=Control Center Remote
Comment=Your home PC's Control Center, on this computer
Exec="${start}"${extraArgs}
Icon=${path.join(APP_ROOT, "assets", "icon.png")}
Terminal=false
Categories=Utility;Network;
StartupWMClass=Control Center Remote
`;
}

export function setStartAtLogin(enabled) {
  if (process.platform === "win32") {
    app.setLoginItemSettings({ openAtLogin: enabled, path: process.execPath, args: [APP_ROOT, "--hidden"] });
    return;
  }
  if (enabled) {
    mkdirSync(path.dirname(LINUX_AUTOSTART), { recursive: true });
    writeFileSync(LINUX_AUTOSTART, linuxDesktopEntry(" --hidden"));
  } else if (existsSync(LINUX_AUTOSTART)) {
    rmSync(LINUX_AUTOSTART);
  }
}

/* ---------------- Shortcuts (run by install.ps1) ---------------- */

/** Start Menu and desktop shortcuts. They carry the app ID, which Windows needs to show notifications. */
export function installShortcuts() {
  if (process.platform !== "win32") return;
  const options = {
    target: process.execPath,
    args: `"${APP_ROOT}"`,
    cwd: APP_ROOT,
    icon: ICON,
    iconIndex: 0,
    appUserModelId: APP_ID,
    description: "Your home PC's Control Center, on this computer"
  };
  const startMenu = path.join(app.getPath("appData"), "Microsoft", "Windows", "Start Menu", "Programs", "Control Center Remote.lnk");
  shell.writeShortcutLink(startMenu, "create", options);
  shell.writeShortcutLink(path.join(app.getPath("desktop"), "Control Center Remote.lnk"), "create", options);
}

export function removeShortcuts() {
  if (process.platform === "win32") {
    for (const link of [
      path.join(app.getPath("appData"), "Microsoft", "Windows", "Start Menu", "Programs", "Control Center Remote.lnk"),
      path.join(app.getPath("desktop"), "Control Center Remote.lnk")
    ]) {
      rmSync(link, { force: true });
    }
  }
  setStartAtLogin(false);
}

export { ICON };
