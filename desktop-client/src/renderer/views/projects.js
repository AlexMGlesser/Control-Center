import { icon } from "../icons.js";
import { api, ApiError, confirmDialog, dialog, el, esc, formatBytes, q, toast } from "../lib.js";
import { frame, note } from "./frame.js";

// Projects: personal and work projects, one folder at a time, and a text
// editor for scripts. Like the phone, this computer can edit and create;
// rename, move and delete stay on the PC.

const BASE = "/api/apps/project-app";

// Kept between visits, so switching to Jarvis or another app and back
// doesn't lose the open file or unsaved edits.
let kept = null;

export async function render(host, ctx) {
  const state = kept?.state || { projects: [], filter: "all", project: null, listing: null, file: null, savedText: "", showHidden: false };
  const restoredText = kept?.text;
  kept = null;
  const view = frame(host, { title: "Projects", onBack: () => goBack(), flush: true });
  const body = el(`<div style="display:contents"></div>`);
  view.content.append(body);

  const dirty = () => Boolean(state.file && !state.file.binary && editorText() !== state.savedText);
  const editorText = () => body.querySelector("textarea")?.value ?? state.savedText;

  async function guard() {
    return !dirty() || confirmDialog(`Discard changes to ${state.file.name}?`, "You have unsaved changes.", "Discard", true);
  }

  async function goBack() {
    if (!(await guard())) return;
    if (state.file) {
      state.file = null;
      return drawFolder();
    }
    if (state.listing?.parent) return openFolder(state.listing.parent);
    if (state.project) {
      state.project = null;
      state.listing = null;
      return drawProjects();
    }
    ctx.closeApp();
  }

  /* ---------------- Projects ---------------- */

  async function loadProjects() {
    try {
      state.projects = (await api(`${BASE}/projects`)).projects;
    } catch (error) {
      toast(error.message, { tone: "error" });
    }
  }

  function drawProjects() {
    view.setTitle("Projects");
    view.setActions("");
    const visible = state.projects.filter((project) => state.filter === "all" || project.category === state.filter);
    body.innerHTML = `
      <div class="toolbar">
        ${["all", "personal", "work"].map((filter) => `<button class="chip ${state.filter === filter ? "active" : ""}" data-filter="${filter}">${filter[0].toUpperCase() + filter.slice(1)}</button>`).join("")}
      </div>
      <div class="content"><div class="list" id="projects"></div>${visible.length ? "" : note("No projects here. Add project folders in the Projects app on the PC.")}</div>`;
    const list = body.querySelector("#projects");
    for (const project of visible) {
      const card = el(`
        <button class="card chamfer">
          <div style="display:flex;align-items:center;gap:10px">
            <b class="grow ellipsis" style="flex:1">${esc(project.name)}</b>
            <span class="pill ${project.category === "work" ? "waiting" : ""}" style="${project.category === "work" ? "" : "color:var(--muted)"}">${project.category === "work" ? "WORK" : "PERSONAL"}</span>
          </div>
          <div class="muted small ellipsis">${esc(project.path)}</div>
          ${project.missing ? `<div class="danger-text small">Folder is missing</div>` : ""}
        </button>`);
      card.addEventListener("click", () => {
        state.project = project;
        openFolder(null);
      });
      list.append(card);
    }
    body.querySelectorAll("[data-filter]").forEach((chip) =>
      chip.addEventListener("click", () => {
        state.filter = chip.dataset.filter;
        drawProjects();
      })
    );
  }

  /* ---------------- Folder ---------------- */

  async function openFolder(folderPath) {
    try {
      state.listing = await api(`${BASE}/projects/${q(state.project.id)}/list${folderPath ? `?path=${q(folderPath)}` : ""}`);
      drawFolder();
    } catch (error) {
      toast(error.message, { tone: "error" });
    }
  }

  function drawFolder() {
    const listing = state.listing;
    view.setTitle(state.project.name);
    view.setActions(`
      <button class="btn small" data-new="file">${icon("plus")} New file</button>
      <button class="btn small" data-new="folder">${icon("plus")} New folder</button>
      <label class="small muted" style="display:flex;gap:6px;align-items:center"><input type="checkbox" class="switch" id="hidden" ${state.showHidden ? "checked" : ""}/> Hidden</label>`);
    view.actions.querySelectorAll("[data-new]").forEach((button) => button.addEventListener("click", () => createEntry(button.dataset.new)));
    view.actions.querySelector("#hidden").addEventListener("change", (event) => {
      state.showHidden = event.target.checked;
      drawFolder();
    });

    const parts = listing.relativePath ? listing.relativePath.split(/[\\/]/) : [];
    const crumbs = [{ label: state.project.name, path: null }];
    let walk = listing.project.path.replace(/[\\/]+$/, "");
    for (const part of parts) {
      walk = `${walk}\\${part}`;
      crumbs.push({ label: part, path: walk });
    }
    const entries = listing.entries.filter((entry) => state.showHidden || !entry.hidden);
    body.innerHTML = `
      <nav class="breadcrumb">${crumbs.map((crumb, index) => `${index ? "<span class='muted'>›</span>" : ""}<button data-crumb="${index}">${esc(crumb.label)}</button>`).join("")}</nav>
      <div class="scroll" id="entries"></div>`;
    body.querySelectorAll("[data-crumb]").forEach((button) => {
      const crumb = crumbs[Number(button.dataset.crumb)];
      if (Number(button.dataset.crumb) < crumbs.length - 1) button.addEventListener("click", () => openFolder(crumb.path));
    });
    const list = body.querySelector("#entries");
    if (!entries.length) list.innerHTML = note("This folder is empty.");
    for (const entry of entries) {
      const row = el(`
        <div class="row">
          <span class="glyph">${icon(entry.type === "folder" ? "folder" : "file")}</span>
          <span class="grow ellipsis" style="${entry.hidden ? "color:var(--muted)" : ""}">${esc(entry.name)}</span>
          <span class="muted small">${entry.type === "file" ? formatBytes(entry.size) : ""}</span>
        </div>`);
      row.addEventListener("click", () => (entry.type === "folder" ? openFolder(entry.path) : openFile(entry)));
      list.append(row);
    }
  }

  async function createEntry(type) {
    const values = await dialog({
      title: type === "folder" ? "New folder" : "New file",
      ok: "Create",
      fields: [{ name: "name", label: "Name", placeholder: type === "folder" ? "scripts" : "script.py", required: true }]
    });
    if (!values) return;
    try {
      const created = await api(`${BASE}/projects/${q(state.project.id)}/entries`, {
        method: "POST",
        body: { parentPath: state.listing.path, name: values.name, type }
      });
      await openFolder(state.listing.path);
      if (created.type === "file") openFile(created);
    } catch (error) {
      toast(error.message, { tone: "error" });
    }
  }

  /* ---------------- Editor ---------------- */

  async function openFile(entry) {
    try {
      const file = await api(`${BASE}/projects/${q(state.project.id)}/file?path=${q(entry.path)}`);
      state.file = file;
      state.savedText = file.text;
      drawEditor();
    } catch (error) {
      if (error instanceof ApiError && error.code === "BINARY_FILE") {
        state.file = { ...entry, binary: true };
        drawEditor();
      } else toast(error.message, { tone: "error" });
    }
  }

  function drawEditor(text = state.savedText) {
    const file = state.file;
    view.setTitle(file.name);
    if (file.binary) {
      view.setActions("");
      body.innerHTML = `<div class="content">${note(`This isn't a text file (${formatBytes(file.size)}). Open it from File System to view or download it.`)}</div>`;
      return;
    }
    view.setActions(`<span class="muted small" id="dirty"></span><button class="btn primary small" id="save" ${file.truncated ? "disabled" : ""}>Save</button>`);
    body.innerHTML = `
      ${file.truncated ? `<div class="alert-bar"><span>Only the first 512 KB is shown, so this file can't be saved here.</span></div>` : ""}
      <div class="editor"><pre class="gutter"></pre><textarea spellcheck="false" wrap="off" ${file.truncated ? "readonly" : ""}></textarea></div>`;
    const textarea = body.querySelector("textarea");
    const gutter = body.querySelector(".gutter");
    textarea.value = text;
    const update = () => {
      const lines = textarea.value.split("\n").length;
      gutter.textContent = Array.from({ length: lines }, (_, n) => n + 1).join("\n");
      gutter.scrollTop = textarea.scrollTop;
      view.actions.querySelector("#dirty").textContent = dirty() ? "● unsaved" : "";
    };
    textarea.addEventListener("input", update);
    textarea.addEventListener("scroll", () => {
      gutter.scrollTop = textarea.scrollTop;
    });
    textarea.addEventListener("keydown", (event) => {
      if (event.key === "Tab" && !event.ctrlKey) {
        event.preventDefault();
        textarea.setRangeText("    ", textarea.selectionStart, textarea.selectionEnd, "end");
        update();
      } else if (event.key === "Enter") {
        // Keep the indentation of the line above.
        const start = textarea.value.lastIndexOf("\n", textarea.selectionStart - 1) + 1;
        const indent = textarea.value.slice(start, textarea.selectionStart).match(/^[\t ]*/)[0];
        if (indent) {
          event.preventDefault();
          textarea.setRangeText(`\n${indent}`, textarea.selectionStart, textarea.selectionEnd, "end");
          update();
        }
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        save();
      }
    });
    view.actions.querySelector("#save").addEventListener("click", () => save());
    update();
    textarea.focus();
  }

  async function save(force = false) {
    const textarea = body.querySelector("textarea");
    if (!textarea || !state.file || state.file.truncated) return;
    const text = textarea.value;
    try {
      const saved = await api(`${BASE}/projects/${q(state.project.id)}/file`, {
        method: "PUT",
        body: { path: state.file.path, content: text, ...(force ? {} : { expectedModified: state.file.modified }) }
      });
      state.file.modified = saved.modified;
      state.savedText = text;
      body.querySelector(".alert-bar.conflict")?.remove();
      textarea.dispatchEvent(new Event("input"));
      toast(`Saved ${saved.name}.`);
    } catch (error) {
      if (error instanceof ApiError && error.code === "FILE_CHANGED") {
        if (body.querySelector(".alert-bar.conflict")) return;
        const bar = el(`<div class="alert-bar conflict"><span>This file changed on the PC since you opened it.</span><button class="btn small" data-reload>Reload</button><button class="btn danger small" data-force>Save anyway</button></div>`);
        bar.querySelector("[data-reload]").addEventListener("click", () => openFile(state.file));
        bar.querySelector("[data-force]").addEventListener("click", () => save(true));
        body.querySelector(".editor").before(bar);
      } else toast(error.message, { tone: "error" });
    }
  }

  // Saved elsewhere while open here with no local edits: show the new text.
  ctx.onEvent(async (event) => {
    if (event.appId !== "project-app" || event.type !== "data-changed") return;
    if (event.meta?.entity === "project") {
      await loadProjects();
      if (!state.project) drawProjects();
      return;
    }
    if (state.file && !state.file.binary && event.meta?.path === state.file.path && !dirty()) {
      const latest = await api(`${BASE}/projects/${q(state.project.id)}/file?path=${q(state.file.path)}`).catch(() => null);
      if (latest && latest.modified !== state.file.modified && !dirty()) {
        state.file = latest;
        state.savedText = latest.text;
        drawEditor();
        toast(`${latest.name} changed on the PC and was reloaded.`);
      }
    } else if (!state.file && state.listing) {
      openFolder(state.listing.path);
    }
  });

  const beforeUnload = (event) => {
    if (dirty()) event.preventDefault();
  };
  window.addEventListener("beforeunload", beforeUnload);

  await loadProjects();
  if (state.file) drawEditor(restoredText ?? state.savedText);
  else if (state.listing) drawFolder();
  else drawProjects();
  return () => {
    kept = { state, text: body.querySelector("textarea")?.value };
    window.removeEventListener("beforeunload", beforeUnload);
  };
}
