import { execFile, spawn, spawnSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import path from "path";
import { getBundledAppDirectory, getRuntimeDataRoot, isPackagedElectronRuntime } from "../appPaths.js";
import { publishEvent } from "./eventBus.js";

// File System is a native Python/Tkinter app, not a web bundle, so instead
// of a static route it runs as managed child processes: the gesture file
// explorer and the gesture recorder. Both open the webcam, so only one runs at
// a time. This service only ever signals PIDs it spawned itself.

const APP_ID = "file-system-app";
export const FILE_SYSTEM_VERSION = "0.1.0";

const PROCESS_SCRIPTS = {
  explorer: "file_explorer.py",
  recorder: "gesture_recorder.py"
};
const PROCESS_LABELS = {
  explorer: "File System",
  recorder: "Gesture Recorder"
};

// A Python/MediaPipe startup crash (missing module, bad model path) shows up
// within a second or two — waiting this long before reporting "launched"
// turns those into a real failure result instead of a false success.
const STARTUP_GRACE_MS = 2500;
// Third-party modules the explorer and recorder import (requirements.txt);
// "PIL" is Pillow's import name.
const REQUIRED_MODULES = ["cv2", "mediapipe", "numpy", "PIL"];
const PROBE_TIMEOUT_MS = 15000;
// Window close (WM_CLOSE) lets the app release the camera cleanly before we
// fall back to a forced tree kill.
const GRACEFUL_STOP_MS = 3000;
const FORCED_STOP_MS = 3000;
const OUTPUT_TAIL_LINES = 40;

const managed = { explorer: null, recorder: null };
// One app open can arrive through several paths at once (agent tool on the
// server plus the UI's own open via IPC/HTTP), so concurrent launches of the
// same kind share one in-flight promise instead of racing to spawn twice.
const pendingLaunch = { explorer: null, recorder: null };
const lastExit = { explorer: null, recorder: null };
let exitHookInstalled = false;
let resolvedPython = null;

export function getFileSystemAppDirectory() {
  return getBundledAppDirectory(APP_ID);
}

/**
 * User data (calibration profiles, recorded datasets). Dev runs keep it in
 * the app folder, matching standalone use; packaged builds can't write into
 * resources/, so they use the per-user runtime data root instead.
 */
export function getFileSystemDataDirectory() {
  const configured = String(process.env.FILE_SYSTEM_DATA_DIR || "").trim();
  if (configured) {
    return path.resolve(configured);
  }
  if (isPackagedElectronRuntime()) {
    return path.join(getRuntimeDataRoot(), APP_ID);
  }
  return getFileSystemAppDirectory();
}

/**
 * Picks the interpreter to run the app with. Whatever "pythonw" is first on
 * PATH isn't reliable: Control Center inherits the PATH of wherever it was
 * started from, and an activated venv there (e.g. a VS Code terminal) puts
 * a Python without OpenCV/MediaPipe first. So candidates are probed for the
 * modules the app imports, and the first one that has them all wins:
 *   1. FILE_SYSTEM_PYTHON, if set (then it is the only candidate)
 *   2. a venv inside the app folder (.venv)
 *   3. Windows: the registered Python, via the py launcher (PATH-independent)
 *   4. python / python3 from PATH
 * On Windows the winner's pythonw.exe is launched when it has one, so no
 * console window appears. The result is cached until a launch fails.
 */
export async function resolvePython() {
  if (resolvedPython) {
    return resolvedPython;
  }

  const tried = [];
  for (const candidate of pythonCandidates()) {
    const probe = await probePython(candidate);
    if (!probe) {
      continue;
    }
    if (tried.some((entry) => entry.executable === probe.executable)) {
      continue;
    }
    tried.push(probe);
    if (!probe.missing.length) {
      resolvedPython = ok({ executable: probe.executable, command: windowlessVariant(probe.executable) });
      return resolvedPython;
    }
  }

  const requirements = path.join(getFileSystemAppDirectory(), "requirements.txt");
  const detail = tried.length
    ? tried.map((entry) => `${entry.executable} (missing: ${entry.missing.join(", ")})`).join("; ")
    : "no Python interpreter was found";
  const fix = tried.length
    ? ` Install them with: "${tried[0].executable}" -m pip install -r "${requirements}"`
    : " Install Python 3.12, or set FILE_SYSTEM_PYTHON in control-app/.env.";
  return fail(
    "FILE_SYSTEM_PYTHON_DEPS_MISSING",
    `No Python with the File System app's packages (${REQUIRED_MODULES.join(", ")}) was found. Tried: ${detail}.${fix}`
  );
}

function pythonCandidates() {
  const candidates = [];
  const configured = String(process.env.FILE_SYSTEM_PYTHON || "").trim();
  if (configured) {
    // An explicit choice is honored, not silently swapped for another one.
    return [{ command: configured, args: [] }];
  }
  const venvPython =
    process.platform === "win32"
      ? path.join(getFileSystemAppDirectory(), ".venv", "Scripts", "python.exe")
      : path.join(getFileSystemAppDirectory(), ".venv", "bin", "python");
  if (existsSync(venvPython)) {
    candidates.push({ command: venvPython, args: [] });
  }
  if (process.platform === "win32") {
    candidates.push({ command: "py", args: ["-3"] });
    candidates.push({ command: "python", args: [] });
  } else {
    candidates.push({ command: "python3", args: [] });
  }
  return candidates;
}

// find_spec only locates each module — no import — so the probe is fast even
// though mediapipe itself takes seconds to import.
const PROBE_SCRIPT =
  "import importlib.util as u, sys\n" +
  `missing = [m for m in ${JSON.stringify(REQUIRED_MODULES)} if u.find_spec(m) is None]\n` +
  "print(sys.executable)\n" +
  "print(','.join(missing))\n";

function probePython({ command, args }) {
  return new Promise((resolve) => {
    execFile(
      command,
      [...args, "-c", PROBE_SCRIPT],
      { windowsHide: true, timeout: PROBE_TIMEOUT_MS },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        const [executable, missingLine = ""] = String(stdout).trim().split(/\r?\n/);
        if (!executable) {
          resolve(null);
          return;
        }
        resolve({ executable: executable.trim(), missing: missingLine.split(",").map((m) => m.trim()).filter(Boolean) });
      }
    );
  });
}

function windowlessVariant(executable) {
  if (process.platform !== "win32") {
    return executable;
  }
  const pythonw = path.join(path.dirname(executable), "pythonw.exe");
  return existsSync(pythonw) ? pythonw : executable;
}

export function getFileSystemStatus() {
  return ok({
    appId: APP_ID,
    version: FILE_SYSTEM_VERSION,
    python: resolvedPython?.command || "(chosen at first launch)",
    appDir: getFileSystemAppDirectory(),
    dataDir: getFileSystemDataDirectory(),
    processes: {
      explorer: describeProcess("explorer"),
      recorder: describeProcess("recorder")
    },
    dataset: readDatasetSummary()
  });
}

export function isFileSystemRunning(kind) {
  const kinds = kind ? [kind] : Object.keys(managed);
  return kinds.some((entry) => Boolean(managed[entry]));
}

/** Launch the gesture file explorer. */
export function launchFileExplorer() {
  return launchProcess("explorer", []);
}

/**
 * Launch the gesture recorder, optionally pre-configured. Options are
 * validated here and passed as an argv array (never through a shell).
 */
export function launchGestureRecorder(options = {}) {
  const parsed = parseRecorderOptions(options);
  if (!parsed.ok) {
    return Promise.resolve(parsed);
  }
  return launchProcess("recorder", parsed.args, parsed.options);
}

/** Stop one process kind, or both with "all". Resolves once they're gone. */
export async function stopFileSystem(kind = "all") {
  const kinds = kind === "all" ? Object.keys(managed) : [kind];
  if (!kinds.every((entry) => PROCESS_SCRIPTS[entry])) {
    return fail("INVALID_FILE_SYSTEM_PROCESS", "process must be one of explorer, recorder, or all.");
  }

  const stopped = [];
  for (const entry of kinds) {
    const wasRunning = Boolean(managed[entry]);
    if (wasRunning) {
      await stopProcess(entry);
    }
    stopped.push({ process: entry, wasRunning, running: Boolean(managed[entry]) });
  }

  return ok({ stopped, status: getFileSystemStatus() });
}

/** Called from Control Center shutdown. */
export async function shutdownFileSystem() {
  if (!isFileSystemRunning()) {
    return;
  }
  await stopFileSystem("all");
}

function launchProcess(kind, extraArgs, options = {}) {
  if (pendingLaunch[kind]) {
    return pendingLaunch[kind].then((result) => (result.ok ? { ...result, alreadyRunning: true, launched: false } : result));
  }
  pendingLaunch[kind] = spawnManaged(kind, extraArgs, options).finally(() => {
    pendingLaunch[kind] = null;
  });
  return pendingLaunch[kind];
}

async function spawnManaged(kind, extraArgs, options = {}) {
  if (managed[kind]?.stopPromise) {
    // Being closed right now (e.g. close then reopen) — let it finish first.
    await managed[kind].stopPromise;
  }
  if (managed[kind]) {
    return ok({ process: kind, alreadyRunning: true, ...describeProcess(kind) });
  }

  const appDir = getFileSystemAppDirectory();
  const scriptPath = path.join(appDir, PROCESS_SCRIPTS[kind]);
  if (!existsSync(scriptPath)) {
    return fail("FILE_SYSTEM_SCRIPT_MISSING", `File System script not found: ${scriptPath}`);
  }

  // Webcam is exclusive — stop the other process first.
  const other = kind === "explorer" ? "recorder" : "explorer";
  const stoppedOther = Boolean(managed[other]);
  if (stoppedOther) {
    await stopProcess(other);
  }

  const resolved = await resolvePython();
  if (!resolved.ok) {
    return resolved;
  }
  const python = resolved.command;
  const dataDir = getFileSystemDataDirectory();
  const args = ["-u", scriptPath, ...extraArgs];
  let child;
  try {
    child = spawn(python, args, {
      cwd: appDir,
      env: {
        ...process.env,
        FILE_SYSTEM_DATA_DIR: dataDir,
        PYTHONUNBUFFERED: "1",
        PYTHONDONTWRITEBYTECODE: "1"
      },
      stdio: ["ignore", "pipe", "pipe"],
      // Hide a console window only when it's a console interpreter; pythonw
      // has none, and hiding would risk hiding the Tk window's first show.
      windowsHide: !/pythonw(\.exe)?$/i.test(python),
      shell: false
    });
  } catch (error) {
    return fail("FILE_SYSTEM_SPAWN_FAILED", `Could not start ${python}: ${error?.message || error}`);
  }

  const entry = {
    child,
    pid: child.pid,
    startedAt: new Date().toISOString(),
    args: extraArgs,
    options,
    output: [],
    spawnError: null
  };
  managed[kind] = entry;
  installExitHook();

  const appendOutput = (chunk) => {
    String(chunk)
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .forEach((line) => {
        entry.output.push(line);
        if (entry.output.length > OUTPUT_TAIL_LINES) {
          entry.output.shift();
        }
      });
  };
  child.stdout?.on("data", appendOutput);
  child.stderr?.on("data", appendOutput);

  const exited = new Promise((resolve) => {
    child.once("error", (error) => {
      entry.spawnError = error?.message || String(error);
      resolve();
    });
    child.once("exit", (code, signal) => {
      lastExit[kind] = {
        code,
        signal,
        exitedAt: new Date().toISOString(),
        startedAt: entry.startedAt,
        stoppedByControlCenter: Boolean(entry.stopping),
        outputTail: entry.output.slice(-15)
      };
      if (managed[kind] === entry) {
        managed[kind] = null;
      }
      if (!entry.stopping) {
        publishEvent({
          source: "file-system",
          appId: APP_ID,
          type: "file-system-exit",
          message: `${PROCESS_LABELS[kind]} exited (code ${code ?? signal}).`,
          meta: { process: kind, code, signal }
        });
      }
      resolve();
    });
  });
  entry.exited = exited;

  const startedOk = await Promise.race([
    exited.then(() => false),
    new Promise((resolve) => setTimeout(() => resolve(true), STARTUP_GRACE_MS))
  ]);

  if (!startedOk || entry.spawnError) {
    if (managed[kind] === entry) {
      managed[kind] = null;
    }
    // Re-pick the interpreter next time rather than retrying a bad one.
    resolvedPython = null;
    const tail = entry.output.slice(-8).join("\n");
    const reason = entry.spawnError
      ? `Could not start '${python}': ${entry.spawnError}. Set FILE_SYSTEM_PYTHON to your Python interpreter.`
      : `${PROCESS_LABELS[kind]} exited during startup (code ${lastExit[kind]?.code}).`;
    return fail("FILE_SYSTEM_START_FAILED", tail ? `${reason}\n${tail}` : reason);
  }

  publishEvent({
    source: "file-system",
    appId: APP_ID,
    type: "file-system-launch",
    message: `${PROCESS_LABELS[kind]} launched.`,
    meta: { process: kind, pid: entry.pid, args: extraArgs }
  });

  return ok({ process: kind, launched: true, stoppedOther: stoppedOther ? other : null, ...describeProcess(kind) });
}

function stopProcess(kind) {
  const entry = managed[kind];
  if (!entry) {
    return Promise.resolve();
  }
  // Close can also arrive through several paths at once; share one stop.
  if (!entry.stopPromise) {
    entry.stopPromise = terminateEntry(kind, entry);
  }
  return entry.stopPromise;
}

async function terminateEntry(kind, entry) {
  entry.stopping = true;
  const pid = entry.pid;

  if (process.platform === "win32" && pid) {
    // Without /f, taskkill posts WM_CLOSE to the tree's windows, which runs
    // the app's own close handler (releases the camera). /t covers any
    // children the interpreter started.
    await runTaskkill(["/pid", String(pid), "/t"]);
    if (!(await waitForExit(entry, GRACEFUL_STOP_MS))) {
      await runTaskkill(["/pid", String(pid), "/t", "/f"]);
      await waitForExit(entry, FORCED_STOP_MS);
    }
  } else {
    try {
      entry.child.kill("SIGTERM");
    } catch {
      // Ignore — already gone.
    }
    if (!(await waitForExit(entry, GRACEFUL_STOP_MS))) {
      try {
        entry.child.kill("SIGKILL");
      } catch {
        // Ignore.
      }
      await waitForExit(entry, FORCED_STOP_MS);
    }
  }

  if (managed[kind] === entry) {
    managed[kind] = null;
  }

  publishEvent({
    source: "file-system",
    appId: APP_ID,
    type: "file-system-stop",
    message: `${PROCESS_LABELS[kind]} stopped.`,
    meta: { process: kind, pid }
  });
}

function waitForExit(entry, timeoutMs) {
  if (entry.child.exitCode !== null || entry.child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return Promise.race([
    entry.exited.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs))
  ]);
}

function runTaskkill(args) {
  return new Promise((resolve) => {
    const killer = spawn("taskkill", args, { windowsHide: true, stdio: "ignore" });
    killer.on("close", resolve);
    killer.on("error", resolve);
  });
}

// Last-resort cleanup if Node exits without going through shutdownFileSystem
// (crash, process.exit). Only synchronous work is possible here.
function installExitHook() {
  if (exitHookInstalled) {
    return;
  }
  exitHookInstalled = true;
  process.on("exit", () => {
    Object.values(managed).forEach((entry) => {
      if (!entry?.pid) {
        return;
      }
      try {
        if (process.platform === "win32") {
          spawnSync("taskkill", ["/pid", String(entry.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
        } else {
          entry.child.kill("SIGKILL");
        }
      } catch {
        // Ignore.
      }
    });
  });
}

function describeProcess(kind) {
  const entry = managed[kind];
  return {
    running: Boolean(entry),
    pid: entry?.pid || null,
    startedAt: entry?.startedAt || null,
    args: entry?.args || [],
    outputTail: entry ? entry.output.slice(-10) : [],
    lastExit: lastExit[kind]
  };
}

function readDatasetSummary() {
  const manifestPath = path.join(getFileSystemDataDirectory(), "dataset", "manifest.json");
  if (!existsSync(manifestPath)) {
    return { totalSamples: 0, labels: {}, updatedAt: null };
  }
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    return {
      totalSamples: Number(manifest.total_samples || 0),
      labels: manifest.labels || {},
      updatedAt: manifest.updated_at || null
    };
  } catch {
    return { totalSamples: 0, labels: {}, updatedAt: null, error: "manifest.json could not be read." };
  }
}

// Mirrors gesture_dataset.normalize_label() so the label Control Center
// reports is the label the recorder will actually save under.
export function normalizeGestureLabel(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/ /g, "_")
    .replace(/[^a-z0-9_-]+/g, "")
    .replace(/^[_-]+|[_-]+$/g, "")
    .slice(0, 64);
}

function parseRecorderOptions(options) {
  const args = [];
  const normalized = {};

  if (options.label !== undefined && options.label !== null && String(options.label).trim()) {
    const label = normalizeGestureLabel(options.label);
    if (!label) {
      return fail("INVALID_GESTURE_LABEL", "label may only contain letters, digits, spaces, '_' or '-'.");
    }
    normalized.label = label;
    args.push("--label", label);
  }

  if (options.reps !== undefined && options.reps !== null && options.reps !== "") {
    const reps = Number(options.reps);
    if (!Number.isInteger(reps) || reps < 1 || reps > 500) {
      return fail("INVALID_REPS", "reps must be a whole number from 1 to 500.");
    }
    normalized.reps = reps;
    args.push("--reps", String(reps));
  }

  if (options.duration !== undefined && options.duration !== null && options.duration !== "") {
    const duration = Number(options.duration);
    if (!Number.isFinite(duration) || duration < 0.5 || duration > 30) {
      return fail("INVALID_DURATION", "duration must be between 0.5 and 30 seconds.");
    }
    normalized.duration = duration;
    args.push("--duration", String(duration));
  }

  if (options.saveVideo === true) {
    normalized.saveVideo = true;
    args.push("--save-video");
  }

  if (options.autostart === true) {
    if (!normalized.label) {
      return fail("INVALID_RECORDER_OPTIONS", "autostart requires a label.");
    }
    normalized.autostart = true;
    args.push("--autostart");
  }

  return { ok: true, args, options: normalized };
}

function ok(data) {
  return { ok: true, ...data };
}

function fail(code, message) {
  return { ok: false, code, message };
}
