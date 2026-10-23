import { icon } from "../icons.js";
import { api, dialog, el, esc, formatBytes, longDate, q, shortDate, toast } from "../lib.js";
import { frame, note } from "./frame.js";

// File System: the whole PC, read-only (view and download). Locked behind
// Windows Hello or a PIN first, like the phone's fingerprint lock; it locks
// again whenever you leave it.

const KIND_ICON = { folder: "folder", text: "file", image: "file", pdf: "file", audio: "music", video: "clapperboard" };
const contentUrl = (path) => `/api/files/content?path=${q(path)}`;

export async function render(host, ctx) {
  const view = frame(host, { title: "File System", onBack: () => back(), flush: true });
  const state = { roots: null, folder: null, preview: null, filter: "", showHidden: false };

  function back() {
    if (state.preview) {
      state.preview = null;
      return draw();
    }
    if (state.folder?.parent) return openFolder(state.folder.parent);
    if (state.folder) {
      state.folder = null;
      return draw();
    }
    ctx.closeApp();
  }

  /* ---------------- Lock ---------------- */

  async function unlock() {
    const settings = await window.cc.settings.get();
    if (!settings.lockFileSystem) return true;
    view.content.innerHTML = note("Unlocking…");
    const result = await window.cc.lock.unlock().catch(() => "Unavailable");
    if (result === "Verified") return true;
    if (result !== "Unavailable") return false;
    // No Windows Hello (or not Windows): the File System PIN.
    if (!settings.hasPin) {
      const values = await dialog({
        title: "Set a File System PIN",
        text: "File System shows everything on your PC, so it's locked. Choose a PIN (4 to 12 digits) to unlock it on this computer.",
        ok: "Save and unlock",
        fields: [{ name: "pin", label: "PIN", type: "password" }]
      });
      if (!values) return false;
      try {
        await window.cc.lock.setPin(values.pin);
        return true;
      } catch (error) {
        toast(error.message, { tone: "error" });
        return false;
      }
    }
    const values = await dialog({ title: "Unlock File System", ok: "Unlock", fields: [{ name: "pin", label: "PIN", type: "password" }] });
    if (!values) return false;
    const check = await window.cc.lock.unlock(values.pin);
    if (check !== "Verified") toast("That PIN isn't right.", { tone: "error" });
    return check === "Verified";
  }

  /* ---------------- Browsing ---------------- */

  async function loadRoots() {
    try {
      state.roots = await api("/api/files/roots");
    } catch (error) {
      view.content.innerHTML = note(error.code === "PHONE_FILE_ACCESS_OFF" ? "File access from other devices is switched off on the PC (Settings > Devices)." : error.message);
      return false;
    }
    return true;
  }

  async function openFolder(path) {
    try {
      state.folder = await api(`/api/files/list?path=${q(path)}${state.showHidden ? "&hidden=1" : ""}`);
      state.filter = "";
      state.preview = null;
      draw();
    } catch (error) {
      toast(error.message, { tone: "error" });
    }
  }

  function draw() {
    if (state.preview) return drawPreview(state.preview);
    view.setActions(`<label class="small muted" style="display:flex;gap:6px;align-items:center"><input type="checkbox" class="switch" id="hidden" ${state.showHidden ? "checked" : ""}/> Hidden</label>`);
    view.actions.querySelector("#hidden").addEventListener("change", (event) => {
      state.showHidden = event.target.checked;
      if (state.folder) openFolder(state.folder.path);
    });

    if (!state.folder) {
      view.setTitle("File System");
      const root = el(`<div class="scroll" style="padding:12px 20px"><div class="list"></div></div>`);
      const list = root.querySelector(".list");
      const section = (title, items) => {
        list.append(el(`<div class="section-label">${esc(title)}</div>`));
        for (const item of items) {
          const row = el(`
            <button class="card chamfer" style="display:flex;align-items:center;gap:12px">
              <span class="glyph">${icon(item.type === "drive" ? "server" : "folder")}</span>
              <span style="flex:1">${esc(item.name)}</span>
              ${item.totalBytes ? `<span class="muted small">${formatBytes(item.freeBytes)} free of ${formatBytes(item.totalBytes)}</span>` : ""}
            </button>`);
          row.addEventListener("click", () => openFolder(item.path));
          list.append(row);
        }
      };
      section("Quick locations", state.roots.quick);
      section("Drives", state.roots.drives);
      view.content.replaceChildren(root);
      return;
    }

    const folder = state.folder;
    view.setTitle(folder.path.split("\\").filter(Boolean).pop() || folder.path);
    const parts = folder.path.split("\\").filter(Boolean);
    view.content.innerHTML = `
      <nav class="breadcrumb">${parts.map((part, index) => `${index ? "<span class='muted'>›</span>" : ""}<button data-index="${index}">${esc(part)}</button>`).join("")}</nav>
      <div class="toolbar"><input type="search" id="filter" placeholder="Filter this folder…" value="${esc(state.filter)}" style="flex:1" /></div>
      <div class="scroll" id="entries"></div>`;
    view.content.querySelectorAll(".breadcrumb [data-index]").forEach((button) => {
      const index = Number(button.dataset.index);
      if (index < parts.length - 1) button.addEventListener("click", () => openFolder(`${parts.slice(0, index + 1).join("\\")}${index === 0 ? "\\" : ""}`));
    });
    const filter = view.content.querySelector("#filter");
    filter.addEventListener("input", () => {
      state.filter = filter.value;
      drawEntries();
    });
    drawEntries();
  }

  function drawEntries() {
    const list = view.content.querySelector("#entries");
    const text = state.filter.trim().toLowerCase();
    const entries = state.folder.entries.filter((entry) => !text || entry.name.toLowerCase().includes(text));
    list.replaceChildren();
    if (!entries.length) list.innerHTML = note(text ? "Nothing matches." : "This folder is empty.");
    for (const entry of entries) {
      const row = el(`
        <div class="row" title="${esc(entry.path)}">
          <span class="glyph" style="${entry.noAccess ? "color:var(--muted)" : ""}">${icon(entry.noAccess ? "lock" : KIND_ICON[entry.kind] || "file")}</span>
          <span class="grow ellipsis" style="${entry.hidden || entry.noAccess ? "color:var(--muted)" : ""}">${esc(entry.name)}</span>
          <span class="muted small">${entry.noAccess ? "No access" : [entry.type === "file" ? formatBytes(entry.size) : "", shortDate(entry.modified)].filter(Boolean).join("  ")}</span>
          ${entry.type === "file" && !entry.noAccess ? `<button class="icon-btn" data-download title="Download">${icon("download")}</button>` : ""}
        </div>`);
      row.addEventListener("click", (event) => {
        if (event.target.closest("[data-download]")) return download(entry);
        if (entry.noAccess) return toast(`Windows won't let Control Center open ${entry.name}.`);
        if (entry.type === "folder") return openFolder(entry.path);
        state.preview = entry;
        draw();
      });
      list.append(row);
    }
  }

  /* ---------------- Preview ---------------- */

  async function drawPreview(file) {
    view.setTitle(file.name);
    view.setActions(`
      <button class="btn small" id="details">Details</button>
      <button class="btn primary small" id="download">${icon("download")} Download</button>`);
    view.actions.querySelector("#download").addEventListener("click", () => download(file));
    view.actions.querySelector("#details").addEventListener("click", () => details(file));

    const url = contentUrl(file.path);
    if (file.kind === "image") {
      view.content.innerHTML = `<div class="viewer"><img src="${esc(url)}" alt="${esc(file.name)}" /></div>`;
    } else if (file.kind === "pdf") {
      view.content.innerHTML = `<div class="viewer"><iframe src="${esc(url)}" title="${esc(file.name)}"></iframe></div>`;
    } else if (file.kind === "video") {
      view.content.innerHTML = `<div class="viewer"><video src="${esc(url)}" controls autoplay></video></div>`;
      view.content.querySelector("video").addEventListener("error", () => toast("This computer can't play this video's format. Download it and use another player.", { tone: "error" }));
    } else if (file.kind === "audio") {
      view.content.innerHTML = `<div class="viewer" style="background:var(--bg)"><audio src="${esc(url)}" controls autoplay></audio></div>`;
    } else if (file.kind === "text") {
      view.content.innerHTML = note("Loading…");
      try {
        const res = await fetch(url, { headers: { Range: "bytes=0-524287" } });
        const text = await res.text();
        if (state.preview !== file) return;
        view.content.innerHTML = `${(file.size || 0) > 524288 ? `<div class="alert-bar"><span>Showing the first 512 KB.</span></div>` : ""}<pre class="text-preview"></pre>`;
        view.content.querySelector("pre").textContent = text;
      } catch (error) {
        view.content.innerHTML = note(error.message);
      }
    } else {
      view.content.innerHTML = `<div class="content">${note(`No preview for this kind of file (${formatBytes(file.size)}). Use Download.`)}</div>`;
    }
  }

  async function download(file) {
    try {
      const result = await window.cc.files.download({ path: file.path, name: file.name });
      if (!result.canceled) toast(`Saved ${file.name}.`);
    } catch (error) {
      toast(`Couldn't download ${file.name}: ${error.message}`, { tone: "error" });
    }
  }

  async function details(file) {
    const info = await api(`/api/files/info?path=${q(file.path)}`).catch(() => file);
    await dialog({
      title: info.name,
      text: [`Location: ${info.path}`, info.size !== null && info.size !== undefined ? `Size: ${formatBytes(info.size)}` : "", info.created ? `Created: ${longDate(info.created)}` : "", info.modified ? `Modified: ${longDate(info.modified)}` : ""]
        .filter(Boolean)
        .join("\n"),
      ok: "Close"
    });
  }

  if (!(await unlock())) {
    view.content.innerHTML = `<div class="content">${note("File System is locked.")}<button class="btn primary" id="retry" style="margin-left:24px">Unlock</button></div>`;
    view.content.querySelector("#retry").addEventListener("click", () => ctx.openApp("file-system-app"));
    return;
  }
  if (await loadRoots()) draw();
}
