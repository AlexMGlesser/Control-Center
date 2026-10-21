import { WebSocketServer } from "ws";
import { transcribeAudio, isWhisperReady } from "./whisperService.js";
import { synthesizeSpeech, isPiperReady } from "./piperService.js";
import { addUserMessage } from "./chatService.js";
import { enqueueUserTurn, onReplyDelivered } from "./queueWorker.js";
import { isDesktopUpgradeRequest } from "./authService.js";

const WAKE_WORD_VARIANTS = ["jarvis", "jarves", "jarv is", "jar vis", "jarvas"];
const MUTE_PATTERN = /^\s*mute\b/i;
const UNMUTE_PATTERN = /^\s*(unmute|un-?mute)\b/i;

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

/**
 * Attach the voice WebSocket server to an existing HTTP server.
 * Clients connect to ws://host:port/voice and send binary PCM audio frames.
 *
 * Protocol (client -> server): binary = WAV audio of one utterance;
 *   JSON = { type: "ping" } | { type: "cancel" }
 * Protocol (server -> client): JSON status/transcript/agent-text/wake/mute-state/error
 *   messages, plus binary WAV audio for the spoken reply.
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
      // Voice is desktop-only: the handshake must carry the local session cookie.
      if (!isDesktopUpgradeRequest(request)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
      });
    }
  };

  httpServer.on("upgrade", upgradeHandler);

  wss.on("connection", (ws) => {
    console.log("[Voice] Client connected.");
    sendStatus(ws, "ready");

    ws.on("message", async (data, isBinary) => {
      if (!isBinary) {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === "ping") {
            sendJSON(ws, { type: "pong" });
          } else if (msg.type === "cancel") {
            getClientState(ws).cancelToken += 1;
          }
        } catch {
          // Ignore malformed JSON.
        }
        return;
      }

      await handleAudioMessage(ws, data);
    });

    ws.on("close", () => console.log("[Voice] Client disconnected."));
    ws.on("error", (err) => console.error("[Voice] WebSocket error:", err.message));
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

/**
 * Speaks a message to every currently-connected voice client, without being
 * triggered by that client's own turn (e.g. an alarm's wake-up briefing).
 * Respects each client's mute state; always sends the text regardless.
 */
export function broadcastSpokenMessage(text) {
  if (!wss) {
    return;
  }

  for (const client of wss.clients) {
    if (client.readyState !== client.OPEN) {
      continue;
    }
    sendJSON(client, { type: "agent-text", text });
    if (!getClientState(client).muted) {
      speakAndSend(client, text).catch(() => {
        // speakAndSend already reports errors to the client; nothing more to do here.
      });
    }
  }
}

// --- Internal ---

function runAgentTurnQueued(userText) {
  return new Promise((resolve) => {
    const { turnId } = enqueueUserTurn(userText, { priority: "high", origin: { type: "user", channel: "voice" } });
    const unsubscribe = onReplyDelivered(({ turnId: completedTurnId, message }) => {
      if (completedTurnId !== turnId) {
        return;
      }
      unsubscribe();
      resolve(message);
    });
  });
}

async function handleAudioMessage(ws, wavBuffer) {
  sendStatus(ws, "processing");

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

  const { detected, command } = extractWakeWord(transcript);
  if (!detected) {
    sendStatus(ws, "ready");
    return;
  }

  sendJSON(ws, { type: "wake", detected: true });

  if (!command.trim()) {
    const ackText = "Yes?";
    sendJSON(ws, { type: "agent-text", text: ackText });
    await speakAndSend(ws, ackText);
    sendStatus(ws, "ready");
    return;
  }

  if (MUTE_PATTERN.test(command)) {
    getClientState(ws).muted = true;
    const ackText = "Voice muted. I will respond with text only.";
    sendJSON(ws, { type: "agent-text", text: ackText });
    sendJSON(ws, { type: "mute-state", muted: true });
    sendStatus(ws, "ready");
    return;
  }

  if (UNMUTE_PATTERN.test(command)) {
    getClientState(ws).muted = false;
    const ackText = "Voice unmuted.";
    sendJSON(ws, { type: "agent-text", text: ackText });
    sendJSON(ws, { type: "mute-state", muted: false });
    await speakAndSend(ws, ackText);
    sendStatus(ws, "ready");
    return;
  }

  let agentText;
  try {
    const userText = command.trim();
    addUserMessage(userText);
    const result = await runAgentTurnQueued(userText);
    agentText = result || "Done.";
  } catch (err) {
    console.error("[Voice] Agent error:", err.message);
    agentText = "I'm sorry, I encountered an error processing your request.";
  }

  sendJSON(ws, { type: "agent-text", text: agentText });

  if (!getClientState(ws).muted) {
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

async function speakAndSend(ws, text) {
  if (!text || !isPiperReady()) {
    return;
  }

  const state = getClientState(ws);
  const cancelToken = state.cancelToken;

  sendStatus(ws, "speaking");

  try {
    const cleanText = text
      .replace(/[*_`#[\]()]/g, "")
      .replace(/\bhttps?:\/\/\S+/g, "")
      .trim();

    if (!cleanText) {
      return;
    }

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
