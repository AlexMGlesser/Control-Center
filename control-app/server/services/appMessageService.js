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
const appMessageHistoryPath = path.join(dataDirectory, "app-agent-messages.json");

const MAX_APP_MESSAGES = 200;

const appMessageState = loadAppMessageState();

export function addAppMessage({ appId, appName, message, meta = {} }) {
  const cleanedMessage = String(message || "").trim();
  const cleanedAppId = String(appId || "").trim();
  const cleanedAppName = String(appName || cleanedAppId).trim();

  if (!cleanedAppId || !cleanedMessage) {
    return {
      ok: false,
      code: "INVALID_APP_MESSAGE",
      message: "appId and message are required."
    };
  }

  const entry = {
    id: appMessageState.nextId++,
    appId: cleanedAppId,
    appName: cleanedAppName,
    message: cleanedMessage,
    formattedText: formatAppMessage(cleanedAppName, cleanedMessage),
    meta,
    timestamp: new Date().toISOString()
  };

  appMessageState.messages.push(entry);
  trimAppMessages();
  persistAppMessageState();

  return {
    ok: true,
    entry
  };
}

export function getRecentAppMessages(limit = 20) {
  const parsedLimit = Number(limit);
  const safeLimit = Number.isFinite(parsedLimit)
    ? Math.max(1, Math.min(parsedLimit, MAX_APP_MESSAGES))
    : 20;

  return appMessageState.messages.slice(-safeLimit);
}

export function getAppMessageContext(limit = 20) {
  return formatAppMessageContext(getRecentAppMessages(limit));
}

export function formatAppMessage(originApp, message) {
  return `{${String(originApp || "Unknown App").trim()}}[${String(message || "").trim()}]`;
}

function trimAppMessages() {
  if (appMessageState.messages.length > MAX_APP_MESSAGES) {
    const overflow = appMessageState.messages.length - MAX_APP_MESSAGES;
    appMessageState.messages.splice(0, overflow);
  }
}

function loadAppMessageState() {
  const runtimeState = readRuntimeSection("appMessages", null);
  if (runtimeState && typeof runtimeState === "object") {
    const loadedState = sanitizeAppMessageState(runtimeState);
    refreshAgentRuntimeContext();
    return loadedState;
  }

  if (!existsSync(appMessageHistoryPath)) {
    const initialState = {
      messages: [],
      nextId: 1
    };
    writeAppMessageFiles(initialState);
    return initialState;
  }

  try {
    const parsed = JSON.parse(readFileSync(appMessageHistoryPath, "utf-8"));
    const messages = Array.isArray(parsed?.messages) ? parsed.messages.filter(isValidAppMessage) : [];
    const nextId = Number(parsed?.nextId);

    const loadedState = {
      messages,
      nextId: Number.isFinite(nextId) ? Math.max(nextId, getNextIdFromMessages(messages)) : getNextIdFromMessages(messages)
    };

    writeAppMessageFiles(loadedState);
    return loadedState;
  } catch {
    const fallbackState = {
      messages: [],
      nextId: 1
    };
    writeAppMessageFiles(fallbackState);
    return fallbackState;
  }
}

function persistAppMessageState() {
  writeAppMessageFiles(appMessageState);
}

function writeAppMessageFiles(state) {
  const safeState = sanitizeAppMessageState(state);
  writeRuntimeSection("appMessages", safeState);
  refreshAgentRuntimeContext();
}

function formatAppMessageContext(messages) {
  const header = [
    "Control Center App Message Context",
    "These are background app-to-agent messages.",
    "Each message is formatted as {Origin App}[message].",
    "Newest messages are at the bottom.",
    ""
  ];

  const lines = messages.slice(-60).map((entry) => `[${entry.timestamp}] ${entry.formattedText}`);
  return [...header, ...lines].join("\n");
}

function isValidAppMessage(entry) {
  return (
    entry &&
    typeof entry === "object" &&
    typeof entry.id === "number" &&
    typeof entry.appId === "string" &&
    typeof entry.appName === "string" &&
    typeof entry.message === "string" &&
    typeof entry.formattedText === "string" &&
    typeof entry.timestamp === "string"
  );
}

function getNextIdFromMessages(messages) {
  const maxId = messages.reduce((highest, entry) => Math.max(highest, Number(entry.id) || 0), 0);
  return maxId + 1;
}

function sanitizeAppMessageState(state) {
  const messages = Array.isArray(state?.messages) ? state.messages.filter(isValidAppMessage) : [];
  const nextId = Number(state?.nextId);

  return {
    messages,
    nextId: Number.isFinite(nextId) ? Math.max(nextId, getNextIdFromMessages(messages)) : getNextIdFromMessages(messages)
  };
}