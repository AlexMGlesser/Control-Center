const state = {
  appType: "project-app",
  projects: [],
  selectedProject: null,
  treeData: [],
  selectedNode: null,
  clipboard: null,
  graphZoom: 1,
  status: { tone: "info", text: "Select a project to load its structure." }
};

const projectsGrid = document.getElementById("projects-grid");
const projectsContainer = document.querySelector(".projects-container");
const treeTitle = document.getElementById("tree-title");
const treeContent = document.getElementById("tree-content");
const closeTreeBtn = document.getElementById("close-tree-btn");
const toolButtons = document.querySelectorAll(".tool-btn[data-tool]");
const createProjectBtn = document.getElementById("create-project-btn");
const deleteProjectBtn = document.getElementById("delete-project-btn");

async function loadProjects() {
  try {
    const response = await fetch(`/api/apps/${state.appType}/projects`);
    const data = await response.json();

    if (data.ok) {
      state.projects = data.projects || [];
      renderProjects();
      return;
    }

    setStatus(data.message || "Failed to load projects.", "error");
  } catch (error) {
    setStatus(`Failed to load projects: ${error.message}`, "error");
  }
}

function renderProjects() {
  projectsGrid.innerHTML = state.projects
    .map(
      (project) => `
        <article class="project-card ${state.selectedProject?.id === project.id ? "selected" : ""}" data-project-id="${escapeAttribute(project.id)}">
          <h3 class="project-name">${escapeHtml(project.name)}</h3>
          <p class="project-path">${escapeHtml(project.path)}</p>
        </article>
      `
    )
    .join("");

  syncProjectActionButtons();

  projectsGrid.querySelectorAll(".project-card").forEach((card) => {
    card.addEventListener("click", () => {
      openProjectTree(card.dataset.projectId).catch((error) => {
        setStatus(error.message, "error");
      });
    });
  });
}

async function openProjectTree(projectId) {
  const project = state.projects.find((item) => item.id === projectId);
  if (!project) {
    return;
  }

  state.selectedProject = project;
  state.selectedNode = null;
  renderProjects();
  treeTitle.textContent = project.name;
  treeContent.innerHTML = '<p class="muted">Loading file structure...</p>';
  projectsContainer.classList.add("tree-open");

  await refreshProjectTree();
}

async function handleCreateProject() {
  const dialogResult = await openFormDialog({
    title: "Create Project",
    description: "Add a project folder to this list.",
    confirmLabel: "Create Project",
    fields: [
      {
        name: "name",
        label: "Project name",
        type: "text",
        placeholder: "My Project",
        required: true
      },
      {
        name: "path",
        label: "Project folder",
        type: "directory",
        value: state.selectedProject?.path || "",
        required: true,
        restrictToProject: false,
        allowManual: true
      }
    ]
  });

  if (!dialogResult.confirmed) {
    return;
  }

  const name = String(dialogResult.values.name || "").trim();
  const projectPath = String(dialogResult.values.path || "").trim();

  if (!name || !projectPath) {
    setStatus("Project name and folder are required.", "error");
    updateStatusView();
    return;
  }

  const response = await fetch(`/api/apps/${state.appType}/projects`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ name, path: projectPath })
  });

  const data = await response.json();
  if (!data.ok) {
    setStatus(data.message || "Failed to create project.", "error");
    updateStatusView();
    return;
  }

  setStatus(`Created project ${data.project.name}.`, "success");
  await loadProjects();
  await openProjectTree(data.project.id);
}

async function handleDeleteProject() {
  if (!state.selectedProject) {
    setStatus("Select a project before deleting.", "info");
    updateStatusView();
    return;
  }

  const dialogResult = await openConfirmDialog({
    title: "Delete Project",
    description: `Remove ${state.selectedProject.name} from this app? Files on disk will not be deleted.`,
    confirmLabel: "Remove",
    tone: "danger"
  });

  if (!dialogResult.confirmed) {
    return;
  }

  const response = await fetch(`/api/apps/${state.appType}/projects/${encodeURIComponent(state.selectedProject.id)}`, {
    method: "DELETE"
  });

  const data = await response.json();
  if (!data.ok) {
    setStatus(data.message || "Failed to delete project.", "error");
    updateStatusView();
    return;
  }

  const removedName = data.project?.name || state.selectedProject.name;
  state.selectedProject = null;
  state.selectedNode = null;
  projectsContainer.classList.remove("tree-open");
  treeTitle.textContent = "Select a project";
  treeContent.innerHTML = '<p class="muted">Select a project to load its structure.</p>';
  setStatus(`Removed project ${removedName}.`, "success");
  await loadProjects();
}

function syncProjectActionButtons() {
  if (deleteProjectBtn) {
    deleteProjectBtn.disabled = !state.selectedProject;
  }
}

async function refreshProjectTree(preferredPath = state.selectedNode?.path || null) {
  if (!state.selectedProject) {
    return;
  }

  const response = await fetch(`/api/apps/${state.appType}/projects/${state.selectedProject.id}/tree`);
  const data = await response.json();

  if (!data.ok) {
    throw new Error(data.message || "Failed to load file structure.");
  }

  state.treeData = data.tree || [];
  const nextSelectedNode = findNodeByPath(preferredPath) || createRootNode();
  state.selectedNode = preferredPath ? nextSelectedNode : null;
  renderFileTree();
}

function renderFileTree() {
  if (!state.selectedProject) {
    treeContent.innerHTML = '<p class="muted">Select a project to load its structure.</p>';
    return;
  }

  const rootNode = createRootNode();
  const graphNodes = [];
  let visualIndex = 0;

  function visit(node, depth = 0, parentPath = null) {
    graphNodes.push({
      ...node,
      depth,
      parentPath,
      visualIndex: visualIndex++
    });

    (node.children || []).forEach((child) => visit(child, depth + 1, node.path));
  }

  visit(rootNode);

  const toolbarHtml = `
    <div class="file-tree-toolbar">
      <button class="file-op-btn" data-op="create">+ Create</button>
      <button class="file-op-btn" data-op="cut" ${state.selectedNode ? "" : "disabled"}>Cut</button>
      <button class="file-op-btn" data-op="copy" ${state.selectedNode ? "" : "disabled"}>Copy</button>
      <button class="file-op-btn" data-op="paste" ${state.clipboard ? "" : "disabled"}>Paste</button>
      <button class="file-op-btn" data-op="delete" ${canDeleteSelectedNode() ? "" : "disabled"}>Delete</button>
      <span class="tree-toolbar-separator"></span>
      <button class="file-op-btn" data-op="zoom-out">-</button>
      <button class="file-op-btn file-op-btn-static" data-op="zoom-reset">${Math.round(state.graphZoom * 100)}%</button>
      <button class="file-op-btn" data-op="zoom-in">+</button>
    </div>
    <div class="tree-status tree-status-${escapeAttribute(state.status.tone)}">${escapeHtml(state.status.text)}</div>
    <div class="file-tree-graph" style="--graph-scale:${state.graphZoom};">
      <div class="graph-canvas">
        <svg class="connection-lines"></svg>
        <div class="graph-nodes"></div>
      </div>
    </div>
  `;

  treeContent.innerHTML = toolbarHtml;

  const graphElement = treeContent.querySelector(".file-tree-graph");
  const svgElement = treeContent.querySelector(".connection-lines");
  const nodesElement = treeContent.querySelector(".graph-nodes");
  const elementByPath = new Map();

  const updateSelectionStyles = (selectedPath) => {
    nodesElement.querySelectorAll(".graph-node.selected").forEach((element) => {
      element.classList.remove("selected");
    });

    if (!selectedPath) {
      return;
    }

    const selectedElement = elementByPath.get(selectedPath);
    if (selectedElement) {
      selectedElement.classList.add("selected");
    }
  };

  graphNodes.forEach((node) => {
    const nodeElement = document.createElement("button");
    nodeElement.type = "button";
    nodeElement.className = `graph-node ${node.type === "folder" ? "folder-node" : "file-node"}${
      state.selectedNode?.path === node.path ? " selected" : ""
    }`;
    nodeElement.style.left = `${node.depth * 220 + 24}px`;
    nodeElement.style.top = `${node.visualIndex * 96 + 24}px`;
    nodeElement.innerHTML = `
      <span class="node-icon">${getNodeIcon(node)}</span>
      <span class="node-name">${escapeHtml(node.name)}</span>
    `;

    nodeElement.addEventListener("click", (event) => {
      event.stopPropagation();
      state.selectedNode = node;
      setStatus(getSelectionHint(node), "info");
      updateSelectionStyles(node.path);
    });

    nodeElement.addEventListener("dblclick", async (event) => {
      event.stopPropagation();
      try {
        await openNode(node.path);
      } catch (error) {
        setStatus(`Could not open ${node.name}: ${error.message}`, "error");
      }
    });

    nodesElement.appendChild(nodeElement);
    elementByPath.set(node.path, nodeElement);
  });

  drawConnections(graphNodes, svgElement, elementByPath);
  wireTreeToolbar();

  graphElement.addEventListener("click", () => {
    state.selectedNode = null;
    setStatus("Select a file or folder to enable actions.", "info");
    updateSelectionStyles(null);
  });
}

function wireTreeToolbar() {
  treeContent.querySelectorAll(".file-op-btn").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      const operation = button.dataset.op;

      if (operation === "create") {
        await handleCreate();
        return;
      }

      if (operation === "cut") {
        handleClipboard("move");
        return;
      }

      if (operation === "copy") {
        handleClipboard("copy");
        return;
      }

      if (operation === "paste") {
        await handlePaste();
        return;
      }

      if (operation === "delete") {
        await handleDelete();
        return;
      }

      if (operation === "zoom-in") {
        adjustGraphZoom(0.1);
        return;
      }

      if (operation === "zoom-out") {
        adjustGraphZoom(-0.1);
        return;
      }

      if (operation === "zoom-reset") {
        state.graphZoom = 1;
        renderFileTree();
      }
    });
  });
}

function adjustGraphZoom(delta) {
  const nextZoom = Math.max(0.4, Math.min(2.2, Number((state.graphZoom + delta).toFixed(2))));

  if (nextZoom === state.graphZoom) {
    return;
  }

  state.graphZoom = nextZoom;
  renderFileTree();
}

async function handleCreate() {
  if (!state.selectedProject) {
    return;
  }

  const dialogResult = await openFormDialog({
    title: "Create Item",
    description: `Create inside ${pathLabel(getCurrentTargetDirectory())}.`,
    confirmLabel: "Create",
    fields: [
      {
        name: "name",
        label: "Name",
        type: "text",
        placeholder: "notes.txt",
        required: true
      },
      {
        name: "nodeType",
        label: "Type",
        type: "select",
        value: state.selectedNode?.type === "folder" ? "folder" : "file",
        options: [
          { value: "file", label: "File" },
          { value: "folder", label: "Folder" }
        ]
      },
      {
        name: "parentPath",
        label: "Destination folder",
        type: "directory",
        value: getCurrentTargetDirectory(),
        required: true,
        allowManual: true
      }
    ]
  });

  if (!dialogResult.confirmed) {
    return;
  }

  const name = String(dialogResult.values.name || "").trim();
  const nodeType = String(dialogResult.values.nodeType || "file") === "folder" ? "folder" : "file";
  const parentPath = String(dialogResult.values.parentPath || "").trim() || getCurrentTargetDirectory();

  if (!name) {
    setStatus("Create cancelled. Name is required.", "error");
    renderFileTree();
    return;
  }

  if (!isPathInsideSelectedProject(parentPath)) {
    setStatus("Create destination must be inside the selected project.", "error");
    renderFileTree();
    return;
  }

  const result = await postProjectAction("create", {
    parentPath,
    name,
    nodeType
  });

  state.selectedNode = result.node;
  setStatus(`${nodeType === "folder" ? "Folder" : "File"} created: ${result.node.name}`, "success");
  await refreshProjectTree(result.path);
}

function handleClipboard(mode) {
  if (!state.selectedNode) {
    return;
  }

  state.clipboard = {
    mode,
    path: state.selectedNode.path,
    sourceProjectId: state.selectedProject.id
  };

  setStatus(`${mode === "move" ? "Cut" : "Copied"} ${state.selectedNode.name}.`, "success");
  renderFileTree();
}

async function handlePaste() {
  if (!state.clipboard || !state.selectedProject) {
    return;
  }

  if (state.clipboard.sourceProjectId !== state.selectedProject.id) {
    setStatus("Paste is limited to the currently open project.", "error");
    renderFileTree();
    return;
  }

  const action = state.clipboard.mode === "move" ? "move" : "copy";
  const result = await postProjectAction(action, {
    sourcePath: state.clipboard.path,
    destinationPath: getCurrentTargetDirectory()
  });

  if (action === "move") {
    state.clipboard = null;
  }

  state.selectedNode = result.node;
  setStatus(`${action === "move" ? "Moved" : "Copied"} ${result.node.name}.`, "success");
  await refreshProjectTree(result.path);
}

async function handleDelete() {
  if (!state.selectedNode || !canDeleteSelectedNode()) {
    return;
  }

  const dialogResult = await openConfirmDialog({
    title: "Delete Item",
    description: `Delete ${state.selectedNode.name}? This action cannot be undone.`,
    confirmLabel: "Delete",
    tone: "danger"
  });

  if (!dialogResult.confirmed) {
    return;
  }

  const targetPath = state.selectedNode.path;
  await postProjectAction("delete", { targetPath });
  state.selectedNode = null;
  setStatus(`Deleted ${pathLabel(targetPath)}.`, "success");
  await refreshProjectTree();
}

async function openNode(targetPath) {
  const result = await postProjectAction("open", { targetPath });
  setStatus(result.message || `Opened ${pathLabel(targetPath)}.`, "success");
  renderFileTree();
}

async function postProjectAction(action, payload) {
  const response = await fetch(`/api/apps/${state.appType}/projects/${state.selectedProject.id}/files/${action}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const data = await response.json();
  if (!data.ok) {
    setStatus(data.message || `Project action '${action}' failed.`, "error");
    renderFileTree();
    throw new Error(data.message || `Project action '${action}' failed.`);
  }

  return data;
}

async function launchTool(toolName) {
  try {
    const response = await fetch(`/api/apps/${state.appType}/launch-tool`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ tool: toolName })
    });
    const data = await response.json();
    setStatus(data.message || `Tool action for ${toolName} completed.`, data.ok ? "success" : "error");
    if (state.selectedProject) {
      renderFileTree();
    }
  } catch (error) {
    setStatus(`Failed to launch ${toolName}: ${error.message}`, "error");
    if (state.selectedProject) {
      renderFileTree();
    }
  }
}

function drawConnections(graphNodes, svgElement, elementByPath) {
  const width = Math.max(...graphNodes.map((node) => node.depth * 220 + 200), 280);
  const height = Math.max(...graphNodes.map((node) => node.visualIndex * 96 + 120), 220);
  const graphElement = svgElement.closest(".file-tree-graph");
  if (graphElement) {
    graphElement.style.setProperty("--graph-width", `${width}px`);
    graphElement.style.setProperty("--graph-height", `${height}px`);
  }

  svgElement.setAttribute("width", String(width));
  svgElement.setAttribute("height", String(height));
  svgElement.innerHTML = `
    <defs>
      <marker id="arrowhead" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
        <path d="M0,0 L0,6 L9,3 z" fill="var(--accent)"></path>
      </marker>
    </defs>
  `;

  graphNodes.forEach((node) => {
    if (!node.parentPath) {
      return;
    }

    const parentElement = elementByPath.get(node.parentPath);
    const childElement = elementByPath.get(node.path);
    if (!parentElement || !childElement) {
      return;
    }

    const startX = parseFloat(parentElement.style.left) + 168;
    const startY = parseFloat(parentElement.style.top) + 36;
    const endX = parseFloat(childElement.style.left);
    const endY = parseFloat(childElement.style.top) + 36;
    const midX = (startX + endX) / 2;

    const pathElement = document.createElementNS("http://www.w3.org/2000/svg", "path");
    pathElement.setAttribute("d", `M ${startX} ${startY} C ${midX} ${startY}, ${midX} ${endY}, ${endX} ${endY}`);
    pathElement.setAttribute("fill", "none");
    pathElement.setAttribute("stroke", "var(--accent)");
    pathElement.setAttribute("stroke-width", "1.5");
    pathElement.setAttribute("marker-end", "url(#arrowhead)");
    svgElement.appendChild(pathElement);
  });
}

function createRootNode() {
  return {
    name: state.selectedProject.name,
    path: state.selectedProject.path,
    type: "folder",
    children: state.treeData,
    isRoot: true
  };
}

function findNodeByPath(targetPath, nodes = state.treeData) {
  if (!targetPath || !state.selectedProject) {
    return null;
  }

  if (targetPath === state.selectedProject.path) {
    return createRootNode();
  }

  for (const node of nodes) {
    if (node.path === targetPath) {
      return node;
    }

    const childMatch = findNodeByPath(targetPath, node.children || []);
    if (childMatch) {
      return childMatch;
    }
  }

  return null;
}

function getCurrentTargetDirectory() {
  if (!state.selectedProject) {
    return null;
  }

  if (!state.selectedNode) {
    return state.selectedProject.path;
  }

  if (state.selectedNode.type === "folder") {
    return state.selectedNode.path;
  }

  return getParentPath(state.selectedNode.path);
}

function getParentPath(targetPath) {
  return String(targetPath || "").replace(/[\\/][^\\/]+$/, "") || state.selectedProject.path;
}

function normalizePathForCompare(targetPath) {
  return String(targetPath || "")
    .replace(/[\\/]+/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();
}

function isPathInsideSelectedProject(targetPath) {
  if (!state.selectedProject?.path || !targetPath) {
    return false;
  }

  const rootPath = normalizePathForCompare(state.selectedProject.path);
  const candidatePath = normalizePathForCompare(targetPath);

  return candidatePath === rootPath || candidatePath.startsWith(`${rootPath}/`);
}

function canDeleteSelectedNode() {
  return Boolean(state.selectedNode && state.selectedNode.path !== state.selectedProject?.path);
}

function getSelectionHint(node) {
  if (!node) {
    return "Select a file or folder to enable actions.";
  }

  if (node.path === state.selectedProject?.path) {
    return "Project root selected. Create and paste will target the project root.";
  }

  if (node.type === "folder") {
    return `${node.name} selected. Create and paste will target this folder.`;
  }

  return `${node.name} selected. Double-click to open it.`;
}

function setStatus(text, tone = "info") {
  state.status = { tone, text };
  updateStatusView();
}

function updateStatusView() {
  const statusElement = treeContent.querySelector(".tree-status");
  if (!statusElement) {
    return;
  }

  statusElement.className = `tree-status tree-status-${escapeAttribute(state.status.tone)}`;
  statusElement.textContent = state.status.text;
}

async function pickDirectory(defaultPath = "") {
  const desktopBridge = getDesktopBridge();
  const chooseDirectory = desktopBridge?.chooseDirectory;

  if (typeof chooseDirectory === "function") {
    try {
      const result = await chooseDirectory(defaultPath);
      if (!result?.ok) {
        setStatus(result?.message || "Could not open folder picker.", "error");
        updateStatusView();
        return null;
      }

      if (result.canceled) {
        return null;
      }

      return typeof result.path === "string" ? result.path : null;
    } catch (error) {
      setStatus(`Could not open folder picker: ${error.message}`, "error");
      updateStatusView();
    }
  }

  const apiResult = await chooseDirectoryViaApi(defaultPath);
  if (apiResult) {
    return apiResult;
  }

  setStatus("Desktop folder picker is unavailable here. Type the folder path manually.", "info");
  updateStatusView();
  return null;
}

async function chooseDirectoryViaApi(defaultPath = "") {
  try {
    const response = await fetch("/api/system/choose-directory", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ defaultPath })
    });

    const data = await response.json();
    if (!data.ok) {
      return null;
    }

    if (data.canceled) {
      return null;
    }

    return typeof data.path === "string" ? data.path : null;
  } catch {
    return null;
  }
}

function hasDesktopDirectoryPicker() {
  return typeof getDesktopBridge()?.chooseDirectory === "function";
}

function getDesktopBridge() {
  if (window.controlCenterDesktop) {
    return window.controlCenterDesktop;
  }

  try {
    if (window.parent && window.parent !== window && window.parent.controlCenterDesktop) {
      return window.parent.controlCenterDesktop;
    }

    if (window.top && window.top !== window && window.top.controlCenterDesktop) {
      return window.top.controlCenterDesktop;
    }
  } catch {
    return null;
  }

  return null;
}

function ensureDialogRoot() {
  let dialogRoot = document.getElementById("dialog-root");
  if (dialogRoot) {
    return dialogRoot;
  }

  dialogRoot = document.createElement("div");
  dialogRoot.id = "dialog-root";
  document.body.appendChild(dialogRoot);
  return dialogRoot;
}

function openConfirmDialog({ title, description, confirmLabel = "Confirm", tone = "default" }) {
  return openDialog({
    title,
    description,
    confirmLabel,
    tone,
    fields: []
  });
}

function openFormDialog({ title, description, confirmLabel = "Save", fields = [], tone = "default" }) {
  return openDialog({
    title,
    description,
    confirmLabel,
    tone,
    fields
  });
}

function openDialog({ title, description, confirmLabel, fields, tone }) {
  const dialogRoot = ensureDialogRoot();

  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "dialog-overlay";
    overlay.innerHTML = `
      <div class="dialog-backdrop"></div>
      <div class="dialog-panel dialog-panel-${escapeAttribute(tone)}" role="dialog" aria-modal="true" aria-labelledby="dialog-title" tabindex="-1">
        <div class="dialog-header">
          <h3 id="dialog-title">${escapeHtml(title)}</h3>
          <button type="button" class="dialog-close-btn" aria-label="Close dialog">×</button>
        </div>
        <p class="dialog-description">${escapeHtml(description || "")}</p>
        <form class="dialog-form">
          ${fields.map(renderDialogField).join("")}
          <div class="dialog-actions">
            <button type="button" class="dialog-btn dialog-btn-secondary" data-action="cancel">Cancel</button>
            <button type="submit" class="dialog-btn dialog-btn-primary dialog-btn-${escapeAttribute(tone)}">${escapeHtml(confirmLabel)}</button>
          </div>
        </form>
      </div>
    `;

    dialogRoot.replaceChildren(overlay);

    const form = overlay.querySelector(".dialog-form");
    const panel = overlay.querySelector(".dialog-panel");
    const closeButton = overlay.querySelector(".dialog-close-btn");
    const cancelButton = overlay.querySelector('[data-action="cancel"]');
    const browseButtons = overlay.querySelectorAll(".dialog-browse-btn");
    const firstInput = overlay.querySelector("input, select, textarea, button");

    const cleanup = (result) => {
      document.removeEventListener("keydown", onKeyDown);
      overlay.remove();
      resolve(result);
    };

    const onCancel = () => cleanup({ confirmed: false, values: {} });

    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        onCancel();
      }
    };

    overlay.querySelector(".dialog-backdrop").addEventListener("click", onCancel);
    closeButton.addEventListener("click", onCancel);
    cancelButton.addEventListener("click", onCancel);
    document.addEventListener("keydown", onKeyDown);

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(form).entries());
      cleanup({ confirmed: true, values });
    });

    browseButtons.forEach((button) => {
      button.addEventListener("click", async (event) => {
        event.preventDefault();
        const targetName = button.dataset.target;
        const targetField = targetName ? form.elements.namedItem(targetName) : null;
        if (!targetField || typeof targetField.value !== "string") {
          return;
        }

        const selectedPath = await pickDirectory(targetField.value);
        if (!selectedPath) {
          if (!hasDesktopDirectoryPicker()) {
            targetField.removeAttribute("readonly");
            targetField.focus();
            if (typeof targetField.select === "function") {
              targetField.select();
            }
            setStatus("Type or paste a folder path, then confirm.", "info");
            updateStatusView();
          }
          return;
        }

        const restrictToProject = button.dataset.restrictProject !== "false";
        if (restrictToProject && !isPathInsideSelectedProject(selectedPath)) {
          setStatus("Selected folder must be inside the active project.", "error");
          return;
        }

        targetField.value = selectedPath;
      });
    });

    window.requestAnimationFrame(() => {
      overlay.classList.add("is-visible");
      panel.focus();
      firstInput?.focus();
    });
  });
}

function renderDialogField(field) {
  const name = escapeAttribute(field.name);
  const label = escapeHtml(field.label || field.name);
  const required = field.required ? "required" : "";
  const value = escapeAttribute(field.value || "");

  if (field.type === "select") {
    return `
      <label class="dialog-field">
        <span>${label}</span>
        <select name="${name}" ${required}>
          ${(field.options || [])
            .map((option) => {
              const optionValue = escapeAttribute(option.value);
              const selected = option.value === field.value ? "selected" : "";
              return `<option value="${optionValue}" ${selected}>${escapeHtml(option.label)}</option>`;
            })
            .join("")}
        </select>
      </label>
    `;
  }

  if (field.type === "directory") {
    const restrictToProject = field.restrictToProject !== false;
    const readOnly = field.allowManual ? "" : "readonly";
    return `
      <label class="dialog-field">
        <span>${label}</span>
        <div class="dialog-directory-row">
          <input type="text" name="${name}" value="${value}" placeholder="Choose a folder" ${required} ${readOnly} />
          <button type="button" class="dialog-btn dialog-btn-secondary dialog-browse-btn" data-target="${name}" data-restrict-project="${restrictToProject}">Choose Folder</button>
        </div>
      </label>
    `;
  }

  return `
    <label class="dialog-field">
      <span>${label}</span>
      <input type="${escapeAttribute(field.type || "text")}" name="${name}" value="${value}" placeholder="${escapeAttribute(field.placeholder || "")}" ${required} />
    </label>
  `;
}

function getNodeIcon(node) {
  if (node.isRoot || node.type === "folder") {
    return "📁";
  }

  const lowerName = node.name.toLowerCase();
  if (lowerName.endsWith(".js")) return "JS";
  if (lowerName.endsWith(".ts")) return "TS";
  if (lowerName.endsWith(".json")) return "{}";
  if (lowerName.endsWith(".css")) return "#";
  if (lowerName.endsWith(".html")) return "<>";
  if (lowerName.endsWith(".py")) return "PY";
  if (lowerName.endsWith(".md")) return "MD";
  if (/(png|jpg|jpeg|gif|webp|svg)$/.test(lowerName)) return "IMG";
  return "FILE";
}

function pathLabel(targetPath) {
  const segments = String(targetPath || "").split(/[/\\]+/).filter(Boolean);
  return segments[segments.length - 1] || targetPath;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttribute(value) {
  return escapeHtml(value);
}

closeTreeBtn.addEventListener("click", () => {
  projectsContainer.classList.remove("tree-open");
  state.selectedProject = null;
  state.selectedNode = null;
  renderProjects();
  treeTitle.textContent = "Select a project";
  treeContent.innerHTML = '<p class="muted">Select a project to load its structure.</p>';
});

toolButtons.forEach((button) => {
  button.addEventListener("click", () => {
    launchTool(button.dataset.tool);
  });
});

createProjectBtn?.addEventListener("click", () => {
  handleCreateProject().catch((error) => {
    setStatus(`Failed to create project: ${error.message}`, "error");
    updateStatusView();
  });
});

deleteProjectBtn?.addEventListener("click", () => {
  handleDeleteProject().catch((error) => {
    setStatus(`Failed to delete project: ${error.message}`, "error");
    updateStatusView();
  });
});

loadProjects().catch((error) => {
  setStatus(`Failed to initialize: ${error.message}`, "error");
  renderFileTree();
});