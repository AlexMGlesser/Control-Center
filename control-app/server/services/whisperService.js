import { spawn } from "child_process";
import { existsSync, writeFileSync, readFileSync, unlinkSync, mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const voiceDir = path.join(__dirname, "..", "..", "voice");
const whisperDir = path.join(voiceDir, "whisper");
const whisperExe = path.join(whisperDir, "whisper-cli.exe");
const whisperModelSmall = path.join(whisperDir, "ggml-small.en.bin");
const whisperModelBase = path.join(whisperDir, "ggml-base.en.bin");
// Prefer base.en for speed — adequate accuracy for short voice commands
const whisperModel = existsSync(whisperModelBase) ? whisperModelBase : whisperModelSmall;
const tempDir = path.join(voiceDir, "temp");

let ready = false;

export function isWhisperReady() {
  if (ready) return true;
  ready = existsSync(whisperExe) && (existsSync(whisperModelSmall) || existsSync(whisperModelBase));
  return ready;
}

/**
 * Transcribe a 16-bit 16kHz mono PCM WAV buffer using whisper.cpp.
 * Returns the transcribed text string.
 */
export function transcribeAudio(wavBuffer) {
  return new Promise((resolve, reject) => {
    if (!isWhisperReady()) {
      reject(new Error("Whisper is not set up. Run voice/setup-voice.ps1 first."));
      return;
    }

    mkdirSync(tempDir, { recursive: true });
    const tmpFile = path.join(tempDir, `whisper_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.wav`);
    const outFile = tmpFile + ".txt";

    try {
      writeFileSync(tmpFile, wavBuffer);
    } catch (err) {
      reject(new Error(`Failed to write temp WAV file: ${err.message}`));
      return;
    }

    const args = [
      "-m", whisperModel,
      "-f", tmpFile,
      "--language", "en",
      "--no-timestamps",
      "--no-prints",
      "--threads", "4",
      "--output-txt",
      "--output-file", tmpFile  // whisper appends .txt
    ];

    const proc = spawn(whisperExe, args, {
      cwd: whisperDir,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });

    let stderr = "";
    proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

    const timeoutId = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error("Whisper transcription timed out after 30 seconds."));
    }, 30000);

    proc.on("close", (code) => {
      clearTimeout(timeoutId);

      let text = "";
      try {
        if (existsSync(outFile)) {
          text = readFileSync(outFile, "utf-8").trim();
          unlinkSync(outFile);
        }
      } catch {
        // Ignore cleanup errors
      }

      try { unlinkSync(tmpFile); } catch { /* ignore */ }

      if (code !== 0 && !text) {
        reject(new Error(`Whisper exited with code ${code}: ${stderr.slice(0, 500)}`));
        return;
      }

      resolve(text);
    });

    proc.on("error", (err) => {
      clearTimeout(timeoutId);
      try { unlinkSync(tmpFile); } catch { /* ignore */ }
      reject(new Error(`Failed to spawn whisper: ${err.message}`));
    });
  });
}
