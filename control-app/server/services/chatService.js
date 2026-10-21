const chatState = {
  messages: [],
  nextId: 1
};

export function getChatMessages(limit = 80) {
  const safeLimit = Number.isFinite(Number(limit)) ? Number(limit) : 80;
  return chatState.messages.slice(-safeLimit);
}

// `device` ({ id, kind, name }) records which device sent it, for the
// "from Phone" / "from PC" label in the shared chat history.
export function addUserMessage(text, device = null) {
  const cleaned = String(text || "").trim();
  if (!cleaned) {
    return { ok: false, code: "EMPTY_MESSAGE", message: "Message text is required." };
  }
  const message = {
    id: chatState.nextId++,
    role: "user",
    text: cleaned,
    timestamp: new Date().toISOString(),
    ...(device ? { device } : {})
  };
  chatState.messages.push(message);
  return { ok: true, message };
}

export function addAgentMessage(text) {
  const cleaned = String(text || "").trim();
  if (!cleaned) {
    return { ok: false, code: "EMPTY_MESSAGE", message: "Message text is required." };
  }
  const message = { id: chatState.nextId++, role: "agent", text: cleaned, timestamp: new Date().toISOString() };
  chatState.messages.push(message);
  return { ok: true, message };
}

export function getChatHistoryContext(limit = 20) {
  return getChatMessages(limit).map((message) => ({ role: message.role, text: message.text }));
}
