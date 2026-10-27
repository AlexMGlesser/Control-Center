import { execFile } from "child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import path from "path";
import { getRuntimeLogPath } from "./runtimePersistenceService.js";

// Jarvis's process check (a systems diagnostic): list the PC's running
// processes into a text log, read the log back, flag anything that looks
// like malware, then delete the log. The checks are the usual red flags
// (system names in the wrong place, look-alike names, unsigned programs in
// Temp/Downloads, script one-liners that download or hide code). They're
// signs worth a look, not proof; and processes Windows won't show the path
// of (other users', protected ones) can only be checked by name.

const COLLECT_TIMEOUT_MS = 90_000;

// Name -> where the real one lives. Anything else with the name is a fake.
const SYSTEM_PROCESSES = new Map(
  [
    "svchost.exe", "lsass.exe", "csrss.exe", "winlogon.exe", "services.exe", "smss.exe", "wininit.exe",
    "spoolsv.exe", "taskhostw.exe", "dwm.exe", "conhost.exe", "rundll32.exe", "dllhost.exe", "sihost.exe",
    "ctfmon.exe", "fontdrvhost.exe", "lsaiso.exe", "searchindexer.exe", "wmiprvse.exe", "audiodg.exe"
  ].map((name) => [name, ["c:\\windows\\system32\\", "c:\\windows\\syswow64\\", "c:\\windows\\winsxs\\"]])
);
SYSTEM_PROCESSES.set("explorer.exe", ["c:\\windows\\explorer.exe", "c:\\windows\\syswow64\\explorer.exe"]);

// Places malware likes to run from, because any program can write there.
const RISKY_FOLDERS = [
  /\\appdata\\local\\temp\\/i,
  /\\windows\\temp\\/i,
  /\\downloads\\/i,
  /\\users\\public\\/i,
  /\\\$recycle\.bin\\/i,
  /^c:\\programdata\\[^\\]+\.exe$/i,
  /\\appdata\\roaming\\[^\\]+\.exe$/i
];

const SUSPICIOUS_COMMANDS = [
  [/\b(powershell|pwsh)(\.exe)?\b.*\s-(e|ec|en|enc|encodedcommand)\s/i, "PowerShell running an encoded (hidden) command"],
  [/\b(powershell|pwsh)(\.exe)?\b(?=.*(downloadstring|downloadfile|invoke-webrequest|iwr |net\.webclient|start-bitstransfer))(?=.*\b(iex|invoke-expression)\b)/i, "PowerShell downloading and running code"],
  [/\b(powershell|pwsh)(\.exe)?\b.*-w(indowstyle)?\s+hidden/i, "PowerShell started with a hidden window"],
  [/\bmshta(\.exe)?\b.*(https?:|javascript:|vbscript:)/i, "mshta running a script from the web or inline"],
  [/\brundll32(\.exe)?\b.*(javascript:|https?:)/i, "rundll32 running a script"],
  [/\bregsvr32(\.exe)?\b.*(\/i:\s*https?:|scrobj\.dll)/i, "regsvr32 loading a remote script"],
  [/\bcertutil(\.exe)?\b.*(-urlcache|-decode)/i, "certutil downloading or decoding a file"],
  [/\bbitsadmin(\.exe)?\b.*\/transfer/i, "bitsadmin downloading a file"],
  [/\b(wscript|cscript)(\.exe)?\b.*\\(temp|downloads)\\/i, "a script running from Temp or Downloads"]
];

const OFFICE_APPS = new Set(["winword.exe", "excel.exe", "powerpnt.exe", "outlook.exe", "msaccess.exe", "mspub.exe"]);
const SHELLS = new Set(["powershell.exe", "pwsh.exe", "cmd.exe", "wscript.exe", "cscript.exe", "mshta.exe"]);

/* ---------------- Collecting ---------------- */

// One query for every process, plus a signature check for the programs that
// aren't in Windows or Program Files (checking all of them would be slow).
const COLLECT_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$procs = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, ExecutablePath, CommandLine
$signatures = @{}
foreach ($exe in ($procs | Where-Object { $_.ExecutablePath } | Select-Object -ExpandProperty ExecutablePath -Unique)) {
  if ($exe -like "$env:windir\\*" -or $exe -like "$env:ProgramFiles\\*" -or $exe -like "\${env:ProgramFiles(x86)}\\*") { continue }
  $sig = Get-AuthenticodeSignature -LiteralPath $exe
  $signer = if ($sig.SignerCertificate) { $sig.SignerCertificate.GetNameInfo('SimpleName', $false) } else { '' }
  $signatures[$exe] = "$($sig.Status)|$signer"
}
$procs | ForEach-Object {
  [pscustomobject]@{
    pid = $_.ProcessId; ppid = $_.ParentProcessId; name = $_.Name; path = $_.ExecutablePath
    signature = if ($_.ExecutablePath -and $signatures.ContainsKey($_.ExecutablePath)) { $signatures[$_.ExecutablePath] } else { '' }
    commandLine = $_.CommandLine
  }
} | ConvertTo-Json -Compress
`;

function collectProcesses() {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", COLLECT_SCRIPT],
      { windowsHide: true, timeout: COLLECT_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout) => {
        if (error && !stdout) return reject(new Error(`Couldn't list processes: ${error.message}`));
        try {
          const parsed = JSON.parse(stdout);
          resolve(Array.isArray(parsed) ? parsed : [parsed]);
        } catch {
          reject(new Error("Couldn't read the process list."));
        }
      }
    );
  });
}

/* ---------------- The log file ---------------- */

const COLUMNS = ["PID", "PPID", "Name", "Signature", "Path", "CommandLine"];
const clean = (value) => String(value ?? "").replace(/[\t\r\n]+/g, " ");

function writeLog(processes, file) {
  const lines = [
    `Control Center process check, ${new Date().toISOString()}, ${processes.length} processes`,
    COLUMNS.join("\t"),
    ...processes.map((p) => [p.pid, p.ppid, p.name, p.signature, p.path, p.commandLine].map(clean).join("\t"))
  ];
  writeFileSync(file, lines.join("\n"), "utf-8");
}

function readLog(file) {
  const [, header, ...rows] = readFileSync(file, "utf-8").split("\n");
  const columns = header.split("\t");
  return rows.filter(Boolean).map((row) => {
    const values = row.split("\t");
    const record = Object.fromEntries(columns.map((column, index) => [column, values[index] ?? ""]));
    return {
      pid: Number(record.PID),
      ppid: Number(record.PPID),
      name: record.Name,
      signature: record.Signature,
      path: record.Path,
      commandLine: record.CommandLine
    };
  });
}

/* ---------------- Analysis ---------------- */

/** Edit distance where swapping two neighbors counts as one edit (svchost -> scvhost). */
function distance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

const trimCommand = (text) => {
  const value = String(text || "").replace(/[A-Za-z0-9+/=]{60,}/g, (blob) => `${blob.slice(0, 20)}…(${blob.length} chars)`);
  return value.length > 220 ? `${value.slice(0, 220)}…` : value;
};

/** Pure: process records in, findings out (testable without Windows). */
export function analyzeProcesses(processes) {
  const findings = [];
  const byPid = new Map(processes.map((p) => [p.pid, p]));
  const add = (severity, p, reason) =>
    findings.push({ severity, name: p.name, pid: p.pid, path: p.path || null, commandLine: p.commandLine ? trimCommand(p.commandLine) : null, reason });

  for (const p of processes) {
    const name = String(p.name || "").toLowerCase();
    const exe = String(p.path || "").toLowerCase();
    const [status, signer] = String(p.signature || "").split("|");

    // A system process name running from somewhere else.
    const realHomes = SYSTEM_PROCESSES.get(name);
    if (realHomes && exe && !realHomes.some((home) => exe.startsWith(home) || exe === home)) {
      add("high", p, `Has a Windows system process's name but runs from ${p.path}, not from Windows.`);
      continue;
    }

    // One letter off a system name (scvhost.exe, lsasss.exe). Two letters
    // catches real Windows programs (dasHost.exe vs dllhost.exe), and
    // anything that really lives in Windows is fine.
    if (!realHomes && !exe.startsWith("c:\\windows\\")) {
      const lookalike = [...SYSTEM_PROCESSES.keys()].find((system) => name.length > 6 && distance(name, system) === 1);
      if (lookalike) add("high", p, `Its name is one letter off the Windows process ${lookalike}.`);
    }

    // Script one-liners that download or hide code.
    for (const [pattern, reason] of SUSPICIOUS_COMMANDS) {
      if (p.commandLine && pattern.test(p.commandLine)) {
        add("high", p, `${reason}.`);
        break;
      }
    }

    // Office documents starting a shell is how many malicious attachments work.
    const parent = byPid.get(p.ppid);
    if (parent && SHELLS.has(name) && OFFICE_APPS.has(String(parent.name).toLowerCase())) {
      add("medium", p, `Started by ${parent.name}, which usually means a document ran a script.`);
    }

    // Programs running from Temp, Downloads and the like.
    if (exe && RISKY_FOLDERS.some((pattern) => pattern.test(exe))) {
      if (status === "Valid") add("low", p, `Runs from ${p.path}, an unusual place for a program (signed by ${signer || "a known publisher"}).`);
      else add("medium", p, `Runs from ${p.path} and isn't signed${status && status !== "NotSigned" ? ` (signature: ${status})` : ""}.`);
      continue;
    }

    // A broken or tampered signature anywhere outside Windows.
    if (["HashMismatch", "NotTrusted"].includes(status)) {
      add("medium", p, `Its digital signature is ${status === "HashMismatch" ? "broken: the file was changed after signing" : "not trusted"}.`);
    }
  }

  // One finding per program and reason (a browser may run 20 copies).
  const seen = new Set();
  const order = { high: 0, medium: 1, low: 2 };
  return findings
    .filter((finding) => {
      const key = `${finding.name}|${finding.path}|${finding.reason}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => order[a.severity] - order[b.severity]);
}

/* ---------------- The whole check ---------------- */

export async function runProcessCheck() {
  if (process.platform !== "win32") throw new Error("The process check works on Windows only.");
  const folder = path.dirname(getRuntimeLogPath());
  mkdirSync(folder, { recursive: true });
  const file = path.join(folder, `process-check-${Date.now()}.txt`);
  try {
    writeLog(await collectProcesses(), file);
    const processes = readLog(file);
    const findings = analyzeProcesses(processes);
    const hiddenPaths = processes.filter((p) => !p.path).length;
    return {
      checked: processes.length,
      withoutPath: hiddenPaths,
      findings,
      summary: findings.length ? `${findings.length} thing${findings.length === 1 ? "" : "s"} worth a look.` : "All processes normal."
    };
  } finally {
    // The log is only for this check: it never outlives it.
    rmSync(file, { force: true });
  }
}
