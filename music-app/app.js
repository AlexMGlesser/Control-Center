const state = {
  tracks: [],
  currentIndex: -1,
  isShuffle: true,
  isLoop: false,
  savedPlaylists: []
};

const STORAGE_KEY = "control-center-music-playlists";
const LAST_COMMAND_ID_KEY = "control-center-music-last-command-id";
const LAST_COMMAND_MARKER_KEY = "control-center-music-last-command-marker";
// Replay only brief startup race windows so old commands never auto-play on app open.
const COMMAND_REPLAY_WINDOW_MS = 12 * 1000;
const MUSIC_EVENT_STREAM_RETRY_MS = 1500;
const stateChannel = typeof BroadcastChannel !== "undefined"
  ? new BroadcastChannel("control-center-music-state")
  : null;
const commandChannel = typeof BroadcastChannel !== "undefined"
  ? new BroadcastChannel("control-center-music-command")
  : null;
let musicEventStream = null;
let musicEventStreamRetryTimer = null;

const elements = {
  audio: document.getElementById("audio"),
  fileInput: document.getElementById("audio-files"),
  folderInput: document.getElementById("folder-files"),
  playBtn: document.getElementById("play-btn"),
  prevBtn: document.getElementById("prev-btn"),
  nextBtn: document.getElementById("next-btn"),
  shuffleBtn: document.getElementById("shuffle-btn"),
  loopBtn: document.getElementById("loop-btn"),
  clearBtn: document.getElementById("clear-btn"),
  seek: document.getElementById("seek"),
  volume: document.getElementById("volume"),
  currentTime: document.getElementById("current-time"),
  duration: document.getElementById("duration"),
  trackTitle: document.getElementById("track-title"),
  trackMeta: document.getElementById("track-meta"),
  playlist: document.getElementById("playlist"),
  visualizer: document.querySelector(".visualizer"),
  savePlaylistBtn: document.getElementById("save-playlist-btn"),
  playlistNameInput: document.getElementById("playlist-name"),
  savedPlaylists: document.getElementById("saved-playlists")
};

function normalizeForMatch(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isLocalTrackSource(track) {
  const sourcePath = String(track?.sourcePath || "").trim();
  if (sourcePath) {
    return true;
  }

  const url = String(track?.url || "").trim().toLowerCase();
  if (!url) {
    return false;
  }

  if (url.startsWith("blob:")) {
    return true;
  }

  if (url.startsWith("file://")) {
    return true;
  }

  if (url.startsWith("/api/apps/music-app/local-file")) {
    return true;
  }

  return false;
}

function getTrackArtistHint(trackName) {
  const value = String(trackName || "").trim();
  const parts = value.split(" - ");
  if (parts.length < 2) {
    return "";
  }

  return parts.slice(1).join(" - ").trim();
}

function collectLocalTracksForArtist(artistName) {
  const target = normalizeForMatch(artistName);
  if (!target) {
    return [];
  }

  const savedTracks = state.savedPlaylists
    .flatMap((playlist) => (Array.isArray(playlist?.tracks) ? playlist.tracks : []))
    .map(resolveStoredTrackForPlayback)
    .filter(Boolean);

  const combined = [...savedTracks, ...state.tracks]
    .map((track) => cloneTrackForPlayback(track))
    .filter((track) => isLocalTrackSource(track));

  const unique = [];
  const seen = new Set();
  combined.forEach((track) => {
    const key = String(track.sourcePath || track.url || track.name || "").toLowerCase();
    if (!key || seen.has(key)) {
      return;
    }
    seen.add(key);
    unique.push(track);
  });

  return unique.filter((track) => {
    const name = normalizeForMatch(track.name);
    const artistHint = normalizeForMatch(getTrackArtistHint(track.name));
    return name.includes(target) || artistHint.includes(target);
  });
}

async function apiRequest(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json();
  return {
    ok: response.ok,
    status: response.status,
    payload
  };
}

async function syncSavedPlaylistsToServer() {
  const playlists = state.savedPlaylists.map((playlist) => ({
    name: String(playlist?.name || "").trim(),
    count: Array.isArray(playlist?.tracks) ? playlist.tracks.length : 0,
    tracks: Array.isArray(playlist?.tracks)
      ? playlist.tracks.map((track) => ({
          name: String(track?.name || "").trim(),
          sourcePath: String(track?.sourcePath || "").trim()
        }))
      : []
  }));

  try {
    await apiRequest("/api/apps/music-app/local-playlists/sync", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ playlists })
    });
  } catch {
    // Ignore sync failures and keep local playback functional.
  }
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatTime(totalSeconds) {
  const safeSeconds = Number.isFinite(totalSeconds) ? Math.max(0, totalSeconds) : 0;
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = Math.floor(safeSeconds % 60);
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function updateNowPlaying() {
  const track = state.tracks[state.currentIndex];
  if (!track) {
    elements.trackTitle.textContent = "No track selected";
    elements.trackMeta.textContent = "Import files to begin.";
    elements.playBtn.textContent = "Play";
    elements.currentTime.textContent = "0:00";
    elements.duration.textContent = "0:00";
    elements.seek.value = 0;
    elements.seek.max = 100;
    elements.visualizer.classList.remove("playing");
    broadcastMusicState();
    return;
  }

  elements.trackTitle.textContent = track.name;
  elements.trackMeta.textContent = `Track ${state.currentIndex + 1} of ${state.tracks.length}`;
  elements.playBtn.textContent = elements.audio.paused ? "Play" : "Pause";
  broadcastMusicState();
}

function renderPlaylist() {
  if (!state.tracks.length) {
    elements.playlist.innerHTML = '<li class="empty">No tracks loaded yet.</li>';
    return;
  }

  elements.playlist.innerHTML = state.tracks
    .map((track, index) => {
      const activeClass = index === state.currentIndex ? "active" : "";
      const durationText = track.duration ? formatTime(track.duration) : "Ready";
      return `
        <li class="track-item ${activeClass}" data-index="${index}">
          <p class="track-name">${track.name}</p>
          <p class="track-sub">${durationText}</p>
        </li>
      `;
    })
    .join("");
}

async function startCurrentTrackPlayback() {
  const track = state.tracks[state.currentIndex];
  if (!track) {
    return false;
  }

  try {
    await elements.audio.play();
    updateNowPlaying();
    elements.visualizer.classList.add("playing");
    broadcastMusicState();
    return true;
  } catch (error) {
    const originalMuted = elements.audio.muted;

    try {
      elements.audio.muted = true;
      await elements.audio.play();
      updateNowPlaying();
      elements.visualizer.classList.add("playing");
      broadcastMusicState();

      window.setTimeout(() => {
        elements.audio.muted = originalMuted;
      }, 150);

      return true;
    } catch (retryError) {
      elements.audio.muted = originalMuted;
      const failure = retryError || error;
      const reason = String(failure?.message || failure?.name || "Playback was blocked.").trim();
      elements.trackMeta.textContent = `Could not start '${track.name}'. ${reason}`;
      updateNowPlaying();
      return false;
    }
  }
}

function setTrack(index, { autoplay = false } = {}) {
  if (!state.tracks.length) {
    state.currentIndex = -1;
    elements.audio.removeAttribute("src");
    updateNowPlaying();
    renderPlaylist();
    return;
  }

  const boundedIndex = Math.max(0, Math.min(index, state.tracks.length - 1));
  state.currentIndex = boundedIndex;

  const track = state.tracks[state.currentIndex];
  elements.audio.src = track.url;
  elements.audio.load();

  updateNowPlaying();
  renderPlaylist();

  if (autoplay) {
    startCurrentTrackPlayback().catch(() => {
      updateNowPlaying();
    });
  }
}

function getRandomTrackIndex(trackCount) {
  const safeCount = Number(trackCount);
  if (!Number.isFinite(safeCount) || safeCount <= 1) {
    return 0;
  }

  return Math.floor(Math.random() * safeCount);
}

function loadSavedPlaylists() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      state.savedPlaylists = [];
      return;
    }

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      state.savedPlaylists = [];
      return;
    }

    state.savedPlaylists = parsed
      .filter((entry) => entry && typeof entry.name === "string")
      .map(normalizeSavedPlaylistEntry)
      .filter((entry) => entry.tracks.length || entry.trackNames.length);

    // Persist migrated shape so future loads are consistent.
    persistSavedPlaylists();
  } catch {
    state.savedPlaylists = [];
  }
}

function persistSavedPlaylists() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.savedPlaylists));
  syncSavedPlaylistsToServer().catch(() => {
    // Ignore background sync failures.
  });
}

function renderSavedPlaylists() {
  if (!state.savedPlaylists.length) {
    elements.savedPlaylists.innerHTML = '<li class="empty">No saved playlists yet.</li>';
    return;
  }

  elements.savedPlaylists.innerHTML = state.savedPlaylists
    .map((playlist, index) => {
      const stats = getPlaylistSourceStats(playlist);
      const totalCount = playlist.tracks.length || playlist.trackNames.length;
      const healthText = totalCount
        ? `Path linked ${stats.linked}/${totalCount}${stats.missing ? ` | Missing ${stats.missing}` : ""}`
        : "No tracks";

      return `
      <li class="saved-item" data-index="${index}">
        <div>
          <p class="saved-item-name">${escapeHtml(playlist.name)} (${totalCount})</p>
          <p class="track-sub">${escapeHtml(healthText)}</p>
        </div>
        <div>
          <button class="chip" data-action="load-saved">Load</button>
          <button class="chip danger" data-action="delete-saved">Delete</button>
        </div>
      </li>
    `;
    })
    .join("");
}

function saveCurrentQueueAsPlaylist() {
  const rawName = String(elements.playlistNameInput.value || "").trim();
  if (!rawName) {
    return;
  }

  const tracks = state.tracks
    .filter((track) => track && typeof track.url === "string" && track.url.trim())
    .map(cloneTrackForStorage);

  if (!tracks.length) {
    elements.trackMeta.textContent = "No playable tracks in queue to save.";
    return;
  }

  const existingIndex = state.savedPlaylists.findIndex(
    (playlist) => playlist.name.toLowerCase() === rawName.toLowerCase()
  );

  const entry = {
    name: rawName,
    tracks,
    trackNames: tracks.map((track) => track.name)
  };

  // Revoke any blob URLs that are no longer referenced after replacement.
  const previousEntry = existingIndex >= 0 ? state.savedPlaylists[existingIndex] : null;
  if (existingIndex >= 0) {
    state.savedPlaylists[existingIndex] = entry;
  } else {
    state.savedPlaylists.push(entry);
  }

  cleanupOrphanedPlaylistBlobUrls(previousEntry);

  persistSavedPlaylists();
  renderSavedPlaylists();
  elements.playlistNameInput.value = "";
}

function loadSavedPlaylist(index, { autoplay = false } = {}) {
  const playlist = state.savedPlaylists[index];
  if (!playlist) {
    return;
  }

  const storedTracks = Array.isArray(playlist.tracks) ? playlist.tracks : [];
  const playableStoredTracks = storedTracks
    .map(resolveStoredTrackForPlayback)
    .filter(Boolean);

  if (playableStoredTracks.length) {
    state.tracks = playableStoredTracks;
    setTrack(getRandomTrackIndex(state.tracks.length), { autoplay });
    renderPlaylist();
    return;
  }

  // Backward compatibility for legacy name-only playlists.
  const matchedTracks = state.tracks.filter((track) =>
    Array.isArray(playlist.trackNames) && playlist.trackNames.includes(track.name)
  );
  if (!matchedTracks.length) {
    const stats = getPlaylistSourceStats(playlist);
    elements.trackMeta.textContent = stats.missing
      ? `Saved playlist is missing ${stats.missing} source paths. Re-import once, then resave.`
      : "Saved playlist has no stored file links. Re-import once, then resave playlist.";
    return;
  }

  state.tracks = matchedTracks;
  setTrack(getRandomTrackIndex(state.tracks.length), { autoplay });
  renderPlaylist();
}

function playSavedPlaylistByName(playlistName) {
  const targetName = String(playlistName || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

  if (!targetName) {
    return false;
  }

  const index = state.savedPlaylists.findIndex(
    (playlist) => playlist.name.toLowerCase() === targetName
  );

  if (index < 0) {
    elements.trackMeta.textContent = `Playlist '${playlistName}' not found in saved playlists.`;
    return false;
  }

  loadSavedPlaylist(index, { autoplay: true });
  return true;
}

async function playLibraryPlaylistByName(playlistName) {
  const targetName = String(playlistName || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

  if (!targetName) {
    return false;
  }

  const result = await apiRequest("/api/apps/music-app/playlists");
  if (!result.ok) {
    elements.trackMeta.textContent = "Could not load synced playlists.";
    return false;
  }

  const playlists = Array.isArray(result.payload?.playlists) ? result.payload.playlists : [];
  const playlist = playlists.find(
    (item) => String(item?.name || "").trim().toLowerCase() === targetName
  );

  if (!playlist) {
    return false;
  }

  const mappedTracks = (Array.isArray(playlist.tracks) ? playlist.tracks : [])
    .map((track) => {
      const sourcePath = String(track?.sourcePath || "").trim();
      const title = String(track?.title || track?.name || "").trim();
      const artist = String(track?.artist || "").trim();
      const localUrl = toApiStreamUrl(sourcePath);
      if (!localUrl) {
        return null;
      }

      return {
        name: artist ? `${title} - ${artist}` : title,
        url: localUrl,
        duration: 0,
        sourcePath
      };
    })
    .filter(Boolean);

  if (!mappedTracks.length) {
    elements.trackMeta.textContent = `Playlist '${playlist.name}' has no playable local tracks.`;
    return false;
  }

  state.tracks = mappedTracks;
  setTrack(getRandomTrackIndex(state.tracks.length), { autoplay: true });
  renderPlaylist();
  return true;
}

function playPlaylistTracksFromCommand(tracks) {
  const mappedTracks = (Array.isArray(tracks) ? tracks : [])
    .map((track) => {
      const sourcePath = String(track?.sourcePath || "").trim();
      const audioUrl = String(track?.audioUrl || "").trim();
      const title = String(track?.title || track?.name || "").trim();
      const artist = String(track?.artist || "").trim();
      const localUrl = toApiStreamUrl(sourcePath);
      const resolvedUrl = localUrl || audioUrl;

      if (!resolvedUrl) {
        return null;
      }

      return {
        name: artist ? `${title} - ${artist}` : title,
        url: resolvedUrl,
        duration: 0,
        sourcePath
      };
    })
    .filter(Boolean);

  if (!mappedTracks.length) {
    return false;
  }

  state.tracks = mappedTracks;
  setTrack(getRandomTrackIndex(state.tracks.length), { autoplay: true });
  renderPlaylist();
  return true;
}

async function playLibraryArtistByName(artistName) {
  const targetName = String(artistName || "")
    .replace(/\s+/g, " ")
    .trim();

  if (!targetName) {
    return false;
  }

  const mappedTracks = collectLocalTracksForArtist(targetName);

  if (!mappedTracks.length) {
    elements.trackMeta.textContent = `No local tracks found for '${targetName}'.`;
    return false;
  }

  state.tracks = mappedTracks;
  setTrack(0, { autoplay: true });
  renderPlaylist();
  return true;
}

function deleteSavedPlaylist(index) {
  if (!Number.isInteger(index) || index < 0 || index >= state.savedPlaylists.length) {
    return;
  }

  const [deletedPlaylist] = state.savedPlaylists.splice(index, 1);
  cleanupOrphanedPlaylistBlobUrls(deletedPlaylist);
  persistSavedPlaylists();
  renderSavedPlaylists();
}

function normalizeSavedPlaylistEntry(entry) {
  const name = String(entry.name || "").trim();
  const tracksFromStorage = Array.isArray(entry.tracks) ? entry.tracks : [];
  const normalizedTracks = tracksFromStorage
    .filter((track) => track && typeof track.name === "string")
    .map((track) => {
      const normalizedUrl = String(track.url || "").trim();
      const providedSourcePath = String(track.sourcePath || "").trim();
      const recoveredSourcePath = providedSourcePath || sourcePathFromFileUrl(normalizedUrl);

      return {
        name: String(track.name || "").trim(),
        url: normalizedUrl,
        duration: Number.isFinite(track.duration) ? Number(track.duration) : 0,
        sourcePath: recoveredSourcePath
      };
    })
    .filter((track) => track.name);

  const fallbackTrackNames = Array.isArray(entry.trackNames)
    ? entry.trackNames.map((trackName) => String(trackName || "").trim()).filter(Boolean)
    : [];

  return {
    name,
    tracks: normalizedTracks,
    trackNames: normalizedTracks.length ? normalizedTracks.map((track) => track.name) : fallbackTrackNames
  };
}

function cloneTrackForStorage(track) {
  return {
    name: String(track.name || "").trim() || "Untitled Track",
    url: String(track.url || "").trim(),
    duration: Number.isFinite(track.duration) ? Number(track.duration) : 0,
    sourcePath: String(track.sourcePath || "").trim()
  };
}

function cloneTrackForPlayback(track) {
  return {
    name: String(track.name || "").trim() || "Untitled Track",
    url: String(track.url || "").trim(),
    duration: Number.isFinite(track.duration) ? Number(track.duration) : 0,
    sourcePath: String(track.sourcePath || "").trim()
  };
}

function toFileUrl(rawPath) {
  const normalizedPath = String(rawPath || "").trim().replace(/\\/g, "/");
  if (!normalizedPath) {
    return "";
  }

  if (/^file:\/\//i.test(normalizedPath)) {
    return normalizedPath;
  }

  if (/^[A-Za-z]:\//.test(normalizedPath)) {
    return `file:///${encodeURI(normalizedPath)}`;
  }

  if (normalizedPath.startsWith("/")) {
    return `file://${encodeURI(normalizedPath)}`;
  }

  return "";
}

function toApiStreamUrl(rawPath) {
  const sourcePath = String(rawPath || "").trim();
  if (!sourcePath) {
    return "";
  }

  return `/api/apps/music-app/local-file?path=${encodeURIComponent(sourcePath)}`;
}

function sourcePathFromFileUrl(rawUrl) {
  const value = String(rawUrl || "").trim();
  if (!/^file:\/\//i.test(value)) {
    return "";
  }

  try {
    const parsed = new URL(value);
    const decodedPath = decodeURIComponent(parsed.pathname || "");
    if (/^\/[A-Za-z]:/.test(decodedPath)) {
      return decodedPath.slice(1).replace(/\//g, "\\");
    }
    return decodedPath.replace(/\//g, "\\");
  } catch {
    return "";
  }
}

function getFileSystemPath(file) {
  if (!file || typeof file !== "object") {
    return "";
  }

  const directPath = String(file.path || "").trim();
  if (directPath) {
    return directPath;
  }

  return "";
}

function resolveStoredTrackForPlayback(storedTrack) {
  if (!storedTrack || typeof storedTrack !== "object") {
    return null;
  }

  const fallbackUrl = String(storedTrack.url || "").trim();
  const sourcePath = String(storedTrack.sourcePath || "").trim() || sourcePathFromFileUrl(fallbackUrl);
  const apiStreamUrl = toApiStreamUrl(sourcePath);
  const fileUrl = toFileUrl(sourcePath);
  const fallbackResolvedUrl = isBlobUrl(fallbackUrl) && fileUrl ? fileUrl : fallbackUrl || fileUrl;
  const resolvedUrl = apiStreamUrl || fallbackResolvedUrl;
  if (!resolvedUrl) {
    return null;
  }

  return {
    ...cloneTrackForPlayback(storedTrack),
    url: resolvedUrl,
    sourcePath
  };
}

function getPlaylistSourceStats(playlist) {
  const tracks = Array.isArray(playlist?.tracks) ? playlist.tracks : [];
  if (!tracks.length) {
    return { linked: 0, missing: 0 };
  }

  let linked = 0;
  let missing = 0;

  tracks.forEach((track) => {
    const sourcePath = String(track?.sourcePath || "").trim();
    if (sourcePath) {
      linked += 1;
      return;
    }

    const recovered = sourcePathFromFileUrl(track?.url || "");
    if (recovered) {
      linked += 1;
    } else {
      missing += 1;
    }
  });

  return { linked, missing };
}

function isBlobUrl(url) {
  return String(url || "").startsWith("blob:");
}

function getLastHandledCommandMarker() {
  try {
    const markerRaw = localStorage.getItem(LAST_COMMAND_MARKER_KEY);
    if (markerRaw) {
      const parsed = JSON.parse(markerRaw);
      const id = Number(parsed?.id);
      const timestampMs = Number(parsed?.timestampMs);
      return {
        id: Number.isFinite(id) ? id : 0,
        timestampMs: Number.isFinite(timestampMs) ? timestampMs : 0
      };
    }

    // Backward compatibility with legacy id-only marker.
    const legacyRaw = localStorage.getItem(LAST_COMMAND_ID_KEY);
    const legacyId = Number(legacyRaw);
    return {
      id: Number.isFinite(legacyId) ? legacyId : 0,
      timestampMs: 0
    };
  } catch {
    return { id: 0, timestampMs: 0 };
  }
}

function setLastHandledCommandMarker({ commandId = 0, eventTimestamp = "" } = {}) {
  const safeId = Number.isFinite(commandId) && commandId > 0 ? Math.trunc(commandId) : 0;
  const timestampMs = Date.parse(String(eventTimestamp || ""));
  const safeTimestampMs = Number.isFinite(timestampMs) ? timestampMs : 0;

  if (!safeId && !safeTimestampMs) {
    return;
  }

  try {
    localStorage.setItem(
      LAST_COMMAND_MARKER_KEY,
      JSON.stringify({
        id: safeId,
        timestampMs: safeTimestampMs
      })
    );
    // Keep legacy key updated for compatibility with older builds.
    if (safeId) {
      localStorage.setItem(LAST_COMMAND_ID_KEY, String(safeId));
    }
  } catch {
    // Ignore storage write failures.
  }
}

function isCommandAlreadyHandled({ commandId = 0, eventTimestamp = "" } = {}) {
  const marker = getLastHandledCommandMarker();
  const incomingId = Number.isFinite(commandId) ? commandId : 0;
  const incomingTimestampMs = Date.parse(String(eventTimestamp || ""));

  if (Number.isFinite(incomingTimestampMs) && incomingTimestampMs > 0) {
    if (incomingTimestampMs < marker.timestampMs) {
      return true;
    }

    if (incomingTimestampMs > marker.timestampMs) {
      return false;
    }

    if (incomingId > 0 && marker.id > 0 && incomingId <= marker.id) {
      return true;
    }

    return false;
  }

  if (incomingId > 0 && marker.id > 0 && incomingId <= marker.id) {
    return true;
  }

  return false;
}

function isTrackUrlReferencedBySavedPlaylists(url) {
  const targetUrl = String(url || "").trim();
  if (!targetUrl) {
    return false;
  }

  return state.savedPlaylists.some((playlist) =>
    Array.isArray(playlist.tracks) && playlist.tracks.some((track) => String(track?.url || "").trim() === targetUrl)
  );
}

function cleanupOrphanedPlaylistBlobUrls(previousEntry) {
  if (!previousEntry || !Array.isArray(previousEntry.tracks)) {
    return;
  }

  previousEntry.tracks.forEach((track) => {
    const trackUrl = String(track?.url || "").trim();
    if (!isBlobUrl(trackUrl)) {
      return;
    }

    if (isTrackUrlReferencedBySavedPlaylists(trackUrl)) {
      return;
    }

    URL.revokeObjectURL(trackUrl);
  });
}

function broadcastMusicState() {
  if (!stateChannel) {
    return;
  }

  const currentTrack = state.tracks[state.currentIndex] || null;
  stateChannel.postMessage({
    type: "music-state",
    payload: {
      trackTitle: currentTrack?.name || "No track selected",
      isPlaying: !elements.audio.paused,
      currentTime: Number.isFinite(elements.audio.currentTime) ? elements.audio.currentTime : 0,
      duration: Number.isFinite(elements.audio.duration) ? elements.audio.duration : 0,
      queueCount: state.tracks.length,
      updatedAt: Date.now()
    }
  });
}

async function handleRemoteCommand(commandPayload) {
  const payload =
    commandPayload && typeof commandPayload === "object"
      ? commandPayload
      : { action: commandPayload };

  const commandId = Number(payload.__eventId);
  const eventTimestamp = String(payload.__eventTimestamp || "");
  if (isCommandAlreadyHandled({ commandId, eventTimestamp })) {
    return;
  }

  setLastHandledCommandMarker({ commandId, eventTimestamp });

  const command = String(payload.action || "").trim().toLowerCase();
  if (!command) {
    return;
  }

  if (command === "play-pause") {
    elements.playBtn.click();
    return;
  }

  if (command === "next") {
    elements.nextBtn.click();
    return;
  }

  if (command === "prev") {
    elements.prevBtn.click();
    return;
  }

  if (command === "play-playlist") {
    const playedFromPayload = playPlaylistTracksFromCommand(payload.tracks);
    if (playedFromPayload) {
      return;
    }

    const playedSaved = playSavedPlaylistByName(payload.playlistName);
    if (playedSaved) {
      return;
    }

    const playedSynced = await playLibraryPlaylistByName(payload.playlistName);
    if (!playedSynced) {
      elements.trackMeta.textContent = `Playlist '${payload.playlistName || ""}' could not be started.`;
    }
    return;
  }

  if (command === "play-artist") {
    await playLibraryArtistByName(payload.artistName);
  }
}

async function replayMissedMusicCommandOnStartup() {
  const result = await apiRequest("/api/events?limit=40");
  if (!result.ok) {
    return;
  }

  const events = Array.isArray(result.payload?.events) ? result.payload.events : [];
  const musicCommandEvents = events.filter(
    (event) => event?.appId === "music-app" && event?.type === "music-command"
  );

  if (!musicCommandEvents.length) {
    return;
  }

  const latestEvent = musicCommandEvents.reduce((latest, current) => {
    if (!latest) {
      return current;
    }
    return Number(current?.id || 0) > Number(latest?.id || 0) ? current : latest;
  }, null);

  if (!latestEvent) {
    return;
  }

  const latestAction = String(latestEvent?.meta?.action || "").trim().toLowerCase();
  const replayableAction = latestAction === "play-playlist" || latestAction === "play-artist";
  const replayableSource = String(latestEvent?.source || "").trim().toLowerCase() === "agent";
  const replayableOpenApp = Boolean(latestEvent?.meta?.openApp);
  if (!replayableAction || !replayableSource || !replayableOpenApp) {
    return;
  }

  const latestId = Number(latestEvent.id || 0);
  if (isCommandAlreadyHandled({
    commandId: latestId,
    eventTimestamp: latestEvent.timestamp
  })) {
    return;
  }

  const eventTimestamp = Date.parse(String(latestEvent.timestamp || ""));
  if (!Number.isFinite(eventTimestamp)) {
    return;
  }

  if (Date.now() - eventTimestamp > COMMAND_REPLAY_WINDOW_MS) {
    return;
  }

  await handleRemoteCommand({
    ...(latestEvent.meta || {}),
    __eventId: latestEvent.id,
    __eventTimestamp: latestEvent.timestamp
  });
}

function scheduleMusicEventStreamReconnect() {
  if (musicEventStreamRetryTimer) {
    return;
  }

  musicEventStreamRetryTimer = window.setTimeout(() => {
    musicEventStreamRetryTimer = null;
    startMusicEventStream();
  }, MUSIC_EVENT_STREAM_RETRY_MS);
}

function stopMusicEventStream() {
  if (musicEventStream) {
    musicEventStream.close();
    musicEventStream = null;
  }

  if (musicEventStreamRetryTimer) {
    window.clearTimeout(musicEventStreamRetryTimer);
    musicEventStreamRetryTimer = null;
  }
}

function startMusicEventStream() {
  if (typeof EventSource === "undefined") {
    return;
  }

  if (musicEventStream) {
    return;
  }

  const stream = new EventSource("/api/events/stream");
  musicEventStream = stream;

  stream.onmessage = (message) => {
    let payload;
    try {
      payload = JSON.parse(message.data);
    } catch {
      return;
    }

    if (payload?.type !== "event" || !payload.event) {
      return;
    }

    const event = payload.event;
    if (event.appId !== "music-app" || event.type !== "music-command") {
      return;
    }

    handleRemoteCommand({
      ...(event.meta || {}),
      __eventId: event.id,
      __eventTimestamp: event.timestamp
    }).catch(() => {
      // Ignore background stream command failures.
    });
  };

  stream.onerror = () => {
    if (musicEventStream === stream) {
      musicEventStream.close();
      musicEventStream = null;
    }
    scheduleMusicEventStreamReconnect();
  };
}

function selectNextTrack() {
  if (!state.tracks.length) {
    return;
  }

  if (state.isShuffle && state.tracks.length > 1) {
    let randomIndex = state.currentIndex;
    while (randomIndex === state.currentIndex) {
      randomIndex = Math.floor(Math.random() * state.tracks.length);
    }
    setTrack(randomIndex, { autoplay: true });
    return;
  }

  const nextIndex = (state.currentIndex + 1) % state.tracks.length;
  setTrack(nextIndex, { autoplay: true });
}

function selectPreviousTrack() {
  if (!state.tracks.length) {
    return;
  }

  const previousIndex = (state.currentIndex - 1 + state.tracks.length) % state.tracks.length;
  setTrack(previousIndex, { autoplay: true });
}

function appendFiles(fileList) {
  const audioFiles = Array.from(fileList || []).filter((file) => file.type.startsWith("audio/"));
  if (!audioFiles.length) {
    return;
  }

  const newTracks = audioFiles.map((file) => ({
    name: file.name,
    url: URL.createObjectURL(file),
    duration: 0,
    sourcePath: getFileSystemPath(file)
  }));

  state.tracks.push(...newTracks);

  if (state.currentIndex === -1) {
    setTrack(0, { autoplay: false });
  } else {
    renderPlaylist();
  }
}

function clearQueue() {
  state.tracks.forEach((track) => {
    const trackUrl = String(track?.url || "").trim();
    if (!isBlobUrl(trackUrl)) {
      return;
    }

    if (isTrackUrlReferencedBySavedPlaylists(trackUrl)) {
      return;
    }

    URL.revokeObjectURL(trackUrl);
  });
  state.tracks = [];
  state.currentIndex = -1;
  elements.audio.pause();
  elements.audio.currentTime = 0;
  elements.audio.removeAttribute("src");
  updateNowPlaying();
  renderPlaylist();
}

function initEvents() {
  elements.fileInput.addEventListener("change", (event) => {
    appendFiles(event.target.files);
    event.target.value = "";
  });

  elements.folderInput.addEventListener("change", (event) => {
    appendFiles(event.target.files);
    event.target.value = "";
  });

  elements.playBtn.addEventListener("click", () => {
    if (!state.tracks.length) {
      return;
    }

    if (elements.audio.paused) {
      startCurrentTrackPlayback().catch(() => {
        // startCurrentTrackPlayback updates the UI with the failure reason.
      });
      return;
    }

    elements.audio.pause();
    updateNowPlaying();
    elements.visualizer.classList.remove("playing");
  });

  elements.prevBtn.addEventListener("click", selectPreviousTrack);
  elements.nextBtn.addEventListener("click", selectNextTrack);

  elements.shuffleBtn.addEventListener("click", () => {
    state.isShuffle = !state.isShuffle;
    elements.shuffleBtn.setAttribute("aria-pressed", String(state.isShuffle));
  });

  elements.loopBtn.addEventListener("click", () => {
    state.isLoop = !state.isLoop;
    elements.audio.loop = state.isLoop;
    elements.loopBtn.setAttribute("aria-pressed", String(state.isLoop));
  });

  elements.clearBtn.addEventListener("click", clearQueue);
  elements.savePlaylistBtn.addEventListener("click", saveCurrentQueueAsPlaylist);

  elements.volume.addEventListener("input", () => {
    elements.audio.volume = Number(elements.volume.value);
  });

  elements.seek.addEventListener("input", () => {
    if (!Number.isFinite(elements.audio.duration) || elements.audio.duration <= 0) {
      return;
    }

    const percentage = Number(elements.seek.value) / 100;
    elements.audio.currentTime = elements.audio.duration * percentage;
  });

  elements.playlist.addEventListener("click", (event) => {
    const trackItem = event.target.closest(".track-item");
    if (!trackItem) {
      return;
    }

    const index = Number(trackItem.dataset.index);
    if (!Number.isFinite(index)) {
      return;
    }

    setTrack(index, { autoplay: true });
  });

  elements.audio.addEventListener("play", () => {
    elements.visualizer.classList.add("playing");
    updateNowPlaying();
    broadcastMusicState();
  });

  elements.audio.addEventListener("pause", () => {
    elements.visualizer.classList.remove("playing");
    updateNowPlaying();
    broadcastMusicState();
  });

  elements.audio.addEventListener("loadedmetadata", () => {
    const track = state.tracks[state.currentIndex];
    if (track && Number.isFinite(elements.audio.duration)) {
      track.duration = elements.audio.duration;
      renderPlaylist();
    }

    elements.duration.textContent = formatTime(elements.audio.duration);
    broadcastMusicState();
  });

  elements.audio.addEventListener("timeupdate", () => {
    const duration = Number.isFinite(elements.audio.duration) ? elements.audio.duration : 0;
    const currentTime = Number.isFinite(elements.audio.currentTime) ? elements.audio.currentTime : 0;

    elements.currentTime.textContent = formatTime(currentTime);
    elements.duration.textContent = formatTime(duration);

    if (duration > 0) {
      elements.seek.value = String((currentTime / duration) * 100);
    } else {
      elements.seek.value = "0";
    }

    broadcastMusicState();
  });

  elements.audio.addEventListener("ended", () => {
    if (state.isLoop) {
      return;
    }

    selectNextTrack();
  });

  elements.audio.addEventListener("error", () => {
    const currentTrack = state.tracks[state.currentIndex];
    if (!currentTrack) {
      return;
    }

    elements.trackMeta.textContent = `Could not play '${currentTrack.name}'. File might be missing or unsupported.`;
  });

  window.addEventListener("dragover", (event) => {
    event.preventDefault();
  });

  window.addEventListener("drop", (event) => {
    event.preventDefault();
    appendFiles(event.dataTransfer?.files || []);
  });

  elements.savedPlaylists.addEventListener("click", (event) => {
    const row = event.target.closest(".saved-item");
    if (!row) {
      return;
    }

    const index = Number(row.dataset.index);
    if (!Number.isInteger(index)) {
      return;
    }

    if (event.target.closest("[data-action='load-saved']")) {
      loadSavedPlaylist(index);
      return;
    }

    if (event.target.closest("[data-action='delete-saved']")) {
      deleteSavedPlaylist(index);
    }
  });

  if (commandChannel) {
    commandChannel.onmessage = (event) => {
      if (event?.data?.type !== "music-command") {
        return;
      }

      handleRemoteCommand(event.data.payload).catch(() => {
        // Ignore background command handling failures.
      });
    };
  }

  document.addEventListener("keydown", (event) => {
    if (event.code === "Space") {
      const activeElement = document.activeElement;
      const tagName = activeElement?.tagName || "";
      if (tagName === "INPUT" || tagName === "TEXTAREA") {
        return;
      }
      event.preventDefault();
      elements.playBtn.click();
    }

    if (event.code === "ArrowRight" && event.shiftKey) {
      event.preventDefault();
      elements.nextBtn.click();
    }

    if (event.code === "ArrowLeft" && event.shiftKey) {
      event.preventDefault();
      elements.prevBtn.click();
    }
  });
}

function init() {
  elements.audio.volume = Number(elements.volume.value);
  elements.shuffleBtn.setAttribute("aria-pressed", String(state.isShuffle));
  loadSavedPlaylists();
  syncSavedPlaylistsToServer().catch(() => {
    // Ignore startup sync failures.
  });
  renderPlaylist();
  renderSavedPlaylists();
  updateNowPlaying();
  initEvents();
  broadcastMusicState();
  startMusicEventStream();
  replayMissedMusicCommandOnStartup().catch(() => {
    // Ignore startup replay failures.
  });
}

window.addEventListener("beforeunload", () => {
  stopMusicEventStream();
});

init();
