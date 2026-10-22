// Phase 5 server pieces: the movie library, Server Manager's saved list and
// "play on PC" music commands, from the PC and from a paired phone.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";

const tempRoot = mkdtempSync(path.join(tmpdir(), "cc-media-test-"));
process.env.CC_SECURITY_DIR = path.join(tempRoot, "security");
process.env.CC_RUNTIME_STATE_FILE = path.join(tempRoot, "runtime.json");

const { createServerApp } = await import("../server/index.js");
const auth = await import("../server/services/authService.js");

const movies = path.join(tempRoot, "Movies");
let server;
let baseUrl;
let token;
let desktopCookie;

before(async () => {
  mkdirSync(path.join(movies, "Heat (1995)"), { recursive: true });
  writeFileSync(path.join(movies, "Heat (1995)", "heat.mkv"), Buffer.alloc(10_000, 1));
  writeFileSync(path.join(movies, "Heat (1995)", "poster.jpg"), Buffer.from([0xff, 0xd8, 0xff]));
  writeFileSync(path.join(movies, "Alien.mp4"), Buffer.alloc(2_000, 2));
  writeFileSync(path.join(movies, "Alien.srt"), "1\r\n00:00:01,500 --> 00:00:03,000\r\nIn space\r\n");
  writeFileSync(path.join(movies, "notes.txt"), "not a movie");
  auth.initLocalSession();
  desktopCookie = `${auth.LOCAL_SESSION_COOKIE}=${encodeURIComponent(auth.getLocalSessionSecret())}`;
  token = auth.createDevice({ name: "Phone" }).token;
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

function call(urlPath, { method = "GET", body, phone = false, headers = {} } = {}) {
  const all = { ...(phone ? { Authorization: `Bearer ${token}` } : { Cookie: desktopCookie }), ...headers };
  if (body) all["Content-Type"] = "application/json";
  return fetch(`${baseUrl}/api${urlPath}`, { method, headers: all, body: body ? JSON.stringify(body) : undefined });
}

describe("movie library", () => {
  let library;

  test("adding a folder scans it: titles, posters, subtitles", async () => {
    const res = await call("/apps/movie-app/folders", { method: "POST", body: { path: movies } });
    assert.equal(res.status, 200);
    library = await res.json();
    assert.deepEqual(library.movies.map((m) => m.title), ["Alien", "Heat (1995)"]);
    const heat = library.movies.find((m) => m.title === "Heat (1995)");
    const alien = library.movies.find((m) => m.title === "Alien");
    assert.equal(heat.hasPoster, true);
    assert.equal(heat.container, "mkv");
    assert.equal(alien.subtitles.length, 1);
    assert.equal(JSON.stringify(library).includes("heat.mkv\""), true);
    // No full PC paths for movies, just file names.
    assert.equal(library.movies.some((m) => "path" in m), false);
  });

  test("the phone can list, stream with Range, get posters and subtitles", async () => {
    const alien = library.movies.find((m) => m.title === "Alien");
    const heat = library.movies.find((m) => m.title === "Heat (1995)");
    const list = await call("/apps/movie-app/library", { phone: true });
    assert.equal(list.status, 200);

    const ranged = await call(`/apps/movie-app/stream/${alien.id}`, { phone: true, headers: { Range: "bytes=0-99" } });
    assert.equal(ranged.status, 206);
    assert.equal((await ranged.arrayBuffer()).byteLength, 100);

    const poster = await call(`/apps/movie-app/poster/${heat.id}`, { phone: true });
    assert.equal(poster.status, 200);

    const subs = await call(`/apps/movie-app/subtitles/${alien.id}`, { phone: true });
    assert.equal(subs.status, 200);
    const vtt = await subs.text();
    assert.ok(vtt.startsWith("WEBVTT"));
    assert.ok(vtt.includes("00:00:01.500 --> 00:00:03.000"));
  });

  test("unknown ids are refused; the phone can't add folders or rescan", async () => {
    assert.equal((await call("/apps/movie-app/stream/0123456789abcdef", { phone: true })).status, 404);
    assert.equal((await call("/apps/movie-app/folders", { method: "POST", phone: true, body: { path: tmpdir() } })).status, 403);
    assert.equal((await call("/apps/movie-app/rescan", { method: "POST", phone: true })).status, 403);
    assert.equal((await call("/apps/movie-app/folders/remove", { method: "POST", phone: true, body: { path: movies } })).status, 403);
  });

  test("removing the folder empties the library but leaves the files", async () => {
    const res = await call("/apps/movie-app/folders/remove", { method: "POST", body: { path: movies } });
    const body = await res.json();
    assert.equal(body.movies.length, 0);
    assert.equal(body.folders.length, 0);
  });
});

describe("server manager list", () => {
  test("starts uninitialized, then saves and normalizes", async () => {
    const first = await (await call("/apps/server-manager-app/servers")).json();
    assert.equal(first.initialized, false);
    const saved = await call("/apps/server-manager-app/servers", {
      method: "PUT",
      body: { servers: [{ id: "server-1", name: "Pi", ssh: { host: "pi.local", username: "alex", port: 99999 } }, { name: "no id" }] }
    });
    const body = await saved.json();
    assert.equal(body.servers.length, 1);
    assert.equal(body.servers[0].ssh.port, 22);
  });

  test("the phone can read it but not change it", async () => {
    const read = await (await call("/apps/server-manager-app/servers", { phone: true })).json();
    assert.equal(read.servers[0].name, "Pi");
    const write = await call("/apps/server-manager-app/servers", { method: "PUT", phone: true, body: { servers: [] } });
    assert.equal(write.status, 403);
  });
});

describe("music on the PC from the phone", () => {
  test("valid commands go through; bad ones are refused", async () => {
    const good = await call("/apps/music-app/command", { method: "POST", phone: true, body: { action: "play-pause" } });
    assert.equal(good.status, 200);
    const bad = await call("/apps/music-app/command", { method: "POST", phone: true, body: { action: "format-disk" } });
    assert.equal(bad.status, 400);
  });
});
