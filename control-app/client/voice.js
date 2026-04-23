/**
 * Control Center — Client Voice Module
 *
 * Captures microphone audio, performs energy-based Voice Activity Detection (VAD),
 * records utterances as WAV, sends them to the server over WebSocket for
 * Whisper transcription + agent processing, and plays back Piper TTS responses.
 *
 * Usage (from app.js):
 *   import { initVoice, getVoiceState } from "./voice.js";
 *   initVoice({ onStatusChange, onTranscript, onAgentText, onWake, onError });
 */

// ---- State ----
let ws = null;
let mediaStream = null;
let audioContext = null;
let analyserNode = null;
let workletNode = null;
let isListening = false;
let voiceStatus = "off"; // off | connecting | ready | listening | recording | processing | speaking | error
let callbacks = {};
let reconnectTimer = null;
let activePlaybackSource = null;
let activePlaybackCtx = null;
let isMuted = false;
const RECONNECT_MS = 3000;

// VAD parameters
const VAD_ENERGY_THRESHOLD = 0.015;   // RMS threshold to detect speech
const VAD_SILENCE_DURATION = 800;     // ms of silence before ending utterance
const VAD_MIN_UTTERANCE_MS = 500;     // minimum utterance length to send
const VAD_MAX_UTTERANCE_MS = 15000;   // maximum utterance length
const SAMPLE_RATE = 16000;

// Recording state
let isRecording = false;
let recordedChunks = [];
let recordStartTime = 0;
let silenceStartTime = 0;
let vadCheckInterval = null;

export function getVoiceState() {
  return {
    status: voiceStatus,
    isListening,
    isRecording
  };
}

/**
 * Initialize the voice system.
 * @param {Object} opts
 * @param {Function} opts.onStatusChange  - (status: string) => void
 * @param {Function} opts.onTranscript    - (text: string) => void
 * @param {Function} opts.onAgentText     - (text: string) => void
 * @param {Function} opts.onWake          - () => void
 * @param {Function} opts.onError         - (message: string) => void
 */
export function initVoice(opts = {}) {
  callbacks = opts;
  startVoicePipeline();
}

export function stopVoice() {
  isListening = false;
  cleanupAudio();
  cleanupWebSocket();
  setStatus("off");
}

export function isVoiceActive() {
  return isListening && ws && ws.readyState === WebSocket.OPEN;
}

// ---- WebSocket ----

function connectWebSocket() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  setStatus("connecting");

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${protocol}//${window.location.host}/voice`;
  ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";

  ws.onopen = () => {
    console.log("[Voice] WebSocket connected.");
    setStatus("ready");
    scheduleReconnect(false);
  };

  ws.onmessage = (event) => {
    if (typeof event.data === "string") {
      handleJsonMessage(JSON.parse(event.data));
    } else {
      // Binary = TTS audio response
      playAudioResponse(event.data);
    }
  };

  ws.onclose = () => {
    console.log("[Voice] WebSocket closed.");
    if (isListening) {
      setStatus("connecting");
      scheduleReconnect(true);
    } else {
      setStatus("off");
    }
  };

  ws.onerror = () => {
    // onclose will fire after this
  };
}

function handleJsonMessage(msg) {
  switch (msg.type) {
    case "status":
      setStatus(msg.status === "ready" ? "listening" : msg.status);
      break;
    case "transcript":
      callbacks.onTranscript?.(msg.text);
      break;
    case "agent-text":
      callbacks.onAgentText?.(msg.text);
      break;
    case "wake":
      callbacks.onWake?.();
      break;
    case "error":
      callbacks.onError?.(msg.message);
      break;
    case "mute-state":
      isMuted = msg.muted;
      break;
    case "pong":
      break;
  }
}

function cleanupWebSocket() {
  scheduleReconnect(false);
  if (ws) {
    ws.onclose = null;
    ws.onerror = null;
    ws.close();
    ws = null;
  }
}

function scheduleReconnect(enable) {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (enable && isListening) {
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (isListening) connectWebSocket();
    }, RECONNECT_MS);
  }
}

// ---- Audio Capture ----

async function startVoicePipeline() {
  if (isListening) return;

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: SAMPLE_RATE,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });
  } catch (err) {
    console.error("[Voice] Microphone access denied:", err.message);
    setStatus("error");
    callbacks.onError?.("Microphone access denied. Please allow microphone access.");
    return;
  }

  audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
  const source = audioContext.createMediaStreamSource(mediaStream);

  // Analyser for energy-based VAD
  analyserNode = audioContext.createAnalyser();
  analyserNode.fftSize = 2048;
  source.connect(analyserNode);

  // ScriptProcessor for capturing raw PCM (AudioWorklet would be better but this is simpler)
  const bufferSize = 4096;
  const scriptNode = audioContext.createScriptProcessor(bufferSize, 1, 1);
  scriptNode.onaudioprocess = (e) => {
    if (isRecording) {
      const inputData = e.inputBuffer.getChannelData(0);
      recordedChunks.push(new Float32Array(inputData));
    }
  };
  source.connect(scriptNode);
  scriptNode.connect(audioContext.destination);

  isListening = true;
  connectWebSocket();
  startVAD();
}

function cleanupAudio() {
  stopVAD();

  if (audioContext) {
    audioContext.close().catch(() => {});
    audioContext = null;
  }

  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }

  analyserNode = null;
  isRecording = false;
  recordedChunks = [];
}

// ---- Voice Activity Detection ----

function startVAD() {
  if (vadCheckInterval) return;
  vadCheckInterval = setInterval(checkVAD, 100);
}

function stopVAD() {
  if (vadCheckInterval) {
    clearInterval(vadCheckInterval);
    vadCheckInterval = null;
  }
}

function checkVAD() {
  if (!analyserNode || !isListening) return;

  const energy = computeRMSEnergy();
  const now = Date.now();
  const speakingBargeIn = voiceStatus === "speaking" || voiceStatus === "processing";
  const threshold = speakingBargeIn ? VAD_ENERGY_THRESHOLD * 0.65 : VAD_ENERGY_THRESHOLD;

  if (!isRecording) {
    // Check if speech started
    if (energy > threshold) {
      // Barge-in: stop any active TTS playback
      stopPlayback();

      isRecording = true;
      recordedChunks = [];
      recordStartTime = now;
      silenceStartTime = 0;
      setStatus("recording");
    }
  } else {
    // Currently recording — check for silence or max duration
    const duration = now - recordStartTime;

    if (energy > threshold) {
      silenceStartTime = 0;
    } else {
      if (!silenceStartTime) {
        silenceStartTime = now;
      }

      const silenceDuration = now - silenceStartTime;
      if (silenceDuration >= VAD_SILENCE_DURATION || duration >= VAD_MAX_UTTERANCE_MS) {
        // End of utterance
        finishRecording(duration);
      }
    }

    // Force-end if max duration exceeded
    if (duration >= VAD_MAX_UTTERANCE_MS) {
      finishRecording(duration);
    }
  }
}

function computeRMSEnergy() {
  const dataArray = new Float32Array(analyserNode.fftSize);
  analyserNode.getFloatTimeDomainData(dataArray);

  let sum = 0;
  for (let i = 0; i < dataArray.length; i++) {
    sum += dataArray[i] * dataArray[i];
  }
  return Math.sqrt(sum / dataArray.length);
}

function finishRecording(durationMs) {
  isRecording = false;

  if (durationMs < VAD_MIN_UTTERANCE_MS || !recordedChunks.length) {
    recordedChunks = [];
    setStatus("listening");
    return;
  }

  // Merge all chunks into a single Float32Array
  const totalLength = recordedChunks.reduce((acc, chunk) => acc + chunk.length, 0);
  const merged = new Float32Array(totalLength);
  let offset = 0;
  for (const chunk of recordedChunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  recordedChunks = [];

  // Convert to 16-bit PCM WAV
  const wavBuffer = encodeWAV(merged, SAMPLE_RATE);

  // Send to server
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(wavBuffer);
    setStatus("processing");
  } else {
    setStatus("listening");
  }
}

// ---- WAV Encoding ----

function encodeWAV(samples, sampleRate) {
  const numChannels = 1;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = numChannels * bytesPerSample;
  const dataLength = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);

  // RIFF header
  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + dataLength, true);
  writeString(view, 8, "WAVE");

  // fmt chunk
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true); // chunk size
  view.setUint16(20, 1, true);  // PCM format
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);

  // data chunk
  writeString(view, 36, "data");
  view.setUint32(40, dataLength, true);

  // Write samples as 16-bit PCM
  let pos = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(pos, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    pos += 2;
  }

  return buffer;
}

function writeString(view, offset, str) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

// ---- Audio Playback ----

function stopPlayback() {
  if (activePlaybackSource) {
    try {
      activePlaybackSource.onended = null;
      activePlaybackSource.stop();
    } catch { /* already stopped */ }
    activePlaybackSource = null;
  }
  if (activePlaybackCtx) {
    activePlaybackCtx.close().catch(() => {});
    activePlaybackCtx = null;
  }
  // Notify server the client interrupted
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "cancel" }));
  }
}

async function playAudioResponse(arrayBuffer) {
  if (isMuted) {
    setStatus("listening");
    return;
  }

  setStatus("speaking");
  try {
    const playbackCtx = new AudioContext();
    const audioBuffer = await playbackCtx.decodeAudioData(arrayBuffer);
    const source = playbackCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(playbackCtx.destination);

    activePlaybackSource = source;
    activePlaybackCtx = playbackCtx;

    source.onended = () => {
      activePlaybackSource = null;
      activePlaybackCtx = null;
      playbackCtx.close().catch(() => {});
      setStatus("listening");
    };
    source.start(0);
  } catch (err) {
    console.error("[Voice] Playback error:", err.message);
    activePlaybackSource = null;
    activePlaybackCtx = null;
    setStatus("listening");
  }
}

// ---- Status Management ----

function setStatus(newStatus) {
  if (voiceStatus === newStatus) return;
  voiceStatus = newStatus;
  callbacks.onStatusChange?.(newStatus);
}
