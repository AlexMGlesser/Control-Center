// The phone's read-only File System endpoints (mobile architecture 5.10).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";

const tempRoot = mkdtempSync(path.join(tmpdir(), "cc-files-test-"));
process.env.CC_SECURITY_DIR = path.join(tempRoot, "security");
process.env.CC_RUNTIME_STATE_FILE = path.join(tempRoot, "runtime.json");

const { createServerApp } = await import("../server/index.js");
const auth = await import("../server/services/authService.js");
const files = await import("../server/services/remoteFilesService.js");

const sample = path.join(tempRoot, "sample");
let server;
let baseUrl;
let token;
let desktopCookie;

before(async () => {
  mkdirSync(path.join(sample, "Sub folder"), { recursive: true });
  writeFileSync(path.join(sample, "notes.md"), "# hello\n");
  writeFileSync(path.join(sample, "clip.mp4"), Buffer.alloc(4096, 7));
  writeFileSync(path.join(sample, ".secret"), "dotfile");
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

const get = (urlPath, headers = { Authorization: `Bearer ${token}` }) => fetch(`${baseUrl}${urlPath}`, { headers });
const q = (p) => encodeURIComponent(p);

describe("file browsing from the phone", () => {
  test("roots list drives and quick locations", async () => {
    const res = await get("/api/files/roots");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.drives) && body.drives.length > 0);
    assert.ok(Array.isArray(body.quick));
  });

  test("listing a folder: folders first, kinds, dotfiles hidden unless asked", async () => {
    const body = await (await get(`/api/files/list?path=${q(sample)}`)).json();
    assert.deepEqual(body.entries.map((e) => e.name), ["Sub folder", "clip.mp4", "notes.md"]);
    assert.equal(body.entries.find((e) => e.name === "notes.md").kind, "text");
    assert.equal(body.entries.find((e) => e.name === "clip.mp4").kind, "video");
    const withHidden = await (await get(`/api/files/list?path=${q(sample)}&hidden=1`)).json();
    assert.ok(withHidden.entries.some((e) => e.name === ".secret" && e.hidden));
  });

  test("file content streams, supports Range, and downloads as an attachment", async () => {
    const whole = await get(`/api/files/content?path=${q(path.join(sample, "notes.md"))}`);
    assert.equal(await whole.text(), "# hello\n");
    const ranged = await fetch(`${baseUrl}/api/files/content?path=${q(path.join(sample, "clip.mp4"))}`, {
      headers: { Authorization: `Bearer ${token}`, Range: "bytes=0-99" }
    });
    assert.equal(ranged.status, 206, "seekable");
    assert.equal((await ranged.arrayBuffer()).byteLength, 100);
    const download = await get(`/api/files/content?path=${q(path.join(sample, "notes.md"))}&download=1`);
    assert.match(download.headers.get("content-disposition") || "", /attachment/);
  });

  test("unsafe paths are refused", () => {
    const bad = [
      "\\\\server\\share\\file.txt",
      "\\\\?\\C:\\Windows",
      "\\\\.\\PhysicalDrive0",
      `${sample}\\..\\..`,
      `${path.join(sample, "notes.md")}:hidden`,
      `${sample}\\NUL`,
      "relative\\path"
    ];
    for (const value of bad) {
      assert.throws(() => files.resolveSafePath(value), { code: "INVALID_PATH" }, value);
    }
  });

  test("there is no way to write, rename or delete", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      for (const route of ["list", "content", "info", "roots", "upload", "rename", "delete", "trash"]) {
        const res = await fetch(`${baseUrl}/api/files/${route}?path=${q(path.join(sample, "notes.md"))}`, {
          method,
          headers: { Authorization: `Bearer ${token}` }
        });
        assert.ok([403, 404].includes(res.status), `${method} /files/${route} -> ${res.status}`);
      }
    }
  });

  test("the PC's switch turns phone file access off, but not the PC's own", async () => {
    const off = await fetch(`${baseUrl}/api/devices/phone-file-access`, {
      method: "PUT",
      headers: { Cookie: desktopCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false })
    });
    assert.equal((await off.json()).enabled, false);
    assert.equal((await get("/api/files/roots")).status, 403);
    assert.equal((await get("/api/files/roots", { Cookie: desktopCookie })).status, 200);
    assert.equal((await fetch(`${baseUrl}/api/devices/phone-file-access`, { method: "PUT", headers: { Authorization: `Bearer ${token}` } })).status, 403, "the phone can't flip it back");
    files.setPhoneFileAccessEnabled(true);
    assert.equal((await get("/api/files/roots")).status, 200);
  });
});
