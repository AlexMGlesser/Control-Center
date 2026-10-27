import { closeSync, openSync, readSync, statSync } from "fs";

// Titles, artists and albums from the music files' own ID3v2 tags, so the
// phone can show "Crazy Train" instead of a ripper's file name. Only the
// start of each file is read, and results are cached until the file changes.

const READ_BYTES = 64 * 1024;
const FRAMES = {
  TIT2: "title",
  TPE1: "artist",
  TALB: "album",
  TRCK: "track",
  // ID3v2.2 uses three-letter frame names.
  TT2: "title",
  TP1: "artist",
  TAL: "album",
  TRK: "track"
};

const cache = new Map();

function syncsafe(bytes, offset) {
  return ((bytes[offset] & 0x7f) << 21) | ((bytes[offset + 1] & 0x7f) << 14) | ((bytes[offset + 2] & 0x7f) << 7) | (bytes[offset + 3] & 0x7f);
}

function decodeText(bytes) {
  if (!bytes.length) return "";
  const encoding = bytes[0];
  const body = bytes.subarray(1);
  let text;
  if (encoding === 1 || encoding === 2) {
    // UTF-16 with a byte-order mark (1) or big-endian without one (2).
    let data = body;
    let bigEndian = encoding === 2;
    if (data[0] === 0xfe && data[1] === 0xff) {
      bigEndian = true;
      data = data.subarray(2);
    } else if (data[0] === 0xff && data[1] === 0xfe) {
      data = data.subarray(2);
    }
    const even = data.subarray(0, data.length - (data.length % 2));
    const swapped = bigEndian ? Buffer.from(even).swap16() : Buffer.from(even);
    text = swapped.toString("utf16le");
  } else if (encoding === 3) {
    text = Buffer.from(body).toString("utf-8");
  } else {
    text = Buffer.from(body).toString("latin1");
  }
  return text.replace(/\0[\s\S]*$/, "").trim();
}

function parseId3(buffer) {
  if (buffer.length < 10 || buffer.toString("latin1", 0, 3) !== "ID3") return {};
  const version = buffer[3];
  const tagSize = syncsafe(buffer, 6);
  const end = Math.min(buffer.length, 10 + tagSize);
  const nameLength = version === 2 ? 3 : 4;
  const headerLength = version === 2 ? 6 : 10;
  let offset = 10;
  // An extended header (rare) comes first in v2.3/v2.4.
  if (version >= 3 && buffer[5] & 0x40) {
    offset += version === 4 ? syncsafe(buffer, 10) : buffer.readUInt32BE(10) + 4;
  }
  const tags = {};
  while (offset + headerLength <= end) {
    const id = buffer.toString("latin1", offset, offset + nameLength);
    if (!/^[A-Z0-9]+$/.test(id)) break; // padding
    let size;
    if (version === 2) size = (buffer[offset + 3] << 16) | (buffer[offset + 4] << 8) | buffer[offset + 5];
    else if (version === 4) size = syncsafe(buffer, offset + 4);
    else size = buffer.readUInt32BE(offset + 4);
    const start = offset + headerLength;
    if (size <= 0 || start + size > end) break;
    const field = FRAMES[id];
    if (field && !tags[field]) {
      const value = decodeText(buffer.subarray(start, start + size));
      if (value) tags[field] = value;
    }
    offset = start + size;
  }
  return tags;
}

/** {title, artist, album, track} from the file's tags; {} when there are none or it can't be read. */
export function readMusicTags(filePath) {
  let stats;
  try {
    stats = statSync(filePath);
  } catch {
    return {};
  }
  const key = filePath.toLowerCase();
  const cached = cache.get(key);
  if (cached && cached.mtimeMs === stats.mtimeMs) return cached.tags;

  let tags = {};
  let fd;
  try {
    fd = openSync(filePath, "r");
    const buffer = Buffer.alloc(Math.min(READ_BYTES, stats.size));
    readSync(fd, buffer, 0, buffer.length, 0);
    tags = parseId3(buffer);
  } catch {
    tags = {};
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  cache.set(key, { mtimeMs: stats.mtimeMs, tags });
  return tags;
}

/** Adds tag fields to each track that has a file on this PC. */
export function withTrackTags(playlists) {
  return playlists.map((playlist) => ({
    ...playlist,
    tracks: (playlist.tracks || []).map((track) => (track.sourcePath ? { ...track, ...readMusicTags(track.sourcePath) } : track))
  }));
}
