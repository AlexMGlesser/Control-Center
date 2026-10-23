// Phone-only apps ("Hack the mainframe"): Jarvis opens them on the phone
// that asked, and says so when asked from anywhere else.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";

const tempRoot = mkdtempSync(path.join(tmpdir(), "cc-phone-apps-test-"));
process.env.CC_SECURITY_DIR = path.join(tempRoot, "security");
process.env.CC_RUNTIME_STATE_FILE = path.join(tempRoot, "runtime.json");

const { executeToolCall } = await import("../server/services/agentTools.js");
const { subscribeToEvents } = await import("../server/services/eventBus.js");

after(() => rmSync(tempRoot, { recursive: true, force: true }));

const from = (kind) => ({ origin: { type: "user", device: { id: kind === "desktop" ? "desktop" : `dev_${kind}`, kind, name: kind } } });

describe("Hack the mainframe", () => {
  test("asked from the phone, it opens on that phone", async () => {
    const events = [];
    const unsubscribe = subscribeToEvents((event) => events.push(event));
    const result = await executeToolCall("open_app", { target: "Hack the mainframe" }, from("phone"));
    unsubscribe();
    assert.equal(result.ok, true);
    assert.equal(result.target, "hack-mainframe");
    const opened = events.find((event) => event.type === "open-app");
    assert.equal(opened.meta.target, "hack-mainframe");
    assert.equal(opened.meta.targetDeviceId, "dev_phone");
  });

  test("asked from the PC or a laptop, Jarvis says it's phone-only", async () => {
    for (const kind of ["desktop", "laptop"]) {
      const result = await executeToolCall("open_app", { target: "hack-mainframe" }, from(kind));
      assert.equal(result.ok, false, kind);
      assert.equal(result.code, "PHONE_ONLY_APP");
    }
  });
});
