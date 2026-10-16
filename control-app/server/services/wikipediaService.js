import { spawn } from "child_process";
import { existsSync } from "fs";
import path from "path";
import { getBundledAppDirectory } from "../appPaths.js";

// The Wikipedia App is the GLESSER ARCHIVE librarian (wikipedia-app/librarian/
// librarian.py), a stdlib-only Python HTTP server. This service runs it as a
// managed child process the same way ollamaService.js manages `ollama serve`:
// reuse one that's already up, spawn one otherwise, and only ever kill the
// process this service spawned itself.

// Folder holding <lang>/<lang>wiki.sqlite + search_index.sqlite. The archive
// is read in place, read-only — it's tens of GB and never copied.
const WIKIPEDIA_DATA_DIR = process.env.WIKIPEDIA_DATA_DIR || "D:\\Glesser-Industries-Database\\Wikipedia\\organized";
const WIKIPEDIA_PYTHON = process.env.WIKIPEDIA_PYTHON || "python";
const LIBRARIAN_PORT = Number(process.env.WIKIPEDIA_LIBRARIAN_PORT || 8766);
const LIBRARIAN_BASE_URL = `http://127.0.0.1:${LIBRARIAN_PORT}`;
// Model for the librarian's own /agent chat page. Defaults to Control
// Center's model so opening that page never loads a second model into VRAM.
const LIBRARIAN_MODEL = process.env.WIKIPEDIA_LIBRARIAN_MODEL || process.env.OLLAMA_MODEL || "qwen3.5:9b";
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";
const STARTUP_TIMEOUT_MS = 30000;

let spawnedProcess = null;
let startPromise = null;
let lastError = null;

export function getWikipediaConfig() {
  return {
    baseUrl: LIBRARIAN_BASE_URL,
    port: LIBRARIAN_PORT,
    dataDir: WIKIPEDIA_DATA_DIR,
    python: WIKIPEDIA_PYTHON,
    script: getLibrarianScriptPath(),
    librarianModel: LIBRARIAN_MODEL
  };
}

function getLibrarianScriptPath() {
  return path.join(getBundledAppDirectory("wikipedia-app"), "librarian", "librarian.py");
}

// librarian.py's --data-dir is the folder that CONTAINS organized/, while
// WIKIPEDIA_DATA_DIR names organized/ itself — accept either.
function getLibrarianDataDirArg() {
  const resolved = path.resolve(WIKIPEDIA_DATA_DIR);
  return path.basename(resolved).toLowerCase() === "organized" ? path.dirname(resolved) : resolved;
}

/**
 * Returns true if a GLESSER ARCHIVE server with at least one indexed language
 * is answering on the configured port (ours or one started elsewhere).
 */
export async function probeLibrarian() {
  try {
    const res = await fetch(`${LIBRARIAN_BASE_URL}/api/v1`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) {
      return false;
    }
    const data = await res.json();
    return data?.name === "GLESSER ARCHIVE" && Array.isArray(data.languages) && data.languages.length > 0;
  } catch {
    return false;
  }
}

export async function getWikipediaStatus() {
  const running = await probeLibrarian();
  return {
    running,
    url: `${LIBRARIAN_BASE_URL}/`,
    spawnedByControlCenter: Boolean(spawnedProcess),
    dataDir: WIKIPEDIA_DATA_DIR,
    lastError: running ? null : lastError
  };
}

function spawnLibrarian() {
  const script = getLibrarianScriptPath();
  const args = [
    "-B", // never write __pycache__ next to the script
    script,
    "--data-dir",
    getLibrarianDataDirArg(),
    "--port",
    String(LIBRARIAN_PORT),
    "--no-browser",
    "--model",
    LIBRARIAN_MODEL,
    "--llm-url",
    OLLAMA_BASE_URL
  ];

  const child = spawn(WIKIPEDIA_PYTHON, args, {
    // Run from the app folder, never from inside the data directory.
    cwd: path.dirname(script),
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PYTHONIOENCODING: "utf-8" }
  });

  child.stdout.on("data", (chunk) => console.log(`[Wikipedia] ${String(chunk).trimEnd()}`));
  child.stderr.on("data", (chunk) => {
    const text = String(chunk).trimEnd();
    lastError = text.slice(-500);
    console.warn(`[Wikipedia] ${text}`);
  });
  child.on("error", (error) => {
    lastError = `Could not run '${WIKIPEDIA_PYTHON}': ${error.message}`;
    if (spawnedProcess === child) {
      spawnedProcess = null;
    }
  });
  child.on("exit", (code) => {
    if (code) {
      lastError = lastError || `Librarian exited with code ${code}.`;
    }
    if (spawnedProcess === child) {
      spawnedProcess = null;
    }
  });

  spawnedProcess = child;
}

/**
 * Ensures the librarian server is running, spawning it if needed. Concurrent
 * callers (opening the app while a tool call is starting it) share one start.
 */
export async function startWikipedia() {
  if (startPromise) {
    return startPromise;
  }

  startPromise = (async () => {
    if (await probeLibrarian()) {
      return { ok: true, alreadyRunning: true, ...(await getWikipediaStatus()) };
    }

    const script = getLibrarianScriptPath();
    if (!existsSync(script)) {
      return fail("WIKIPEDIA_APP_MISSING", `Librarian script not found at ${script}.`);
    }
    if (!existsSync(WIKIPEDIA_DATA_DIR)) {
      return fail("WIKIPEDIA_DATA_MISSING", `Wikipedia data folder not found: ${WIKIPEDIA_DATA_DIR}. Set WIKIPEDIA_DATA_DIR.`);
    }

    lastError = null;
    if (!spawnedProcess) {
      spawnLibrarian();
    }

    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (await probeLibrarian()) {
        console.log(`[Wikipedia] Librarian online at ${LIBRARIAN_BASE_URL}/`);
        return { ok: true, alreadyRunning: false, ...(await getWikipediaStatus()) };
      }
      if (!spawnedProcess) {
        break; // exited early — lastError says why
      }
    }

    return fail("WIKIPEDIA_START_FAILED", lastError || `Librarian did not come up on port ${LIBRARIAN_PORT}.`);
  })();

  try {
    return await startPromise;
  } finally {
    startPromise = null;
  }
}

/**
 * Stops the librarian only if this process spawned it — one started by the
 * user (or another Control Center) is left alone.
 */
export async function stopWikipedia() {
  const child = spawnedProcess;
  if (!child) {
    return { ok: true, stopped: false, message: "Librarian was not started by Control Center." };
  }

  spawnedProcess = null;
  try {
    if (process.platform === "win32" && child.pid) {
      await new Promise((resolve) => {
        const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
        killer.on("close", resolve);
        killer.on("error", resolve);
      });
    } else {
      child.kill();
    }
  } catch {
    // Ignore — it may already be gone.
  }
  return { ok: true, stopped: true, message: "Librarian stopped." };
}

function fail(code, message) {
  return { ok: false, code, message };
}
