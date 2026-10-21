import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { getSecurityDirectory } from "../appPaths.js";
import { publishEvent } from "./eventBus.js";

// Every /api request and the /voice WebSocket must authenticate as one of:
//  - the desktop, via a per-launch local session secret sent as a cookie
//    (Electron sets it on its session, so no desktop page code changes), or
//  - a paired remote device, via `Authorization: Bearer <device token>`.
// The server never trusts a request because of its source address: remote
// traffic arrives through `tailscale serve` from 127.0.0.1 too.

export const LOCAL_SESSION_COOKIE = "cc_session";

const LOCAL_SESSION_FILE = "local-session.secret";
const DEVICE_STORE_FILE = "devices.json";
const LAST_SEEN_WRITE_INTERVAL_MS = 60_000;
const REJECTION_LOG_INTERVAL_MS = 60_000;

let localSessionSecret = null;
let deviceStore = null; // { devices: [{ id, name, kind, tokenHash, createdAt, lastSeenAt }] }
const rejectionLogTimes = new Map();

// Routes a remote device may call; everything else is desktop-only (403).
// Deny by default: a new route stays desktop-only until it's added here.
const REMOTE_ALLOWLIST = [
  ["GET", /^\/health$/],
  ["GET", /^\/system$/],
  ["GET", /^\/apps$/],
  ["GET", /^\/apps\/[^/]+$/],
  ["GET", /^\/chat\/messages$/],
  ["POST", /^\/chat\/messages$/],
  ["GET", /^\/agent\/queue\/status$/],
  ["GET", /^\/events\/stream$/],
  ["GET", /^\/apps\/calendar-app\/(month|events|events\/remaining)$/],
  ["POST", /^\/apps\/calendar-app\/events$/],
  ["DELETE", /^\/apps\/calendar-app\/events\/[^/]+$/],
  ["GET", /^\/apps\/news-app\/briefing$/],
  ["GET", /^\/apps\/music-app\/(library|library\/tracks|library\/artists|library\/genres|local-file|playlists)$/],
  ["POST", /^\/apps\/music-app\/playlists$/],
  ["POST", /^\/apps\/music-app\/playlists\/[^/]+\/tracks$/],
  ["GET", /^\/apps\/drawing-app\/files(\/[^/]+)?$/],
  ["GET", /^\/apps\/(project-app|work-app)\/projects$/],
  ["GET", /^\/apps\/(project-app|work-app)\/projects\/[^/]+\/tree$/]
];

// Reachable without credentials: the health probe (no data, and a second
// Control Center instance uses it to detect a running one).
const PUBLIC_ROUTES = [["GET", /^\/health$/]];

/* ------------------------------------------------------------------ */
/* Desktop local session                                               */
/* ------------------------------------------------------------------ */

/**
 * Creates this launch's local session secret. It's also written to the
 * security folder so a second Control Center instance (or the start:web
 * login link) can authenticate to this one; anyone able to read that folder
 * already controls the PC.
 */
export function initLocalSession() {
  localSessionSecret = randomBytes(32).toString("base64url");
  const directory = ensureSecurityDirectory();
  writeFileSync(path.join(directory, LOCAL_SESSION_FILE), localSessionSecret, { encoding: "utf-8", mode: 0o600 });
  return localSessionSecret;
}

export function getLocalSessionSecret() {
  return localSessionSecret;
}

/** The secret of whichever instance last started (used to stop an old one). */
export function readPersistedLocalSessionSecret() {
  const filePath = path.join(getSecurityDirectory(), LOCAL_SESSION_FILE);
  if (!existsSync(filePath)) {
    return null;
  }
  return readFileSync(filePath, "utf-8").trim() || null;
}

function isLocalSessionValue(value) {
  if (!localSessionSecret || typeof value !== "string" || !value) {
    return false;
  }
  const expected = Buffer.from(localSessionSecret);
  const given = Buffer.from(value);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/* ------------------------------------------------------------------ */
/* Device tokens                                                       */
/* ------------------------------------------------------------------ */

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function loadDeviceStore() {
  if (deviceStore) {
    return deviceStore;
  }
  const filePath = path.join(getSecurityDirectory(), DEVICE_STORE_FILE);
  try {
    const parsed = existsSync(filePath) ? JSON.parse(readFileSync(filePath, "utf-8")) : null;
    deviceStore = { devices: Array.isArray(parsed?.devices) ? parsed.devices : [] };
  } catch (error) {
    // A corrupt store must not silently grant or keep access: start empty
    // (every device has to pair again) and say so.
    console.error("[Auth] Could not read device store; treating it as empty:", error?.message || error);
    deviceStore = { devices: [] };
  }
  return deviceStore;
}

function saveDeviceStore() {
  const directory = ensureSecurityDirectory();
  writeFileSync(path.join(directory, DEVICE_STORE_FILE), JSON.stringify(loadDeviceStore(), null, 2), {
    encoding: "utf-8",
    mode: 0o600
  });
}

/** Creates a device and returns its token. The token is never stored or shown again. */
export function createDevice({ name, kind = "phone" } = {}) {
  const store = loadDeviceStore();
  const token = randomBytes(32).toString("base64url");
  const now = new Date().toISOString();
  const device = {
    id: `dev_${randomBytes(6).toString("hex")}`,
    name: String(name || "").trim().slice(0, 60) || "Phone",
    kind,
    tokenHash: hashToken(token),
    createdAt: now,
    lastSeenAt: now
  };
  store.devices.push(device);
  saveDeviceStore();
  return { device: publicDevice(device), token };
}

export function listDevices() {
  return loadDeviceStore().devices.map(publicDevice);
}

export function revokeDevice(deviceId) {
  const store = loadDeviceStore();
  const before = store.devices.length;
  store.devices = store.devices.filter((device) => device.id !== deviceId);
  if (store.devices.length === before) {
    return false;
  }
  saveDeviceStore();
  return true;
}

function findDeviceByToken(token) {
  if (!token) {
    return null;
  }
  const tokenHash = hashToken(token);
  return loadDeviceStore().devices.find((device) => device.tokenHash === tokenHash) || null;
}

function touchDevice(device) {
  const now = Date.now();
  if (now - Date.parse(device.lastSeenAt || 0) < LAST_SEEN_WRITE_INTERVAL_MS) {
    return;
  }
  device.lastSeenAt = new Date(now).toISOString();
  try {
    saveDeviceStore();
  } catch {
    // Last-seen is informational; never fail a request over it.
  }
}

function publicDevice(device) {
  const { tokenHash, ...rest } = device;
  return rest;
}

/* ------------------------------------------------------------------ */
/* Request authentication                                              */
/* ------------------------------------------------------------------ */

function parseCookies(header) {
  const cookies = {};
  String(header || "")
    .split(";")
    .forEach((part) => {
      const index = part.indexOf("=");
      if (index > 0) {
        cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
      }
    });
  return cookies;
}

/**
 * Identifies the caller from request headers.
 * Returns { scope: "desktop" } or { scope: "remote", device }, or null.
 */
export function identifyRequest(headers = {}) {
  const cookies = parseCookies(headers.cookie);
  if (isLocalSessionValue(cookies[LOCAL_SESSION_COOKIE])) {
    return { scope: "desktop", device: { id: "desktop", kind: "desktop", name: "PC" } };
  }

  const authorization = String(headers.authorization || "");
  const bearer = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  const device = findDeviceByToken(bearer);
  if (device) {
    touchDevice(device);
    return { scope: "remote", device: { id: device.id, kind: device.kind, name: device.name } };
  }

  return null;
}

function matchesRoute(routes, method, routePath) {
  return routes.some(([routeMethod, pattern]) => routeMethod === method && pattern.test(routePath));
}

export function isRemoteAllowed(method, routePath) {
  return matchesRoute(REMOTE_ALLOWLIST, method, routePath);
}

/** Express middleware for the /api router: authenticate, then apply remote scope. */
export function apiAuthMiddleware(req, res, next) {
  const routePath = req.path;
  const identity = identifyRequest(req.headers);

  if (!identity) {
    if (matchesRoute(PUBLIC_ROUTES, req.method, routePath)) {
      next();
      return;
    }
    logRejection(req, "unauthenticated");
    res.status(401).json({ ok: false, code: "UNAUTHORIZED", message: "Authentication required." });
    return;
  }

  if (identity.scope === "remote" && !isRemoteAllowed(req.method, routePath)) {
    logRejection(req, "remote-forbidden", identity.device);
    res.status(403).json({
      ok: false,
      code: "FORBIDDEN_FOR_REMOTE_DEVICE",
      message: "This action is only available on the PC."
    });
    return;
  }

  req.auth = identity;
  next();
}

/** For the /voice WebSocket upgrade: desktop only. */
export function isDesktopUpgradeRequest(request) {
  return identifyRequest(request.headers)?.scope === "desktop";
}

/**
 * GET /auth/local?token=... — for `npm run start:web` in a browser: exchanges
 * the printed one-time link for the local session cookie.
 */
export function localLoginHandler(req, res) {
  if (!isLocalSessionValue(String(req.query.token || ""))) {
    logRejection(req, "bad-local-login");
    res.status(401).send("Invalid or expired local login link. Restart Control Center to get a new one.");
    return;
  }
  res.setHeader("Set-Cookie", buildLocalSessionCookie());
  res.redirect("/");
}

export function buildLocalSessionCookie() {
  return `${LOCAL_SESSION_COOKIE}=${encodeURIComponent(localSessionSecret)}; Path=/; HttpOnly; SameSite=Strict`;
}

function logRejection(req, reason, device) {
  const forwardedFor = String(req.headers?.["x-forwarded-for"] || "").split(",")[0].trim();
  const source = forwardedFor || req.ip || req.socket?.remoteAddress || "unknown";
  const key = `${source}|${reason}`;
  const now = Date.now();
  if (now - (rejectionLogTimes.get(key) || 0) < REJECTION_LOG_INTERVAL_MS) {
    return;
  }
  rejectionLogTimes.set(key, now);

  const message = `Rejected ${req.method} ${req.originalUrl || req.url} (${reason}) from ${source}`;
  console.warn(`[Auth] ${message}`);
  publishEvent({
    source: "auth",
    appId: "control-center",
    type: "auth-rejected",
    message,
    meta: { reason, method: req.method, path: req.path, source, deviceId: device?.id || null }
  });
}

function ensureSecurityDirectory() {
  const directory = getSecurityDirectory();
  mkdirSync(directory, { recursive: true });
  return directory;
}
