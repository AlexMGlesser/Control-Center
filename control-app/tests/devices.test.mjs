// Pairing and device management tests (mobile app phase 2).
// Same isolation as auth.test.mjs: temporary security folder, no services.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";

const tempRoot = mkdtempSync(path.join(tmpdir(), "cc-devices-test-"));
process.env.CC_SECURITY_DIR = path.join(tempRoot, "security");

const { createServerApp } = await import("../server/index.js");
const auth = await import("../server/services/authService.js");

let server;
let baseUrl;
let desktopCookie;

before(async () => {
  auth.initLocalSession();
  desktopCookie = `${auth.LOCAL_SESSION_COOKIE}=${encodeURIComponent(auth.getLocalSessionSecret())}`;
  const app = createServerApp();
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  rmSync(tempRoot, { recursive: true, force: true });
});

// Each test uses its own forwarded source so pairing rate limits don't leak
// between tests.
function request(method, urlPath, { cookie, token, body, source } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (token) headers.Authorization = `Bearer ${token}`;
  if (source) headers["X-Forwarded-For"] = source;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return fetch(`${baseUrl}${urlPath}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

async function newPairingCode() {
  const res = await request("POST", "/api/devices/pairing-codes", { cookie: desktopCookie });
  assert.equal(res.status, 200);
  return res.json();
}

describe("pairing", () => {
  test("the PC creates a code with a QR code", async () => {
    const pairing = await newPairingCode();
    assert.match(pairing.code, /^[0-9A-HJKMNP-TV-Z]{8}$/);
    assert.ok(Date.parse(pairing.expiresAt) > Date.now());
    assert.match(pairing.qrSvg, /^<svg/);
    assert.ok("remoteAccess" in pairing);
  });

  test("a phone pairs once with the right code, and the token works", async () => {
    const pairing = await newPairingCode();
    const source = "100.64.0.10";

    const wrong = await request("POST", "/api/devices/pair", { body: { code: "00000000", deviceName: "Pixel" }, source });
    assert.equal(wrong.status, 401);
    assert.equal((await wrong.json()).code, "INVALID_PAIRING_CODE");

    // Typed the way a person might: lowercase, with a space.
    const typed = `${pairing.code.slice(0, 4)} ${pairing.code.slice(4)}`.toLowerCase();
    const paired = await request("POST", "/api/devices/pair", { body: { code: typed, deviceName: "Pixel 8" }, source });
    assert.equal(paired.status, 200);
    const result = await paired.json();
    assert.ok(result.token && result.deviceId);
    assert.equal(result.device.name, "Pixel 8");
    assert.equal(result.device.tokenHash, undefined, "the hash never leaves the server");

    const reuse = await request("POST", "/api/devices/pair", { body: { code: pairing.code, deviceName: "Again" }, source });
    assert.equal(reuse.status, 401, "codes are single use");

    assert.equal((await request("GET", "/api/apps", { token: result.token })).status, 200);

    const list = await (await request("GET", "/api/devices", { cookie: desktopCookie })).json();
    assert.ok(list.devices.some((device) => device.id === result.deviceId));
  });

  test("five wrong attempts kill the code", async () => {
    const pairing = await newPairingCode();
    const source = "100.64.0.11";
    for (let i = 0; i < 5; i += 1) {
      await request("POST", "/api/devices/pair", { body: { code: "ZZZZZZZZ" }, source });
    }
    const right = await request("POST", "/api/devices/pair", { body: { code: pairing.code }, source });
    assert.equal(right.status, 401);
    assert.equal((await right.json()).code, "PAIRING_CODE_EXPIRED");
  });

  test("pairing attempts are rate limited per source", async () => {
    const source = "100.64.0.12";
    let last;
    for (let i = 0; i < 11; i += 1) {
      last = await request("POST", "/api/devices/pair", { body: { code: "ZZZZZZZZ" }, source });
    }
    assert.equal(last.status, 429);
  });

  test("a spoofed first X-Forwarded-For entry doesn't dodge the rate limit", async () => {
    const proxySource = "100.64.0.13";
    let last;
    for (let i = 0; i < 11; i += 1) {
      last = await request("POST", "/api/devices/pair", { body: { code: "ZZZZZZZZ" }, source: `10.0.0.${i}, ${proxySource}` });
    }
    assert.equal(last.status, 429);
  });

  test("cancelling clears the code", async () => {
    const pairing = await newPairingCode();
    const cancel = await request("DELETE", "/api/devices/pairing-codes", { cookie: desktopCookie });
    assert.equal(cancel.status, 200, "not swallowed by DELETE /devices/:deviceId");
    const after = await request("POST", "/api/devices/pair", { body: { code: pairing.code }, source: "100.64.0.14" });
    assert.equal(after.status, 401);
  });
});

describe("device management", () => {
  test("only the PC can create codes or manage devices", async () => {
    const { token } = auth.createDevice({ name: "Phone" });
    assert.equal((await request("POST", "/api/devices/pairing-codes", { token })).status, 403);
    assert.equal((await request("GET", "/api/devices", { token })).status, 403);
    assert.equal((await request("GET", "/api/devices/remote-access", { token })).status, 403);
  });

  test("removing a device ends its live stream and rejects it from then on", async () => {
    const { device, token } = auth.createDevice({ name: "Soon removed" });

    const controller = new AbortController();
    const stream = await fetch(`${baseUrl}/api/events/stream`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal
    });
    assert.equal(stream.status, 200);
    const reader = stream.body.getReader();
    await reader.read(); // initial snapshot

    const removed = await request("DELETE", `/api/devices/${device.id}`, { cookie: desktopCookie });
    assert.equal(removed.status, 200);

    // The server ends the stream: reads drain and then report done.
    const ended = await Promise.race([
      (async () => {
        for (;;) {
          const { done } = await reader.read();
          if (done) return true;
        }
      })(),
      new Promise((resolve) => setTimeout(() => resolve(false), 3000))
    ]);
    controller.abort();
    assert.equal(ended, true, "stream closed by the server");

    assert.equal((await request("GET", "/api/apps", { token })).status, 401);
  });
});
