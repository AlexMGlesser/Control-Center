// The library lives on the PC (control-app/server/services/movieLibraryService.js):
// folders are added once and remembered, and the phone streams from the same list.
const API = "/api/apps/movie-app";

const state = {
  movies: [],
  folders: [],
  selectedMovieId: null,
  activeMovieId: null,
  captionsEnabled: false,
  thumbnails: new Map()
};

const elements = {
  importFolderBtn: document.getElementById("import-folder-btn"),
  rescanBtn: document.getElementById("rescan-btn"),
  overlayImportBtn: document.getElementById("overlay-import-btn"),
  openSelectedBtn: document.getElementById("open-selected-btn"),
  folderList: document.getElementById("folder-list"),
  movieGrid: document.getElementById("movie-grid"),
  movieCount: document.getElementById("movie-count"),
  video: document.getElementById("movie-player"),
  emptyPlayer: document.getElementById("empty-player"),
  nowPlaying: document.getElementById("now-playing"),
  playbackMeta: document.getElementById("playback-meta"),
  overlay: document.getElementById("select-overlay"),
  playPauseBtn: document.getElementById("play-pause-btn"),
  rewindBtn: document.getElementById("rewind-btn"),
  forwardBtn: document.getElementById("forward-btn"),
  volDownBtn: document.getElementById("vol-down-btn"),
  volUpBtn: document.getElementById("vol-up-btn"),
  speedDownBtn: document.getElementById("speed-down-btn"),
  speedUpBtn: document.getElementById("speed-up-btn"),
  captionsBtn: document.getElementById("captions-btn")
};

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({ ok: false, message: `Request failed (${res.status}).` }));
  if (!res.ok || data.ok === false) throw new Error(data.message || `Request failed (${res.status}).`);
  return data;
}

function formatDuration(value) {
  if (!Number.isFinite(value) || value < 0) {
    return "00:00";
  }

  const totalSeconds = Math.floor(value);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function updatePlaybackMeta() {
  const current = formatDuration(elements.video.currentTime);
  const total = formatDuration(elements.video.duration);
  elements.playbackMeta.textContent = `${current} / ${total} | x${elements.video.playbackRate.toFixed(2)}`;
}

/** A frame from early in the movie, for movies without a poster image. */
async function captureThumbnail(url) {
  try {
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    video.src = url;

    await new Promise((resolve, reject) => {
      video.onloadeddata = resolve;
      video.onerror = () => reject(new Error("thumbnail-load-failed"));
    });

    const targetTime = Math.max(0, Math.min(120, (video.duration || 0) * 0.1));
    if (Number.isFinite(targetTime) && targetTime > 0) {
      await new Promise((resolve) => {
        video.onseeked = resolve;
        video.currentTime = targetTime;
      });
    }

    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 180;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    video.removeAttribute("src");
    video.load();
    return canvas.toDataURL("image/jpeg", 0.82);
  } catch {
    return null;
  }
}

function setCaptionsEnabled(enabled) {
  const tracks = Array.from(elements.video.textTracks || []);
  if (!tracks.length) {
    state.captionsEnabled = false;
    elements.captionsBtn.disabled = true;
    elements.captionsBtn.textContent = "Captions";
    return;
  }

  state.captionsEnabled = Boolean(enabled);
  tracks.forEach((track) => {
    track.mode = state.captionsEnabled ? "showing" : "hidden";
  });
  elements.captionsBtn.disabled = false;
  elements.captionsBtn.textContent = state.captionsEnabled ? "Captions On" : "Captions Off";
}

function updateSelectOverlay() {
  const hasMovies = Array.isArray(state.movies) && state.movies.length > 0;
  elements.overlay.classList.toggle("hidden", hasMovies);
}

function renderFolders() {
  elements.folderList.innerHTML = state.folders
    .map(
      (folder) => `
        <span class="folder-chip ${folder.missing ? "missing" : ""}" title="${escapeHtml(folder.path)}${folder.missing ? " (missing)" : ""}">
          <span>${escapeHtml(folder.path)}</span>
          <button type="button" data-action="remove-folder" data-path="${escapeHtml(folder.path)}" aria-label="Remove folder">×</button>
        </span>`
    )
    .join("");
}

function renderLibrary() {
  renderFolders();
  elements.movieCount.textContent = String(state.movies.length);
  elements.openSelectedBtn.disabled = !state.selectedMovieId;

  if (!state.movies.length) {
    elements.movieGrid.innerHTML = `<article class="movie-card"><div class="movie-fallback">${state.folders.length ? "No movies found in these folders" : "No movie folders yet"}</div></article>`;
    updateSelectOverlay();
    return;
  }

  elements.movieGrid.innerHTML = state.movies
    .map((movie) => {
      const selectedClass = movie.id === state.selectedMovieId ? "is-selected" : "";
      const thumb = movie.thumbnail
        ? `<img class="movie-thumb" src="${escapeHtml(movie.thumbnail)}" alt="${escapeHtml(movie.title)}" />`
        : '<div class="movie-fallback">MOVIE</div>';

      return `
        <article class="movie-card ${selectedClass}" data-movie-id="${movie.id}">
          ${thumb}
          <div class="movie-info">
            <div class="movie-title" title="${escapeHtml(movie.title)}">${escapeHtml(movie.title)}</div>
            <div class="movie-meta">${escapeHtml(movie.fileName)}</div>
            <button class="btn movie-open" type="button" data-action="open-movie" data-movie-id="${movie.id}">Open</button>
          </div>
        </article>
      `;
    })
    .join("");

  updateSelectOverlay();
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function findMovieById(movieId) {
  return state.movies.find((movie) => movie.id === movieId) || null;
}

function setSelectedMovie(movieId) {
  state.selectedMovieId = movieId;
  renderLibrary();
}

function setNowPlaying(movie) {
  elements.nowPlaying.textContent = movie ? `Now Playing: ${movie.title}` : "No movie selected";
}

async function openMovie(movieId) {
  const movie = findMovieById(movieId);
  if (!movie) {
    return;
  }

  state.activeMovieId = movie.id;
  state.selectedMovieId = movie.id;

  elements.video.querySelectorAll("track").forEach((track) => track.remove());
  elements.video.src = movie.url;
  movie.subtitles.forEach((subtitle) => {
    const track = document.createElement("track");
    track.kind = "subtitles";
    track.label = subtitle.label;
    track.src = `${API}/subtitles/${movie.id}?index=${subtitle.index}`;
    elements.video.append(track);
  });
  elements.video.load();
  elements.emptyPlayer.style.display = "none";
  setNowPlaying(movie);
  renderLibrary();
  updateSelectOverlay();

  try {
    await elements.video.play();
  } catch {
    // Autoplay can be blocked; user can press play.
  }

  elements.playPauseBtn.textContent = elements.video.paused ? "Play" : "Pause";
}

function adjustVolume(delta) {
  const nextVolume = Math.max(0, Math.min(1, elements.video.volume + delta));
  elements.video.volume = Number(nextVolume.toFixed(2));
}

function adjustSpeed(delta) {
  const nextRate = Math.max(0.25, Math.min(3, elements.video.playbackRate + delta));
  elements.video.playbackRate = Number(nextRate.toFixed(2));
  updatePlaybackMeta();
}

function applyLibrary(library) {
  state.folders = library.folders || [];
  state.movies = (library.movies || []).map((movie) => ({
    ...movie,
    url: `${API}/stream/${movie.id}`,
    thumbnail: movie.hasPoster ? `${API}/poster/${movie.id}` : state.thumbnails.get(movie.id) || null
  }));
  if (!state.movies.some((movie) => movie.id === state.selectedMovieId)) {
    state.selectedMovieId = state.movies[0]?.id || null;
  }
  renderLibrary();
  fillThumbnails();
}

let thumbnailRun = 0;

/** Grabs frames one movie at a time, for movies without a poster. */
async function fillThumbnails() {
  const run = ++thumbnailRun;
  for (const movie of state.movies) {
    if (run !== thumbnailRun) return;
    if (movie.thumbnail) continue;
    const frame = await captureThumbnail(movie.url);
    if (frame) {
      state.thumbnails.set(movie.id, frame);
      movie.thumbnail = frame;
      renderLibrary();
    }
  }
}

async function loadLibrary() {
  try {
    applyLibrary(await api("/library"));
  } catch (error) {
    elements.nowPlaying.textContent = error.message;
  }
}

async function chooseFolder() {
  const bridge = window.controlCenterDesktop;
  if (bridge?.chooseDirectory) return bridge.chooseDirectory();
  const res = await fetch("/api/system/choose-directory", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  return res.json();
}

async function importMovieFolder() {
  const result = await chooseFolder();
  if (!result?.ok || result.canceled || !result.path) return;
  elements.nowPlaying.textContent = "Scanning…";
  try {
    applyLibrary(await api("/folders", { method: "POST", body: { path: result.path } }));
    setNowPlaying(findMovieById(state.activeMovieId));
  } catch (error) {
    elements.nowPlaying.textContent = error.message;
  }
}

async function removeFolder(folderPath) {
  try {
    applyLibrary(await api("/folders/remove", { method: "POST", body: { path: folderPath } }));
  } catch (error) {
    elements.nowPlaying.textContent = error.message;
  }
}

async function rescan() {
  elements.nowPlaying.textContent = "Scanning…";
  try {
    applyLibrary(await api("/rescan", { method: "POST" }));
    setNowPlaying(findMovieById(state.activeMovieId));
  } catch (error) {
    elements.nowPlaying.textContent = error.message;
  }
}

function bindEvents() {
  elements.importFolderBtn.addEventListener("click", () => {
    importMovieFolder().catch(() => {
      // Ignore picker failures.
    });
  });

  elements.overlayImportBtn.addEventListener("click", () => {
    importMovieFolder().catch(() => {
      // Ignore picker failures.
    });
  });

  elements.rescanBtn.addEventListener("click", () => {
    rescan();
  });

  elements.folderList.addEventListener("click", (event) => {
    const button = event.target.closest('[data-action="remove-folder"]');
    if (button) removeFolder(button.dataset.path);
  });

  elements.movieGrid.addEventListener("click", (event) => {
    const openButton = event.target.closest('[data-action="open-movie"]');
    if (openButton) {
      const movieId = String(openButton.dataset.movieId || "");
      openMovie(movieId).catch(() => {
        // Keep controls responsive if opening fails.
      });
      return;
    }

    const card = event.target.closest("[data-movie-id]");
    if (!card) {
      return;
    }

    setSelectedMovie(String(card.dataset.movieId || ""));
  });

  elements.openSelectedBtn.addEventListener("click", () => {
    if (!state.selectedMovieId) {
      return;
    }

    openMovie(state.selectedMovieId).catch(() => {
      // Keep controls responsive if opening fails.
    });
  });

  elements.playPauseBtn.addEventListener("click", () => {
    if (!elements.video.src) {
      return;
    }

    if (elements.video.paused) {
      elements.video.play().catch(() => {
        // Ignore play failures.
      });
    } else {
      elements.video.pause();
    }
  });

  elements.rewindBtn.addEventListener("click", () => {
    if (!elements.video.src) {
      return;
    }
    elements.video.currentTime = Math.max(0, elements.video.currentTime - 10);
  });

  elements.forwardBtn.addEventListener("click", () => {
    if (!elements.video.src) {
      return;
    }
    const duration = Number.isFinite(elements.video.duration) ? elements.video.duration : Number.POSITIVE_INFINITY;
    elements.video.currentTime = Math.min(duration, elements.video.currentTime + 10);
  });

  elements.volDownBtn.addEventListener("click", () => adjustVolume(-0.1));
  elements.volUpBtn.addEventListener("click", () => adjustVolume(0.1));
  elements.speedDownBtn.addEventListener("click", () => adjustSpeed(-0.25));
  elements.speedUpBtn.addEventListener("click", () => adjustSpeed(0.25));

  elements.captionsBtn.addEventListener("click", () => {
    setCaptionsEnabled(!state.captionsEnabled);
  });

  elements.video.addEventListener("play", () => {
    elements.playPauseBtn.textContent = "Pause";
  });

  elements.video.addEventListener("pause", () => {
    elements.playPauseBtn.textContent = "Play";
  });

  elements.video.addEventListener("timeupdate", updatePlaybackMeta);
  elements.video.addEventListener("ratechange", updatePlaybackMeta);
  elements.video.addEventListener("loadedmetadata", () => {
    updatePlaybackMeta();
    setCaptionsEnabled(false);
  });
}

function init() {
  elements.video.volume = 0.8;
  elements.video.playbackRate = 1;
  renderLibrary();
  setNowPlaying(null);
  updatePlaybackMeta();
  bindEvents();
  updateSelectOverlay();
  loadLibrary();
}

init();
