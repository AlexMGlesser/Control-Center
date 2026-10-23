import { icon } from "../icons.js";
import { api, el, esc, q, toast } from "../lib.js";
import { player } from "../player.js";
import { frame, note } from "./frame.js";

// Music: your playlists from the PC. Plays here (streamed) or on the PC's
// speakers, switched with the "♪ on …" button in the player bar.

// Formats Chromium can't decode: shown greyed out.
const UNPLAYABLE = new Set(["wma", "ape", "aif", "aiff", "alac"]);
const extension = (track) => (track.sourcePath || track.name || "").split(".").pop().toLowerCase();
const playable = (track) => Boolean(track.sourcePath) && !UNPLAYABLE.has(extension(track));
const title = (track) => track.title || (track.name || "").replace(/\.[^.]+$/, "").replace(/^\[[^\]]*\]\s*/, "").replace(/_/g, " ");

export async function render(host, ctx) {
  let playlists = [];
  let open = null;
  const view = frame(host, { title: "Music", onBack: () => (open ? ((open = null), draw()) : ctx.closeApp()) });

  async function load() {
    try {
      playlists = ((await api("/api/apps/music-app/playlists")).playlists || []).filter((playlist) => playlist.tracks?.length);
      if (open) open = playlists.find((playlist) => playlist.name === open.name) || null;
    } catch (error) {
      toast(error.message, { tone: "error" });
    }
    draw();
  }

  function play(playlist, index) {
    if (player.onPc) {
      player.playPc(playlist.name);
      toast(`Playing ${playlist.name} on the PC.`);
      return;
    }
    const items = [];
    let start = 0;
    playlist.tracks.forEach((track, trackIndex) => {
      if (!playable(track)) return;
      if (trackIndex === index) start = items.length;
      items.push({ url: `/api/apps/music-app/local-file?path=${q(track.sourcePath)}`, title: title(track), artist: track.artist || playlist.name, album: track.album || "" });
    });
    if (!items.length) return toast("None of these tracks can play on this computer.", { tone: "error" });
    player.playQueue(items, start);
  }

  function draw() {
    view.setTitle(open ? open.name : "Music");
    if (!open) {
      view.setActions("");
      if (!playlists.length) {
        view.content.innerHTML = note("No playlists yet. Make one in the Music app on the PC.");
        return;
      }
      const list = el(`<div class="list"></div>`);
      for (const playlist of playlists) {
        const card = el(`
          <button class="card chamfer" style="display:flex;align-items:center;gap:12px">
            <span class="glyph" style="color:var(--magenta)">${icon("music")}</span>
            <span style="flex:1;font-weight:600">${esc(playlist.name)}</span>
            <span class="muted small">${playlist.tracks.length} tracks</span>
          </button>`);
        card.addEventListener("click", () => {
          open = playlist;
          draw();
        });
        list.append(card);
      }
      view.content.replaceChildren(list);
      return;
    }

    view.setActions(`<button class="btn primary small" id="play-all">${icon("play")} Play</button>`);
    view.actions.querySelector("#play-all").addEventListener("click", () => play(open, 0));
    const list = el(`<div class="list"></div>`);
    if (player.onPc) list.append(el(`<p class="muted small">Playing on the PC: a playlist starts from its first track.</p>`));
    const nowUrl = player.current?.url;
    open.tracks.forEach((track, index) => {
      const ok = player.onPc || playable(track);
      const isNow = !player.onPc && track.sourcePath && nowUrl === `/api/apps/music-app/local-file?path=${q(track.sourcePath)}`;
      const row = el(`
        <div class="row" style="${ok ? "" : "cursor:default;opacity:0.5"}">
          <span class="muted small" style="width:28px">${isNow ? `<span style="color:var(--cyan)">${icon("play")}</span>` : index + 1}</span>
          <div class="grow">
            <div class="ellipsis" style="${isNow ? "color:var(--cyan)" : ""}">${esc(title(track))}</div>
            <div class="muted small ellipsis">${ok ? esc([track.artist, track.album].filter(Boolean).join(" · ")) : `${esc(extension(track).toUpperCase())} files don't play here. Play it on the PC instead.`}</div>
          </div>
        </div>`);
      if (ok) row.addEventListener("click", () => play(open, index));
      list.append(row);
    });
    view.content.replaceChildren(list);
  }

  // Redraw the "now playing" marker and the PC note as the player changes.
  const unsubscribe = player.subscribe(() => {
    if (open) draw();
  });
  await load();
  return unsubscribe;
}
