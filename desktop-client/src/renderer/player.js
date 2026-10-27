import { icon } from "./icons.js";
import { api, esc, toast } from "./lib.js";

// The music player lives in the shell, not in the Music view, so playback
// carries on while you use other apps or with the window in the tray. The OS
// media controls (Windows' media overlay, Linux MPRIS) work through the
// Media Session API. "On PC" turns it into a remote for the PC's player.

class Player {
  audio = new Audio();
  queue = [];
  index = -1;
  onPc = false;
  pcPlaylist = null;
  footer = null;
  listeners = new Set();

  constructor() {
    this.audio.preload = "auto";
    this.audio.addEventListener("ended", () => this.next());
    this.audio.addEventListener("play", () => this.#changed());
    this.audio.addEventListener("pause", () => this.#changed());
    this.audio.addEventListener("timeupdate", () => this.#updateSeek());
    this.audio.addEventListener("error", () => {
      if (this.current) toast(`Can't play ${this.current.title} on this computer.`, { tone: "error" });
    });
    const session = navigator.mediaSession;
    if (session) {
      session.setActionHandler("play", () => this.toggle());
      session.setActionHandler("pause", () => this.toggle());
      session.setActionHandler("nexttrack", () => this.next());
      session.setActionHandler("previoustrack", () => this.previous());
    }
    window.cc.settings.get().then((settings) => {
      this.onPc = settings.musicOnPc;
      this.#changed();
    });
  }

  get current() {
    return this.queue[this.index] || null;
  }

  get playing() {
    return !this.audio.paused;
  }

  /** Re-render hooks for views that show the player state (Music). */
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  mount(footer) {
    this.footer = footer;
    this.#render();
  }

  /** items: [{ url, title, artist, album }] */
  playQueue(items, index) {
    this.queue = items;
    this.index = index;
    this.#load(true);
  }

  playPc(playlistName) {
    this.pcPlaylist = playlistName;
    this.#pc("play-playlist", playlistName);
    this.#changed();
  }

  toggle() {
    if (this.onPc) return this.#pc("play-pause");
    if (!this.current) return;
    if (this.audio.paused) this.audio.play().catch(() => {});
    else this.audio.pause();
  }

  next() {
    if (this.onPc) return this.#pc("next");
    if (this.index < this.queue.length - 1) {
      this.index += 1;
      this.#load(true);
    } else {
      this.audio.pause();
    }
  }

  previous() {
    if (this.onPc) return this.#pc("prev");
    if (this.audio.currentTime > 3 || this.index === 0) {
      this.audio.currentTime = 0;
      return;
    }
    this.index -= 1;
    this.#load(true);
  }

  async setOnPc(onPc) {
    this.onPc = onPc;
    if (onPc) this.audio.pause();
    await window.cc.settings.update({ musicOnPc: onPc });
    this.#changed();
  }

  stop() {
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.queue = [];
    this.index = -1;
    this.#changed();
  }

  #load(autoplay) {
    const track = this.current;
    if (!track) return;
    this.audio.src = track.url;
    if (autoplay) this.audio.play().catch(() => {});
    if (navigator.mediaSession) {
      navigator.mediaSession.metadata = new MediaMetadata({ title: track.title, artist: track.artist || "", album: track.album || "" });
    }
    this.#changed();
  }

  async #pc(action, playlistName) {
    try {
      await api("/api/apps/music-app/command", { method: "POST", body: { action, playlistName } });
    } catch (error) {
      toast(`The PC didn't take that: ${error.message}`, { tone: "error" });
    }
  }

  #changed() {
    if (navigator.mediaSession) navigator.mediaSession.playbackState = this.playing ? "playing" : "paused";
    this.#render();
    for (const listener of this.listeners) listener();
  }

  #updateSeek() {
    const seek = this.footer?.querySelector(".seek");
    if (seek && this.audio.duration) seek.value = String((this.audio.currentTime / this.audio.duration) * 1000);
  }

  #render() {
    const footer = this.footer;
    if (!footer) return;
    const active = this.onPc ? Boolean(this.pcPlaylist) : Boolean(this.current);
    footer.hidden = !active;
    if (!active) return;
    const track = this.current;
    const title = this.onPc ? `Playlist: ${this.pcPlaylist}` : track.title;
    const subtitle = this.onPc ? "Playing on the PC" : [track.artist, track.album].filter(Boolean).join(" · ");
    footer.innerHTML = `
      <div class="grow">
        <div class="ellipsis">${esc(title)}</div>
        <div class="ellipsis muted small">${esc(subtitle)}</div>
      </div>
      <button class="icon-btn" data-act="prev" title="Previous">${icon("skip-back")}</button>
      <button class="icon-btn" data-act="toggle" title="Play or pause" style="color:var(--cyan)">${icon(!this.onPc && this.playing ? "pause" : "play")}</button>
      <button class="icon-btn" data-act="next" title="Next">${icon("skip-forward")}</button>
      ${this.onPc ? "" : `<input class="seek" type="range" min="0" max="1000" value="0" aria-label="Position" />`}
      <button class="btn magenta small" data-act="target">♪ on ${this.onPc ? "PC" : "this computer"}</button>`;
    footer.querySelector('[data-act="prev"]').addEventListener("click", () => this.previous());
    footer.querySelector('[data-act="toggle"]').addEventListener("click", () => this.toggle());
    footer.querySelector('[data-act="next"]').addEventListener("click", () => this.next());
    footer.querySelector('[data-act="target"]').addEventListener("click", () => this.setOnPc(!this.onPc));
    footer.querySelector(".seek")?.addEventListener("input", (event) => {
      if (this.audio.duration) this.audio.currentTime = (Number(event.target.value) / 1000) * this.audio.duration;
    });
    this.#updateSeek();
  }
}

export const player = new Player();
