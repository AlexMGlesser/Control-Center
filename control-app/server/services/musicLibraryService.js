import { existsSync, readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { readRuntimeSection, writeRuntimeSection } from "./runtimePersistenceService.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataDirectory = path.join(__dirname, "..", "data");
const libraryPath = path.join(dataDirectory, "music-library.json");
const localPlaylistsPath = path.join(dataDirectory, "music-local-playlists.json");
const DEMO_AUDIO_URLS = [
  "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3",
  "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3",
  "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-3.mp3",
  "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-4.mp3",
  "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-5.mp3",
  "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-6.mp3",
  "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-7.mp3",
  "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-8.mp3",
  "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-9.mp3",
  "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-10.mp3",
  "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-11.mp3",
  "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-12.mp3",
  "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-13.mp3",
  "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-14.mp3"
];

const DEFAULT_LIBRARY = {
  tracks: [
    { id: "trk-001", title: "Skyline Echoes", artist: "Neon Atlas", genre: "Synthwave", audioUrl: DEMO_AUDIO_URLS[0] },
    { id: "trk-002", title: "Midnight Protocol", artist: "Neon Atlas", genre: "Synthwave", audioUrl: DEMO_AUDIO_URLS[1] },
    { id: "trk-003", title: "Static Bloom", artist: "Velvet Current", genre: "Indie", audioUrl: DEMO_AUDIO_URLS[2] },
    { id: "trk-004", title: "Golden Orbit", artist: "Velvet Current", genre: "Indie", audioUrl: DEMO_AUDIO_URLS[3] },
    { id: "trk-005", title: "Basalt Pulse", artist: "Granite Unit", genre: "Electronic", audioUrl: DEMO_AUDIO_URLS[4] },
    { id: "trk-006", title: "Circuit Bloom", artist: "Granite Unit", genre: "Electronic", audioUrl: DEMO_AUDIO_URLS[5] },
    { id: "trk-007", title: "Summer Rail", artist: "Harbor Theory", genre: "Pop", audioUrl: DEMO_AUDIO_URLS[6] },
    { id: "trk-008", title: "Paper Planets", artist: "Harbor Theory", genre: "Pop", audioUrl: DEMO_AUDIO_URLS[7] },
    { id: "trk-009", title: "Amber Tide", artist: "Mira Sol", genre: "R&B", audioUrl: DEMO_AUDIO_URLS[8] },
    { id: "trk-010", title: "Quiet Voltage", artist: "Mira Sol", genre: "R&B", audioUrl: DEMO_AUDIO_URLS[9] },
    { id: "trk-011", title: "Hollow Sun", artist: "North Signal", genre: "Rock", audioUrl: DEMO_AUDIO_URLS[10] },
    { id: "trk-012", title: "White Noise City", artist: "North Signal", genre: "Rock", audioUrl: DEMO_AUDIO_URLS[11] },
    { id: "trk-013", title: "No More Rain", artist: "Ozzy Osbourne", genre: "Rock", audioUrl: DEMO_AUDIO_URLS[12] },
    { id: "trk-014", title: "Crazy Train Echo", artist: "Ozzy Osbourne", genre: "Rock", audioUrl: DEMO_AUDIO_URLS[13] }
  ],
  playlists: [
    { name: "Focus", trackIds: ["trk-001", "trk-005", "trk-011"] },
    { name: "Evening", trackIds: ["trk-003", "trk-009", "trk-010"] }
  ],
  updatedAt: new Date().toISOString()
};

const libraryState = loadLibrary();
const localPlaylistState = loadLocalPlaylists();

export function getMusicLibraryState() {
  return {
    ok: true,
    tracks: libraryState.tracks.map((track) => ({ ...track })),
    playlists: hydratePlaylists(),
    artists: listMusicArtists(),
    genres: listMusicGenres(),
    updatedAt: libraryState.updatedAt
  };
}

export function listMusicTracks({ artist, genre, query, limit = 25 } = {}) {
  const artistFilter = String(artist || "").trim().toLowerCase();
  const genreFilter = String(genre || "").trim().toLowerCase();
  const queryFilter = String(query || "").trim().toLowerCase();
  const safeLimit = Math.max(1, Math.min(Number(limit) || 25, 100));

  const tracks = libraryState.tracks
    .filter((track) => {
      if (artistFilter && !track.artist.toLowerCase().includes(artistFilter)) {
        return false;
      }

      if (genreFilter && !track.genre.toLowerCase().includes(genreFilter)) {
        return false;
      }

      if (!queryFilter) {
        return true;
      }

      const haystack = `${track.title} ${track.artist} ${track.genre}`.toLowerCase();
      return haystack.includes(queryFilter);
    })
    .slice(0, safeLimit)
    .map((track) => ({ ...track }));

  return {
    ok: true,
    tracks,
    count: tracks.length,
    filters: {
      artist: artistFilter || null,
      genre: genreFilter || null,
      query: queryFilter || null,
      limit: safeLimit
    }
  };
}

export function listMusicArtists() {
  return Array.from(new Set(libraryState.tracks.map((track) => track.artist))).sort((a, b) =>
    a.localeCompare(b)
  );
}

export function listMusicGenres() {
  return Array.from(new Set(libraryState.tracks.map((track) => track.genre))).sort((a, b) =>
    a.localeCompare(b)
  );
}

export function listMusicPlaylists({ localOnly = false } = {}) {
  return {
    ok: true,
    playlists: localOnly ? buildLocalPlaylists() : buildCombinedPlaylists()
  };
}

export function syncLocalMusicPlaylists(playlists) {
  const normalizedPlaylists = Array.isArray(playlists)
    ? playlists.map(normalizeLocalPlaylist).filter(Boolean)
    : [];

  localPlaylistState.playlists = normalizedPlaylists;
  saveLocalPlaylists();

  return {
    ok: true,
    playlists: buildCombinedPlaylists(),
    syncedLocalCount: normalizedPlaylists.length,
    updatedAt: localPlaylistState.updatedAt
  };
}

export function createMusicPlaylist(name) {
  const normalizedName = String(name || "")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalizedName) {
    throw createMusicError("INVALID_PLAYLIST_NAME", "Playlist name is required.", 400);
  }

  const exists = libraryState.playlists.some(
    (playlist) => playlist.name.toLowerCase() === normalizedName.toLowerCase()
  );

  if (exists) {
    throw createMusicError("PLAYLIST_EXISTS", `Playlist '${normalizedName}' already exists.`, 409);
  }

  const playlist = {
    name: normalizedName,
    trackIds: []
  };

  libraryState.playlists.push(playlist);
  saveLibrary();

  return {
    ok: true,
    playlist: hydratePlaylist(playlist)
  };
}

export function addTrackToPlaylist({ playlistName, trackId, trackName }) {
  const targetName = String(playlistName || "")
    .replace(/\s+/g, " ")
    .trim();

  if (!targetName) {
    throw createMusicError("INVALID_PLAYLIST_NAME", "playlistName is required.", 400);
  }

  const playlist = libraryState.playlists.find(
    (item) => item.name.toLowerCase() === targetName.toLowerCase()
  );

  if (!playlist) {
    throw createMusicError("PLAYLIST_NOT_FOUND", `Playlist '${targetName}' not found.`, 404);
  }

  const track = resolveTrack(trackId, trackName);
  if (!track) {
    throw createMusicError("TRACK_NOT_FOUND", "Track not found for the provided trackId/trackName.", 404);
  }

  if (!playlist.trackIds.includes(track.id)) {
    playlist.trackIds.push(track.id);
    saveLibrary();
  }

  return {
    ok: true,
    playlist: hydratePlaylist(playlist),
    track: { ...track }
  };
}

function hydratePlaylists() {
  return libraryState.playlists.map((playlist) => ({
    ...hydratePlaylist(playlist),
    source: "library"
  }));
}

function buildCombinedPlaylists() {
  const merged = new Map();

  localPlaylistState.playlists.forEach((playlist) => {
    merged.set(playlist.name.toLowerCase(), cloneLocalPlaylist(playlist));
  });

  hydratePlaylists().forEach((playlist) => {
    const key = playlist.name.toLowerCase();
    if (!merged.has(key)) {
      merged.set(key, playlist);
    }
  });

  return Array.from(merged.values());
}

function buildLocalPlaylists() {
  return localPlaylistState.playlists.map((playlist) => cloneLocalPlaylist(playlist));
}

function hydratePlaylist(playlist) {
  const tracks = playlist.trackIds
    .map((trackId) => libraryState.tracks.find((track) => track.id === trackId))
    .filter(Boolean)
    .map((track) => ({ ...track }));

  return {
    name: playlist.name,
    trackIds: [...playlist.trackIds],
    tracks,
    count: tracks.length
  };
}

function resolveTrack(trackId, trackName) {
  const id = String(trackId || "").trim();
  if (id) {
    const byId = libraryState.tracks.find((track) => track.id === id);
    if (byId) {
      return byId;
    }
  }

  const name = String(trackName || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (!name) {
    return null;
  }

  const exact = libraryState.tracks.find((track) => track.title.toLowerCase() === name);
  if (exact) {
    return exact;
  }

  return libraryState.tracks.find((track) => track.title.toLowerCase().includes(name)) || null;
}

function loadLibrary() {
  const runtimeState = readRuntimeSection("musicLibrary", null);
  if (runtimeState && typeof runtimeState === "object") {
    return sanitizeLibraryState(runtimeState);
  }

  if (!existsSync(libraryPath)) {
    const seeded = {
      ...DEFAULT_LIBRARY,
      updatedAt: new Date().toISOString()
    };
    writeRuntimeSection("musicLibrary", seeded);
    return seeded;
  }

  try {
    const parsed = JSON.parse(readFileSync(libraryPath, "utf-8"));
    const tracks = Array.isArray(parsed?.tracks) ? parsed.tracks.filter(isValidTrack) : [];
    const trackDefaultsById = new Map(DEFAULT_LIBRARY.tracks.map((track) => [track.id, track]));
    const hydratedTracks = tracks.map((track) => {
      const fallback = trackDefaultsById.get(track.id);
      if (track.audioUrl || !fallback?.audioUrl) {
        return track;
      }
      return {
        ...track,
        audioUrl: fallback.audioUrl
      };
    });
    const hydratedTrackIds = new Set(hydratedTracks.map((track) => track.id));
    for (const defaultTrack of DEFAULT_LIBRARY.tracks) {
      if (!hydratedTrackIds.has(defaultTrack.id)) {
        hydratedTracks.push({ ...defaultTrack });
      }
    }
    const playlists = Array.isArray(parsed?.playlists)
      ? parsed.playlists.filter(isValidPlaylist).map((playlist) => ({
          name: String(playlist.name).trim(),
          trackIds: playlist.trackIds.filter((trackId) => hydratedTracks.some((track) => track.id === trackId))
        }))
      : [];

    const safeState = {
      tracks: hydratedTracks.length ? hydratedTracks : DEFAULT_LIBRARY.tracks.map((track) => ({ ...track })),
      playlists: playlists.length ? playlists : DEFAULT_LIBRARY.playlists.map((playlist) => ({ ...playlist })),
      updatedAt: String(parsed?.updatedAt || new Date().toISOString())
    };

    writeRuntimeSection("musicLibrary", safeState);
    return safeState;
  } catch {
    const fallback = {
      ...DEFAULT_LIBRARY,
      updatedAt: new Date().toISOString()
    };
    writeRuntimeSection("musicLibrary", fallback);
    return fallback;
  }
}

function loadLocalPlaylists() {
  const runtimeState = readRuntimeSection("localPlaylists", null);
  if (runtimeState && typeof runtimeState === "object") {
    return sanitizeLocalPlaylistState(runtimeState);
  }

  if (!existsSync(localPlaylistsPath)) {
    const seeded = {
      playlists: [],
      updatedAt: new Date().toISOString()
    };
    writeRuntimeSection("localPlaylists", seeded);
    return seeded;
  }

  try {
    const parsed = JSON.parse(readFileSync(localPlaylistsPath, "utf-8"));
    const playlists = Array.isArray(parsed?.playlists)
      ? parsed.playlists.map(normalizeLocalPlaylist).filter(Boolean)
      : [];

    const safeState = {
      playlists,
      updatedAt: String(parsed?.updatedAt || new Date().toISOString())
    };

    writeRuntimeSection("localPlaylists", safeState);
    return safeState;
  } catch {
    const fallback = {
      playlists: [],
      updatedAt: new Date().toISOString()
    };
    writeRuntimeSection("localPlaylists", fallback);
    return fallback;
  }
}

function saveLibrary() {
  libraryState.updatedAt = new Date().toISOString();
  writeRuntimeSection("musicLibrary", libraryState);
}

function saveLocalPlaylists() {
  localPlaylistState.updatedAt = new Date().toISOString();
  writeRuntimeSection("localPlaylists", localPlaylistState);
}

function isValidTrack(track) {
  return (
    track &&
    typeof track === "object" &&
    typeof track.id === "string" &&
    typeof track.title === "string" &&
    typeof track.artist === "string" &&
    typeof track.genre === "string"
  );
}

function isValidPlaylist(playlist) {
  return (
    playlist &&
    typeof playlist === "object" &&
    typeof playlist.name === "string" &&
    Array.isArray(playlist.trackIds) &&
    playlist.trackIds.every((trackId) => typeof trackId === "string")
  );
}

function normalizeLocalPlaylist(playlist) {
  const name = String(playlist?.name || "")
    .replace(/\s+/g, " ")
    .trim();

  if (!name) {
    return null;
  }

  const tracks = Array.isArray(playlist?.tracks)
    ? playlist.tracks.map(normalizeLocalPlaylistTrack).filter(Boolean)
    : [];

  const requestedCount = Number(playlist?.count);
  const count = Number.isFinite(requestedCount) ? Math.max(0, Math.trunc(requestedCount)) : tracks.length;

  return {
    name,
    count: Math.max(count, tracks.length),
    tracks,
    source: "local-saved"
  };
}

function normalizeLocalPlaylistTrack(track) {
  const name = String(track?.name || "")
    .replace(/\s+/g, " ")
    .trim();

  if (!name) {
    return null;
  }

  return {
    name,
    sourcePath: String(track?.sourcePath || "").trim()
  };
}

function cloneLocalPlaylist(playlist) {
  return {
    name: playlist.name,
    count: playlist.count,
    source: "local-saved",
    tracks: Array.isArray(playlist.tracks) ? playlist.tracks.map((track) => ({ ...track })) : []
  };
}

function createMusicError(code, message, status = 500) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function sanitizeLibraryState(state) {
  const tracks = Array.isArray(state?.tracks) ? state.tracks.filter(isValidTrack) : [];
  const trackDefaultsById = new Map(DEFAULT_LIBRARY.tracks.map((track) => [track.id, track]));
  const hydratedTracks = tracks.map((track) => {
    const fallback = trackDefaultsById.get(track.id);
    if (track.audioUrl || !fallback?.audioUrl) {
      return track;
    }
    return {
      ...track,
      audioUrl: fallback.audioUrl
    };
  });
  const hydratedTrackIds = new Set(hydratedTracks.map((track) => track.id));
  for (const defaultTrack of DEFAULT_LIBRARY.tracks) {
    if (!hydratedTrackIds.has(defaultTrack.id)) {
      hydratedTracks.push({ ...defaultTrack });
    }
  }
  const playlists = Array.isArray(state?.playlists)
    ? state.playlists.filter(isValidPlaylist).map((playlist) => ({
        name: String(playlist.name).trim(),
        trackIds: playlist.trackIds.filter((trackId) => hydratedTracks.some((track) => track.id === trackId))
      }))
    : [];

  return {
    tracks: hydratedTracks.length ? hydratedTracks : DEFAULT_LIBRARY.tracks.map((track) => ({ ...track })),
    playlists: playlists.length ? playlists : DEFAULT_LIBRARY.playlists.map((playlist) => ({ ...playlist })),
    updatedAt: String(state?.updatedAt || new Date().toISOString())
  };
}

function sanitizeLocalPlaylistState(state) {
  const playlists = Array.isArray(state?.playlists)
    ? state.playlists.map(normalizeLocalPlaylist).filter(Boolean)
    : [];

  return {
    playlists,
    updatedAt: String(state?.updatedAt || new Date().toISOString())
  };
}
