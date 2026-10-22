// Auth and remote-scope tests for the server lockdown (mobile app phase 1).
// Run: npm test (from control-app). Uses a temporary security folder so the
// real paired-device list and local session secret are never touched, and
// builds the Express app without starting Ollama, alarms or other services.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";

const tempRoot = mkdtempSync(path.join(tmpdir(), "cc-auth-test-"));
process.env.CC_SECURITY_DIR = path.join(tempRoot, "security");

const { createServerApp } = await import("../server/index.js");
const apiRouter = (await import("../server/routes/api.js")).default;
const auth = await import("../server/services/authService.js");
const { executeToolCall } = await import("../server/services/agentTools.js");
const { attachVoiceWebSocket, closeVoiceWebSocket } = await import("../server/services/voiceService.js");
const { default: WebSocket } = await import("ws");

let server;
let baseUrl;
let desktopCookie;
let remoteToken;
let revokedToken;

before(async () => {
  auth.initLocalSession();
  desktopCookie = `${auth.LOCAL_SESSION_COOKIE}=${encodeURIComponent(auth.getLocalSessionSecret())}`;
  remoteToken = auth.createDevice({ name: "Test phone" }).token;
  const revoked = auth.createDevice({ name: "Old phone" });
  revokedToken = revoked.token;
  auth.revokeDevice(revoked.device.id);

  const app = createServerApp();
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  attachVoiceWebSocket(server);
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  closeVoiceWebSocket();
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  rmSync(tempRoot, { recursive: true, force: true });
});

function request(method, urlPath, { cookie, token, body } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return fetch(`${baseUrl}${urlPath}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual"
  });
}

/** Every route on the /api router, with :params filled in. */
function allApiRoutes() {
  const routes = [];
  for (const layer of apiRouter.stack) {
    if (!layer.route) continue;
    const concretePath = layer.route.path.replace(/:[^/]+/g, "x");
    for (const method of Object.keys(layer.route.methods)) {
      routes.push({ method: method.toUpperCase(), path: concretePath });
    }
  }
  return routes;
}

describe("authentication", () => {
  test("every /api route except /health rejects requests without credentials", async () => {
    const routes = allApiRoutes();
    assert.ok(routes.length > 50, `expected the full route list, got ${routes.length}`);
    for (const route of routes) {
      const res = await request(route.method, `/api${route.path}`);
      if (route.method === "GET" && route.path === "/health") {
        assert.equal(res.status, 200, "health stays public");
      } else {
        assert.equal(res.status, 401, `${route.method} /api${route.path} without credentials`);
      }
    }
  });

  test("a wrong cookie, a made-up token and a revoked token are all rejected", async () => {
    assert.equal((await request("GET", "/api/system", { cookie: `${auth.LOCAL_SESSION_COOKIE}=nope` })).status, 401);
    assert.equal((await request("GET", "/api/system", { token: "not-a-real-token" })).status, 401);
    assert.equal((await request("GET", "/api/system", { token: revokedToken })).status, 401);
  });

  test("the desktop session cookie works", async () => {
    const res = await request("GET", "/api/apps", { cookie: desktopCookie });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray((await res.json()).apps));
  });

  test("a paired device token works on allowed routes", async () => {
    assert.equal((await request("GET", "/api/apps", { token: remoteToken })).status, 200);
    assert.equal((await request("GET", "/api/chat/messages", { token: remoteToken })).status, 200);
  });

  test("the start:web login link only accepts this launch's secret", async () => {
    assert.equal((await request("GET", "/auth/local?token=wrong")).status, 401);
    const ok = await request("GET", `/auth/local?token=${encodeURIComponent(auth.getLocalSessionSecret())}`);
    assert.equal(ok.status, 302);
    assert.match(ok.headers.get("set-cookie") || "", /cc_session=.+HttpOnly; SameSite=Strict/);
  });
});

describe("remote scope (deny by default)", () => {
  test("every route outside the allowlist returns 403 for a paired device", async () => {
    for (const route of allApiRoutes()) {
      if (auth.isRemoteAllowed(route.method, route.path)) continue;
      const res = await request(route.method, `/api${route.path}`, { token: remoteToken });
      assert.equal(res.status, 403, `${route.method} /api${route.path} should be desktop-only`);
    }
  });

  test("dangerous PC actions are never on the allowlist", () => {
    const desktopOnly = [
      ["POST", "/shutdown"],
      ["POST", "/system/ssh-connect"],
      ["POST", "/system/choose-directory"],
      ["POST", "/system/choose-file"],
      ["POST", "/apps/project-app/launch-tool"],
      ["POST", "/apps/project-app/projects/x/trash"],
      ["POST", "/apps/project-app/projects/x/rename"],
      ["POST", "/apps/project-app/projects/x/move"],
      ["POST", "/apps/project-app/projects/x/open"],
      ["POST", "/apps/project-app/projects"],
      ["PATCH", "/apps/project-app/projects/x"],
      ["POST", "/events"],
      ["POST", "/agent/respond"],
      ["PUT", "/settings/desktop"],
      ["POST", "/ollama/stop"],
      ["POST", "/mode/switch"],
      ["POST", "/apps/music-app/local-playlists/sync"],
      ["POST", "/apps/file-system-app/launch"],
      ["POST", "/apps/file-system-app/recorder/launch"],
      ["DELETE", "/skills/x"],
      ["DELETE", "/apps/project-app/projects/x"]
    ];
    for (const [method, routePath] of desktopOnly) {
      assert.equal(auth.isRemoteAllowed(method, routePath), false, `${method} ${routePath}`);
    }
  });
});

describe("music file streaming", () => {
  test("serves media files only, and only library tracks to remote devices", async () => {
    const mp3 = path.join(tempRoot, "song.mp3");
    const secret = path.join(tempRoot, "secret.txt");
    writeFileSync(mp3, "ID3 not really audio");
    writeFileSync(secret, "do not leak");

    const fileUrl = (filePath) => `/api/apps/music-app/local-file?path=${encodeURIComponent(filePath)}`;

    const desktopMp3 = await request("GET", fileUrl(mp3), { cookie: desktopCookie });
    assert.equal(desktopMp3.status, 200, "desktop can stream a media file");

    const desktopTxt = await request("GET", fileUrl(secret), { cookie: desktopCookie });
    assert.equal(desktopTxt.status, 403, "non-media files are refused even for the desktop");
    assert.equal((await desktopTxt.json()).code, "MUSIC_FILE_NOT_MEDIA");

    const remoteMp3 = await request("GET", fileUrl(mp3), { token: remoteToken });
    assert.equal(remoteMp3.status, 403, "remote devices only get tracks in a synced playlist");
    assert.equal((await remoteMp3.json()).code, "MUSIC_FILE_NOT_IN_LIBRARY");

    const unauthenticated = await request("GET", fileUrl(mp3));
    assert.equal(unauthenticated.status, 401);
  });
});

describe("voice WebSocket", () => {
  function openVoice(headers) {
    return new Promise((resolve) => {
      const ws = new WebSocket(`${baseUrl.replace("http", "ws")}/voice`, { headers });
      ws.on("open", () => {
        ws.close();
        resolve("open");
      });
      ws.on("unexpected-response", (req, res) => resolve(res.statusCode));
      ws.on("error", () => resolve("error"));
    });
  }

  test("requires the desktop session", async () => {
    assert.equal(await openVoice({}), 401);
    assert.equal(await openVoice({ Authorization: `Bearer ${remoteToken}` }), 401);
    assert.equal(await openVoice({ Cookie: desktopCookie }), "open");
  });
});

describe("Jarvis from a remote device", () => {
  const phoneOrigin = { type: "user", device: { id: "dev_test", kind: "phone", name: "Test phone" } };

  test("desktop-only tools are refused before they run", async () => {
    for (const tool of ["shutdown_app", "update_desktop_settings", "switch_mode", "publish_event", "start_gesture_recorder", "create_project"]) {
      const result = await executeToolCall(tool, {}, { origin: phoneOrigin });
      assert.equal(result.ok, false, tool);
      assert.equal(result.code, "DESKTOP_ONLY_TOOL", tool);
    }
  });

  test("open_app and close_app target the phone, never PC windows or processes", async () => {
    const opened = await executeToolCall("open_app", { target: "file-system-app" }, { origin: phoneOrigin });
    assert.equal(opened.ok, true);
    assert.equal(opened.targetDeviceId, "dev_test");
    assert.equal(opened.pid, undefined, "the webcam explorer must not launch on the PC");

    const all = await executeToolCall("open_app", { target: "all" }, { origin: phoneOrigin });
    assert.equal(all.ok, false);

    const closed = await executeToolCall("close_app", { target: "calendar-app" }, { origin: phoneOrigin });
    assert.equal(closed.ok, true);
    assert.equal(closed.targetDeviceId, "dev_test");
  });
});
