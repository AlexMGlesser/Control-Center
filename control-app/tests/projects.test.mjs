// The merged Projects app: project list, folder browsing and the text editor,
// from the PC and from a paired phone.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";

const tempRoot = mkdtempSync(path.join(tmpdir(), "cc-projects-test-"));
process.env.CC_SECURITY_DIR = path.join(tempRoot, "security");
process.env.CC_RUNTIME_STATE_FILE = path.join(tempRoot, "runtime.json");

const { createServerApp } = await import("../server/index.js");
const auth = await import("../server/services/authService.js");

const folder = path.join(tempRoot, "my-project");
const outside = path.join(tempRoot, "outside.txt");
let server;
let baseUrl;
let token;
let desktopCookie;
let projectId;

before(async () => {
  mkdirSync(path.join(folder, "src"), { recursive: true });
  writeFileSync(path.join(folder, "README.md"), "# hello\n");
  writeFileSync(path.join(folder, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]));
  writeFileSync(outside, "not part of the project");
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

const API = "/api/apps/project-app";
const q = (p) => encodeURIComponent(p);

function call(urlPath, { method = "GET", body, phone = false } = {}) {
  const headers = phone ? { Authorization: `Bearer ${token}` } : { Cookie: desktopCookie };
  if (body) headers["Content-Type"] = "application/json";
  return fetch(`${baseUrl}${API}${urlPath}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
}

describe("projects", () => {
  test("adding a folder lists it with its category", async () => {
    const res = await call("/projects", { method: "POST", body: { path: folder, category: "work" } });
    assert.equal(res.status, 200);
    const { project } = await res.json();
    assert.equal(project.name, "my-project");
    assert.equal(project.category, "work");
    projectId = project.id;

    const { projects } = await (await call("/projects", { phone: true })).json();
    assert.ok(projects.some((p) => p.id === projectId));
  });

  test("the same folder can't be added twice", async () => {
    const res = await call("/projects", { method: "POST", body: { path: folder } });
    assert.equal(res.status, 409);
  });

  test("a folder lists one level, folders first", async () => {
    const body = await (await call(`/projects/${projectId}/list`)).json();
    assert.deepEqual(body.entries.map((e) => e.name), ["src", "logo.png", "README.md"]);
    assert.equal(body.parent, null);
    const sub = await (await call(`/projects/${projectId}/list?path=${q(path.join(folder, "src"))}`)).json();
    assert.equal(sub.relativePath, "src");
    assert.ok(sub.parent);
  });

  test("text files open; binary files are refused", async () => {
    const file = await (await call(`/projects/${projectId}/file?path=${q(path.join(folder, "README.md"))}`, { phone: true })).json();
    assert.equal(file.text, "# hello\n");
    assert.equal(typeof file.modified, "number");
    const binary = await call(`/projects/${projectId}/file?path=${q(path.join(folder, "logo.png"))}`);
    assert.equal(binary.status, 415);
    assert.equal((await binary.json()).code, "BINARY_FILE");
  });

  test("the phone can create and save a file", async () => {
    const created = await call(`/projects/${projectId}/entries`, {
      method: "POST",
      phone: true,
      body: { parentPath: path.join(folder, "src"), name: "hello.py", type: "file" }
    });
    assert.equal(created.status, 200);
    const target = path.join(folder, "src", "hello.py");
    const opened = await (await call(`/projects/${projectId}/file?path=${q(target)}`, { phone: true })).json();
    const saved = await call(`/projects/${projectId}/file`, {
      method: "PUT",
      phone: true,
      body: { path: target, content: "print('hi')\n", expectedModified: opened.modified }
    });
    assert.equal(saved.status, 200);
    assert.equal(readFileSync(target, "utf-8"), "print('hi')\n");
  });

  test("a save over a file changed elsewhere is refused with 409", async () => {
    const target = path.join(folder, "README.md");
    const opened = await (await call(`/projects/${projectId}/file?path=${q(target)}`)).json();
    writeFileSync(target, "edited elsewhere\n");
    const later = new Date(Date.now() + 5000);
    utimesSync(target, later, later);
    const res = await call(`/projects/${projectId}/file`, {
      method: "PUT",
      body: { path: target, content: "mine\n", expectedModified: opened.modified }
    });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).code, "FILE_CHANGED");
    assert.equal(readFileSync(target, "utf-8"), "edited elsewhere\n");
  });

  test("paths outside the project are refused", async () => {
    const refused = async (res) => {
      assert.equal(res.status, 400);
      assert.equal((await res.json()).code, "INVALID_PATH");
    };
    await refused(await call(`/projects/${projectId}/file?path=${q(outside)}`));
    await refused(await call(`/projects/${projectId}/file?path=${q(path.join(folder, "..", "outside.txt"))}`));
    await refused(await call(`/projects/${projectId}/file`, { method: "PUT", body: { path: outside, content: "x" } }));
    assert.equal(readFileSync(outside, "utf-8"), "not part of the project");
    const badName = await call(`/projects/${projectId}/entries`, { method: "POST", body: { parentPath: folder, name: "..\\escape.txt" } });
    assert.equal(badName.status, 400);
  });

  test("rename, copy and move stay on the PC", async () => {
    const target = path.join(folder, "src", "hello.py");
    const renamed = await call(`/projects/${projectId}/rename`, { method: "POST", body: { path: target, newName: "main.py" } });
    assert.equal(renamed.status, 200);
    assert.ok(existsSync(path.join(folder, "src", "main.py")));
    const copied = await call(`/projects/${projectId}/copy`, { method: "POST", body: { path: path.join(folder, "src", "main.py"), destination: folder } });
    assert.equal(copied.status, 200);
    assert.ok(existsSync(path.join(folder, "main.py")));

    for (const action of ["rename", "copy", "move", "trash", "open"]) {
      const res = await call(`/projects/${projectId}/${action}`, { method: "POST", phone: true, body: { path: path.join(folder, "main.py") } });
      assert.equal(res.status, 403, action);
    }
    const remove = await call(`/projects/${projectId}`, { method: "DELETE", phone: true });
    assert.equal(remove.status, 403);
  });

  test("removing a project leaves its folder alone", async () => {
    const res = await call(`/projects/${projectId}`, { method: "DELETE" });
    assert.equal(res.status, 200);
    assert.ok(existsSync(path.join(folder, "README.md")));
  });
});
