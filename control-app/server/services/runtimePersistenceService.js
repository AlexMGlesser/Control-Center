import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const workspaceRoot = path.join(__dirname, "..", "..", "..");
const logsDirectory = path.join(workspaceRoot, "logs");
const runtimeLogPath = path.join(logsDirectory, "control-center-runtime.json");
const agentDirectory = path.join(workspaceRoot, "control-app", "agent");
const agentContextPath = path.join(agentDirectory, "AGENT_RUNTIME_CONTEXT.txt");

const DEFAULT_RUNTIME_STORE = {
  version: 1,
  updatedAt: new Date().toISOString(),
  chat: null,
  appMessages: null,
  calendar: null,
  drawing: null,
  musicLibrary: null,
  localPlaylists: null
};

export function readRuntimeStore() {
  ensureRuntimeDirectories();

  if (!existsSync(runtimeLogPath)) {
    const initialState = { ...DEFAULT_RUNTIME_STORE };
    writeRuntimeStore(initialState);
    return initialState;
  }

  try {
    const parsed = JSON.parse(readFileSync(runtimeLogPath, "utf-8"));
    return {
      ...DEFAULT_RUNTIME_STORE,
      ...(parsed && typeof parsed === "object" ? parsed : {}),
      updatedAt: String(parsed?.updatedAt || new Date().toISOString())
    };
  } catch {
    const fallbackState = { ...DEFAULT_RUNTIME_STORE, updatedAt: new Date().toISOString() };
    writeRuntimeStore(fallbackState);
    return fallbackState;
  }
}

export function writeRuntimeStore(store) {
  ensureRuntimeDirectories();
  const safeStore = {
    ...DEFAULT_RUNTIME_STORE,
    ...(store && typeof store === "object" ? store : {}),
    updatedAt: new Date().toISOString()
  };
  writeFileSync(runtimeLogPath, JSON.stringify(safeStore, null, 2), "utf-8");
  return safeStore;
}

export function readRuntimeSection(sectionName, fallbackValue) {
  const store = readRuntimeStore();
  const section = store[sectionName];
  if (section === undefined || section === null) {
    return cloneValue(fallbackValue);
  }
  return cloneValue(section);
}

export function writeRuntimeSection(sectionName, sectionValue) {
  const store = readRuntimeStore();
  store[sectionName] = cloneValue(sectionValue);
  return writeRuntimeStore(store);
}

export function refreshAgentRuntimeContext() {
  const store = readRuntimeStore();
  const chatMessages = Array.isArray(store.chat?.messages) ? store.chat.messages : [];
  const appMessages = Array.isArray(store.appMessages?.messages) ? store.appMessages.messages : [];

  const lines = [
    "Control Center Agent Runtime Context",
    "Use this as conversational memory and continuity context.",
    "Newest entries are at the bottom.",
    "",
    "[Chat History]"
  ];

  const chatLines = chatMessages.slice(-60).map((message) => {
    const role = message.role === "agent" ? "Agent" : "User";
    return `[${message.timestamp}] ${role}: ${message.text}`;
  });

  if (chatLines.length) {
    lines.push(...chatLines);
  } else {
    lines.push("(no chat history yet)");
  }

  lines.push("", "[App Messages]");

  const appLines = appMessages.slice(-60).map((entry) => `[${entry.timestamp}] ${entry.formattedText}`);
  if (appLines.length) {
    lines.push(...appLines);
  } else {
    lines.push("(no app messages yet)");
  }

  writeFileSync(agentContextPath, lines.join("\n"), "utf-8");
}

export function getRuntimeLogPath() {
  return runtimeLogPath;
}

export function getAgentRuntimeContextPath() {
  return agentContextPath;
}

function ensureRuntimeDirectories() {
  mkdirSync(logsDirectory, { recursive: true });
  mkdirSync(agentDirectory, { recursive: true });
}

function cloneValue(value) {
  if (value === undefined) {
    return undefined;
  }

  return JSON.parse(JSON.stringify(value));
}