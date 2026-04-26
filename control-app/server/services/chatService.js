import { existsSync, readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  refreshAgentRuntimeContext,
  readRuntimeSection,
  writeRuntimeSection
} from "./runtimePersistenceService.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataDirectory = path.join(__dirname, "..", "data");
const chatHistoryPath = path.join(dataDirectory, "chat-history.json");

const MAX_MESSAGES = 200;
const DEFAULT_AGENT_MESSAGE = {
  id: 1,
  role: "agent",
  text: "Agent chat is online. Text interaction is ready in Desktop Mode.",
  timestamp: new Date().toISOString()
};

const chatState = loadChatState();

export function getChatMessages(limit = 80) {
  const parsedLimit = Number(limit);
  const safeLimit = Number.isFinite(parsedLimit)
    ? Math.max(1, Math.min(parsedLimit, MAX_MESSAGES))
    : 80;

  return chatState.messages.slice(-safeLimit);
}

export function getChatHistoryContext(limit = 20) {
  return formatChatContext(getChatMessages(limit));
}

export function addChatMessage(role, text, meta = {}) {
  const cleaned = String(text || "").trim();
  if (!cleaned) {
    return {
      ok: false,
      code: "EMPTY_MESSAGE",
      message: "Message text is required."
    };
  }

  const message = {
    id: chatState.nextId++,
    role,
    text: cleaned,
    meta,
    timestamp: new Date().toISOString()
  };

  chatState.messages.push(message);
  trimChatMessages();
  persistChatState();

  return {
    ok: true,
    message,
    messages: getChatMessages(80)
  };
}

export function postUserMessage(text) {
  const cleaned = String(text || "").trim();
  if (!cleaned) {
    return {
      ok: false,
      code: "EMPTY_MESSAGE",
      message: "Message text is required."
    };
  }

  const userMessage = {
    id: chatState.nextId++,
    role: "user",
    text: cleaned,
    timestamp: new Date().toISOString()
  };

  const agentMessage = {
    id: chatState.nextId++,
    role: "agent",
    text: buildAgentReply(cleaned),
    timestamp: new Date().toISOString()
  };

  chatState.messages.push(userMessage, agentMessage);
  trimChatMessages();
  persistChatState();

  return {
    ok: true,
    userMessage,
    agentMessage,
    messages: getChatMessages(80)
  };
}

export function addUserMessage(text) {
  return addChatMessage("user", text);
}

export function addAgentMessage(text, meta = {}) {
  return addChatMessage("agent", text, meta);
}

function buildAgentReply(userText) {
  return `Acknowledged. I received: "${userText}". This is a local text-chat stub and is ready for LMStudio agent integration.`;
}

function trimChatMessages() {
  if (chatState.messages.length > MAX_MESSAGES) {
    const overflow = chatState.messages.length - MAX_MESSAGES;
    chatState.messages.splice(0, overflow);
  }
}

function loadChatState() {
  const runtimeState = readRuntimeSection("chat", null);
  if (runtimeState && typeof runtimeState === "object") {
    const loadedState = sanitizeChatState(runtimeState);
    refreshAgentRuntimeContext();
    return loadedState;
  }

  if (!existsSync(chatHistoryPath)) {
    const initialState = {
      messages: [DEFAULT_AGENT_MESSAGE],
      nextId: 2
    };
    writeChatFiles(initialState);
    return initialState;
  }

  try {
    const parsed = JSON.parse(readFileSync(chatHistoryPath, "utf-8"));
    const messages = Array.isArray(parsed?.messages) ? parsed.messages.filter(isValidMessageShape) : [];
    const nextId = Number(parsed?.nextId);

    const safeMessages = messages.length ? messages : [DEFAULT_AGENT_MESSAGE];
    const safeNextId = Number.isFinite(nextId)
      ? Math.max(nextId, getNextIdFromMessages(safeMessages))
      : getNextIdFromMessages(safeMessages);

    const loadedState = {
      messages: safeMessages,
      nextId: safeNextId
    };

    writeChatFiles(loadedState);
    return loadedState;
  } catch {
    const fallbackState = {
      messages: [DEFAULT_AGENT_MESSAGE],
      nextId: 2
    };
    writeChatFiles(fallbackState);
    return fallbackState;
  }
}

function persistChatState() {
  writeChatFiles(chatState);
}

function writeChatFiles(state) {
  const safeState = sanitizeChatState(state);
  writeRuntimeSection("chat", safeState);
  refreshAgentRuntimeContext();
}

function formatChatContext(messages) {
  const header = [
    "Control Center Chat History Context",
    "Use this as conversational memory and continuity context.",
    "Newest messages are at the bottom.",
    ""
  ];

  const lines = messages.slice(-60).map((message) => {
    const role = message.role === "agent" ? "Agent" : "User";
    return `[${message.timestamp}] ${role}: ${message.text}`;
  });

  return [...header, ...lines].join("\n");
}

function isValidMessageShape(message) {
  return (
    message &&
    typeof message === "object" &&
    typeof message.id === "number" &&
    typeof message.role === "string" &&
    typeof message.text === "string" &&
    typeof message.timestamp === "string"
  );
}

function getNextIdFromMessages(messages) {
  const maxId = messages.reduce((highest, message) => Math.max(highest, Number(message.id) || 0), 0);
  return maxId + 1;
}

function sanitizeChatState(state) {
  const messages = Array.isArray(state?.messages) ? state.messages.filter(isValidMessageShape) : [];
  const safeMessages = messages.length ? messages : [DEFAULT_AGENT_MESSAGE];
  const nextId = Number(state?.nextId);

  return {
    messages: safeMessages,
    nextId: Number.isFinite(nextId) ? Math.max(nextId, getNextIdFromMessages(safeMessages)) : getNextIdFromMessages(safeMessages)
  };
}
