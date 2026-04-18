const blockedPattern =
  /\b(rm\s+-rf|del\s+\/f|format\s+[a-z]:|powershell(\.exe)?\b|cmd\.exe|invoke-expression|start-process|shutdown\s+\/|curl\s+https?:\/\/|wget\s+https?:\/\/|bash\s+-c)\b/i;

export function filterAgentOutput(rawOutput, availableTools) {
  const text = String(rawOutput || "").trim();

  if (!text) {
    return {
      ok: false,
      code: "EMPTY_AGENT_OUTPUT",
      message: "Agent output is empty.",
      safeText: "I could not generate a valid response."
    };
  }

  if (blockedPattern.test(text)) {
    return {
      ok: false,
      code: "BLOCKED_COMMAND_PATTERN",
      message: "Agent output contained blocked command content.",
      safeText: "I cannot run or suggest direct shell commands here. I can use approved Control Center tools instead."
    };
  }

  const objectStrings = extractTopLevelJsonObjects(text);
  if (objectStrings.length !== 2) {
    return {
      ok: false,
      code: "INVALID_ENVELOPE",
      message: "Agent output must include exactly two JSON objects: {tool...}{response...}.",
      safeText: "I generated an invalid response envelope."
    };
  }

  const parsedCalls = parseCommandBlock(objectStrings[0], availableTools);
  if (!parsedCalls.ok) {
    return {
      ok: false,
      code: "INVALID_TOOL_OBJECT",
      message: parsedCalls.message,
      safeText: "I generated an invalid tool object."
    };
  }

  const responseObj = safeParseJsonObject(objectStrings[1]);
  if (!responseObj.ok) {
    return {
      ok: false,
      code: "INVALID_RESPONSE_OBJECT",
      message: responseObj.message,
      safeText: "I generated an invalid response object."
    };
  }

  const safeMessages = extractSafeMessages(responseObj.value);
  const toolCalls = parsedCalls.calls;

  return {
    ok: true,
    toolCalls,
    safeText: safeMessages[0] || "",
    safeMessages
  };
}

function parseCommandBlock(commandBlockText, availableTools) {
  const parsedObj = safeParseJsonObject(commandBlockText);

  if (parsedObj.ok) {
    const fromObject = parseCommandObject(parsedObj.value, availableTools);
    if (fromObject.ok) {
      return fromObject;
    }
  }

  // Multi-command shorthand: {{"tool":"a","args":{}} | {"tool":"b","args":{}}}
  const raw = String(commandBlockText || "").trim();
  if (!(raw.startsWith("{") && raw.endsWith("}"))) {
    return {
      ok: false,
      message: "Command block must be a JSON object or a multi-command block wrapped in braces."
    };
  }

  const inner = raw.slice(1, -1).trim();
  const segments = splitTopLevelPipes(inner);
  if (!segments.length) {
    return { ok: false, message: "Command block contained no commands." };
  }

  const calls = [];
  for (const segment of segments) {
    const parsedSegment = safeParseJsonObject(segment);
    if (!parsedSegment.ok) {
      return { ok: false, message: "A command segment could not be parsed as JSON." };
    }

    const parsedCall = parseSingleCall(parsedSegment.value, availableTools);
    if (!parsedCall.ok) {
      return parsedCall;
    }

    if (parsedCall.call) {
      calls.push(parsedCall.call);
    }
  }

  return { ok: true, calls };
}

function parseCommandObject(obj, availableTools) {
  if (obj && typeof obj === "object" && Array.isArray(obj.commands)) {
    const calls = [];
    for (const entry of obj.commands) {
      const parsed = parseSingleCall(entry, availableTools);
      if (!parsed.ok) {
        return parsed;
      }
      if (parsed.call) {
        calls.push(parsed.call);
      }
    }
    return { ok: true, calls };
  }

  const parsed = parseSingleCall(obj, availableTools);
  if (!parsed.ok) {
    return parsed;
  }

  return { ok: true, calls: parsed.call ? [parsed.call] : [] };
}

function parseSingleCall(obj, availableTools) {
  const tool = String(obj?.tool || "").trim();
  const args = obj?.args ?? {};

  if (!tool) {
    return { ok: false, message: "Tool object must contain a tool name." };
  }

  if (typeof args !== "object" || Array.isArray(args) || args === null) {
    return { ok: false, message: "Tool args must be an object." };
  }

  if (tool !== "none" && !availableTools.has(tool)) {
    return { ok: false, message: `Tool '${tool}' is not in the allowlist.` };
  }

  if (tool === "none") {
    return { ok: true, call: null };
  }

  return {
    ok: true,
    call: {
      tool,
      args
    }
  };
}

function splitTopLevelPipes(text) {
  const segments = [];
  let depth = 0;
  let inString = false;
  let escaping = false;
  let start = 0;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (escaping) {
      escaping = false;
      continue;
    }

    if (ch === "\\") {
      escaping = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (ch === "{") {
      depth += 1;
      continue;
    }

    if (ch === "}") {
      depth -= 1;
      continue;
    }

    if (ch === "|" && depth === 0) {
      const part = text.slice(start, i).trim();
      if (part) {
        segments.push(part);
      }
      start = i + 1;
    }
  }

  const tail = text.slice(start).trim();
  if (tail) {
    segments.push(tail);
  }

  return segments;
}

function safeParseJsonObject(value) {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") {
      return { ok: false, message: "JSON section must be an object." };
    }

    return {
      ok: true,
      value: parsed
    };
  } catch {
    return { ok: false, message: "JSON section could not be parsed." };
  }
}

function extractTopLevelJsonObjects(text) {
  const results = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaping = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (escaping) {
      escaping = false;
      continue;
    }

    if (ch === "\\") {
      escaping = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (ch === "{") {
      if (depth === 0) {
        start = i;
      }
      depth += 1;
      continue;
    }

    if (ch === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        results.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }

  return results;
}

function sanitizeText(text) {
  return String(text || "").replace(blockedPattern, "[blocked-command]").trim();
}

function extractSafeMessages(responseObj) {
  const messages = [];

  if (Array.isArray(responseObj?.messages)) {
    for (const entry of responseObj.messages) {
      const cleaned = sanitizeText(String(entry || "").trim());
      if (cleaned) {
        messages.push(cleaned);
      }
    }
  }

  const responseText = sanitizeText(String(responseObj?.response || "").trim());
  if (responseText) {
    messages.push(responseText);
  }

  return messages;
}
