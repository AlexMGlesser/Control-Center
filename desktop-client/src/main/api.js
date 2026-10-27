import { net } from "electron";
import { currentSession } from "./store.js";

// Requests to the home PC. Only the main process holds the token: the page
// calls cc://app/api/..., and proxyApi() forwards it with the token added.

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Called when the PC rejects the token: this device was removed there. */
let onUnauthorized = () => {};

export function setUnauthorizedHandler(handler) {
  onUnauthorized = handler;
}

/** Turns what someone types ("my-pc.tailnet.ts.net") into a base URL, or null. */
export function normalizeBaseUrl(raw) {
  const trimmed = String(raw || "").trim().replace(/\/+$/, "");
  if (!trimmed) return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

async function readError(res) {
  const body = await res.json().catch(() => ({}));
  return new ApiError(res.status, body.code || null, body.message || `Request failed (${res.status}).`);
}

/** JSON request with this device's token. */
export async function api(pathAndQuery, { method = "GET", body, timeoutMs = 30_000 } = {}) {
  const session = currentSession();
  if (!session) throw new ApiError(401, "NOT_PAIRED", "This computer isn't paired.");
  let res;
  try {
    res = await net.fetch(`${session.baseUrl}${pathAndQuery}`, {
      method,
      headers: {
        Authorization: `Bearer ${session.token}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {})
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    throw new ApiError(0, "NETWORK", `Can't reach the PC: ${error.message}`);
  }
  if (res.status === 401) onUnauthorized();
  if (!res.ok) throw await readError(res);
  return res.json();
}

/** Pairing: no token yet, just the code shown on the PC. */
export async function pair(baseUrl, code, deviceName) {
  let res;
  try {
    res = await net.fetch(`${baseUrl}/api/devices/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, deviceName, kind: "laptop" }),
      signal: AbortSignal.timeout(15_000)
    });
  } catch (error) {
    throw new ApiError(0, "NETWORK", `Can't reach ${baseUrl}. Is Tailscale on, and is the address right? (${error.message})`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new ApiError(res.status, data.code, data.message || "Pairing failed.");
  return data;
}

export async function health(baseUrl) {
  try {
    const res = await net.fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(5_000) });
    return res.ok;
  } catch {
    return false;
  }
}

// Request headers the page may pass through (Range makes media seeking work).
const FORWARDED_HEADERS = ["accept", "content-type", "range", "if-range"];

/** cc://app/api/... -> the PC, with the token. Streams the response straight back. */
export async function proxyApi(request, url) {
  const session = currentSession();
  if (!session) {
    return Response.json({ ok: false, code: "NOT_PAIRED", message: "This computer isn't paired." }, { status: 401 });
  }
  const headers = new Headers({ Authorization: `Bearer ${session.token}` });
  for (const name of FORWARDED_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const hasBody = !["GET", "HEAD"].includes(request.method);
  try {
    const res = await net.fetch(`${session.baseUrl}${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      body: hasBody ? await request.arrayBuffer() : undefined
    });
    if (res.status === 401) onUnauthorized();
    return res;
  } catch (error) {
    return Response.json({ ok: false, code: "NETWORK", message: `Can't reach the PC: ${error.message}` }, { status: 502 });
  }
}
