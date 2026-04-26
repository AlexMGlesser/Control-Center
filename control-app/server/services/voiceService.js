import { WebSocketServer } from "ws";
import { transcribeAudio, isWhisperReady } from "./whisperService.js";
import { synthesizeSpeech, isPiperReady } from "./piperService.js";
import { runAgentTurn } from "./agentRuntime.js";
import { addUserMessage, addAgentMessage } from "./chatService.js";
import { publishEvent } from "./eventBus.js";

const WAKE_WORD = "jarvis";
const WAKE_WORD_VARIANTS = ["jarvis", "jarves", "jarv is", "jar vis", "jarvas"];

let wss = null;
let attachedHttpServer = null;
let upgradeHandler = null;
const clientState = new WeakMap();

function getClientState(ws) {
  if (!clientState.has(ws)) {
    clientState.set(ws, { muted: false, cancelToken: 0 });
  }
  return clientState.get(ws);
}

const MUTE_PATTERN = /^\s*mute\b/i;
const UNMUTE_PATTERN = /^\s*(unmute|un-?mute)\b/i;

/**
 * Attach the voice WebSocket server to an existing HTTP server.
 * Clients connect to ws://host:port/voice and send binary PCM audio frames.
 *
 * Protocol (client → server):
 *   Binary message  = 16-bit 16kHz mono PCM WAV audio of one utterance
 *   JSON message    = { type: "ping" } or { type: "config", ... }
 *
 * Protocol (server → client):
 *   JSON  { type: "status",      status: "ready"|"listening"|"processing"|"speaking"|"error" }
 *   JSON  { type: "transcript",  text: "..." }
 *   JSON  { type: "agent-text",  text: "..." }
 *   JSON  { type: "wake",        detected: true }
 *   JSON  { type: "error",       message: "..." }
 *   Binary message  = WAV audio of agent's spoken response
 */
export function attachVoiceWebSocket(httpServer) {
  if (wss) {
    closeVoiceWebSocket();
  }

  wss = new WebSocketServer({ noServer: true });
  attachedHttpServer = httpServer;

  upgradeHandler = (request, socket, head) => {
    const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
    if (pathname === "/voice") {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
      });
    }
    // Let other upgrade requests (if any) pass through
  };

  httpServer.on("upgrade", upgradeHandler);

  wss.on("connection", (ws) => {
    console.log("[Voice] Client connected.");
    sendStatus(ws, "ready");

    ws.on("message", async (data, isBinary) => {
      if (!isBinary) {
        // JSON control message
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === "ping") {
            sendJSON(ws, { type: "pong" });
          } else if (msg.type === "cancel") {
            const state = getClientState(ws);
            state.cancelToken += 1;
          }
        } catch {
          // Ignore malformed JSON
        }
        return;
      }

      // Binary = WAV audio from client
      await handleAudioMessage(ws, data);
    });

    ws.on("close", () => {
      console.log("[Voice] Client disconnected.");
    });

    ws.on("error", (err) => {
      console.error("[Voice] WebSocket error:", err.message);
    });
  });

  console.log("[Voice] WebSocket server attached on /voice");
}

export function closeVoiceWebSocket() {
  if (attachedHttpServer && upgradeHandler) {
    attachedHttpServer.off("upgrade", upgradeHandler);
  }

  if (wss) {
    for (const client of wss.clients) {
      try {
        client.terminate();
      } catch {
        // Ignore individual client termination failures during shutdown.
      }
    }

    wss.close();
  }

  wss = null;
  attachedHttpServer = null;
  upgradeHandler = null;
}

export function getVoiceStatus() {
  return {
    whisperReady: isWhisperReady(),
    piperReady: isPiperReady(),
    connectedClients: wss ? wss.clients.size : 0
  };
}

// --- Internal ---

async function handleAudioMessage(ws, wavBuffer) {
  sendStatus(ws, "processing");

  // 1. Transcribe with Whisper
  let transcript;
  try {
    transcript = await transcribeAudio(Buffer.from(wavBuffer));
  } catch (err) {
    console.error("[Voice] Whisper error:", err.message);
    sendJSON(ws, { type: "error", message: `Transcription failed: ${err.message}` });
    sendStatus(ws, "ready");
    return;
  }

  if (!transcript || !transcript.trim()) {
    sendStatus(ws, "ready");
    return;
  }

  sendJSON(ws, { type: "transcript", text: transcript });

  // 2. Check for wake word
  const { detected, command } = extractWakeWord(transcript);
  if (!detected) {
    // No wake word — silently ignore
    sendStatus(ws, "ready");
    return;
  }

  sendJSON(ws, { type: "wake", detected: true });

  if (!command.trim()) {
    // Just the wake word with nothing after it — acknowledge
    const ackText = "Yes sir?";
    sendJSON(ws, { type: "agent-text", text: ackText });
    await speakAndSend(ws, ackText);
    sendStatus(ws, "ready");
    return;
  }

  // 3. Check for mute / unmute
  if (MUTE_PATTERN.test(command)) {
    const state = getClientState(ws);
    state.muted = true;
    const ackText = "Voice muted. I will respond with text only.";
    sendJSON(ws, { type: "agent-text", text: ackText });
    sendJSON(ws, { type: "mute-state", muted: true });
    sendStatus(ws, "ready");
    return;
  }

  if (UNMUTE_PATTERN.test(command)) {
    const state = getClientState(ws);
    state.muted = false;
    const ackText = "Voice unmuted.";
    sendJSON(ws, { type: "agent-text", text: ackText });
    sendJSON(ws, { type: "mute-state", muted: false });
    await speakAndSend(ws, ackText);
    sendStatus(ws, "ready");
    return;
  }

  // 4. Run through agent
  let agentText;
  try {
    const userText = command.trim();

    // Persist user message in chat history
    addUserMessage(userText);

    const agentTurn = await runAgentTurn({ userText, origin: { type: "user", channel: "voice" } });

    // Persist agent reply in chat history
    const agentMessages = Array.isArray(agentTurn.agentMessages) ? agentTurn.agentMessages : [];
    const composedMessage = agentMessages.map((m) => String(m || "").trim()).filter(Boolean).join("\n\n");
    if (composedMessage) {
      addAgentMessage(composedMessage, {
        toolResults: agentTurn.toolResults,
        toolSummary: agentTurn.toolSummary,
        code: agentTurn.code || "OK"
      });
    }

    // Publish a chat event so the UI updates
    publishEvent({
      appId: "control-center",
      source: "voice",
      type: "chat",
      message: "Voice command processed."
    });

    agentText = extractAgentReplyText(agentTurn);
  } catch (err) {
    console.error("[Voice] Agent error:", err.message);
    agentText = "I'm sorry, I encountered an error processing your request.";
  }

  sendJSON(ws, { type: "agent-text", text: agentText });

  // 5. Speak the response (skip if muted)
  const clientMuted = getClientState(ws).muted;
  if (!clientMuted) {
    await speakAndSend(ws, agentText);
  }

  sendStatus(ws, "ready");
}

function extractWakeWord(transcript) {
  const lower = transcript.toLowerCase().trim();

  for (const variant of WAKE_WORD_VARIANTS) {
    const idx = lower.indexOf(variant);
    if (idx !== -1) {
      const command = transcript.slice(idx + variant.length).replace(/^[,.\s]+/, "");
      return { detected: true, command };
    }
  }

  return { detected: false, command: "" };
}

function extractAgentReplyText(agentTurn) {
  if (!agentTurn) return "I couldn't process that request.";

  // Prefer agentMessages array, then agentText
  if (Array.isArray(agentTurn.agentMessages) && agentTurn.agentMessages.length) {
    return agentTurn.agentMessages.join(" ");
  }

  if (agentTurn.agentText) {
    return agentTurn.agentText;
  }

  // Build from tool summary if available
  if (agentTurn.toolSummary) {
    return agentTurn.toolSummary;
  }

  return "Done.";
}

async function speakAndSend(ws, text) {
  if (!text || !isPiperReady()) return;

  const state = getClientState(ws);
  const cancelToken = state.cancelToken;

  sendStatus(ws, "speaking");

  try {
    // Strip markdown/special chars for cleaner speech
    const cleanText = text
      .replace(/[*_`#\[\]()]/g, "")
      .replace(/\bhttps?:\/\/\S+/g, "")
      .trim();

    if (!cleanText) return;

    const wavBuffer = await synthesizeSpeech(cleanText);
    if (ws.readyState === ws.OPEN && state.cancelToken === cancelToken) {
      ws.send(wavBuffer);
    }
  } catch (err) {
    console.error("[Voice] TTS error:", err.message);
    sendJSON(ws, { type: "error", message: `Speech synthesis failed: ${err.message}` });
  }
}

function sendJSON(ws, obj) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function sendStatus(ws, status) {
  sendJSON(ws, { type: "status", status });
}
