import { execFile, spawn } from "child_process";
import { existsSync, readdirSync, statSync } from "fs";
import os from "os";
import path from "path";

// Jarvis's access to the ArtCraft suite (getartcraft.com): a set of creative
// apps installed under ARTCRAFT_DIR (default D:\ArtCraft), each in
// apps/<Name>/ with a GUI (<name>.exe) and a headless CLI (<name>-cli.exe).
// Apps are found by scanning that folder, so new or updated apps need no code
// change. Jarvis can open an app (optionally with a file), read a file's
// details, pull the text out of a document, and convert between formats.
// The ArtCraft folder itself is never written to: the apps run from a
// neutral working folder, and conversions can't target it.

const CLI_TIMEOUT_MS = 120_000;
const TEXT_LIMIT_CHARS = 12_000;
const INFO_LIMIT_CHARS = 8_000;

// What each app is for, so the model can pick one from a plain request.
const ABOUT = {
  cadcraft: "2D CAD drafting (DXF/DWG drawings)",
  deckcraft: "presentations and slide decks (.pptx)",
  designcraft: "page layout and desktop publishing (print-ready PDFs)",
  effectcraft: "motion graphics, animation and compositing",
  figcraft: "UI and interface design (Figma-style)",
  filmcraft: "video editing",
  gridcraft: "spreadsheets (.xlsx, .csv)",
  lightcraft: "photo library and raw photo developing",
  pdfcraft: "viewing and editing PDFs (combine, split, OCR)",
  photocraft: "raster image and photo editing (Photoshop-style, .psd)",
  soundcraft: "audio recording and editing",
  vectorcraft: "vector illustration (Illustrator-style, .svg)",
  wordcraft: "word processing (.docx)"
};

// File extension -> the app whose CLI reads it, and how.
const INFO_BY_EXT = {
  pdfcraft: [".pdf"],
  wordcraft: [".docx", ".doc", ".odt", ".rtf"],
  gridcraft: [".xlsx", ".csv", ".tsv"],
  deckcraft: [".pptx", ".deckcraft"],
  cadcraft: [".dxf", ".dwg"],
  figcraft: [".figcraft", ".fig"],
  photocraft: [".psd", ".pcraft", ".png", ".jpg", ".jpeg", ".tif", ".tiff", ".webp", ".exr", ".bmp", ".gif"],
  soundcraft: [".wav", ".mp3", ".flac", ".aiff", ".aif", ".ogg", ".scraft"]
};
const INFO_ARGS = {
  pdfcraft: (f) => ["info", f],
  wordcraft: (f) => ["info", f],
  gridcraft: (f) => ["info", f, "--json"],
  deckcraft: (f) => ["info", f],
  cadcraft: (f) => ["info", f],
  figcraft: (f) => ["info", f, "--json"],
  photocraft: (f) => ["info", "--compact", f],
  soundcraft: (f) => ["info", f]
};
// Every converter takes `convert IN OUT`; OUT's extension picks the format.
const CONVERT_BY_EXT = {
  ...INFO_BY_EXT,
  wordcraft: [...INFO_BY_EXT.wordcraft, ".md", ".html", ".htm", ".txt"],
  vectorcraft: [".svg", ".ai", ".eps", ".vectorcraft"]
};
delete CONVERT_BY_EXT.pdfcraft; // PdfCraft has no convert
const TEXT_BY_EXT = { pdfcraft: [".pdf"], wordcraft: [".docx", ".doc", ".odt", ".rtf", ".md"] };

function artcraftError(code, message, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

export function getArtcraftDirectory() {
  return process.env.ARTCRAFT_DIR || "D:\\ArtCraft";
}

/** The installed apps: { id, name, about, folder, gui, cli }. */
export function discoverArtcraftApps() {
  const appsDir = path.join(getArtcraftDirectory(), "apps");
  if (!existsSync(appsDir)) return [];
  return readdirSync(appsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const id = entry.name.toLowerCase();
      const folder = path.join(appsDir, entry.name);
      const gui = path.join(folder, `${id}.exe`);
      const cli = path.join(folder, `${id}-cli.exe`);
      return {
        id,
        name: entry.name,
        about: ABOUT[id] || "an ArtCraft app",
        folder,
        gui: existsSync(gui) ? gui : null,
        cli: existsSync(cli) ? cli : null
      };
    })
    .filter((app) => app.gui || app.cli)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function listArtcraftApps() {
  return discoverArtcraftApps().map(({ id, name, about }) => ({ id, name, about }));
}

const normalize = (value) => String(value || "").toLowerCase().replace(/[^a-z]/g, "");

/** "PhotoCraft", "photo craft", "photocraft" and "photo" all find PhotoCraft. */
export function resolveArtcraftApp(query) {
  const key = normalize(query);
  const apps = discoverArtcraftApps();
  if (!apps.length) {
    throw artcraftError("ARTCRAFT_NOT_FOUND", `No ArtCraft apps found in ${getArtcraftDirectory()}\\apps.`, 404);
  }
  const match = apps.find((app) => app.id === key) || apps.find((app) => app.id === `${key}craft`);
  if (!match) {
    throw artcraftError("UNKNOWN_ARTCRAFT_APP", `"${query}" isn't an installed ArtCraft app. Installed: ${apps.map((a) => a.name).join(", ")}.`);
  }
  return match;
}

/** Which installed app handles a file, from a table like INFO_BY_EXT. */
export function appForFile(filePath, table, action) {
  const ext = path.extname(String(filePath || "")).toLowerCase();
  const id = Object.keys(table).find((appId) => table[appId].includes(ext));
  if (!id) {
    throw artcraftError("UNSUPPORTED_FILE", `No ArtCraft app can ${action} ${ext || "files without an extension"} files.`);
  }
  const app = discoverArtcraftApps().find((candidate) => candidate.id === id);
  if (!app?.cli) {
    throw artcraftError("ARTCRAFT_NOT_FOUND", `${ABOUT[id] ? id : "That app"} handles ${ext} files but isn't installed.`, 404);
  }
  return app;
}

function requireExistingFile(filePath) {
  const value = String(filePath || "").trim();
  if (!value) throw artcraftError("MISSING_PATH", "Give the file's full path.");
  if (!path.isAbsolute(value)) throw artcraftError("RELATIVE_PATH", `Give the full path (like D:\\Folder\\file.ext), not "${value}".`);
  if (!existsSync(value) || !statSync(value).isFile()) throw artcraftError("FILE_NOT_FOUND", `There's no file at ${value}.`, 404);
  return value;
}

function runCli(app, args) {
  return new Promise((resolve, reject) => {
    execFile(
      app.cli,
      args,
      // Not the app's own folder, so nothing the CLI writes beside itself lands in ArtCraft.
      { cwd: os.tmpdir(), windowsHide: true, timeout: CLI_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr || stdout || error.message).trim().split("\n").slice(-6).join("\n");
          return reject(artcraftError("ARTCRAFT_CLI_FAILED", `${app.name} couldn't do that: ${detail}`, 500));
        }
        resolve(String(stdout));
      }
    );
  });
}

function isInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

const clip = (text, limit) =>
  text.length > limit ? { text: text.slice(0, limit), truncated: true, totalChars: text.length } : { text, truncated: false };

/* ---------------- The tools ---------------- */

/** Opens an app's window on the PC, optionally with a file. */
export function openArtcraftApp(appQuery, filePath) {
  const app = resolveArtcraftApp(appQuery);
  if (!app.gui) throw artcraftError("NO_GUI", `${app.name} has no app window installed, only its command-line tool.`);
  const file = filePath ? requireExistingFile(filePath) : null;
  spawn(app.gui, file ? [file] : [], { cwd: file ? path.dirname(file) : os.homedir(), detached: true, stdio: "ignore" }).unref();
  return { app: app.name, file, message: file ? `Opened ${path.basename(file)} in ${app.name}.` : `Opened ${app.name}.` };
}

/** A file's details (pages, slides, sheets, layers, duration…) from the app that reads it. */
export async function artcraftFileInfo(filePath) {
  const file = requireExistingFile(filePath);
  const app = appForFile(file, INFO_BY_EXT, "read");
  const output = (await runCli(app, INFO_ARGS[app.id](file))).trim();
  return { app: app.name, file, ...clip(output, INFO_LIMIT_CHARS) };
}

/** The text of a PDF or a word-processor document. */
export async function artcraftReadText(filePath) {
  const file = requireExistingFile(filePath);
  const app = appForFile(file, TEXT_BY_EXT, "read the text of");
  const output = (await runCli(app, ["text", file])).replace(/\f/g, "\n\n").trim();
  return { app: app.name, file, ...clip(output, TEXT_LIMIT_CHARS) };
}

/** Converts a file; the output's extension picks the format. Never overwrites. */
export async function artcraftConvert(inputPath, outputPath) {
  const input = requireExistingFile(inputPath);
  const output = String(outputPath || "").trim();
  if (!output) throw artcraftError("MISSING_PATH", "Give the full path for the converted file.");
  if (!path.isAbsolute(output)) throw artcraftError("RELATIVE_PATH", `Give the full output path, not "${output}".`);
  if (isInside(getArtcraftDirectory(), output)) {
    throw artcraftError("ARTCRAFT_FOLDER", "Converted files can't be saved inside the ArtCraft install folder; pick another folder.");
  }
  if (existsSync(output)) throw artcraftError("OUTPUT_EXISTS", `${output} already exists; pick another name so nothing is overwritten.`, 409);
  if (!existsSync(path.dirname(output))) throw artcraftError("FOLDER_NOT_FOUND", `The folder ${path.dirname(output)} doesn't exist.`, 404);
  const app = appForFile(input, CONVERT_BY_EXT, "convert");
  await runCli(app, ["convert", input, output]);
  if (!existsSync(output)) throw artcraftError("ARTCRAFT_CLI_FAILED", `${app.name} finished but didn't write ${output}.`, 500);
  return { app: app.name, input, output, message: `Converted ${path.basename(input)} to ${path.basename(output)} with ${app.name}.` };
}
