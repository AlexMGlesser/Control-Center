// Relative and device-targeted alarms. Uses a throwaway runtime state file
// and security folder, so real alarms and pairings are never touched.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";

const tempRoot = mkdtempSync(path.join(tmpdir(), "cc-alarm-test-"));
process.env.CC_SECURITY_DIR = path.join(tempRoot, "security");
process.env.CC_RUNTIME_STATE_FILE = path.join(tempRoot, "runtime.json");

const alarms = await import("../server/services/alarmService.js");
const { subscribeToEvents } = await import("../server/services/eventBus.js");
const { executeToolCall } = await import("../server/services/agentTools.js");
const { createServerApp } = await import("../server/index.js");
const auth = await import("../server/services/authService.js");

const phone = { id: "dev_phone", kind: "phone", name: "Test phone" };
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
  alarms.stopAlarmScheduler();
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("relative alarms", () => {
  test("inSeconds fires that far from now", () => {
    const before = Date.now();
    const alarm = alarms.createAlarm({ inSeconds: 30 });
    const fireAt = Date.parse(alarm.nextFireAt);
    assert.ok(fireAt >= before + 30_000 && fireAt <= Date.now() + 30_000, "within the second");
    assert.equal(alarm.recurrence.type, "once");
    assert.match(alarm.time, /^\d{2}:\d{2}$/);
    assert.ok(alarm.nextFireAtLocal);
    alarms.cancelAlarm(alarm.id);
  });

  test("bad durations are rejected", () => {
    for (const bad of [0, -5, 999_999_999, "abc"]) {
      assert.throws(() => alarms.createAlarm({ inSeconds: bad }), { code: "INVALID_DURATION" }, String(bad));
    }
  });

  test("the scheduler fires a short alarm on time, aimed at the right device", async () => {
    alarms.startAlarmScheduler();
    const fired = new Promise((resolve) => {
      const unsubscribe = subscribeToEvents((event) => {
        if (event.type === "alarm-fired") {
          unsubscribe();
          resolve({ event, at: Date.now() });
        }
      });
    });
    const created = alarms.createAlarm({ inSeconds: 1, device: phone, label: "Quick" });
    const { event, at } = await fired;
    const lateBy = at - Date.parse(created.nextFireAt);
    assert.ok(lateBy < 1000, `fired ${lateBy} ms after due (the 15 s poll alone could be 15 s late)`);
    assert.equal(event.meta.alarmId, created.id);
    assert.equal(event.meta.targetDeviceId, "dev_phone");
    alarms.stopAlarm(created.id);
    alarms.stopAlarmScheduler();
  });
});

describe("which device rings", () => {
  test("Jarvis sets the alarm for the device that asked", async () => {
    const fromPhone = await executeToolCall("set_alarm", { inSeconds: 120 }, { origin: { type: "user", device: phone } });
    assert.equal(fromPhone.ok, true);
    assert.equal(fromPhone.alarm.deviceId, "dev_phone");

    const fromPc = await executeToolCall("set_alarm", { inSeconds: 120 }, { origin: { type: "user", device: { id: "desktop", kind: "desktop" } } });
    assert.equal(fromPc.alarm.deviceId, undefined, "PC alarms ring on the PC");

    const clockTime = await executeToolCall("set_alarm", { time: "07:30", recurrence: "once" }, { origin: { type: "user", device: phone } });
    assert.equal(clockTime.alarm.deviceId, "dev_phone");

    for (const alarm of [fromPhone.alarm, fromPc.alarm, clockTime.alarm]) alarms.cancelAlarm(alarm.id);
  });

  test("a phone can only cancel or stop its own alarms", async () => {
    const { device, token } = auth.createDevice({ name: "Phone" });
    const pcAlarm = alarms.createAlarm({ inSeconds: 600 });
    const phoneAlarm = alarms.createAlarm({ inSeconds: 600, device: { id: device.id, kind: "phone" } });
    const headers = { Authorization: `Bearer ${token}` };

    const denied = await fetch(`${baseUrl}/api/alarms/${pcAlarm.id}`, { method: "DELETE", headers });
    assert.equal(denied.status, 403);
    const allowed = await fetch(`${baseUrl}/api/alarms/${phoneAlarm.id}`, { method: "DELETE", headers });
    assert.equal(allowed.status, 200);

    const created = await fetch(`${baseUrl}/api/alarms`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ inSeconds: 60 })
    });
    assert.equal(created.status, 201);
    assert.equal((await created.json()).alarm.deviceId, device.id, "created from the phone, rings on the phone");

    const desktopDelete = await fetch(`${baseUrl}/api/alarms/${pcAlarm.id}`, { method: "DELETE", headers: { Cookie: desktopCookie } });
    assert.equal(desktopDelete.status, 200);
  });
});
