const LMSTUDIO_BASE_URL = process.env.LMSTUDIO_BASE_URL || "http://127.0.0.1:1234/v1";
const LMSTUDIO_MODEL = process.env.LMSTUDIO_MODEL || "google/gemma-4-26b-a4b";
const LMSTUDIO_TIMEOUT_MS = Number(process.env.LMSTUDIO_TIMEOUT_MS || 45000);
const PROBE_INTERVAL_MS = 10000;
let probeIntervalId = null;

const lmStudioState = {
  status: "not_connected",
  model: LMSTUDIO_MODEL,
  lastError: null,
  lastConnectedAt: null
};

export function getLmStudioConfig() {
  return {
    baseUrl: LMSTUDIO_BASE_URL,
    model: LMSTUDIO_MODEL,
    timeoutMs: LMSTUDIO_TIMEOUT_MS
  };
}

export function getLmStudioState() {
  return { ...lmStudioState };
}

export function markLmStudioConnected(model) {
  lmStudioState.status = "connected";
  lmStudioState.model = model || LMSTUDIO_MODEL;
  lmStudioState.lastError = null;
  lmStudioState.lastConnectedAt = new Date().toISOString();
}

export function markLmStudioOffline() {
  lmStudioState.status = "not_connected";
  lmStudioState.model = LMSTUDIO_MODEL;
  lmStudioState.lastError = null;
}

export async function probeLmStudioStatus() {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(`${LMSTUDIO_BASE_URL}/models`, { signal: controller.signal });
    clearTimeout(timeoutId);
    if (!res.ok) {
      markLmStudioOffline();
      return false;
    }
    const data = await res.json();
    const models = Array.isArray(data?.data) ? data.data : [];
    if (models.length === 0) {
      markLmStudioOffline();
      return false;
    }
    const loadedModel = String(models[0]?.id || models[0]?.name || LMSTUDIO_MODEL);
    markLmStudioConnected(loadedModel);
    return true;
  } catch {
    markLmStudioOffline();
    return false;
  }
}

function ensureLmStudioProbe() {
  if (probeIntervalId) {
    return;
  }

  probeIntervalId = setInterval(() => {
    probeLmStudioStatus().catch(() => {});
  }, PROBE_INTERVAL_MS);
  probeIntervalId.unref?.();
}

export function stopLmStudioProbe() {
  if (!probeIntervalId) {
    return;
  }

  clearInterval(probeIntervalId);
  probeIntervalId = null;
}

// Background probe — keeps status in sync regardless of how the model was loaded/unloaded
ensureLmStudioProbe();
probeLmStudioStatus().catch(() => {});

export async function requestLmStudioChatCompletion({ messages, temperature = 0.2 }) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), LMSTUDIO_TIMEOUT_MS);

  try {
    const res = await fetch(`${LMSTUDIO_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: LMSTUDIO_MODEL,
        temperature,
        max_tokens: 300,
        messages
      }),
      signal: controller.signal
    });

    if (!res.ok) {
      const errorBody = await safeReadResponseText(res);
      markLmStudioError(`HTTP ${res.status}: ${errorBody || "request failed"}`);
      return {
        ok: false,
        code: "LMSTUDIO_HTTP_ERROR",
        message: `LM Studio request failed with HTTP ${res.status}.`
      };
    }

    const data = await res.json();
    const content = String(data?.choices?.[0]?.message?.content || "").trim();

    if (!content) {
      markLmStudioError("Empty completion content.");
      return {
        ok: false,
        code: "LMSTUDIO_EMPTY_RESPONSE",
        message: "LM Studio returned an empty response."
      };
    }

    markLmStudioConnected(String(data?.model || LMSTUDIO_MODEL));
    return {
      ok: true,
      content,
      model: String(data?.model || LMSTUDIO_MODEL)
    };
  } catch (error) {
    const message = error?.name === "AbortError" ? "Request timed out." : String(error?.message || error);
    markLmStudioError(message);

    return {
      ok: false,
      code: "LMSTUDIO_REQUEST_FAILED",
      message: `LM Studio request failed: ${message}`
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

function markLmStudioError(message) {
  lmStudioState.status = "error";
  lmStudioState.model = LMSTUDIO_MODEL;
  lmStudioState.lastError = String(message || "Unknown LM Studio error.");
}

async function safeReadResponseText(res) {
  try {
    return String(await res.text() || "").trim();
  } catch {
    return "";
  }
}