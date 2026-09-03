import { getToolDefinitions } from "./agentTools.js";

/**
 * Splits raw model output into a sequence of top-level {type | ...} envelopes.
 * Depth/quote-aware so JSON payloads inside an envelope (which contain their
 * own {}/[]/"...") don't get mistaken for envelope boundaries.
 */
export function parseEnvelopes(rawText) {
  const text = String(rawText || "");
  const envelopes = [];
  let i = 0;

  while (i < text.length) {
    // Skip whitespace between envelopes.
    while (i < text.length && /\s/.test(text[i])) {
      i += 1;
    }
    if (i >= text.length) {
      break;
    }
    if (text[i] !== "{") {
      // Stray non-envelope text between/around envelopes — ignore it and
      // keep scanning for the next "{".
      i += 1;
      continue;
    }

    const start = i;
    let depth = 0;
    let inString = false;
    let escapeNext = false;

    for (; i < text.length; i += 1) {
      const ch = text[i];

      if (inString) {
        if (escapeNext) {
          escapeNext = false;
        } else if (ch === "\\") {
          escapeNext = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }

      if (ch === '"') {
        inString = true;
      } else if (ch === "{") {
        depth += 1;
      } else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          i += 1;
          break;
        }
      }
    }

    const raw = text.slice(start, i);
    const parsed = parseSingleEnvelope(raw);
    if (parsed) {
      envelopes.push(parsed);
    }
  }

  return envelopes;
}

// Splits the inside of one envelope on top-level "|" characters (outside any
// nested {}/[]/quotes), then interprets the fields by type.
function parseSingleEnvelope(raw) {
  const inner = raw.trim().replace(/^\{/, "").replace(/\}$/, "");
  const fields = splitTopLevel(inner, "|").map((field) => field.trim());
  if (!fields.length || !fields[0]) {
    return null;
  }

  const type = fields[0].toLowerCase();

  if (type === "reply") {
    const message = unescapeReplyText(fields.slice(1).join("|").trim());
    return message ? { type: "reply", message } : null;
  }

  if (type === "system") {
    // {system | request | <json array of {tool, args}>}
    const jsonPayload = fields.slice(2).join("|").trim();
    try {
      const apiCalls = JSON.parse(jsonPayload);
      if (!Array.isArray(apiCalls) || !apiCalls.length) {
        return null;
      }
      return { type: "system", message: { apiCalls } };
    } catch {
      return null;
    }
  }

  // "user" and "returned" envelopes are only ever system-authored (rendered
  // by renderUserEnvelope/renderReturnedEnvelope below), never parsed back
  // out of model output, but are harmless to ignore if a model echoes one.
  return null;
}

// Reply content is plain text, not JSON, so the model's own literal "\n"
// (two characters: backslash + n) never gets decoded into a real line break
// the way it would inside a JSON string. Models reach for that escape out of
// habit anyway — convert it here rather than relying on the prompt to stop.
function unescapeReplyText(text) {
  return text.replace(/\\n/g, "\n").replace(/\\t/g, "\t");
}

function splitTopLevel(text, separator) {
  const parts = [];
  let depth = 0;
  let inString = false;
  let escapeNext = false;
  let current = "";

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (inString) {
      current += ch;
      if (escapeNext) {
        escapeNext = false;
      } else if (ch === "\\") {
        escapeNext = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      current += ch;
    } else if (ch === "{" || ch === "[") {
      depth += 1;
      current += ch;
    } else if (ch === "}" || ch === "]") {
      depth -= 1;
      current += ch;
    } else if (ch === separator && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }

  parts.push(current);
  return parts;
}

export function renderUserEnvelope(text) {
  return `{user | ${String(text || "").trim()}}`;
}

export function renderReplyEnvelope(text) {
  return `{reply | ${String(text || "").trim()}}`;
}

export function renderReturnedEnvelope(toolResults) {
  const allOk = toolResults.every((entry) => entry.result?.ok);
  const payload = toolResults.map((entry) => ({
    tool: entry.tool,
    args: entry.args,
    ok: Boolean(entry.result?.ok),
    result: entry.result
  }));
  return `{returned | ${allOk ? "success" : "failure"} | ${JSON.stringify(payload)}}`;
}

export function describeToolCatalog() {
  return getToolDefinitions()
    .map((tool) => {
      const fn = tool.function;
      const params = Object.entries(fn.parameters?.properties || {})
        .map(([name, schema]) => {
          const required = fn.parameters?.required?.includes(name) ? "" : "?";
          const desc = schema.description ? ` — ${schema.description}` : "";
          return `${name}${required}: ${schema.type}${desc}`;
        })
        .join(", ");
      return `- ${fn.name}(${params})\n  ${fn.description}`;
    })
    .join("\n");
}
