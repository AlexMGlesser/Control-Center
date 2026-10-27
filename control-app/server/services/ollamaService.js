import { spawn } from "child_process";
import { readRuntimeSection, writeRuntimeSection } from "./runtimePersistenceService.js";

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";
// The .env model is the default; Settings > AI Model on the PC can pick
// another installed model, which is remembered across restarts.
const DEFAULT_MODEL = process.env.OLLAMA_MODEL || "qwen3.5:9b";
const PROBE_INTERVAL_MS = 5000;

let spawnedProcess = null;
let probeTimer = null;
let lastKnownState = { status: "not_connected", model: null };
let activeModel = String(readRuntimeSection("ollama", null)?.model || "").trim() || DEFAULT_MODEL;

export function getOllamaConfig() {
  return { baseUrl: OLLAMA_BASE_URL, model: activeModel, defaultModel: DEFAULT_MODEL };
}

export function getActiveModel() {
  return activeModel;
}

export function getOllamaState() {
  return { ...lastKnownState };
}

export function markOllamaOffline() {
  lastKnownState = { status: "not_connected", model: null };
  return null;
}

export async function probeOllamaStatus() {
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) {
      throw new Error(`status ${res.status}`);
    }
    const data = await res.json();
    const models = Array.isArray(data?.models) ? data.models : [];
    const modelPulled = models.some((entry) => entry?.name === activeModel || entry?.model === activeModel);
    lastKnownState = { status: "connected", model: activeModel, modelPulled };
    return true;
  } catch {
    lastKnownState = { status: "not_connected", model: null };
    return false;
  }
}

export function startOllamaProbe() {
  if (probeTimer) {
    return;
  }
  probeOllamaStatus();
  probeTimer = setInterval(probeOllamaStatus, PROBE_INTERVAL_MS);
}

export function stopOllamaProbe() {
  if (probeTimer) {
    clearInterval(probeTimer);
    probeTimer = null;
  }
}

function spawnOllamaServe() {
  return new Promise((resolve) => {
    try {
      // Not detached on Windows: a detached child gets no console, so every
      // runner ollama serve launches (llama-server, gpu-discover — several
      // per chat request) pops its own console window for a moment. Attached
      // and hidden, those runners share this one hidden console instead.
      // stopOllama() still kills the tree on shutdown either way.
      const detached = process.platform !== "win32";
      spawnedProcess = spawn("ollama", ["serve"], { shell: false, windowsHide: true, stdio: "ignore", detached });
      spawnedProcess.on("error", () => {
        spawnedProcess = null;
      });
      spawnedProcess.on("exit", () => {
        spawnedProcess = null;
      });
      spawnedProcess.unref();
    } catch {
      spawnedProcess = null;
    }
    setTimeout(resolve, 1500);
  });
}

/**
 * Ensures the Ollama daemon is running (spawning it if this process needs to)
 * and warms the configured model into memory.
 */
export async function startOllama() {
  const alreadyUp = await probeOllamaStatus();

  if (!alreadyUp) {
    await spawnOllamaServe();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      if (await probeOllamaStatus()) {
        break;
      }
    }
  }

  try {
    await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: activeModel, messages: [{ role: "user", content: "hi" }], stream: false })
    });
  } catch {
    // Model may not be pulled yet — status will reflect modelPulled: false.
  }

  await probeOllamaStatus();
  return getOllamaState();
}

/**
 * Unloads the model from memory (keep_alive: 0) and stops the daemon if this
 * process was the one that spawned it.
 */
export async function stopOllama() {
  // Only a daemon we're leaving running needs its model unloaded — one we
  // spawned is about to be killed, and asking it to unload first just spins
  // up more runner processes during shutdown. Bounded so a busy or hung
  // daemon can't stall app exit.
  if (!spawnedProcess) {
    await unloadModel(activeModel);
  }

  if (spawnedProcess) {
    try {
      if (process.platform === "win32" && spawnedProcess.pid) {
        // ollama serve launches its own backend runner as a child of the
        // process we spawned — spawnedProcess.kill() only signals that
        // top-level process, leaving the runner orphaned. taskkill's /T
        // takes the whole tree down. Awaited so it's done before the caller
        // (app shutdown) proceeds to exit.
        await new Promise((resolve) => {
          const killer = spawn("taskkill", ["/pid", String(spawnedProcess.pid), "/t", "/f"], {
            windowsHide: true,
            stdio: "ignore"
          });
          killer.on("close", resolve);
          killer.on("error", resolve);
        });
      } else {
        spawnedProcess.kill();
      }
    } catch {
      // Ignore.
    }
    spawnedProcess = null;
  }

  markOllamaOffline();
  return { ok: true, message: "Ollama model unloaded." };
}

async function unloadModel(model) {
  try {
    await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages: [], stream: false, keep_alive: 0 }),
      signal: AbortSignal.timeout(3000)
    });
  } catch {
    // Ignore — daemon may already be down.
  }
}

/** The models installed in Ollama, for the model picker. */
export async function listOllamaModels() {
  const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
  if (!res.ok) throw new Error(`Ollama responded with status ${res.status}.`);
  const data = await res.json();
  return (Array.isArray(data?.models) ? data.models : [])
    .map((entry) => ({
      name: String(entry.name || entry.model || ""),
      size: Number(entry.size) || null,
      parameterSize: entry.details?.parameter_size || null,
      quantization: entry.details?.quantization_level || null
    }))
    .filter((entry) => entry.name)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Switches every Ollama caller (Jarvis, the IDE's AI panel) to another
 * installed model. The old one is unloaded first, so two big models never
 * share the GPU; the new one loads on its next request.
 */
export async function setActiveModel(model) {
  const name = String(model || "").trim();
  const installed = await listOllamaModels();
  if (!installed.some((entry) => entry.name === name)) {
    const error = new Error(`${name || "That model"} isn't installed in Ollama. Pull it first: ollama pull ${name || "<model>"}`);
    error.code = "MODEL_NOT_INSTALLED";
    error.status = 400;
    throw error;
  }
  const previous = activeModel;
  if (previous !== name) await unloadModel(previous);
  activeModel = name;
  writeRuntimeSection("ollama", { model: name === DEFAULT_MODEL ? null : name });
  if (lastKnownState.status === "connected") lastKnownState = { ...lastKnownState, model: name, modelPulled: true };
  return { previous, model: name };
}

/**
 * Sends a chat completion request with optional tool definitions.
 * Returns { ok, rawText } — the model's raw text response. Tool-call intent
 * is expressed in that text as {system | request | ...} envelopes (see
 * envelopeProtocol.js), not via Ollama's structured tool-calling API.
 */
export async function requestOllamaChatCompletion({ messages, timeoutMs = 120000, temperature }) {
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: activeModel,
        messages,
        think: false,
        stream: false,
        // Ollama's default context window (4096) is too small for this
        // system's prompt (tool catalog + role doc + growing chat history) —
        // once a retry or a few chat turns accumulate, requests were hitting
        // the wall and getting truncated to a single token. Model supports
        // far more; 16384 comfortably covers real usage with headroom.
        options: { num_ctx: 16384, ...(temperature !== undefined ? { temperature } : {}) }
      }),
      signal: AbortSignal.timeout(timeoutMs)
    });

    if (!res.ok) {
      return {
        ok: false,
        code: "OLLAMA_REQUEST_FAILED",
        message: `Ollama responded with status ${res.status}.`
      };
    }

    const data = await res.json();
    console.log(
      `[Ollama] done_reason=${data.done_reason} prompt_eval_count=${data.prompt_eval_count} eval_count=${data.eval_count}`
    );
    return {
      ok: true,
      rawText: String(data.message?.content || ""),
      // "length" means the reply hit the context window and was cut off.
      doneReason: data.done_reason || null
    };
  } catch (error) {
    const cause = error?.cause?.message || error?.cause?.code || "";
    console.error("[Ollama] Chat completion failed:", error?.message, cause ? `(${cause})` : "");
    return {
      ok: false,
      code: "OLLAMA_UNAVAILABLE",
      message: [error?.message, cause].filter(Boolean).join(" — ") || "Ollama request failed."
    };
  }
}
