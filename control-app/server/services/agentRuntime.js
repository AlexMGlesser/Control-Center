import { existsSync, readFileSync } from "fs";
import path from "path";
import { getAgentRuntimeDirectory } from "../appPaths.js";
import { getAppMessageContext } from "./appMessageService.js";
import { buildAgentContextBundle } from "./agentContextLoader.js";
import { getChatHistoryContext } from "./chatService.js";
import { getOllamaState } from "./ollamaService.js";
import { getToolDefinitions } from "./agentTools.js";
import { getCalendarTimeZone } from "./calendarService.js";
import { describeToolCatalog, renderUserEnvelope, renderReplyEnvelope } from "./envelopeProtocol.js";

const CALENDAR_TIMEZONE = getCalendarTimeZone();
const roleContextPath = path.join(getAgentRuntimeDirectory(), "AGENT_TOOL_CONTEXT.txt");

export function getAgentContextText() {
  if (!existsSync(roleContextPath)) {
    return "";
  }
  return readFileSync(roleContextPath, "utf-8");
}

export function getAgentToolCatalog() {
  return getToolDefinitions();
}

export function getAgentRuntimeStatus() {
  return { ollama: getOllamaState() };
}

/**
 * Builds the message array to seed a brand-new turn: system prompt (role
 * doc + envelope grammar/tool catalog from AGENT_TOOL_CONTEXT.txt + current
 * date/time + reference docs + background app messages), prior chat history
 * rendered in envelope form for consistency, then the new {user | ...} line.
 */
export function buildInitialMessages(userText, origin = { type: "user" }) {
  const contextBundle = buildAgentContextBundle(userText);
  const appMessageContext = getAppMessageContext(10);
  const chatHistory = getChatHistoryContext(20);
  const now = new Date();

  const localNow = new Intl.DateTimeFormat("en-US", {
    timeZone: CALENDAR_TIMEZONE,
    dateStyle: "full",
    timeStyle: "medium"
  }).format(now);

  const systemPrompt = [
    getAgentContextText(),
    `Tool catalog:\n${describeToolCatalog()}`,
    `Current date/time (${CALENDAR_TIMEZONE}): ${localNow}. This system assumes ${CALENDAR_TIMEZONE} for all dates/times. ` +
      `Resolve relative dates ("tomorrow", "next Tuesday") against this. When calling calendar tools, pass plain local wall-clock ` +
      `timestamps in this timezone (format YYYY-MM-DDTHH:mm:ss, no offset, no "Z") — do not convert to UTC or any other timezone yourself.`,
    contextBundle.text ? `Reference docs:\n${contextBundle.text}` : "",
    appMessageContext ? `Background app messages (not from the user directly):\n${appMessageContext}` : ""
  ]
    .filter(Boolean)
    .join("\n\n");

  const messages = [{ role: "system", content: systemPrompt }];

  for (const entry of chatHistory) {
    const isAgent = entry.role === "agent";
    messages.push({
      role: isAgent ? "assistant" : "user",
      content: isAgent ? renderReplyEnvelope(entry.text) : renderUserEnvelope(entry.text)
    });
  }

  const prefix = origin?.type === "app" ? `[Background message from ${origin.appName || origin.appId}]\n` : "";
  messages.push({ role: "user", content: renderUserEnvelope(`${prefix}${userText}`) });

  return messages;
}
