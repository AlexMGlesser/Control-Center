# Agent Context

The agent's system prompt is built at runtime in `agentRuntime.js`'s
`buildMessages()`, combining a few sources — it is not a single static file.

## Sources combined into the system prompt

1. `control-app/agent/AGENT_TOOL_CONTEXT.txt` - short role/style instructions
   (read via `getAgentContextText()` in `agentRuntime.js`)
2. `control-app/server/services/agentContextLoader.js` - a ranked, size-capped
   bundle of excerpts from `design-documents/*.md` (control-center-overview,
   control-center-architecture, plus the movie-app docs), relevant to the
   current message
3. The current date/time (for resolving relative dates in calendar requests)
4. Recent app-to-agent background messages (`appMessageService.js`)
5. Recent chat history (`chatService.getChatHistoryContext`)

## Files referenced

- `agentic-testing/agent.md` - human-readable architecture overview (not fed
  to the model directly)
- `control-app/server/services/agentRuntime.js` - builds the prompt, runs the
  tool-calling loop
- `control-app/server/services/agentTools.js` - the actual tool catalog and
  dispatcher (source of truth for what the model can call)
- `control-app/server/services/ollamaService.js` - Ollama chat completion
  with native tool-calling, replacing the old LMStudio/text-envelope approach

## Tool calling

Tools are passed to Ollama in its native JSON-schema function-calling format
(see `TOOL_DEFINITIONS` in `agentTools.js`). The model returns structured
`tool_calls` — there is no custom message envelope or protocol to parse.
