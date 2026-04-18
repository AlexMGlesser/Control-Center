const LMSTUDIO_BASE_URL = process.env.LMSTUDIO_BASE_URL || "http://127.0.0.1:1234/v1";
const LMSTUDIO_MODEL = process.env.LMSTUDIO_MODEL || "google/gemma-4-26b-a4b";
const LMSTUDIO_TIMEOUT_MS = Number(process.env.LMSTUDIO_TIMEOUT_MS || 45000);

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

function markLmStudioConnected(model) {
  lmStudioState.status = "connected";
  lmStudioState.model = model || LMSTUDIO_MODEL;
  lmStudioState.lastError = null;
  lmStudioState.lastConnectedAt = new Date().toISOString();
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