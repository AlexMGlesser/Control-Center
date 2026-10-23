import { icon } from "../icons.js";
import { api, el, esc, formatBytes, toast } from "../lib.js";
import { player } from "../player.js";
import { frame, note } from "./frame.js";

// Movies: the library saved on the PC, streamed here with subtitles. The
// video's own controls include full screen.

const BASE = "/api/apps/movie-app";
const FRAME_CACHE = "movie-frames";

/** Frames grabbed from movies without a poster, kept so each is grabbed once. */
function cachedFrames() {
  try {
    return JSON.parse(localStorage.getItem(FRAME_CACHE) || "{}");
  } catch {
    return {};
  }
}

function saveFrame(id, dataUrl) {
  try {
    const frames = cachedFrames();
    frames[id] = dataUrl;
    localStorage.setItem(FRAME_CACHE, JSON.stringify(frames));
  } catch {
    // Storage full: it's only a thumbnail.
  }
}

/** A frame about a minute in (or 10% through a short video). */
async function grabFrame(url) {
  const video = document.createElement("video");
  video.muted = true;
  video.preload = "metadata";
  video.src = url;
  try {
    await new Promise((resolve, reject) => {
      video.onloadeddata = resolve;
      video.onerror = reject;
    });
    const target = Math.min(60, (video.duration || 0) * 0.1);
    if (target > 0) {
      await new Promise((resolve) => {
        video.onseeked = resolve;
        video.currentTime = target;
      });
    }
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 180;
    canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.8);
  } catch {
    return null;
  } finally {
    video.removeAttribute("src");
    video.load();
  }
}

export async function render(host, ctx) {
  let library = { movies: [], folders: [] };
  let playing = null;
  let frameRun = 0;
  const view = frame(host, { title: "Movies", onBack: () => (playing ? ((playing = null), draw()) : ctx.closeApp()) });

  async function load() {
    try {
      library = await api(`${BASE}/library`);
    } catch (error) {
      toast(error.message, { tone: "error" });
    }
    draw();
  }

  function draw() {
    frameRun += 1;
    if (playing) return drawPlayer(playing);
    view.setTitle("Movies");
    view.content.classList.remove("flush");
    const movies = library.movies || [];
    if (!movies.length) {
      view.content.innerHTML = note(
        library.folders?.length ? "No movies found in your movie folders. Rescan in the desktop Movie app after adding some." : "Pick a movie folder in the desktop Movie app to make it available here."
      );
      return;
    }
    const grid = el(`<div class="media-grid"></div>`);
    const frames = cachedFrames();
    const missing = [];
    for (const movie of movies) {
      const thumb = movie.hasPoster ? `${BASE}/poster/${movie.id}` : frames[movie.id];
      const card = el(`
        <button class="media-card" title="${esc(movie.fileName)} · ${esc(formatBytes(movie.size))}">
          ${thumb ? `<img class="media-thumb chamfer ${movie.hasPoster ? "poster" : ""}" src="${esc(thumb)}" alt="" />` : `<div class="media-thumb chamfer" data-frame="${esc(movie.id)}">${icon("play")}</div>`}
          <div class="title ellipsis">${esc(movie.title)}</div>
        </button>`);
      card.addEventListener("click", () => {
        playing = movie;
        draw();
      });
      grid.append(card);
      if (!thumb) missing.push(movie);
    }
    view.content.replaceChildren(grid);
    fillFrames(missing, frameRun);
  }

  /** One at a time: each grab streams a little of the movie from the PC. */
  async function fillFrames(movies, run) {
    for (const movie of movies) {
      if (run !== frameRun) return;
      const dataUrl = await grabFrame(`${BASE}/stream/${movie.id}`);
      if (!dataUrl || run !== frameRun) continue;
      saveFrame(movie.id, dataUrl);
      const slot = view.content.querySelector(`[data-frame="${CSS.escape(movie.id)}"]`);
      slot?.replaceWith(el(`<img class="media-thumb chamfer" src="${dataUrl}" alt="" />`));
    }
  }

  function drawPlayer(movie) {
    view.setTitle(movie.title);
    view.setActions("");
    view.content.classList.add("flush");
    // Music would play over the movie.
    if (player.playing && !player.onPc) player.toggle();
    view.content.innerHTML = `
      <div class="viewer">
        <video controls autoplay src="${BASE}/stream/${esc(movie.id)}">
          ${movie.subtitles.map((subtitle) => `<track kind="subtitles" label="${esc(subtitle.label)}" src="${BASE}/subtitles/${esc(movie.id)}?index=${subtitle.index}" />`).join("")}
        </video>
      </div>`;
    const video = view.content.querySelector("video");
    video.addEventListener("error", () =>
      toast("This computer can't play this movie's video or audio format. The desktop Movie app or another player may.", { tone: "error", timeout: 8000 })
    );
  }

  ctx.onEvent((event) => {
    if (event.appId === "movie-app" && event.type === "data-changed" && !playing) load();
  });
  await load();
  return () => {
    frameRun += 1;
  };
}
