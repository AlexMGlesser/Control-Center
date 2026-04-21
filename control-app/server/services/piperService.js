import { spawn } from "child_process";
import { existsSync, readFileSync, unlinkSync, mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const voiceDir = path.join(__dirname, "..", "..", "voice");
const piperDir = path.join(voiceDir, "piper");
const piperExe = path.join(piperDir, "piper.exe");
const piperModel = path.join(piperDir, "en_GB-alan-medium.onnx");
const tempDir = path.join(voiceDir, "temp");

let ready = false;

export function isPiperReady() {
  if (ready) return true;
  ready = existsSync(piperExe) && existsSync(piperModel);
  return ready;
}

/**
 * Synthesize speech from text using Piper TTS.
 * Returns a Buffer containing 16-bit 16kHz mono PCM WAV audio.
 */
export function synthesizeSpeech(text) {
  return new Promise((resolve, reject) => {
    if (!isPiperReady()) {
      reject(new Error("Piper TTS is not set up. Run voice/setup-voice.ps1 first."));
      return;
    }

    if (!text || !text.trim()) {
      reject(new Error("No text provided for speech synthesis."));
      return;
    }

    mkdirSync(tempDir, { recursive: true });
    const outFile = path.join(tempDir, `piper_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.wav`);

    const args = [
      "--model", piperModel,
      "--output_file", outFile,
      "--length-scale", "0.75"
    ];

    const proc = spawn(piperExe, args, {
      cwd: piperDir,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });

    // Feed text via stdin
    proc.stdin.write(text.trim());
    proc.stdin.end();

    let stderr = "";
    proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

    const timeoutId = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error("Piper TTS timed out after 30 seconds."));
    }, 30000);

    proc.on("close", (code) => {
      clearTimeout(timeoutId);

      if (!existsSync(outFile)) {
        reject(new Error(`Piper produced no output (exit code ${code}): ${stderr.slice(0, 500)}`));
        return;
      }

      try {
        const wavData = readFileSync(outFile);
        unlinkSync(outFile);
        resolve(wavData);
      } catch (err) {
        reject(new Error(`Failed to read Piper output: ${err.message}`));
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timeoutId);
      reject(new Error(`Failed to spawn piper: ${err.message}`));
    });
  });
}
