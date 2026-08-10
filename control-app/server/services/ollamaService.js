import { spawn } from "child_process";

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "qwen3.5:9b";
const PROBE_INTERVAL_MS = 5000;

let spawnedProcess = null;
let probeTimer = null;
let lastKnownState = { status: "not_connected", model: null };

export function getOllamaConfig() {
  return { baseUrl: OLLAMA_BASE_URL, model: OLLAMA_MODEL };
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
    const modelPulled = models.some((entry) => entry?.name === OLLAMA_MODEL || entry?.model === OLLAMA_MODEL);
    lastKnownState = { status: "connected", model: OLLAMA_MODEL, modelPulled };
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
      spawnedProcess = spawn("ollama", ["serve"], { shell: false, windowsHide: true, stdio: "ignore", detached: true });
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
      body: JSON.stringify({ model: OLLAMA_MODEL, messages: [{ role: "user", content: "hi" }], stream: false })
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
  try {
    await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: OLLAMA_MODEL, messages: [], stream: false, keep_alive: 0 })
    });
  } catch {
    // Ignore — daemon may already be down.
  }

  if (spawnedProcess) {
    try {
      spawnedProcess.kill();
    } catch {
      // Ignore.
    }
    spawnedProcess = null;
  }

  markOllamaOffline();
  return { ok: true, message: "Ollama model unloaded." };
}

/**
 * Sends a chat completion request with optional tool definitions.
 * Returns { ok, rawText } — the model's raw text response. Tool-call intent
 * is expressed in that text as {system | request | ...} envelopes (see
 * envelopeProtocol.js), not via Ollama's structured tool-calling API.
 */
export async function requestOllamaChatCompletion({ messages }) {
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        messages,
        think: false,
        stream: false,
        // Ollama's default context window (4096) is too small for this
        // system's prompt (tool catalog + role doc + growing chat history) —
        // once a retry or a few chat turns accumulate, requests were hitting
        // the wall and getting truncated to a single token. Model supports
        // far more; 16384 comfortably covers real usage with headroom.
        options: { num_ctx: 16384 }
      }),
      signal: AbortSignal.timeout(120000)
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
      rawText: String(data.message?.content || "")
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
