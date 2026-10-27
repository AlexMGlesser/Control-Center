import { execFile } from "child_process";
import { getAllApps } from "./appRegistry.js";
import { getOllamaState } from "./ollamaService.js";
import { getActiveModel } from "./ollamaService.js";
import { runProcessCheck } from "./processCheckService.js";

// Jarvis's hardware health checks and the system diagnostic. Each piece is
// its own request ("check my CPU", "do a GPU scan"), or "all" runs the whole
// hardware sweep. The diagnostic is separate: the process check plus the app
// center and loaded-model status. Everything here is read-only and needs no
// admin rights; what Windows won't report (e.g. a drive that hides its SMART
// counters, or CPU temperature, which has no built-in source) is reported as
// "unknown" rather than treated as a problem.

const COLLECT_TIMEOUT_MS = 60_000;
const ERROR_WINDOW_DAYS = 14;

export const HARDWARE_COMPONENTS = ["cpu", "gpu", "drives", "memory", "errors"];
const STATUS_RANK = { ok: 0, unavailable: 1, warn: 2, critical: 3 };

/** The worst status in the list wins; all-unavailable stays unavailable. */
export function worstStatus(statuses) {
  const real = statuses.filter((s) => s && s !== "unavailable");
  if (!real.length) return statuses.includes("unavailable") ? "unavailable" : "ok";
  return real.reduce((worst, s) => (STATUS_RANK[s] > STATUS_RANK[worst] ? s : worst), "ok");
}

/* ---------------- Assessors (pure: testable without Windows) ---------------- */

export function assessCpu(cpu) {
  if (!cpu || !cpu.name) return { status: "unavailable", summary: "Couldn't read the CPU." };
  const load = typeof cpu.load === "number" ? cpu.load : null;
  const status = load !== null && load >= 97 ? "warn" : "ok";
  const ghz = cpu.clockMHz ? ` at ${(cpu.clockMHz / 1000).toFixed(1)} GHz` : "";
  return {
    status,
    summary:
      `${cpu.name} (${cpu.cores} cores / ${cpu.logical} threads)${ghz}, ` +
      (load !== null ? `${load}% load right now.` : "load unavailable.") +
      (status === "warn" ? " Running flat out." : ""),
    details: { ...cpu, note: "CPU temperature has no built-in Windows source; use HWiNFO64 or LibreHardwareMonitor for that." }
  };
}

export function assessMemory(memory) {
  if (!memory || !memory.totalKB) return { status: "unavailable", summary: "Couldn't read memory." };
  const totalGB = memory.totalKB / 1024 / 1024;
  const freeGB = (memory.freeKB || 0) / 1024 / 1024;
  const usedPct = Math.round(((memory.totalKB - (memory.freeKB || 0)) / memory.totalKB) * 100);
  return {
    status: usedPct >= 95 ? "warn" : "ok",
    summary: `${usedPct}% of ${totalGB.toFixed(0)} GB RAM in use (${freeGB.toFixed(1)} GB free).`,
    details: { totalGB: Number(totalGB.toFixed(1)), freeGB: Number(freeGB.toFixed(1)), usedPercent: usedPct }
  };
}

export function assessGpu(gpu) {
  if (!gpu) return { status: "unavailable", summary: "No NVIDIA GPU found (nvidia-smi isn't available)." };
  const temp = gpu.tempC;
  const status = temp >= 90 ? "critical" : temp >= 84 ? "warn" : "ok";
  const hot = status === "critical" ? " — that's very hot." : status === "warn" ? " — running warm." : "";
  const mem = gpu.memUsedMiB != null && gpu.memTotalMiB ? `, ${Math.round(gpu.memUsedMiB / 1024)}/${Math.round(gpu.memTotalMiB / 1024)} GB VRAM` : "";
  const power = gpu.powerW != null && gpu.powerLimitW ? `, ${Math.round(gpu.powerW)}/${Math.round(gpu.powerLimitW)} W` : "";
  return {
    status,
    summary: `${gpu.name}: ${temp}°C, ${gpu.utilPct ?? "?"}% load${mem}${power}${hot}`,
    details: gpu
  };
}

function assessOneDrive(drive) {
  const health = String(drive.health || "").toLowerCase();
  const findings = [];
  let status = "ok";
  if (health && health !== "healthy") {
    status = "critical";
    findings.push(`health is "${drive.health}"`);
  }
  if (typeof drive.wear === "number" && drive.wear >= 80) {
    status = worstStatus([status, drive.wear >= 90 ? "critical" : "warn"]);
    findings.push(`${drive.wear}% worn`);
  }
  if ((drive.readErrors || 0) > 0 || (drive.writeErrors || 0) > 0) {
    status = worstStatus([status, "warn"]);
    findings.push(`${(drive.readErrors || 0) + (drive.writeErrors || 0)} read/write errors`);
  }
  const hot = drive.media === "HDD" ? 60 : 70;
  if (typeof drive.temp === "number" && drive.temp >= hot) {
    status = worstStatus([status, "warn"]);
    findings.push(`${drive.temp}°C`);
  }
  return { ...drive, status, findings };
}

export function assessDrives(drives) {
  if (!Array.isArray(drives) || !drives.length) return { status: "unavailable", summary: "Couldn't read any drives." };
  const assessed = drives.map(assessOneDrive);
  const status = worstStatus(assessed.map((d) => d.status));
  const bad = assessed.filter((d) => d.status !== "ok");
  const summary = bad.length
    ? bad.map((d) => `${d.name}: ${d.findings.join(", ")}`).join("; ")
    : `All ${assessed.length} drive${assessed.length === 1 ? "" : "s"} healthy.`;
  return { status, summary, details: { drives: assessed } };
}

export function assessErrors(errors) {
  if (!errors) return { status: "unavailable", summary: "Couldn't read the event log." };
  const whea = errors.wheaCount || 0;
  const disk = errors.diskCount || 0;
  const status = whea > 0 ? "critical" : disk > 0 ? "warn" : "ok";
  const summary =
    whea > 0
      ? `${whea} hardware (WHEA) error${whea === 1 ? "" : "s"} in the last ${ERROR_WINDOW_DAYS} days — worth investigating.`
      : disk > 0
        ? `No hardware errors, but ${disk} disk warning${disk === 1 ? "" : "s"} in the event log.`
        : `No hardware or disk errors in the last ${ERROR_WINDOW_DAYS} days.`;
  return { status, summary, details: { ...errors, windowDays: ERROR_WINDOW_DAYS } };
}

const ASSESSORS = {
  cpu: (raw) => assessCpu(raw.cpu),
  memory: (raw) => assessMemory(raw.memory),
  gpu: (raw) => assessGpu(raw.gpu),
  drives: (raw) => assessDrives(raw.drives),
  errors: (raw) => assessErrors(raw.errors)
};

/* ---------------- Collection (PowerShell + nvidia-smi) ---------------- */

function psSection(component) {
  switch (component) {
    case "cpu":
      return `$c = Get-CimInstance Win32_Processor | Select-Object -First 1
$out.cpu = @{ name = $c.Name.Trim(); cores = $c.NumberOfCores; logical = $c.NumberOfLogicalProcessors; load = $c.LoadPercentage; clockMHz = $c.CurrentClockSpeed; maxClockMHz = $c.MaxClockSpeed }`;
    case "memory":
      return `$os = Get-CimInstance Win32_OperatingSystem
$out.memory = @{ totalKB = $os.TotalVisibleMemorySize; freeKB = $os.FreePhysicalMemory }`;
    case "drives":
      return `$out.drives = @(Get-PhysicalDisk | ForEach-Object {
  $rc = $_ | Get-StorageReliabilityCounter -ErrorAction SilentlyContinue
  @{ name = $_.FriendlyName; media = $_.MediaType.ToString(); sizeGB = [math]::Round($_.Size/1GB); health = $_.HealthStatus.ToString(); op = $_.OperationalStatus.ToString(); temp = $rc.Temperature; wear = $rc.Wear; powerOnHours = $rc.PowerOnHours; readErrors = $rc.ReadErrorsTotal; writeErrors = $rc.WriteErrorsTotal }
})`;
    case "errors":
      return `$since = (Get-Date).AddDays(-${ERROR_WINDOW_DAYS})
$whea = @(Get-WinEvent -FilterHashtable @{LogName='System';ProviderName='Microsoft-Windows-WHEA-Logger';StartTime=$since} -ErrorAction SilentlyContinue)
$diskEv = @(Get-WinEvent -FilterHashtable @{LogName='System';ProviderName='disk';StartTime=$since} -ErrorAction SilentlyContinue)
$out.errors = @{ wheaCount = $whea.Count; diskCount = $diskEv.Count; whea = @($whea | Select-Object -First 10 | ForEach-Object { @{ time = $_.TimeCreated.ToString('s'); id = $_.Id; level = "$($_.LevelDisplayName)" } }) }`;
    default:
      return "";
  }
}

function collectViaPowerShell(components) {
  const sections = components.map(psSection).filter(Boolean);
  if (!sections.length) return Promise.resolve({});
  const script = `$ErrorActionPreference='SilentlyContinue'; $out=@{}; ${sections.join("\n")}
$out | ConvertTo-Json -Depth 6 -Compress`;
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true, timeout: COLLECT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => {
        if (error && !stdout) return reject(new Error(`Couldn't read hardware status: ${error.message}`));
        try {
          const parsed = JSON.parse(stdout);
          // A single drive comes back as an object, not a one-item array.
          if (parsed.drives && !Array.isArray(parsed.drives)) parsed.drives = [parsed.drives];
          resolve(parsed);
        } catch {
          reject(new Error("Couldn't read hardware status."));
        }
      }
    );
  });
}

function collectGpu() {
  const fields = "name,temperature.gpu,utilization.gpu,memory.used,memory.total,power.draw,power.limit,fan.speed";
  return new Promise((resolve) => {
    execFile(
      "nvidia-smi",
      [`--query-gpu=${fields}`, "--format=csv,noheader,nounits"],
      { windowsHide: true, timeout: 15_000 },
      (error, stdout) => {
        if (error || !stdout.trim()) return resolve(null);
        // First GPU only (this PC has one).
        const [name, temp, util, memUsed, memTotal, power, powerLimit, fan] = stdout.trim().split("\n")[0].split(",").map((v) => v.trim());
        const num = (v) => (v === "" || v === "[N/A]" || v == null ? null : Number(v));
        resolve({
          name,
          tempC: num(temp),
          utilPct: num(util),
          memUsedMiB: num(memUsed),
          memTotalMiB: num(memTotal),
          powerW: num(power),
          powerLimitW: num(powerLimit),
          fanPct: num(fan)
        });
      }
    );
  });
}

async function collect(components) {
  const needsPs = components.filter((c) => c !== "gpu");
  if (needsPs.length && process.platform !== "win32") {
    throw new Error("Hardware checks other than the GPU work on Windows only.");
  }
  const [psData, gpu] = await Promise.all([
    needsPs.length ? collectViaPowerShell(needsPs) : Promise.resolve({}),
    components.includes("gpu") ? collectGpu() : Promise.resolve(undefined)
  ]);
  return gpu === undefined ? psData : { ...psData, gpu };
}

/* ---------------- The checks ---------------- */

const LABELS = { cpu: "CPU", gpu: "GPU", drives: "Drives", memory: "Memory", errors: "Hardware errors" };

/**
 * One hardware check, or the full sweep. `component` is one of
 * HARDWARE_COMPONENTS, or "all" / "full" for everything.
 */
export async function runHardwareCheck(component = "all") {
  const scope = String(component || "all").toLowerCase();
  const components = scope === "all" || scope === "full" ? [...HARDWARE_COMPONENTS] : [scope];
  const unknown = components.filter((c) => !HARDWARE_COMPONENTS.includes(c));
  if (unknown.length) {
    const error = new Error(`Unknown check "${unknown[0]}". Choose ${HARDWARE_COMPONENTS.join(", ")}, or "all".`);
    error.code = "UNKNOWN_CHECK";
    throw error;
  }

  const raw = await collect(components);
  const results = {};
  for (const c of components) results[c] = { label: LABELS[c], ...ASSESSORS[c](raw) };

  const status = worstStatus(components.map((c) => results[c].status));
  const flagged = components.filter((c) => results[c].status === "warn" || results[c].status === "critical");
  const isSweep = components.length > 1;
  const summary = flagged.length
    ? `${flagged.map((c) => LABELS[c]).join(", ")} need${flagged.length === 1 ? "s" : ""} a look.`
    : isSweep
      ? "Everything checks out."
      : results[components[0]].summary;

  return { scope: isSweep ? "all" : components[0], status, summary, components: results };
}

/**
 * The system diagnostic: the process check, plus the app center and the
 * loaded AI model. Not hardware — that's runHardwareCheck.
 */
export async function runSystemDiagnostic() {
  const processes = await runProcessCheck();

  const apps = getAllApps();
  const offline = apps.filter((a) => !["online", "live"].includes(String(a.status || "").toLowerCase()));
  const appCenter = {
    total: apps.length,
    offline: offline.map((a) => a.name),
    status: offline.length ? "warn" : "ok",
    summary: offline.length ? `${offline.length} of ${apps.length} apps not online.` : `All ${apps.length} apps online.`
  };

  const ollama = getOllamaState();
  const connected = ollama.status === "connected";
  const model = ollama.model || getActiveModel();
  const llm = {
    status: connected ? (ollama.modelPulled === false ? "warn" : "ok") : "critical",
    connected,
    model,
    modelPulled: ollama.modelPulled !== false,
    summary: connected
      ? ollama.modelPulled === false
        ? `Ollama is up but ${model} isn't pulled yet.`
        : `Ollama connected, model ${model} ready.`
      : "Ollama isn't connected."
  };

  const status = worstStatus([processes.findings.length ? "warn" : "ok", appCenter.status, llm.status]);
  return {
    status,
    summary: `${processes.summary} ${appCenter.summary} ${llm.summary}`,
    processes,
    appCenter,
    llm
  };
}
