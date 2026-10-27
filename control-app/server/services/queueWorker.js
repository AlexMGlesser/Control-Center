import { enqueueTask, dequeueTask, getQueueStatus, hasPendingTurnEntries } from "./queueManager.js";
import { buildInitialMessages } from "./agentRuntime.js";
import { requestOllamaChatCompletion } from "./ollamaService.js";
import { executeToolCall } from "./agentTools.js";
import { parseEnvelopes, renderReturnedEnvelope } from "./envelopeProtocol.js";
import { addAgentMessage } from "./chatService.js";
import { publishEvent, publishDebugEvent, publishAIThought } from "./eventBus.js";

const MAX_LLM_STEPS_PER_TURN = 6;

let processing = false;
let nextTurnId = 1;
const replyListeners = new Set();
const turns = new Map(); // turnId -> { origin, messages, llmSteps, replyDelivered }

export { getQueueStatus };

export function onReplyDelivered(listener) {
  replyListeners.add(listener);
  return () => replyListeners.delete(listener);
}

/**
 * Starts a new turn: registers turn state and enqueues the initial "user"
 * envelope entry. Returns immediately — the caller does not wait for the
 * agent to finish; use onReplyDelivered() to be notified when it does.
 */
export function enqueueUserTurn(content, { priority = "normal", origin = { type: "user" } } = {}) {
  const turnId = `turn_${nextTurnId++}`;
  turns.set(turnId, { origin, messages: null, llmSteps: 0, replyDelivered: false, deliveredReplyTexts: new Set() });
  const task = enqueueTask({ type: "user", message: content, turnId, origin, priority });
  drain();
  return { task, turnId };
}

async function drain() {
  if (processing) {
    return;
  }
  processing = true;

  try {
    let entry = dequeueTask();
    while (entry) {
      try {
        await processEntry(entry);
      } catch (error) {
        console.error("[Queue] Entry processing failed:", entry.type, entry.turnId, error?.message || error);
      }
      entry = dequeueTask();
    }
  } finally {
    processing = false;
  }
}

async function processEntry(entry) {
  const turn = turns.get(entry.turnId);
  if (!turn) {
    console.warn(`[Queue] No turn state for ${entry.type} entry (turn ${entry.turnId} already completed) — dropping.`);
    return;
  }

  switch (entry.type) {
    case "user": {
      turn.messages = buildInitialMessages(entry.message, entry.origin);
      await runLlmStep(entry.turnId, entry.priority);
      break;
    }

    case "system": {
      const apiCalls = Array.isArray(entry.message?.apiCalls) ? entry.message.apiCalls : [];
      const toolResults = [];
      for (const call of apiCalls) {
        publishAIThought(`Calling tool ${call.tool}`, { tool: call.tool, args: call.args, turnId: entry.turnId });
        const result = await executeToolCall(call.tool, call.args || {}, { origin: entry.origin });
        toolResults.push({ tool: call.tool, args: call.args, result });
      }
      turn.messages.push({ role: "user", content: renderReturnedEnvelope(toolResults) });
      enqueueTask({ type: "returned", message: toolResults, turnId: entry.turnId, origin: entry.origin, priority: entry.priority });
      break;
    }

    case "returned": {
      await runLlmStep(entry.turnId, entry.priority);
      break;
    }

    case "reply": {
      deliverReply(entry.turnId, turn, entry.message);
      turn.replyDelivered = true;
      break;
    }

    default:
      console.warn(`[Queue] Unknown entry type '${entry.type}' — dropping.`);
  }

  if (turn.replyDelivered && !hasPendingTurnEntries(entry.turnId)) {
    turns.delete(entry.turnId);
  }
}

async function runLlmStep(turnId, priority) {
  const turn = turns.get(turnId);
  if (!turn) {
    return;
  }

  turn.llmSteps += 1;
  if (turn.llmSteps > MAX_LLM_STEPS_PER_TURN) {
    enqueueTask({
      type: "reply",
      message: "I got stuck trying to finish that — stopping here. Could you rephrase or simplify the request?",
      turnId,
      origin: turn.origin,
      priority
    });
    return;
  }

  const completion = await requestOllamaChatCompletion({ messages: turn.messages });

  if (!completion.ok) {
    publishDebugEvent("Agent: Ollama request failed", { code: completion.code, message: completion.message });
    enqueueTask({
      type: "reply",
      message: "I couldn't reach Ollama. Is it running?",
      turnId,
      origin: turn.origin,
      priority
    });
    return;
  }

  turn.messages.push({ role: "assistant", content: completion.rawText });

  const envelopes = parseEnvelopes(completion.rawText);
  if (!envelopes.length) {
    console.error("[Agent] Model produced no parseable envelope, reprompting. Raw output:", completion.rawText);
    turn.messages.push({
      role: "user",
      content:
        "Your last response wasn't wrapped in a valid envelope. Every response must be exactly " +
        '{reply | ...} or {system | request | [...]} — no bare text. Please answer the same request ' +
        "again, using the correct format."
    });
    await runLlmStep(turnId, priority);
    return;
  }

  const sanitized = sanitizeEnvelopes(envelopes, turn);

  for (const envelope of sanitized) {
    enqueueTask({ type: envelope.type, message: envelope.message, turnId, origin: turn.origin, priority });
  }
}

/**
 * A reply can only legitimately report a task that already has a confirmed
 * result. The prompt asks the model to follow that rule, but it isn't
 * reliable on its own — this is the enforced version:
 *  - On the turn's very first LLM step, nothing has executed yet, so any
 *    reply sent alongside a system call is premature narration ("opening
 *    now...") rather than a real result — drop it, keep the system call.
 *  - A step with no system call in it has nothing new to report beyond one
 *    answer — extra replies there are just rambling, not multiple real
 *    tasks being closed out. Keep only the first.
 */
function sanitizeEnvelopes(envelopes, turn) {
  const systemCount = envelopes.filter((entry) => entry.type === "system").length;
  let replySeen = 0;
  const seenTextsThisStep = new Set();

  const sanitized = envelopes.filter((entry) => {
    if (entry.type !== "reply") {
      return true;
    }
    replySeen += 1;

    if (turn.llmSteps === 1 && systemCount > 0) {
      return false;
    }
    if (systemCount === 0 && replySeen > 1) {
      return false;
    }

    // A reply repeating (near-)exactly what was already said earlier this
    // turn is the same "premature narration" failure showing up on a later
    // step — e.g. a system call and a reply claiming its result together in
    // one response, followed by the real confirmation once the returned
    // result actually comes back. Content-based, so it doesn't matter which
    // step it happens on.
    const normalized = normalizeReplyText(entry.message);
    if (normalized && (turn.deliveredReplyTexts.has(normalized) || seenTextsThisStep.has(normalized))) {
      return false;
    }
    seenTextsThisStep.add(normalized);
    return true;
  });

  if (sanitized.length !== envelopes.length) {
    console.warn(
      `[Agent] Dropped ${envelopes.length - sanitized.length} premature/redundant reply envelope(s) on step ${turn.llmSteps}.`
    );
  }

  return sanitized;
}

function normalizeReplyText(text) {
  return String(text || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function deliverReply(turnId, turn, message) {
  const persisted = message ? addAgentMessage(String(message)) : null;
  turn.deliveredReplyTexts.add(normalizeReplyText(message));

  publishEvent({
    source: "agent",
    appId: "control-center",
    type: "chat",
    message: "Agent turn completed.",
    meta: {
      turnId,
      origin: turn.origin,
      agentMessageId: persisted?.message?.id || null
    }
  });

  for (const listener of replyListeners) {
    try {
      listener({ turnId, message, origin: turn.origin });
    } catch {
      // A misbehaving listener should not stop the queue from draining.
    }
  }
}
