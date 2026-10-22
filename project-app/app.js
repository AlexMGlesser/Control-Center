// Projects: one list of personal and work project folders, browsed one folder
// at a time, with a built-in text editor. Server: control-app/server/services/projectService.js.

const API = "/api/apps/project-app";

const state = {
  projects: [],
  filter: "all",
  projectId: null,
  folder: null, // current folder listing { path, parent, entries, project }
  selectedPath: null,
  clipboard: null, // { mode: "copy" | "cut", path, projectId }
  showHidden: false,
  file: null, // open file { path, name, modified, text }
  dirty: false
};

const $ = (id) => document.getElementById(id);
const els = {
  list: $("project-list"),
  projectEmpty: $("project-empty"),
  tools: $("tools"),
  breadcrumb: $("breadcrumb"),
  entries: $("entries"),
  browserEmpty: $("browser-empty"),
  newFile: $("new-file"),
  newFolder: $("new-folder"),
  paste: $("paste"),
  showHidden: $("show-hidden"),
  editor: $("editor"),
  editorName: $("editor-name"),
  editorDirty: $("editor-dirty"),
  editorBanner: $("editor-banner"),
  editorBody: $("editor-body"),
  fileInfo: $("file-info"),
  gutter: $("gutter"),
  text: $("text"),
  save: $("save"),
  status: $("status")
};

/* ------------------------------------------------------------------ */
/* Server calls                                                        */
/* ------------------------------------------------------------------ */

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({ ok: false, message: `Request failed (${res.status}).` }));
  if (!res.ok || data.ok === false) {
    const error = new Error(data.message || `Request failed (${res.status}).`);
    error.code = data.code;
    error.status = res.status;
    error.data = data;
    throw error;
  }
  return data;
}

const q = (value) => encodeURIComponent(value);

function setStatus(text, tone = "") {
  els.status.textContent = text || "";
  els.status.className = `status ${tone}`;
}

function report(error) {
  setStatus(error?.message || String(error), "error");
}

/* ------------------------------------------------------------------ */
/* Projects                                                            */
/* ------------------------------------------------------------------ */

async function loadProjects() {
  const { projects } = await api("/projects");
  state.projects = projects;
  if (state.projectId && !projects.some((project) => project.id === state.projectId)) {
    state.projectId = null;
    state.folder = null;
  }
  renderProjects();
  renderBrowser();
}

function renderProjects() {
  const visible = state.projects.filter((project) => state.filter === "all" || project.category === state.filter);
  els.projectEmpty.hidden = visible.length > 0;
  els.list.replaceChildren(
    ...visible.map((project) => {
      const item = document.createElement("li");
      item.className = `project${project.id === state.projectId ? " is-active" : ""}`;
      item.tabIndex = 0;
      item.innerHTML = `
        <span class="project-name"></span>
        <span class="badge ${project.category}">${project.category === "work" ? "Work" : "Personal"}</span>
        <span class="project-path"></span>
        ${project.missing ? '<span class="project-missing">Folder is missing</span>' : ""}
        <div class="project-actions">
          <button class="btn" data-action="edit">Edit</button>
          <button class="btn" data-action="vscode">VS Code</button>
          <button class="btn danger" data-action="remove">Remove</button>
        </div>`;
      item.querySelector(".project-name").textContent = project.name;
      item.querySelector(".project-path").textContent = project.path;
      item.querySelector(".project-path").title = project.path;
      item.addEventListener("click", (event) => {
        const action = event.target.closest("[data-action]")?.dataset.action;
        if (action === "edit") return editProject(project);
        if (action === "remove") return removeProject(project);
        if (action === "vscode") return openInVsCode(project.path, project.id);
        if (project.id !== state.projectId) selectProject(project.id);
      });
      item.addEventListener("keydown", (event) => {
        if (event.key === "Enter") selectProject(project.id);
      });
      return item;
    })
  );
}

async function selectProject(projectId) {
  if (!(await confirmDiscard())) return;
  state.projectId = projectId;
  closeEditor(true);
  renderProjects();
  await openFolder(null);
}

async function addProject() {
  const values = await askForm({
    title: "Add a project",
    text: "Choose an existing folder. It isn't moved or copied.",
    ok: "Add project",
    fields: [
      { name: "path", label: "Folder", browse: true, required: true },
      { name: "name", label: "Name", placeholder: "Defaults to the folder name" },
      { name: "category", label: "Category", type: "select", options: [["personal", "Personal"], ["work", "Work"]], value: state.filter === "work" ? "work" : "personal" }
    ]
  });
  if (!values) return;
  try {
    const { project } = await api("/projects", { method: "POST", body: values });
    state.projectId = project.id;
    await loadProjects();
    await openFolder(null);
    setStatus(`Added ${project.name}.`, "ok");
  } catch (error) {
    report(error);
  }
}

async function editProject(project) {
  const values = await askForm({
    title: "Edit project",
    ok: "Save",
    fields: [
      { name: "name", label: "Name", value: project.name, required: true },
      { name: "category", label: "Category", type: "select", options: [["personal", "Personal"], ["work", "Work"]], value: project.category }
    ]
  });
  if (!values) return;
  try {
    await api(`/projects/${q(project.id)}`, { method: "PATCH", body: values });
    await loadProjects();
  } catch (error) {
    report(error);
  }
}

async function removeProject(project) {
  const yes = await askConfirm(`Remove ${project.name}?`, "It's removed from this list only. The folder and its files stay where they are.", "Remove");
  if (!yes) return;
  try {
    await api(`/projects/${q(project.id)}`, { method: "DELETE" });
    if (state.projectId === project.id) {
      state.projectId = null;
      state.folder = null;
      closeEditor(true);
    }
    await loadProjects();
    setStatus(`Removed ${project.name} from the list.`, "ok");
  } catch (error) {
    report(error);
  }
}

/* ------------------------------------------------------------------ */
/* Folder browser                                                      */
/* ------------------------------------------------------------------ */

async function openFolder(folderPath) {
  if (!state.projectId) return;
  try {
    const listing = await api(`/projects/${q(state.projectId)}/list${folderPath ? `?path=${q(folderPath)}` : ""}`);
    state.folder = listing;
    state.selectedPath = null;
    renderBrowser();
  } catch (error) {
    report(error);
  }
}

function renderBrowser() {
  const listing = state.folder;
  const hasFolder = Boolean(listing && state.projectId);
  els.browserEmpty.hidden = hasFolder;
  els.newFile.disabled = !hasFolder;
  els.newFolder.disabled = !hasFolder;
  els.paste.hidden = !(hasFolder && state.clipboard && state.clipboard.projectId === state.projectId);
  if (!hasFolder) {
    els.breadcrumb.replaceChildren();
    els.entries.replaceChildren();
    return;
  }

  // Breadcrumb: project name, then each folder below the project root.
  const root = listing.project;
  const parts = listing.relativePath ? listing.relativePath.split(/[\\/]/) : [];
  const crumbs = [{ label: root.name, path: null }];
  let walk = root.path;
  for (const part of parts) {
    walk = `${walk.replace(/[\\/]+$/, "")}\\${part}`;
    crumbs.push({ label: part, path: walk });
  }
  els.breadcrumb.replaceChildren(
    ...crumbs.flatMap((crumb, index) => {
      const button = document.createElement("button");
      button.className = `crumb${index === crumbs.length - 1 ? " current" : ""}`;
      button.textContent = crumb.label;
      if (index < crumbs.length - 1) button.addEventListener("click", () => openFolder(crumb.path));
      return index === 0 ? [button] : [Object.assign(document.createElement("span"), { className: "crumb-sep", textContent: "›" }), button];
    })
  );

  const entries = listing.entries.filter((entry) => state.showHidden || !entry.hidden);
  const rows = [];
  if (listing.parent) {
    rows.push(entryRow({ name: "..", type: "folder", path: listing.parent, isUp: true }));
  }
  rows.push(...entries.map((entry) => entryRow(entry)));
  if (!entries.length) {
    rows.push(Object.assign(document.createElement("p"), { className: "empty", textContent: "This folder is empty." }));
  }
  els.entries.replaceChildren(...rows);
}

function entryRow(entry) {
  const row = document.createElement("div");
  row.className = "entry";
  row.role = "listitem";
  row.tabIndex = 0;
  if (entry.hidden) row.classList.add("is-hidden");
  if (entry.path === state.selectedPath) row.classList.add("is-selected");
  if (state.clipboard?.mode === "cut" && state.clipboard.path === entry.path) row.classList.add("is-cut");
  row.innerHTML = `
    <span class="entry-icon">${entry.type === "folder" ? "▸" : "◇"}</span>
    <span class="entry-name"></span>
    <span class="entry-size">${entry.type === "file" ? formatSize(entry.size) : ""}</span>
    <span class="entry-actions">
      ${entry.isUp ? "" : `
        <button class="btn" data-action="rename">Rename</button>
        <button class="btn" data-action="copy">Copy</button>
        <button class="btn" data-action="cut">Cut</button>
        <button class="btn" data-action="open">${entry.type === "folder" ? "Explorer" : "Open"}</button>
        <button class="btn danger" data-action="delete">Delete</button>`}
    </span>`;
  row.querySelector(".entry-name").textContent = entry.name;
  row.title = entry.isUp ? "Up one folder" : entry.path;

  const activate = () => (entry.type === "folder" ? openFolder(entry.path) : openFile(entry));
  row.addEventListener("click", (event) => {
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (action) return entryAction(action, entry);
    if (entry.isUp || entry.type === "folder") return activate();
    state.selectedPath = entry.path;
    for (const other of els.entries.querySelectorAll(".entry.is-selected")) other.classList.remove("is-selected");
    row.classList.add("is-selected");
    activate();
  });
  row.addEventListener("keydown", (event) => {
    if (event.key === "Enter") activate();
  });
  return row;
}

async function entryAction(action, entry) {
  const projectId = state.projectId;
  try {
    if (action === "rename") {
      const values = await askForm({ title: `Rename ${entry.name}`, ok: "Rename", fields: [{ name: "newName", label: "New name", value: entry.name, required: true }] });
      if (!values || values.newName === entry.name) return;
      await api(`/projects/${q(projectId)}/rename`, { method: "POST", body: { path: entry.path, newName: values.newName } });
      if (state.file?.path === entry.path) closeEditor(true);
      setStatus(`Renamed to ${values.newName}.`, "ok");
    } else if (action === "copy" || action === "cut") {
      state.clipboard = { mode: action, path: entry.path, projectId, name: entry.name };
      setStatus(`${action === "copy" ? "Copied" : "Cut"} ${entry.name}. Open a folder and press Paste.`);
      renderBrowser();
      return;
    } else if (action === "open") {
      await api(`/projects/${q(projectId)}/open`, { method: "POST", body: { path: entry.path, with: "default" } });
      return;
    } else if (action === "delete") {
      const yes = await askConfirm(`Delete ${entry.name}?`, "It goes to the Recycle Bin, so you can restore it from there.", "Delete");
      if (!yes) return;
      await api(`/projects/${q(projectId)}/trash`, { method: "POST", body: { path: entry.path } });
      if (state.file?.path === entry.path) closeEditor(true);
      setStatus(`Moved ${entry.name} to the Recycle Bin.`, "ok");
    }
    await openFolder(state.folder?.path);
  } catch (error) {
    report(error);
  }
}

async function paste() {
  const clip = state.clipboard;
  if (!clip || !state.folder) return;
  try {
    await api(`/projects/${q(state.projectId)}/${clip.mode === "cut" ? "move" : "copy"}`, {
      method: "POST",
      body: { path: clip.path, destination: state.folder.path }
    });
    if (clip.mode === "cut") state.clipboard = null;
    setStatus(`Pasted ${clip.name}.`, "ok");
    await openFolder(state.folder.path);
  } catch (error) {
    report(error);
  }
}

async function createEntry(type) {
  if (!state.folder) return;
  const values = await askForm({
    title: type === "folder" ? "New folder" : "New file",
    ok: "Create",
    fields: [{ name: "name", label: "Name", placeholder: type === "folder" ? "assets" : "script.py", required: true }]
  });
  if (!values) return;
  try {
    const created = await api(`/projects/${q(state.projectId)}/entries`, {
      method: "POST",
      body: { parentPath: state.folder.path, name: values.name, type }
    });
    await openFolder(state.folder.path);
    if (type === "file") await openFile({ path: created.path, name: created.name, type: "file" });
  } catch (error) {
    report(error);
  }
}

/* ------------------------------------------------------------------ */
/* Editor                                                              */
/* ------------------------------------------------------------------ */

async function openFile(entry) {
  if (state.file?.path === entry.path) return;
  if (!(await confirmDiscard())) return;
  try {
    const file = await api(`/projects/${q(state.projectId)}/file?path=${q(entry.path)}`);
    state.file = file;
    showEditor({ text: file.text, readOnly: file.truncated });
    if (file.truncated) showBanner("Only the first 512 KB of this file is shown, so it can't be saved here. Use VS Code for big files.");
  } catch (error) {
    if (error.code === "BINARY_FILE") {
      state.file = { path: entry.path, name: entry.name, binary: true };
      showFileInfo(entry, error.data);
    } else {
      report(error);
    }
  }
}

function showEditor({ text, readOnly }) {
  els.editor.hidden = false;
  els.editorBody.hidden = false;
  els.fileInfo.hidden = true;
  els.editorBanner.hidden = true;
  els.editorName.textContent = state.file.name;
  els.editorName.title = state.file.path;
  els.text.value = text;
  els.text.readOnly = Boolean(readOnly);
  setDirty(false);
  updateGutter();
  els.text.scrollTop = 0;
}

function showFileInfo(entry, data) {
  els.editor.hidden = false;
  els.editorBody.hidden = true;
  els.editorBanner.hidden = true;
  els.fileInfo.hidden = false;
  els.editorName.textContent = entry.name;
  setDirty(false);
  els.save.disabled = true;
  els.fileInfo.innerHTML = `<p class="muted">This isn't a text file (${formatSize(data?.size)}).</p>`;
  const open = Object.assign(document.createElement("button"), { className: "btn primary", textContent: "Open with its default app" });
  open.addEventListener("click", () => entryAction("open", entry));
  els.fileInfo.append(open);
}

function closeEditor(force = false) {
  if (!force && state.dirty) return;
  state.file = null;
  setDirty(false);
  els.editor.hidden = true;
}

function setDirty(dirty) {
  state.dirty = dirty;
  els.editorDirty.hidden = !dirty;
  els.save.disabled = !dirty || els.text.readOnly;
}

function updateGutter() {
  const lines = els.text.value.split("\n").length;
  let out = "";
  for (let n = 1; n <= lines; n += 1) out += `${n}\n`;
  els.gutter.textContent = out;
  els.gutter.scrollTop = els.text.scrollTop;
}

async function save({ force = false } = {}) {
  if (!state.file || state.file.binary || !state.dirty) return;
  try {
    const saved = await api(`/projects/${q(state.projectId)}/file`, {
      method: "PUT",
      body: { path: state.file.path, content: els.text.value, expectedModified: force ? null : state.file.modified }
    });
    state.file.modified = saved.modified;
    setDirty(false);
    els.editorBanner.hidden = true;
    setStatus(`Saved ${saved.name}.`, "ok");
  } catch (error) {
    if (error.code === "FILE_CHANGED") {
      showBanner("This file changed on disk since you opened it.", [
        ["Reload", () => reloadFile()],
        ["Save anyway", () => save({ force: true })]
      ]);
    } else {
      report(error);
    }
  }
}

async function reloadFile() {
  if (!state.file) return;
  const path = state.file.path;
  state.file = null;
  setDirty(false);
  await openFile({ path, name: path.split(/[\\/]/).pop(), type: "file" });
}

function showBanner(text, actions = []) {
  els.editorBanner.hidden = false;
  els.editorBanner.replaceChildren(Object.assign(document.createElement("span"), { textContent: text }));
  const group = document.createElement("span");
  for (const [label, run] of actions) {
    const button = Object.assign(document.createElement("button"), { className: "btn", textContent: label });
    button.addEventListener("click", run);
    group.append(button, " ");
  }
  els.editorBanner.append(group);
}

async function confirmDiscard() {
  if (!state.dirty) return true;
  return askConfirm(`Discard changes to ${state.file?.name}?`, "You have unsaved changes.", "Discard");
}

async function openInVsCode(targetPath, projectId = state.projectId) {
  try {
    const result = await api(`/projects/${q(projectId)}/open`, { method: "POST", body: { path: targetPath } });
    setStatus(result.message, "ok");
  } catch (error) {
    report(error);
  }
}

/* ------------------------------------------------------------------ */
/* Tools                                                               */
/* ------------------------------------------------------------------ */

async function loadTools() {
  try {
    const { tools } = await api("/tools");
    els.tools.replaceChildren(
      ...tools
        .filter((tool) => tool.id !== "vscode")
        .map((tool) => {
          const button = Object.assign(document.createElement("button"), { className: "btn", textContent: tool.name });
          button.title = `Open ${tool.name}${tool.id === "terminal" || tool.id === "explorer" ? " in the selected project" : ""}`;
          button.addEventListener("click", async () => {
            try {
              const result = await api("/launch-tool", { method: "POST", body: { tool: tool.id, projectId: state.projectId } });
              setStatus(result.message, "ok");
            } catch (error) {
              report(error);
            }
          });
          return button;
        })
    );
  } catch {
    // The toolbar is optional.
  }
}

/* ------------------------------------------------------------------ */
/* Dialogs                                                             */
/* ------------------------------------------------------------------ */

const dialog = $("dialog");

function askConfirm(title, text, ok = "OK") {
  return askForm({ title, text, ok, fields: [] }).then((values) => values !== null);
}

/** A small modal form. Resolves to the field values, or null if cancelled. */
function askForm({ title, text = "", ok = "OK", fields = [] }) {
  $("dialog-title").textContent = title;
  $("dialog-text").textContent = text;
  $("dialog-text").hidden = !text;
  $("dialog-ok").textContent = ok;
  const container = $("dialog-fields");
  container.replaceChildren(
    ...fields.map((field) => {
      const wrap = Object.assign(document.createElement("label"), { className: "field" });
      wrap.append(Object.assign(document.createElement("span"), { textContent: field.label }));
      let input;
      if (field.type === "select") {
        input = document.createElement("select");
        for (const [value, label] of field.options) input.append(new Option(label, value, false, value === field.value));
      } else {
        input = Object.assign(document.createElement("input"), { type: "text", value: field.value || "", placeholder: field.placeholder || "" });
      }
      input.name = field.name;
      input.required = Boolean(field.required);
      if (field.browse) {
        const row = Object.assign(document.createElement("div"), { className: "field-row" });
        const browse = Object.assign(document.createElement("button"), { type: "button", className: "btn", textContent: "Browse…" });
        browse.addEventListener("click", async () => {
          const chosen = await pickFolder(input.value);
          if (chosen) input.value = chosen;
        });
        row.append(input, browse);
        wrap.append(row);
      } else {
        wrap.append(input);
      }
      return wrap;
    })
  );

  return new Promise((resolve) => {
    dialog.onclose = () => {
      if (dialog.returnValue !== "ok") return resolve(null);
      const values = {};
      for (const input of container.querySelectorAll("input, select")) values[input.name] = input.value.trim();
      resolve(values);
    };
    dialog.returnValue = "";
    dialog.showModal();
    container.querySelector("input, select")?.focus();
  });
}

async function pickFolder(defaultPath) {
  const bridge = window.controlCenterDesktop;
  try {
    const result = bridge?.chooseDirectory
      ? await bridge.chooseDirectory(defaultPath)
      : await (await fetch("/api/system/choose-directory", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ defaultPath })
        })).json();
    return result?.ok && !result.canceled ? result.path : null;
  } catch {
    setStatus("The folder picker isn't available here. Type the folder path instead.", "error");
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Live updates and wiring                                             */
/* ------------------------------------------------------------------ */

function formatSize(bytes) {
  if (bytes === null || bytes === undefined) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

let refreshTimer = null;

function listenForChanges() {
  const stream = new EventSource("/api/events/stream");
  stream.onmessage = (message) => {
    const payload = JSON.parse(message.data);
    const event = payload.event;
    if (payload.type !== "event" || event?.appId !== "project-app" || event.type !== "data-changed") return;
    // Saved from the phone (or elsewhere) while open here and unchanged: reload it.
    if (event.meta?.entity === "file" && state.file && event.meta.path === state.file.path && !state.dirty) {
      api(`/projects/${q(state.projectId)}/file?path=${q(state.file.path)}`)
        .then((file) => {
          if (file.modified !== state.file?.modified && !state.dirty) {
            state.file = file;
            showEditor({ text: file.text, readOnly: file.truncated });
            setStatus(`${file.name} was updated elsewhere and reloaded.`);
          }
        })
        .catch(() => {});
    }
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      loadProjects().catch(() => {});
      if (state.folder) openFolder(state.folder.path);
    }, 250);
  };
}

for (const chip of document.querySelectorAll(".chip")) {
  chip.addEventListener("click", () => {
    state.filter = chip.dataset.filter;
    for (const other of document.querySelectorAll(".chip")) other.classList.toggle("is-active", other === chip);
    renderProjects();
  });
}

$("add-project").addEventListener("click", addProject);
els.newFile.addEventListener("click", () => createEntry("file"));
els.newFolder.addEventListener("click", () => createEntry("folder"));
els.paste.addEventListener("click", paste);
els.showHidden.addEventListener("change", () => {
  state.showHidden = els.showHidden.checked;
  renderBrowser();
});
els.save.addEventListener("click", () => save());
$("open-vscode").addEventListener("click", () => state.file && openInVsCode(state.file.path));
$("close-editor").addEventListener("click", async () => {
  if (await confirmDiscard()) closeEditor(true);
});
els.text.addEventListener("input", () => {
  if (!state.dirty) setDirty(true);
  updateGutter();
});
els.text.addEventListener("scroll", () => {
  els.gutter.scrollTop = els.text.scrollTop;
});
els.text.addEventListener("keydown", (event) => {
  // Tab inserts spaces instead of leaving the editor.
  if (event.key === "Tab" && !event.ctrlKey && !els.text.readOnly) {
    event.preventDefault();
    const { selectionStart: start, selectionEnd: end, value } = els.text;
    els.text.value = `${value.slice(0, start)}    ${value.slice(end)}`;
    els.text.selectionStart = els.text.selectionEnd = start + 4;
    els.text.dispatchEvent(new Event("input"));
  }
});
document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    save();
  }
});
window.addEventListener("beforeunload", (event) => {
  if (state.dirty) event.preventDefault();
});

loadProjects().catch(report);
loadTools();
listenForChanges();
