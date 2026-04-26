const VIDEO_EXTENSIONS = [
  ".mp4",
  ".m4v",
  ".mov",
  ".mkv",
  ".webm",
  ".avi",
  ".wmv"
];

const state = {
  movies: [],
  selectedMovieId: null,
  activeMovieId: null,
  captionsEnabled: false
};

const elements = {
  importFolderBtn: document.getElementById("import-folder-btn"),
  overlayImportBtn: document.getElementById("overlay-import-btn"),
  openSelectedBtn: document.getElementById("open-selected-btn"),
  folderInput: document.getElementById("folder-input"),
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

function isVideoFile(file) {
  const name = String(file?.name || "").toLowerCase();
  if (String(file?.type || "").startsWith("video/")) {
    return true;
  }
  return VIDEO_EXTENSIONS.some((ext) => name.endsWith(ext));
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

function clearObjectUrls() {
  state.movies.forEach((movie) => {
    if (movie.url) {
      URL.revokeObjectURL(movie.url);
    }
  });
}

function createMovieId(file, index) {
  return `${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`;
}

function prettyMovieName(fileName) {
  return String(fileName || "")
    .replace(/\.[a-z0-9]{2,5}$/i, "")
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function captureThumbnail(file) {
  const tempUrl = URL.createObjectURL(file);

  try {
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    video.src = tempUrl;

    await new Promise((resolve, reject) => {
      video.onloadeddata = resolve;
      video.onerror = () => reject(new Error("thumbnail-load-failed"));
    });

    const targetTime = Math.max(0, Math.min(2, (video.duration || 0) * 0.1));
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
    return canvas.toDataURL("image/jpeg", 0.82);
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(tempUrl);
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

function renderLibrary() {
  elements.movieCount.textContent = String(state.movies.length);
  elements.openSelectedBtn.disabled = !state.selectedMovieId;

  if (!state.movies.length) {
    elements.movieGrid.innerHTML = '<article class="movie-card"><div class="movie-fallback">No movies imported yet</div></article>';
    updateSelectOverlay();
    return;
  }

  elements.movieGrid.innerHTML = state.movies
    .map((movie) => {
      const selectedClass = movie.id === state.selectedMovieId ? "is-selected" : "";
      const thumb = movie.thumbnail
        ? `<img class="movie-thumb" src="${movie.thumbnail}" alt="${escapeHtml(movie.title)}" />`
        : '<div class="movie-fallback">MOVIE</div>';

      return `
        <article class="movie-card ${selectedClass}" data-movie-id="${movie.id}">
          ${thumb}
          <div class="movie-info">
            <div class="movie-title" title="${escapeHtml(movie.title)}">${escapeHtml(movie.title)}</div>
            <div class="movie-meta">${escapeHtml(movie.file.name)}</div>
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

  elements.video.src = movie.url;
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

async function importMovieFolder() {
  elements.folderInput.value = "";
  elements.folderInput.click();
}

async function onFolderSelected() {
  const files = Array.from(elements.folderInput.files || []).filter(isVideoFile);
  if (!files.length) {
    return;
  }

  clearObjectUrls();
  state.movies = files.map((file, index) => ({
    id: createMovieId(file, index),
    file,
    title: prettyMovieName(file.name),
    url: URL.createObjectURL(file),
    thumbnail: null
  }));

  state.selectedMovieId = state.movies[0]?.id || null;
  state.activeMovieId = null;
  setNowPlaying(null);
  elements.video.removeAttribute("src");
  elements.video.load();
  elements.emptyPlayer.style.display = "grid";

  renderLibrary();

  for (const movie of state.movies) {
    movie.thumbnail = await captureThumbnail(movie.file);
    renderLibrary();
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

  elements.folderInput.addEventListener("change", () => {
    onFolderSelected().catch(() => {
      // Ignore import failures and keep UI usable.
    });
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
}

window.addEventListener("beforeunload", () => {
  clearObjectUrls();
});

init();
