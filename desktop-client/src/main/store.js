import { app, safeStorage } from "electron";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import path from "path";
import { randomBytes, scryptSync, timingSafeEqual } from "crypto";

// Pairing and settings, in the app's user-data folder. The device token is
// encrypted with the OS keychain (Windows DPAPI, or the Linux secret
// service) when one is available; otherwise it's stored in a file only this
// user can read, and Settings says so.

export const DEFAULT_SETTINGS = {
  keepRunningInTray: true,
  startAtLogin: false,
  connectionAlerts: true,
  jarvisReplies: true,
  calendarReminders: true,
  /** Minutes before an event starts: 0 (at start), 5, 10, 15 or 30. */
  remindMinutes: 0,
  lockFileSystem: true,
  /** scrypt hash of the File System PIN, for when Windows Hello isn't available. */
  pinHash: null,
  musicOnPc: false
};

function dataFile(name) {
  const folder = app.getPath("userData");
  mkdirSync(folder, { recursive: true });
  return path.join(folder, name);
}

function readJson(name, fallback) {
  try {
    return JSON.parse(readFileSync(dataFile(name), "utf-8"));
  } catch {
    return fallback;
  }
}

function writeJson(name, value) {
  const file = dataFile(name);
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2), { encoding: "utf-8", mode: 0o600 });
  renameSync(temporary, file);
  if (process.platform !== "win32") chmodSync(file, 0o600);
}

/* ---------------- Session ---------------- */

/** True when the token is protected by the OS keychain rather than file permissions alone. */
export function tokenEncrypted() {
  if (!safeStorage.isEncryptionAvailable()) return false;
  // "basic_text" on Linux means no keyring: a fixed key, so not real protection.
  return process.platform !== "linux" || safeStorage.getSelectedStorageBackend() !== "basic_text";
}

let session = null;

/** { baseUrl, deviceId, deviceName, serverName, pairedAt, token } or null. */
export function loadSession() {
  const saved = readJson("session.json", null);
  if (!saved?.baseUrl || !saved?.deviceId) {
    session = null;
    return null;
  }
  let token = null;
  try {
    token = saved.tokenEncrypted
      ? safeStorage.decryptString(Buffer.from(saved.tokenEncrypted, "base64"))
      : saved.tokenPlain || null;
  } catch {
    token = null;
  }
  session = token ? { ...saved, token, tokenEncrypted: undefined, tokenPlain: undefined } : null;
  return session;
}

export function currentSession() {
  return session;
}

export function saveSession(next) {
  const { token, ...rest } = next;
  const record = { ...rest };
  if (tokenEncrypted()) record.tokenEncrypted = safeStorage.encryptString(token).toString("base64");
  else record.tokenPlain = token;
  writeJson("session.json", record);
  session = { ...next };
}

export function clearSession() {
  session = null;
  const file = dataFile("session.json");
  if (existsSync(file)) rmSync(file);
}

/* ---------------- Settings ---------------- */

let settings = null;

export function getSettings() {
  if (!settings) settings = { ...DEFAULT_SETTINGS, ...readJson("settings.json", {}) };
  return settings;
}

export function updateSettings(patch) {
  const allowed = Object.fromEntries(Object.entries(patch || {}).filter(([key]) => key in DEFAULT_SETTINGS && key !== "pinHash"));
  settings = { ...getSettings(), ...allowed };
  writeJson("settings.json", settings);
  return settings;
}

/** What the page may see: everything except the PIN hash. */
export function publicSettings() {
  const { pinHash, ...rest } = getSettings();
  return { ...rest, hasPin: Boolean(pinHash) };
}

export function setPin(pin) {
  const salt = randomBytes(16);
  const hash = scryptSync(String(pin), salt, 32);
  settings = { ...getSettings(), pinHash: `${salt.toString("hex")}:${hash.toString("hex")}` };
  writeJson("settings.json", settings);
}

export function checkPin(pin) {
  const stored = getSettings().pinHash;
  if (!stored) return false;
  const [saltHex, hashHex] = stored.split(":");
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(String(pin), Buffer.from(saltHex, "hex"), expected.length);
  return timingSafeEqual(actual, expected);
}

/* ---------------- Small caches (reminders, alarms) ---------------- */

export function readCache(name, fallback) {
  return readJson(`${name}.json`, fallback);
}

export function writeCache(name, value) {
  writeJson(`${name}.json`, value);
}
