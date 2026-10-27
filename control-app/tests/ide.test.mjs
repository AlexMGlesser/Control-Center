// The phone's IDE: the scripts folder and the AI panel (against a fake Ollama).
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";

const tempRoot = mkdtempSync(path.join(tmpdir(), "cc-ide-test-"));
const scripts = path.join(tempRoot, "scripts");
const outside = path.join(tempRoot, "outside.txt");
process.env.CC_SECURITY_DIR = path.join(tempRoot, "security");
process.env.CC_RUNTIME_STATE_FILE = path.join(tempRoot, "runtime.json");
process.env.CC_SCRIPTS_DIR = scripts;

// The fake model answers with whatever the test puts here, and records what it was sent.
let modelReply = "";
let lastModelRequest = null;
const fakeOllama = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    lastModelRequest = JSON.parse(body || "{}");
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ message: { content: modelReply }, done_reason: "stop" }));
  });
});
await new Promise((resolve) => fakeOllama.listen(0, "127.0.0.1", resolve));
process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${fakeOllama.address().port}`;

const { createServerApp } = await import("../server/index.js");
const auth = await import("../server/services/authService.js");
const { parseAssistReply } = await import("../server/services/ideService.js");

let server;
let baseUrl;
let token;

before(async () => {
  writeFileSync(outside, "not a script");
  auth.initLocalSession();
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
  fakeOllama.close();
  rmSync(tempRoot, { recursive: true, force: true });
});

const q = (p) => encodeURIComponent(p);

function phone(urlPath, { method = "GET", body } = {}) {
  const headers = { Authorization: `Bearer ${token}` };
  if (body) headers["Content-Type"] = "application/json";
  return fetch(`${baseUrl}/api/ide${urlPath}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
}

describe("ide files", () => {
  test("the phone lists the scripts folder, creating it if needed", async () => {
    const res = await phone("/list");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.path, scripts);
    assert.equal(body.parent, null);
    assert.deepEqual(body.entries, []);
  });

  test("the phone can create a file with content, then open and save it", async () => {
    const created = await phone("/entries", { method: "POST", body: { parentPath: scripts, name: "hello.py", content: "print('hi')\n" } });
    assert.equal(created.status, 200);
    const target = path.join(scripts, "hello.py");
    assert.equal(readFileSync(target, "utf-8"), "print('hi')\n");

    const opened = await (await phone(`/file?path=${q(target)}`)).json();
    assert.equal(opened.text, "print('hi')\n");
    const saved = await phone("/file", { method: "PUT", body: { path: target, content: "print('bye')\n", expectedModified: opened.modified } });
    assert.equal(saved.status, 200);
    assert.equal(readFileSync(target, "utf-8"), "print('bye')\n");
  });

  test("Save As never overwrites an existing file", async () => {
    const res = await phone("/entries", { method: "POST", body: { parentPath: scripts, name: "hello.py", content: "x" } });
    assert.equal(res.status, 409);
    assert.equal(readFileSync(path.join(scripts, "hello.py"), "utf-8"), "print('bye')\n");
  });

  test("the phone can rename a file, but not over another one or the folder itself", async () => {
    await phone("/entries", { method: "POST", body: { parentPath: scripts, name: "other.py", content: "x\n" } });
    const clash = await phone("/rename", { method: "POST", body: { path: path.join(scripts, "other.py"), newName: "hello.py" } });
    assert.equal(clash.status, 409);
    const renamed = await phone("/rename", { method: "POST", body: { path: path.join(scripts, "other.py"), newName: "renamed.py" } });
    assert.equal(renamed.status, 200);
    assert.equal((await renamed.json()).path, path.join(scripts, "renamed.py"));
    assert.equal(readFileSync(path.join(scripts, "renamed.py"), "utf-8"), "x\n");
    const root = await phone("/rename", { method: "POST", body: { path: scripts, newName: "elsewhere" } });
    assert.equal(root.status, 400);
    const escape = await phone("/rename", { method: "POST", body: { path: path.join(scripts, "renamed.py"), newName: "..\\up.py" } });
    assert.equal(escape.status, 400);
  });

  test("paths outside the scripts folder are refused", async () => {
    const read = await phone(`/file?path=${q(outside)}`);
    assert.equal(read.status, 400);
    assert.equal((await read.json()).code, "INVALID_PATH");
    const write = await phone("/file", { method: "PUT", body: { path: path.join(scripts, "..", "outside.txt"), content: "x" } });
    assert.equal(write.status, 400);
    const create = await phone("/entries", { method: "POST", body: { parentPath: tempRoot, name: "escape.py" } });
    assert.equal(create.status, 400);
    assert.equal(readFileSync(outside, "utf-8"), "not a script");
  });
});

describe("ide assist", () => {
  test("a change comes back as the whole new file, without the markers", async () => {
    modelReply = "Added a greeting function.\n<<<BEGIN FILE>>>\ndef greet():\n    print('hi')\n<<<END FILE>>>";
    const res = await phone("/assist", {
      method: "POST",
      body: { fileName: "hello.py", content: "print('hi')\n", instruction: "wrap it in a function", history: [{ role: "user", text: "earlier" }] }
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.reply, "Added a greeting function.");
    assert.equal(body.content, "def greet():\n    print('hi')\n");
    // The model saw the open file and the earlier turn.
    const sent = lastModelRequest.messages;
    assert.equal(sent[1].content, "earlier");
    assert.match(sent.at(-1).content, /print\('hi'\)/);
    assert.match(sent.at(-1).content, /wrap it in a function/);
  });

  test("a question gets an answer and no file", async () => {
    modelReply = "It prints hi.";
    const body = await (await phone("/assist", { method: "POST", body: { fileName: "a.py", content: "print('hi')\n", instruction: "what does this do?" } })).json();
    assert.equal(body.reply, "It prints hi.");
    assert.equal(body.content, null);
  });

  test("an empty request and an oversized file are refused", async () => {
    assert.equal((await phone("/assist", { method: "POST", body: { content: "x", instruction: " " } })).status, 400);
    const big = await phone("/assist", { method: "POST", body: { content: "x".repeat(30 * 1024), instruction: "shorten" } });
    assert.equal(big.status, 413);
  });

  test("the reply parser handles fences, cut-off files and line endings", () => {
    assert.equal(parseAssistReply("Done.\n```python\nx = 1\n```", "x = 0\n").content, "x = 1\n");
    assert.equal(parseAssistReply("Done.\n<<<BEGIN FILE>>>\n```js\nlet a;\n```\n<<<END FILE>>>", "").content, "let a;");
    assert.equal(parseAssistReply("<<<BEGIN FILE>>>\nhalf a fi", "x").truncated, true);
    assert.equal(parseAssistReply("<<<BEGIN FILE>>>\na\nb\n<<<END FILE>>>", "a\r\n").content, "a\r\nb\r\n");
    assert.equal(parseAssistReply("Same.\n<<<BEGIN FILE>>>\nx\n<<<END FILE>>>", "x\n").content, null);
  });
});

describe("ai model picker", () => {
  test("models can only be switched to an installed one, from the PC or a phone", async () => {
    const { listOllamaModels, setActiveModel, getActiveModel } = await import("../server/services/ollamaService.js");
    // The fake Ollama answers every request with the chat shape, so stub its model list here.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) =>
      String(url).endsWith("/api/tags")
        ? new Response(JSON.stringify({ models: [{ name: "big:27b", size: 11e9, details: { parameter_size: "27B" } }, { name: "small:9b" }] }))
        : originalFetch(url, options);
    try {
      assert.deepEqual((await listOllamaModels()).map((m) => m.name), ["big:27b", "small:9b"]);
      await assert.rejects(setActiveModel("missing:1b"), { code: "MODEL_NOT_INSTALLED" });
      assert.equal((await setActiveModel("big:27b")).model, "big:27b");
      assert.equal(getActiveModel(), "big:27b");
      assert.equal(JSON.parse(readFileSync(process.env.CC_RUNTIME_STATE_FILE, "utf-8")).ollama.model, "big:27b");
    } finally {
      globalThis.fetch = originalFetch;
    }
    // A paired phone can switch too; a model that isn't installed is still refused.
    const fromPhone = await fetch(`${baseUrl}/api/ollama/model`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "missing:1b" })
    });
    assert.notEqual(fromPhone.status, 403);
    assert.equal((await fromPhone.json()).ok, false);
  });
});
