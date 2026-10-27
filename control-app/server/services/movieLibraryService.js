import { createHash } from "crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "fs";
import path from "path";
import { readRuntimeSection, writeRuntimeSection } from "./runtimePersistenceService.js";
import { publishEvent } from "./eventBus.js";

// The Movie app's library on the PC (mobile architecture 5.6): the folders
// you picked, scanned into an index that both the desktop Movie app and the
// phone read. Before this, the desktop app only held movies inside the
// browser, so nothing could be shared. Files are streamed, never copied.

const VIDEO_EXTENSIONS = new Set([".mp4", ".m4v", ".mov", ".mkv", ".webm", ".avi", ".wmv"]);
const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"];
const FOLDER_POSTERS = ["poster", "folder", "cover"];
const MAX_DEPTH = 4;
const MAX_MOVIES = 5000;

function movieError(code, message, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function loadStore() {
  const saved = readRuntimeSection("movies", null);
  return {
    folders: Array.isArray(saved?.folders) ? saved.folders.filter((folder) => typeof folder === "string") : [],
    movies: Array.isArray(saved?.movies) ? saved.movies : [],
    scannedAt: saved?.scannedAt || null
  };
}

let store = loadStore();

function saveStore() {
  writeRuntimeSection("movies", store);
  publishEvent({ source: "movies", appId: "movie-app", type: "data-changed", message: "Movie library changed.", meta: { entity: "library" } });
}

function prettyTitle(fileName) {
  return String(fileName || "")
    .replace(/\.[a-z0-9]{2,5}$/i, "")
    .replace(/[._]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function movieId(filePath) {
  return createHash("sha1").update(filePath.toLowerCase()).digest("hex").slice(0, 16);
}

/** A same-name image next to the movie, or poster/folder/cover.jpg when it's alone in its folder. */
function findPoster(folder, baseName, names, aloneInFolder) {
  const lower = new Map(names.map((name) => [name.toLowerCase(), name]));
  for (const ext of IMAGE_EXTENSIONS) {
    const match = lower.get(`${baseName.toLowerCase()}${ext}`) || lower.get(`${baseName.toLowerCase()}-poster${ext}`);
    if (match) return path.join(folder, match);
  }
  if (aloneInFolder) {
    for (const stem of FOLDER_POSTERS) {
      for (const ext of IMAGE_EXTENSIONS) {
        const match = lower.get(`${stem}${ext}`);
        if (match) return path.join(folder, match);
      }
    }
  }
  return null;
}

/** movie.srt, movie.en.srt, movie.vtt … */
function findSubtitles(folder, baseName, names) {
  const prefix = baseName.toLowerCase();
  return names
    .filter((name) => {
      const lower = name.toLowerCase();
      return (lower.endsWith(".srt") || lower.endsWith(".vtt")) && lower.startsWith(prefix) && (lower.length === prefix.length + 4 || lower[prefix.length] === ".");
    })
    .map((name) => {
      const middle = name.slice(baseName.length, -4).replace(/^\./, "");
      return { path: path.join(folder, name), label: middle || "Subtitles" };
    });
}

function scanFolder(root, found) {
  const walk = (folder, depth) => {
    if (depth > MAX_DEPTH || found.length >= MAX_MOVIES) return;
    let entries;
    try {
      entries = readdirSync(folder, { withFileTypes: true });
    } catch {
      return;
    }
    const names = entries.map((entry) => entry.name);
    const videos = entries.filter((entry) => entry.isFile() && VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase()));
    for (const entry of videos) {
      const filePath = path.join(folder, entry.name);
      let stats;
      try {
        stats = statSync(filePath);
      } catch {
        continue;
      }
      const baseName = entry.name.slice(0, -path.extname(entry.name).length);
      // A folder holding one movie is usually named after it ("Heat (1995)/heat.mkv").
      const title = videos.length === 1 && depth > 0 ? prettyTitle(path.basename(folder)) : prettyTitle(entry.name);
      found.push({
        id: movieId(filePath),
        title,
        fileName: entry.name,
        path: filePath,
        folder: root,
        container: path.extname(entry.name).slice(1).toLowerCase(),
        size: stats.size,
        modified: stats.mtime.toISOString(),
        poster: findPoster(folder, baseName, names, videos.length === 1),
        subtitles: findSubtitles(folder, baseName, names)
      });
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith(".") && !entry.name.startsWith("$")) {
        walk(path.join(folder, entry.name), depth + 1);
      }
    }
  };
  walk(root, 0);
}

/** Rescans every folder. Fast: names and sizes only, nothing is read from the video files. */
export function rescanMovies() {
  const found = [];
  for (const folder of store.folders) {
    if (existsSync(folder)) scanFolder(folder, found);
  }
  found.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base", numeric: true }));
  store = { ...store, movies: found, scannedAt: new Date().toISOString() };
  saveStore();
  return getMovieLibrary();
}

/** What clients see: no PC paths beyond the folder names, and flags instead of poster/subtitle paths. */
export function getMovieLibrary() {
  return {
    folders: store.folders.map((folder) => ({ path: folder, missing: !existsSync(folder) })),
    scannedAt: store.scannedAt,
    movies: store.movies.map((movie) => ({
      id: movie.id,
      title: movie.title,
      fileName: movie.fileName,
      container: movie.container,
      size: movie.size,
      modified: movie.modified,
      hasPoster: Boolean(movie.poster),
      subtitles: (movie.subtitles || []).map((subtitle, index) => ({ index, label: subtitle.label }))
    }))
  };
}

export function addMovieFolder(rawPath) {
  const value = String(rawPath || "").trim();
  if (!value) throw movieError("FOLDER_REQUIRED", "Choose a folder.");
  let folder;
  try {
    folder = realpathSync.native(path.resolve(value));
  } catch {
    throw movieError("FOLDER_NOT_FOUND", "That folder doesn't exist.", 404);
  }
  if (!statSync(folder).isDirectory()) throw movieError("NOT_A_FOLDER", "That's a file, not a folder.");
  if (!store.folders.some((existing) => existing.toLowerCase() === folder.toLowerCase())) {
    store = { ...store, folders: [...store.folders, folder] };
  }
  return rescanMovies();
}

export function removeMovieFolder(rawPath) {
  const target = String(rawPath || "").trim().toLowerCase();
  store = { ...store, folders: store.folders.filter((folder) => folder.toLowerCase() !== target) };
  return rescanMovies();
}

function findMovie(id) {
  const movie = store.movies.find((item) => item.id === String(id || ""));
  if (!movie) throw movieError("MOVIE_NOT_FOUND", "That movie isn't in the library.", 404);
  return movie;
}

/** The video file to stream. Only files the library scan found can be served. */
export function movieFilePath(id) {
  const movie = findMovie(id);
  if (!existsSync(movie.path)) throw movieError("MOVIE_FILE_MISSING", "The movie file was moved or deleted. Rescan the library.", 404);
  return movie.path;
}

export function moviePosterPath(id) {
  const movie = findMovie(id);
  if (!movie.poster || !existsSync(movie.poster)) throw movieError("NO_POSTER", "This movie has no poster image.", 404);
  return movie.poster;
}

/** Subtitles as WebVTT, which browsers and the phone's player both read. */
export function movieSubtitlesVtt(id, index = 0) {
  const movie = findMovie(id);
  const subtitle = (movie.subtitles || [])[Number(index) || 0];
  if (!subtitle || !existsSync(subtitle.path)) throw movieError("NO_SUBTITLES", "This movie has no subtitle file.", 404);
  const text = readFileSync(subtitle.path, "utf-8").replace(/^﻿/, "");
  if (subtitle.path.toLowerCase().endsWith(".vtt")) return text;
  // SRT -> VTT: a header, and "00:01:02,345" becomes "00:01:02.345".
  return `WEBVTT\n\n${text.replace(/\r\n/g, "\n").replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2")}`;
}
