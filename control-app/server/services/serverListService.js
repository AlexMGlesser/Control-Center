import { readRuntimeSection, writeRuntimeSection } from "./runtimePersistenceService.js";
import { publishEvent } from "./eventBus.js";

// Server Manager's server list, kept on the PC (mobile architecture 5.7).
// It used to live only in the desktop window's localStorage, so the phone
// couldn't see it. The desktop app uploads that old list once, then reads
// and writes here.

const MAX_SERVERS = 200;

function listError(code, message, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function clean(value, max = 200) {
  return String(value ?? "").trim().slice(0, max);
}

function normalizeServer(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = clean(raw.id, 80);
  if (!id) return null;
  const port = Number(raw.ssh?.port);
  return {
    id,
    name: clean(raw.name, 120) || "Server",
    environment: clean(raw.environment, 60) || "Custom",
    ssh: {
      host: clean(raw.ssh?.host),
      username: clean(raw.ssh?.username, 120),
      port: Number.isInteger(port) && port >= 1 && port <= 65535 ? port : 22,
      keyPath: clean(raw.ssh?.keyPath, 500)
    }
  };
}

/** `initialized` is false until the desktop app has saved once (and uploaded any old list). */
export function listServers() {
  const saved = readRuntimeSection("servers", null);
  return {
    initialized: Boolean(saved),
    servers: Array.isArray(saved?.servers) ? saved.servers : []
  };
}

export function saveServers(servers) {
  if (!Array.isArray(servers)) throw listError("INVALID_SERVERS", "Send the full list of servers.");
  if (servers.length > MAX_SERVERS) throw listError("TOO_MANY_SERVERS", `At most ${MAX_SERVERS} servers.`);
  const normalized = servers.map(normalizeServer).filter(Boolean);
  writeRuntimeSection("servers", { servers: normalized, updatedAt: new Date().toISOString() });
  publishEvent({ source: "server-manager", appId: "server-manager-app", type: "data-changed", message: "Server list changed.", meta: { entity: "servers" } });
  return { initialized: true, servers: normalized };
}
