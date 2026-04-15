const MAX_MESSAGES = 200;

const chatState = {
  messages: [
    {
      id: 1,
      role: "agent",
      text: "Agent chat is online. Text interaction is ready in Desktop Mode.",
      timestamp: new Date().toISOString()
    }
  ],
  nextId: 2
};

export function getChatMessages(limit = 80) {
  const parsedLimit = Number(limit);
  const safeLimit = Number.isFinite(parsedLimit)
    ? Math.max(1, Math.min(parsedLimit, MAX_MESSAGES))
    : 80;

  return chatState.messages.slice(-safeLimit);
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

  if (chatState.messages.length > MAX_MESSAGES) {
    const overflow = chatState.messages.length - MAX_MESSAGES;
    chatState.messages.splice(0, overflow);
  }

  return {
    ok: true,
    userMessage,
    agentMessage,
    messages: getChatMessages(80)
  };
}

function buildAgentReply(userText) {
  return `Acknowledged. I received: "${userText}". This is a local text-chat stub and is ready for LMStudio agent integration.`;
}
