import { mkdirSync } from "fs";
import path from "path";
import { getRuntimeDataRoot } from "../appPaths.js";
import { publishEvent } from "./eventBus.js";
import { requestOllamaChatCompletion } from "./ollamaService.js";
import {
  createEntryInRoot,
  listFolderInRoot,
  readTextFileInRoot,
  renameEntryInRoot,
  saveTextFileInRoot
} from "./projectService.js";

// The phone's IDE: edits files in one scripts folder (the repo's scripts/ in
// dev, %APPDATA%/Control Center/scripts when packaged; CC_SCRIPTS_DIR
// overrides it), with the same path checks as the Projects app. Its AI panel
// sends the open file and a request to the local model and gets back either
// an answer or a whole new version of the file, which the phone shows as a
// diff before applying.

// The file goes in and a whole new copy comes out, both inside Jarvis's
// 16k-token context window, so files are capped well under half of it.
const ASSIST_FILE_LIMIT_BYTES = 24 * 1024;
const ASSIST_HISTORY_TURNS = 6;
// A whole file at a few dozen tokens a second can take minutes.
const ASSIST_TIMEOUT_MS = 300_000;
const FILE_BEGIN = "<<<BEGIN FILE>>>";
const FILE_END = "<<<END FILE>>>";

function ideError(code, message, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

export function getScriptsDirectory() {
  const directory = process.env.CC_SCRIPTS_DIR || path.join(getRuntimeDataRoot(), "scripts");
  mkdirSync(directory, { recursive: true });
  return directory;
}

function changed(message, filePath) {
  publishEvent({ source: "ide", appId: "ide", type: "data-changed", message, meta: { entity: "file", path: filePath } });
}

export function listScriptsFolder(folderPath) {
  return { root: getScriptsDirectory(), ...listFolderInRoot(getScriptsDirectory(), folderPath) };
}

export function readScript(filePath) {
  return readTextFileInRoot(getScriptsDirectory(), filePath);
}

export function saveScript(filePath, content, expectedModified) {
  const saved = saveTextFileInRoot(getScriptsDirectory(), filePath, content, expectedModified);
  changed(`Saved ${saved.name}.`, saved.path);
  return saved;
}

/** A new folder, or a new file with optional starting content (Save As). */
export function createScriptEntry(parentPath, name, type = "file", content = "") {
  const created = createEntryInRoot(getScriptsDirectory(), parentPath, name, type === "folder" ? "folder" : "file", content);
  changed(`Created ${created.name}.`, created.path);
  return created;
}

export function renameScript(targetPath, newName) {
  const renamed = renameEntryInRoot(getScriptsDirectory(), targetPath, newName);
  publishEvent({
    source: "ide",
    appId: "ide",
    type: "data-changed",
    message: `Renamed to ${renamed.name}.`,
    meta: { entity: "file", path: renamed.path, previousPath: String(targetPath || "") }
  });
  return renamed;
}

/* ------------------------------------------------------------------ */
/* The AI panel                                                        */
/* ------------------------------------------------------------------ */

const SYSTEM_PROMPT = [
  "You are a coding assistant built into a code editor on the user's phone.",
  "Each message includes the file the user has open, exactly as it is in the editor right now.",
  "",
  "If the user asks you to change the file (add, fix, rewrite, rename, comment, refactor, and so on):",
  "1. Write one or two short sentences saying what you changed.",
  `2. Then write the COMPLETE updated file between a line containing only ${FILE_BEGIN} and a line containing only ${FILE_END}.`,
  "   Always include the entire file, including unchanged parts. Never write a partial file, a diff, or placeholders like \"... rest unchanged\".",
  "   Do not wrap the file in ``` fences.",
  "",
  "If the user only asks a question about the file, answer briefly and do not include a file.",
  "Keep the file's existing style, indentation and language unless asked otherwise.",
  "",
  "Comments: write as few as possible. Do not add comments to code you write or change unless the user asks for comments.",
  "Never add comments that restate what a line does or describe your change. Keep the file's existing comments as they are."
].join("\n");

function fileMessage(fileName, content, instruction) {
  return [
    `Open file: ${fileName || "untitled"}`,
    FILE_BEGIN,
    content,
    FILE_END,
    "",
    `Request: ${instruction}`,
    "(Change only what the request needs. No new comments unless the request asks for them.)"
  ].join("\n");
}

function stripFence(text) {
  const match = text.match(/^\s*```[^\n]*\n([\s\S]*?)\n?```\s*$/);
  return match ? match[1] : text;
}

/**
 * Splits the model's reply into its explanation and the proposed file, if
 * any. Falls back to the longest ``` block for a model that ignored the
 * markers. `truncated` is a file that started but never ended.
 */
export function parseAssistReply(rawText, originalContent = "") {
  const text = String(rawText || "").replace(/<think>[\s\S]*?<\/think>/g, "");
  let proposed = null;
  let reply = text;
  let truncated = false;

  const begin = text.indexOf(FILE_BEGIN);
  if (begin >= 0) {
    const bodyStart = text.indexOf("\n", begin) + 1 || begin + FILE_BEGIN.length;
    const end = text.indexOf(FILE_END, bodyStart);
    if (end < 0) {
      truncated = true;
      reply = text.slice(0, begin);
    } else {
      proposed = text.slice(bodyStart, end).replace(/\r?\n$/, "");
      reply = text.slice(0, begin) + text.slice(end + FILE_END.length);
      if (!originalContent.trimStart().startsWith("```")) proposed = stripFence(proposed);
    }
  } else {
    const blocks = [...text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)];
    if (blocks.length) {
      const longest = blocks.reduce((a, b) => (b[1].length > a[1].length ? b : a));
      proposed = longest[1].replace(/\r?\n$/, "");
      reply = text.replace(longest[0], "");
    }
  }

  if (proposed !== null) {
    // Match the original's line endings and final newline.
    if (originalContent.includes("\r\n")) proposed = proposed.replace(/\r?\n/g, "\r\n");
    const newline = originalContent.includes("\r\n") ? "\r\n" : "\n";
    if (originalContent.endsWith("\n") && !proposed.endsWith("\n")) proposed += newline;
    if (proposed === originalContent) proposed = null;
  }
  return { reply: reply.trim(), content: proposed, truncated };
}

/**
 * One request from the AI panel. `content` is the editor's text (saved or
 * not); `history` is the panel's earlier turns, [{ role, text }].
 */
export async function assistWithFile({ fileName, content, instruction, history } = {}) {
  const request = String(instruction || "").trim();
  if (!request) throw ideError("EMPTY_REQUEST", "Ask something first.");
  const text = String(content ?? "");
  if (Buffer.byteLength(text, "utf-8") > ASSIST_FILE_LIMIT_BYTES) {
    throw ideError("FILE_TOO_LARGE", "This file is too big for the AI panel (24 KB at most).", 413);
  }

  const earlier = (Array.isArray(history) ? history : [])
    .filter((turn) => turn && (turn.role === "user" || turn.role === "assistant") && String(turn.text || "").trim())
    .slice(-ASSIST_HISTORY_TURNS)
    .map((turn) => ({ role: turn.role, content: String(turn.text).slice(0, 2000) }));

  const result = await requestOllamaChatCompletion({
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      ...earlier,
      { role: "user", content: fileMessage(fileName, text, request) }
    ],
    timeoutMs: ASSIST_TIMEOUT_MS,
    // Edits should be faithful, not creative.
    temperature: 0.2
  });
  if (!result.ok) {
    throw ideError(result.code || "OLLAMA_UNAVAILABLE", `The model isn't answering: ${result.message}`, 503);
  }

  const parsed = parseAssistReply(result.rawText, text);
  if (parsed.truncated || (result.doneReason === "length" && parsed.content === null && result.rawText.includes(FILE_BEGIN))) {
    throw ideError("REPLY_CUT_OFF", "The model's new version of the file was cut off. Try a smaller change or a shorter file.", 502);
  }
  return {
    reply: parsed.reply || (parsed.content !== null ? "Here's the updated file." : "No changes."),
    content: parsed.content
  };
}
