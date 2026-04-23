import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataDir = path.join(__dirname, "..", "data");
const drawingFilesPath = path.join(dataDir, "drawing-files.json");

const MAX_NAME_LENGTH = 80;
const ALLOWED_MODES = new Set(["2d", "3d"]);

function ensureDataStore() {
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  if (!existsSync(drawingFilesPath)) {
    writeFileSync(
      drawingFilesPath,
      JSON.stringify({ nextId: 1, files: [] }, null, 2),
      "utf-8"
    );
  }
}

function loadStore() {
  ensureDataStore();
  try {
    const raw = readFileSync(drawingFilesPath, "utf-8");
    const parsed = JSON.parse(raw);
    const nextId = Number.isFinite(parsed?.nextId) ? Number(parsed.nextId) : 1;
    const files = Array.isArray(parsed?.files) ? parsed.files : [];
    return { nextId, files };
  } catch {
    return { nextId: 1, files: [] };
  }
}

function saveStore(store) {
  ensureDataStore();
  writeFileSync(drawingFilesPath, JSON.stringify(store, null, 2), "utf-8");
}

function normalizeName(name) {
  return String(name || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NAME_LENGTH);
}

function normalizeMode(mode) {
  const value = String(mode || "").trim().toLowerCase();
  return ALLOWED_MODES.has(value) ? value : "";
}

function normalizeLocationPath(rawPath) {
  const value = String(rawPath || "").trim();
  if (!value) {
    return "";
  }

  const resolved = path.resolve(value);
  if (!existsSync(resolved)) {
    throw createDrawingError("DRAWING_LOCATION_NOT_FOUND", "Selected save location does not exist.", 400);
  }

  let stats;
  try {
    stats = statSync(resolved);
  } catch {
    throw createDrawingError("DRAWING_LOCATION_INVALID", "Could not read selected save location.", 400);
  }

  if (!stats.isDirectory()) {
    throw createDrawingError("DRAWING_LOCATION_NOT_DIRECTORY", "Save location must be a folder.", 400);
  }

  return resolved;
}

function toSafeFilename(name) {
  return String(name || "")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NAME_LENGTH);
}

function getDrawingExportPath(file) {
  const locationPath = String(file?.locationPath || "").trim();
  const safeBaseName = toSafeFilename(file?.name || "drawing");
  if (!locationPath || !safeBaseName) {
    return "";
  }

  return path.join(locationPath, `${safeBaseName}.${file.mode || "drawing"}.drawing.json`);
}

function persistDrawingToDisk(file) {
  const exportPath = getDrawingExportPath(file);
  if (!exportPath) {
    return "";
  }

  const payload = {
    id: file.id,
    name: file.name,
    mode: file.mode,
    createdAt: file.createdAt,
    updatedAt: file.updatedAt,
    content: file.content && typeof file.content === "object" ? file.content : {}
  };

  writeFileSync(exportPath, JSON.stringify(payload, null, 2), "utf-8");
  return exportPath;
}

function toSummary(file) {
  return {
    id: file.id,
    name: file.name,
    mode: file.mode,
    locationPath: String(file.locationPath || ""),
    diskFilePath: String(file.diskFilePath || ""),
    createdAt: file.createdAt,
    updatedAt: file.updatedAt
  };
}

export function listDrawingFiles() {
  const store = loadStore();
  const files = store.files
    .slice()
    .sort((a, b) => Date.parse(String(b.updatedAt || "")) - Date.parse(String(a.updatedAt || "")))
    .map(toSummary);

  return {
    ok: true,
    files
  };
}

export function getDrawingFile(fileId) {
  const id = Number(fileId);
  if (!Number.isFinite(id) || id <= 0) {
    throw createDrawingError("INVALID_DRAWING_ID", "A valid drawing file id is required.", 400);
  }

  const store = loadStore();
  const file = store.files.find((item) => item.id === id);
  if (!file) {
    throw createDrawingError("DRAWING_FILE_NOT_FOUND", `Drawing file '${fileId}' was not found.`, 404);
  }

  return {
    ok: true,
    file: {
      ...toSummary(file),
      content: file.content && typeof file.content === "object" ? file.content : {}
    }
  };
}

export function createDrawingFile({ name, mode, locationPath }) {
  const normalizedName = normalizeName(name);
  const normalizedMode = normalizeMode(mode);
  const normalizedLocationPath = normalizeLocationPath(locationPath);

  if (!normalizedName) {
    throw createDrawingError("INVALID_DRAWING_NAME", "Drawing file name is required.", 400);
  }

  if (!normalizedMode) {
    throw createDrawingError("INVALID_DRAWING_MODE", "Drawing mode must be '2d' or '3d'.", 400);
  }

  const store = loadStore();
  const duplicate = store.files.find(
    (file) => file.name.toLowerCase() === normalizedName.toLowerCase() && file.mode === normalizedMode
  );

  if (duplicate) {
    throw createDrawingError(
      "DRAWING_FILE_EXISTS",
      `A ${normalizedMode.toUpperCase()} drawing file named '${normalizedName}' already exists.`,
      409
    );
  }

  const timestamp = new Date().toISOString();
  const file = {
    id: store.nextId,
    name: normalizedName,
    mode: normalizedMode,
    locationPath: normalizedLocationPath,
    diskFilePath: "",
    createdAt: timestamp,
    updatedAt: timestamp,
    content: normalizedMode === "2d"
      ? { imageDataUrl: "", width: 0, height: 0 }
      : {}
  };

  file.diskFilePath = persistDrawingToDisk(file);

  store.nextId += 1;
  store.files.push(file);
  saveStore(store);

  return {
    ok: true,
    file: {
      ...toSummary(file),
      content: file.content
    }
  };
}

export function updateDrawingFile(fileId, { content }) {
  const id = Number(fileId);
  if (!Number.isFinite(id) || id <= 0) {
    throw createDrawingError("INVALID_DRAWING_ID", "A valid drawing file id is required.", 400);
  }

  if (!content || typeof content !== "object") {
    throw createDrawingError("INVALID_DRAWING_CONTENT", "Drawing content payload is required.", 400);
  }

  const store = loadStore();
  const file = store.files.find((item) => item.id === id);
  if (!file) {
    throw createDrawingError("DRAWING_FILE_NOT_FOUND", `Drawing file '${fileId}' was not found.`, 404);
  }

  file.content = {
    ...(file.content && typeof file.content === "object" ? file.content : {}),
    ...content
  };
  file.updatedAt = new Date().toISOString();
  file.diskFilePath = persistDrawingToDisk(file);
  saveStore(store);

  return {
    ok: true,
    file: {
      ...toSummary(file),
      content: file.content
    }
  };
}

export function deleteDrawingFile(fileId) {
  const id = Number(fileId);
  if (!Number.isFinite(id) || id <= 0) {
    throw createDrawingError("INVALID_DRAWING_ID", "A valid drawing file id is required.", 400);
  }

  const store = loadStore();
  const index = store.files.findIndex((item) => item.id === id);
  if (index < 0) {
    throw createDrawingError("DRAWING_FILE_NOT_FOUND", `Drawing file '${fileId}' was not found.`, 404);
  }

  const [removed] = store.files.splice(index, 1);

  const removedPath = String(removed.diskFilePath || "").trim();
  if (removedPath && existsSync(removedPath)) {
    try {
      unlinkSync(removedPath);
    } catch {
      // Ignore delete failures for external files.
    }
  }

  saveStore(store);

  return {
    ok: true,
    file: toSummary(removed)
  };
}

function createDrawingError(code, message, status = 500) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}
