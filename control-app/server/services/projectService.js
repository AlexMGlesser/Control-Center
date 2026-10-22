import { execFile, spawn, spawnSync } from "child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "fs";
import os from "os";
import path from "path";
import { readRuntimeSection, writeRuntimeSection } from "./runtimePersistenceService.js";
import { publishEvent } from "./eventBus.js";

// The Projects app (project-app): one list of project folders, each tagged
// Personal or Work (this replaced the separate Projects and Work apps).
// Projects are browsed one folder at a time and text files can be edited
// in place, from the desktop and from a paired phone.

const CATEGORIES = new Set(["personal", "work"]);
const READ_LIMIT_BYTES = 512 * 1024;
const SAVE_LIMIT_BYTES = 2 * 1024 * 1024;
const TRASH_TIMEOUT_MS = 20_000;

let store = loadStore();

function projectError(code, message, status = 400, details = undefined) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  if (details) error.details = details;
  return error;
}

/* ------------------------------------------------------------------ */
/* The project list                                                    */
/* ------------------------------------------------------------------ */

function loadStore() {
  const saved = readRuntimeSection("projects", null);
  if (saved && Array.isArray(saved.projects)) {
    return { projects: saved.projects.filter((project) => project?.id && project?.path) };
  }
  // First run after the merge: keep the one old placeholder that was a real folder.
  const seeded = [];
  const legacy = path.resolve("D:\\Control-Center");
  if (process.platform === "win32" && existsSync(legacy)) {
    seeded.push({ id: "control-center", name: "Control-Center", path: legacy, category: "personal", createdAt: new Date().toISOString() });
  }
  const initial = { projects: seeded };
  writeRuntimeSection("projects", initial);
  return initial;
}

function saveStore() {
  writeRuntimeSection("projects", store);
  publishEvent({ source: "projects", appId: "project-app", type: "data-changed", message: "Projects changed.", meta: { entity: "project" } });
}

function describe(project) {
  return { ...project, missing: !existsSync(project.path) };
}

export function listProjects() {
  return store.projects.map(describe);
}

export function getProject(projectId) {
  const project = store.projects.find((entry) => entry.id === projectId);
  return project ? describe(project) : null;
}

function requireProject(projectId) {
  const project = store.projects.find((entry) => entry.id === projectId);
  if (!project) {
    throw projectError("PROJECT_NOT_FOUND", "That project isn't in your list.", 404);
  }
  if (!existsSync(project.path)) {
    throw projectError("PROJECT_FOLDER_MISSING", `The folder for ${project.name} is missing: ${project.path}`, 404);
  }
  return project;
}

function normalizeCategory(category) {
  const value = String(category || "personal").trim().toLowerCase();
  if (!CATEGORIES.has(value)) {
    throw projectError("INVALID_CATEGORY", "Category must be personal or work.");
  }
  return value;
}

/** Adds an existing folder to the list. */
export function addProject({ name, path: folderPath, category } = {}) {
  const resolved = path.resolve(String(folderPath || "").trim() || ".");
  if (!String(folderPath || "").trim() || !existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw projectError("INVALID_PROJECT_PATH", "Choose an existing folder.");
  }
  if (store.projects.some((project) => samePath(project.path, resolved))) {
    throw projectError("DUPLICATE_PROJECT_PATH", "That folder is already in your projects.", 409);
  }
  const projectName = String(name || "").trim() || path.basename(resolved) || resolved;
  const project = {
    id: uniqueId(projectName),
    name: projectName.slice(0, 80),
    path: resolved,
    category: normalizeCategory(category),
    createdAt: new Date().toISOString()
  };
  store.projects.push(project);
  saveStore();
  return describe(project);
}

export function updateProject(projectId, { name, category } = {}) {
  const project = store.projects.find((entry) => entry.id === projectId);
  if (!project) throw projectError("PROJECT_NOT_FOUND", "That project isn't in your list.", 404);
  if (name !== undefined) {
    const trimmed = String(name).trim();
    if (!trimmed) throw projectError("INVALID_PROJECT_NAME", "A project needs a name.");
    project.name = trimmed.slice(0, 80);
  }
  if (category !== undefined) project.category = normalizeCategory(category);
  saveStore();
  return describe(project);
}

/** Removes a project from the list. The folder itself is left alone. */
export function removeProject(projectId) {
  const index = store.projects.findIndex((entry) => entry.id === projectId);
  if (index < 0) throw projectError("PROJECT_NOT_FOUND", "That project isn't in your list.", 404);
  const [removed] = store.projects.splice(index, 1);
  saveStore();
  return describe(removed);
}

/** Fuzzy lookup for the agent: id, exact name, then partial name. */
export function findProject(query) {
  const value = String(query || "").trim().toLowerCase();
  if (!value) return null;
  const match =
    store.projects.find((project) => project.id === value) ||
    store.projects.find((project) => project.name.toLowerCase() === value) ||
    store.projects.find((project) => project.name.toLowerCase().includes(value));
  return match ? describe(match) : null;
}

function uniqueId(name) {
  const base =
    String(name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-+|-+$)/g, "") || "project";
  let id = base;
  for (let n = 2; store.projects.some((project) => project.id === id); n += 1) id = `${base}-${n}`;
  return id;
}

function samePath(a, b) {
  const norm = (value) => path.resolve(value).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
}

/* ------------------------------------------------------------------ */
/* Paths inside a project                                              */
/* ------------------------------------------------------------------ */

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Resolves a path inside the project and checks it again after following
 * symlinks/junctions, so nothing outside the project folder is reachable.
 */
function resolveInside(project, targetPath, { mustExist = true } = {}) {
  const root = realpathSync.native(path.resolve(project.path));
  const resolved = path.resolve(String(targetPath || "").trim() || root);
  if (!isInside(path.resolve(project.path), resolved) && !isInside(root, resolved)) {
    throw projectError("INVALID_PATH", "That path is outside the project.");
  }
  if (!existsSync(resolved)) {
    if (mustExist) throw projectError("PATH_NOT_FOUND", "That file or folder doesn't exist.", 404);
    return resolved;
  }
  const real = realpathSync.native(resolved);
  if (!isInside(root, real)) {
    throw projectError("INVALID_PATH", "That path is outside the project.");
  }
  return real;
}

function validateName(name) {
  const value = String(name || "").trim();
  if (!value || value === "." || value === ".." || /[\\/:*?"<>|]/.test(value) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(value)) {
    throw projectError("INVALID_NAME", "That isn't a valid file or folder name.");
  }
  return value;
}

/* ------------------------------------------------------------------ */
/* Browsing and editing                                                */
/* ------------------------------------------------------------------ */

/** One folder of a project. */
export function listProjectFolder(projectId, folderPath) {
  const project = requireProject(projectId);
  const folder = resolveInside(project, folderPath);
  if (!statSync(folder).isDirectory()) {
    throw projectError("NOT_A_FOLDER", "That's a file, not a folder.");
  }
  const entries = readdirSync(folder, { withFileTypes: true })
    .map((entry) => {
      const fullPath = path.join(folder, entry.name);
      let stats = null;
      try {
        stats = statSync(fullPath);
      } catch {
        // listed without details
      }
      const isFolder = stats ? stats.isDirectory() : entry.isDirectory();
      return {
        name: entry.name,
        path: fullPath,
        type: isFolder ? "folder" : "file",
        size: isFolder || !stats ? null : stats.size,
        modified: stats ? stats.mtime.toISOString() : null,
        ...(entry.name.startsWith(".") ? { hidden: true } : {})
      };
    })
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) : a.type === "folder" ? -1 : 1));
  const root = realpathSync.native(path.resolve(project.path));
  return {
    project: describe(project),
    path: folder,
    relativePath: path.relative(root, folder),
    parent: samePath(folder, root) ? null : path.dirname(folder),
    entries
  };
}

/** A text file, up to 512 KB. Binary files are refused (415). */
export function readProjectFile(projectId, filePath) {
  const project = requireProject(projectId);
  const target = resolveInside(project, filePath);
  const stats = statSync(target);
  if (!stats.isFile()) throw projectError("NOT_A_FILE", "That's a folder, not a file.");
  const buffer = readFileSync(target).subarray(0, READ_LIMIT_BYTES);
  // A NUL byte in the first 8 KB means it isn't text.
  if (buffer.subarray(0, 8192).includes(0)) {
    throw projectError("BINARY_FILE", "This isn't a text file.", 415, { size: stats.size, type: path.extname(target).slice(1) || "file" });
  }
  return {
    name: path.basename(target),
    path: target,
    size: stats.size,
    // Saves send this back, so an edit made elsewhere in the meantime isn't overwritten.
    modified: stats.mtimeMs,
    truncated: stats.size > READ_LIMIT_BYTES,
    text: buffer.toString("utf-8")
  };
}

/**
 * Saves a text file. If `expectedModified` is given and the file changed on
 * disk since it was opened, nothing is written and a 409 says so. Writes go
 * to a temporary file first and are then swapped in, so a failed save never
 * leaves a half-written file.
 */
export function saveProjectFile(projectId, filePath, content, expectedModified) {
  const project = requireProject(projectId);
  const text = String(content ?? "");
  if (Buffer.byteLength(text, "utf-8") > SAVE_LIMIT_BYTES) {
    throw projectError("FILE_TOO_LARGE", "Files over 2 MB can't be saved from here.", 413);
  }
  const target = resolveInside(project, filePath);
  const stats = statSync(target);
  if (!stats.isFile()) throw projectError("NOT_A_FILE", "That's a folder, not a file.");
  if (stats.size > READ_LIMIT_BYTES) {
    throw projectError("FILE_TOO_LARGE", "This file was only partly loaded, so it can't be saved from here.", 413);
  }
  if (expectedModified !== undefined && expectedModified !== null && Math.abs(stats.mtimeMs - Number(expectedModified)) > 1) {
    throw projectError("FILE_CHANGED", "The file changed on disk since you opened it. Reload it before saving.", 409, { modified: stats.mtimeMs });
  }
  const temporary = `${target}.cc-save-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, text, "utf-8");
  try {
    renameSync(temporary, target);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw projectError("SAVE_FAILED", `Couldn't save: ${error.message}`, 500);
  }
  const saved = statSync(target);
  publishEvent({
    source: "projects",
    appId: "project-app",
    type: "data-changed",
    message: `Saved ${path.basename(target)}.`,
    meta: { entity: "file", projectId, path: target }
  });
  return { name: path.basename(target), path: target, size: saved.size, modified: saved.mtimeMs };
}

/** New empty file or folder. */
export function createProjectEntry(projectId, parentPath, name, type = "file") {
  const project = requireProject(projectId);
  const parent = resolveInside(project, parentPath);
  if (!statSync(parent).isDirectory()) throw projectError("NOT_A_FOLDER", "New items go inside a folder.");
  const target = path.join(parent, validateName(name));
  if (existsSync(target)) throw projectError("PATH_ALREADY_EXISTS", `${path.basename(target)} already exists here.`, 409);
  if (type === "folder") mkdirSync(target);
  else writeFileSync(target, "", { flag: "wx" });
  publishEvent({ source: "projects", appId: "project-app", type: "data-changed", message: `Created ${path.basename(target)}.`, meta: { entity: "file", projectId, path: target } });
  return { name: path.basename(target), path: target, type: type === "folder" ? "folder" : "file" };
}

export function renameProjectEntry(projectId, targetPath, newName) {
  const project = requireProject(projectId);
  const source = resolveInside(project, targetPath);
  if (samePath(source, project.path)) throw projectError("INVALID_TARGET", "Rename the project itself from the project list.");
  const destination = path.join(path.dirname(source), validateName(newName));
  if (existsSync(destination) && !samePath(source, destination)) {
    throw projectError("PATH_ALREADY_EXISTS", `${path.basename(destination)} already exists here.`, 409);
  }
  renameSync(source, destination);
  return { path: destination, name: path.basename(destination) };
}

export function copyProjectEntry(projectId, sourcePath, destinationFolder) {
  const project = requireProject(projectId);
  const source = resolveInside(project, sourcePath);
  const folder = resolveInside(project, destinationFolder);
  if (!statSync(folder).isDirectory()) throw projectError("NOT_A_FOLDER", "Paste into a folder.");
  if (isInside(source, folder)) throw projectError("INVALID_DESTINATION", "Can't copy a folder into itself.");
  const destination = uniqueDestination(folder, path.basename(source));
  copyRecursive(source, destination);
  return { path: destination, name: path.basename(destination) };
}

export function moveProjectEntry(projectId, sourcePath, destinationFolder) {
  const project = requireProject(projectId);
  const source = resolveInside(project, sourcePath);
  const folder = resolveInside(project, destinationFolder);
  if (!statSync(folder).isDirectory()) throw projectError("NOT_A_FOLDER", "Paste into a folder.");
  if (isInside(source, folder)) throw projectError("INVALID_DESTINATION", "Can't move a folder into itself.");
  const destination = uniqueDestination(folder, path.basename(source));
  renameSync(source, destination);
  return { path: destination, name: path.basename(destination) };
}

/**
 * Deleting sends the item to the Windows Recycle Bin: nothing in Projects
 * is ever deleted permanently. The path goes in through an environment
 * variable, never into the command text.
 */
export function trashProjectEntry(projectId, targetPath) {
  const project = requireProject(projectId);
  const target = resolveInside(project, targetPath);
  if (samePath(target, project.path)) throw projectError("INVALID_TARGET", "Remove the project from the list instead.");
  if (process.platform !== "win32") throw projectError("UNSUPPORTED", "Recycle Bin delete is only available on Windows.", 501);
  const isFolder = statSync(target).isDirectory();
  const script =
    "Add-Type -AssemblyName Microsoft.VisualBasic; " +
    (isFolder
      ? "[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($env:CC_TRASH_PATH, 'OnlyErrorDialogs', 'SendToRecycleBin')"
      : "[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($env:CC_TRASH_PATH, 'OnlyErrorDialogs', 'SendToRecycleBin')");
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, timeout: TRASH_TIMEOUT_MS, env: { ...process.env, CC_TRASH_PATH: target } },
      (error, _stdout, stderr) => {
        if (error || existsSync(target)) {
          reject(projectError("DELETE_FAILED", `Couldn't move it to the Recycle Bin. ${String(stderr || error?.message || "").trim()}`.trim(), 500));
          return;
        }
        resolve({ path: target, recycled: true });
      }
    );
  });
}

function uniqueDestination(folder, baseName) {
  const parsed = path.parse(baseName);
  let candidate = path.join(folder, baseName);
  for (let n = 1; existsSync(candidate); n += 1) {
    const suffix = n === 1 ? " copy" : ` copy ${n}`;
    candidate = path.join(folder, `${parsed.name}${suffix}${parsed.ext}`);
  }
  return candidate;
}

function copyRecursive(source, destination) {
  if (statSync(source).isDirectory()) {
    mkdirSync(destination, { recursive: true });
    for (const child of readdirSync(source)) copyRecursive(path.join(source, child), path.join(destination, child));
    return;
  }
  copyFileSync(source, destination);
}

/* ------------------------------------------------------------------ */
/* Opening things on the PC (desktop only)                             */
/* ------------------------------------------------------------------ */

/** Opens a project, folder or file in VS Code. */
export function openInVsCode(projectId, targetPath) {
  const project = requireProject(projectId);
  const target = resolveInside(project, targetPath || project.path);
  if (!launchVsCode(target)) {
    throw projectError("VSCODE_NOT_AVAILABLE", "VS Code isn't installed, or its 'code' command isn't on PATH.", 409);
  }
  return { path: target, message: `Opened ${path.basename(target)} in VS Code.` };
}

/** Opens a file with its default Windows app, or a folder in Explorer. */
export function openWithDefaultApp(projectId, targetPath) {
  const project = requireProject(projectId);
  const target = resolveInside(project, targetPath || project.path);
  if (process.platform === "win32") {
    spawn("explorer.exe", [target], { detached: true, stdio: "ignore" }).unref();
  } else {
    spawn(process.platform === "darwin" ? "open" : "xdg-open", [target], { detached: true, stdio: "ignore" }).unref();
  }
  return { path: target };
}

const TOOLS = {
  vscode: { name: "VS Code" },
  terminal: { name: "Terminal" },
  explorer: { name: "File Explorer" },
  "android-studio": {
    name: "Android Studio",
    candidates: ["C:\\Program Files\\Android\\Android Studio\\bin\\studio64.exe"]
  },
  vmware: {
    name: "VMware Workstation",
    candidates: ["C:\\Program Files (x86)\\VMware\\VMware Workstation\\vmware.exe", "C:\\Program Files\\VMware\\VMware Workstation Pro\\vmware.exe"]
  }
};

/** Which tools exist on this PC, for the toolbar. */
export function availableTools() {
  return Object.entries(TOOLS)
    .filter(([id, tool]) => !tool.candidates || tool.candidates.some((candidate) => existsSync(candidate)))
    .map(([id, tool]) => ({ id, name: tool.name }));
}

/**
 * Launches a tool, in the project's folder when one is given. Executables
 * are spawned directly with argument arrays (no shell), so paths with
 * spaces work and nothing is interpreted.
 */
export function launchTool(toolId, projectId) {
  const tool = TOOLS[toolId];
  if (!tool) throw projectError("UNKNOWN_TOOL", `Unknown tool: ${toolId}`);
  const folder = projectId ? requireProject(projectId).path : os.homedir();

  if (toolId === "vscode") {
    if (!launchVsCode(folder)) throw projectError("VSCODE_NOT_AVAILABLE", "VS Code isn't installed.", 409);
    return { message: `Opened ${path.basename(folder)} in VS Code.` };
  }
  if (toolId === "explorer") {
    spawn("explorer.exe", [folder], { detached: true, stdio: "ignore" }).unref();
    return { message: "Opened File Explorer." };
  }
  if (toolId === "terminal") {
    // Windows Terminal if installed, otherwise a PowerShell window, starting in the folder.
    const hasWindowsTerminal = spawnSync("where", ["wt"], { windowsHide: true, stdio: "ignore" }).status === 0;
    if (hasWindowsTerminal) {
      spawn("wt.exe", ["-d", folder], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("cmd.exe", ["/c", "start", "", "powershell.exe", "-NoExit"], { cwd: folder, detached: true, stdio: "ignore", windowsHide: true }).unref();
    }
    return { message: "Opened a terminal." };
  }
  const executable = tool.candidates.find((candidate) => existsSync(candidate));
  if (!executable) throw projectError("TOOL_NOT_INSTALLED", `${tool.name} isn't installed here.`, 409);
  spawn(executable, projectId ? [folder] : [], { detached: true, stdio: "ignore" }).unref();
  return { message: `Launched ${tool.name}.` };
}

let vsCodeExecutable;

/**
 * Finds Code.exe. The `code` command on PATH is a .cmd shim, which can only
 * run through a shell (and Node doesn't quote arguments for the shell, so a
 * path with spaces or "&" would break or run something else). Code.exe is
 * started directly instead; it hands the path to an open VS Code window.
 */
function findVsCode() {
  if (vsCodeExecutable !== undefined) return vsCodeExecutable;
  const candidates = [
    path.join(os.homedir(), "AppData", "Local", "Programs", "Microsoft VS Code", "Code.exe"),
    "C:\\Program Files\\Microsoft VS Code\\Code.exe"
  ];
  const where = spawnSync("where", ["code"], { encoding: "utf8", windowsHide: true });
  for (const shim of String(where.stdout || "").split(/\r?\n/).filter(Boolean)) {
    // ...\Microsoft VS Code\bin\code.cmd -> ...\Microsoft VS Code\Code.exe
    candidates.unshift(path.join(path.dirname(path.dirname(shim.trim())), "Code.exe"));
  }
  vsCodeExecutable = candidates.find((candidate) => existsSync(candidate)) || null;
  return vsCodeExecutable;
}

function launchVsCode(target) {
  const executable = findVsCode();
  if (!executable) return false;
  spawn(executable, [target], { detached: true, stdio: "ignore" }).unref();
  return true;
}
