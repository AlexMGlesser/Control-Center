import { execFile } from "child_process";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync, statfsSync, writeFileSync, mkdirSync } from "fs";
import os from "os";
import path from "path";
import { getSecurityDirectory } from "../appPaths.js";

// The phone's File System app (design-documents/mobile-app-architecture.md 5.10):
// a read-only view of the whole PC, i.e. anything the Windows account running
// Control Center can read. There are deliberately no write, rename or delete
// functions here. Separate from fileSystemService.js, which runs the
// hand-tracking explorer on the PC.

const ACCESS_FILE = "phone-access.json";
const HIDDEN_CACHE_MS = 10_000;
const HIDDEN_QUERY_TIMEOUT_MS = 8_000;
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

const KIND_BY_EXTENSION = new Map([
  ...["txt", "md", "json", "js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "java", "kt", "kts", "c", "h", "cpp", "hpp", "cs", "go", "rs", "rb", "php",
    "html", "htm", "css", "scss", "csv", "tsv", "log", "xml", "yml", "yaml", "toml", "ini", "cfg", "conf", "sh", "ps1", "bat", "cmd", "sql", "gradle",
    "properties", "env", "gitignore", "svg"].map((ext) => [ext, "text"]),
  ...["png", "jpg", "jpeg", "gif", "webp", "bmp", "heic", "avif"].map((ext) => [ext, "image"]),
  ["pdf", "pdf"],
  ...["mp3", "m4a", "aac", "flac", "wav", "ogg", "oga", "opus", "wma"].map((ext) => [ext, "audio"]),
  ...["mp4", "m4v", "mkv", "webm", "mov", "avi", "wmv"].map((ext) => [ext, "video"])
]);

export function fileKind(name) {
  const ext = path.extname(name).slice(1).toLowerCase() || (name.startsWith(".") ? name.slice(1).toLowerCase() : "");
  return KIND_BY_EXTENSION.get(ext) || "other";
}

function filesError(code, message, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

/* ---------------- Kill switch (desktop Settings > Devices) ---------------- */

export function isPhoneFileAccessEnabled() {
  const filePath = path.join(getSecurityDirectory(), ACCESS_FILE);
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")).files !== false;
  } catch {
    return true; // on by default (design 3.5)
  }
}

export function setPhoneFileAccessEnabled(enabled) {
  const directory = getSecurityDirectory();
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, ACCESS_FILE), JSON.stringify({ files: Boolean(enabled) }, null, 2), "utf-8");
  return Boolean(enabled);
}

/* ---------------- Path checks ---------------- */

/**
 * Validates a path from a paired device. The whole PC is in scope, so paths
 * are absolute, but only plain local-drive paths are accepted: no UNC network
 * paths, no \\?\ or \\.\ device prefixes, no alternate data streams, no
 * reserved device names. Symlinks/junctions are followed and the target is
 * checked by the same rules.
 */
export function resolveSafePath(rawPath) {
  const value = String(rawPath || "").trim();
  if (!value) {
    throw filesError("PATH_REQUIRED", "A path is required.");
  }
  checkPathShape(value);
  const resolved = path.resolve(value);
  checkPathShape(resolved);
  if (!existsSync(resolved)) {
    throw filesError("PATH_NOT_FOUND", "That file or folder doesn't exist.", 404);
  }
  let real;
  try {
    real = realpathSync.native(resolved);
  } catch {
    throw filesError("NO_ACCESS", "Windows won't let Control Center open that.", 403);
  }
  checkPathShape(real);
  return real;
}

function checkPathShape(value) {
  if (process.platform === "win32") {
    if (!/^[a-zA-Z]:[\\/]/.test(value)) {
      throw filesError("INVALID_PATH", "Only local drive paths like C:\\Users are allowed.");
    }
    if (value.startsWith("\\\\")) {
      throw filesError("INVALID_PATH", "Network and device paths aren't allowed.");
    }
    // A colon is only allowed as the drive letter's: anything else is an alternate data stream.
    if (value.slice(2).includes(":")) {
      throw filesError("INVALID_PATH", "Alternate data streams aren't allowed.");
    }
  } else if (!path.isAbsolute(value)) {
    throw filesError("INVALID_PATH", "Paths must be absolute.");
  }
  const segments = value.split(/[\\/]+/).filter(Boolean);
  if (segments.some((segment) => segment === "..")) {
    throw filesError("INVALID_PATH", "'..' isn't allowed.");
  }
  if (segments.slice(1).some((segment) => RESERVED_NAMES.test(segment))) {
    throw filesError("INVALID_PATH", "That name is reserved by Windows.");
  }
}

/* ---------------- Roots ---------------- */

export function listRoots() {
  const home = os.homedir();
  const quick = ["Desktop", "Documents", "Downloads", "Pictures", "Music", "Videos"]
    .map((name) => {
      // Windows can redirect these into OneDrive.
      const candidates = [path.join(home, name), path.join(home, "OneDrive", name)];
      const found = candidates.find((candidate) => existsSync(candidate));
      return found ? { name, path: found, type: "folder" } : null;
    })
    .filter(Boolean);

  const drives = [];
  if (process.platform === "win32") {
    for (let code = 65; code <= 90; code += 1) {
      const root = `${String.fromCharCode(code)}:\\`;
      if (!existsSync(root)) continue;
      let freeBytes = null;
      let totalBytes = null;
      try {
        const stats = statfsSync(root);
        freeBytes = stats.bavail * stats.bsize;
        totalBytes = stats.blocks * stats.bsize;
      } catch {
        // Some drives (empty card readers) can't report space.
      }
      drives.push({ name: root.slice(0, 2), path: root, type: "drive", freeBytes, totalBytes });
    }
  } else {
    drives.push({ name: "/", path: "/", type: "drive", freeBytes: null, totalBytes: null });
  }
  return { quick, drives };
}

/* ---------------- Hidden and system files ---------------- */

const hiddenCache = new Map(); // folder -> { at, names: Set }

/**
 * Names in `folder` with the Windows hidden or system attribute. Node can't
 * read those attributes, so this asks PowerShell once per folder. The folder
 * is passed through an environment variable, never spliced into the command.
 */
function windowsHiddenNames(folder) {
  const cached = hiddenCache.get(folder);
  if (cached && Date.now() - cached.at < HIDDEN_CACHE_MS) {
    return Promise.resolve(cached.names);
  }
  const script =
    "[Console]::OutputEncoding = [Text.Encoding]::UTF8;" +
    "Get-ChildItem -LiteralPath $env:CC_LIST_PATH -Force -ErrorAction SilentlyContinue | " +
    "Where-Object { $_.Attributes -band 6 } | ForEach-Object { $_.Name }";
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, timeout: HIDDEN_QUERY_TIMEOUT_MS, env: { ...process.env, CC_LIST_PATH: folder }, encoding: "utf8" },
      (error, stdout) => {
        const names = new Set(
          String(stdout || "")
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
        );
        if (!error) hiddenCache.set(folder, { at: Date.now(), names });
        resolve(names);
      }
    );
  });
}

/** Same rule as the desktop explorer's is_hidden_entry: dot-names plus hidden/system. */
async function hiddenNamesIn(folder) {
  return process.platform === "win32" ? windowsHiddenNames(folder) : new Set();
}

/* ---------------- Listing, details, content ---------------- */

export async function listFolder(rawPath, { showHidden = false } = {}) {
  const folder = resolveSafePath(rawPath);
  let stats;
  try {
    stats = statSync(folder);
  } catch {
    throw filesError("NO_ACCESS", "Windows won't let Control Center open that folder.", 403);
  }
  if (!stats.isDirectory()) {
    throw filesError("NOT_A_FOLDER", "That's a file, not a folder.");
  }

  let dirents;
  try {
    dirents = readdirSync(folder, { withFileTypes: true });
  } catch {
    throw filesError("NO_ACCESS", "Windows won't let Control Center open that folder.", 403);
  }

  const hidden = showHidden ? new Set() : await hiddenNamesIn(folder);
  const entries = [];
  for (const dirent of dirents) {
    const name = dirent.name;
    const isHidden = name.startsWith(".") || hidden.has(name);
    if (isHidden && !showHidden) continue;
    const fullPath = path.join(folder, name);
    let entryStats = null;
    try {
      entryStats = statSync(fullPath);
    } catch {
      // Unreadable entry: still list it, marked as no access.
    }
    const isFolder = entryStats ? entryStats.isDirectory() : dirent.isDirectory();
    // Only entries we can't even stat are flagged; a folder we can stat but
    // not open is found out when the phone opens it (403 NO_ACCESS).
    const noAccess = !entryStats;
    entries.push({
      name,
      path: fullPath,
      type: isFolder ? "folder" : "file",
      kind: isFolder ? "folder" : fileKind(name),
      size: isFolder || !entryStats ? null : entryStats.size,
      modified: entryStats ? entryStats.mtime.toISOString() : null,
      ...(showHidden && isHidden ? { hidden: true } : {}),
      ...(noAccess ? { noAccess: true } : {})
    });
  }

  entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) : a.type === "folder" ? -1 : 1));
  const parent = path.dirname(folder);
  return { path: folder, parent: parent !== folder ? parent : null, entries };
}

export function fileInfo(rawPath) {
  const target = resolveSafePath(rawPath);
  const stats = statSync(target);
  return {
    name: path.basename(target) || target,
    path: target,
    type: stats.isDirectory() ? "folder" : "file",
    kind: stats.isDirectory() ? "folder" : fileKind(target),
    size: stats.isDirectory() ? null : stats.size,
    created: stats.birthtime.toISOString(),
    modified: stats.mtime.toISOString()
  };
}

/** The real path of a readable regular file, for streaming. */
export function resolveReadableFile(rawPath) {
  const target = resolveSafePath(rawPath);
  const stats = statSync(target);
  if (!stats.isFile()) {
    throw filesError("NOT_A_FILE", "That's a folder, not a file.");
  }
  return { path: target, size: stats.size, name: path.basename(target) };
}
