// The hardware-health assessors, on made-up readings (no Windows needed).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  assessCpu,
  assessDrives,
  assessErrors,
  assessGpu,
  assessMemory,
  runHardwareCheck,
  worstStatus
} from "../server/services/systemHealthService.js";

describe("system health assessors", () => {
  test("worstStatus ranks severity and ignores unavailable", () => {
    assert.equal(worstStatus(["ok", "warn", "ok"]), "warn");
    assert.equal(worstStatus(["ok", "critical", "warn"]), "critical");
    assert.equal(worstStatus(["ok", "unavailable"]), "ok");
    assert.equal(worstStatus(["unavailable", "unavailable"]), "unavailable");
  });

  test("CPU: normal is ok, pegged load warns, missing is unavailable", () => {
    assert.equal(assessCpu({ name: "Ryzen", cores: 8, logical: 16, load: 30, clockMHz: 4200 }).status, "ok");
    assert.equal(assessCpu({ name: "Ryzen", cores: 8, logical: 16, load: 99 }).status, "warn");
    assert.equal(assessCpu(null).status, "unavailable");
  });

  test("GPU: hot is critical, warm is warn, none is unavailable", () => {
    assert.equal(assessGpu({ name: "RTX", tempC: 45, utilPct: 10, memUsedMiB: 1024, memTotalMiB: 16376 }).status, "ok");
    assert.equal(assessGpu({ name: "RTX", tempC: 86, utilPct: 99 }).status, "warn");
    assert.equal(assessGpu({ name: "RTX", tempC: 92, utilPct: 99 }).status, "critical");
    assert.equal(assessGpu(null).status, "unavailable");
  });

  test("drives: unhealthy is critical, worn/errored is warn, healthy is ok", () => {
    const healthy = assessDrives([{ name: "SSD", media: "SSD", health: "Healthy", wear: 2 }]);
    assert.equal(healthy.status, "ok");
    assert.equal(assessDrives([{ name: "D", media: "SSD", health: "Unhealthy" }]).status, "critical");
    assert.equal(assessDrives([{ name: "D", media: "SSD", health: "Healthy", wear: 85 }]).status, "warn");
    assert.equal(assessDrives([{ name: "D", media: "HDD", health: "Healthy", readErrors: 3 }]).status, "warn");
    // The worst drive sets the overall status.
    const mixed = assessDrives([{ name: "A", media: "SSD", health: "Healthy" }, { name: "B", media: "SSD", health: "Warning" }]);
    assert.equal(mixed.status, "critical");
  });

  test("memory: high use warns", () => {
    assert.equal(assessMemory({ totalKB: 32 * 1024 * 1024, freeKB: 16 * 1024 * 1024 }).status, "ok");
    assert.equal(assessMemory({ totalKB: 32 * 1024 * 1024, freeKB: 1 * 1024 * 1024 }).status, "warn");
  });

  test("errors: WHEA is critical, disk-only is warn, none is ok", () => {
    assert.equal(assessErrors({ wheaCount: 0, diskCount: 0 }).status, "ok");
    assert.equal(assessErrors({ wheaCount: 0, diskCount: 2 }).status, "warn");
    assert.equal(assessErrors({ wheaCount: 1, diskCount: 0 }).status, "critical");
  });

  test("an unknown component is rejected", async () => {
    await assert.rejects(runHardwareCheck("teapot"), { code: "UNKNOWN_CHECK" });
  });
});
