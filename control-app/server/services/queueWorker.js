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
  turns.set(turnId, { origin, messages: null, llmSteps: 0, replyDelivered: false });
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
        publishAIThought(`Calling tool ${call.tool}`, { tool: call.tool, args: call.args });
        const result = await executeToolCall(call.tool, call.args || {});
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

  for (const envelope of envelopes) {
    enqueueTask({ type: envelope.type, message: envelope.message, turnId, origin: turn.origin, priority });
  }
}

function deliverReply(turnId, turn, message) {
  const persisted = message ? addAgentMessage(String(message)) : null;

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
