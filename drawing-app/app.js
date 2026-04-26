import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { STLExporter } from "three/addons/exporters/STLExporter.js";

const state = {
  files: [],
  selectedFileId: null,
  activeFile: null,
  createLocationPath: "",
  mode: "files",
  tool: "pen",
  color: "#00d4ff",
  opacity: 1,
  size: 4,
  drawing: false,
  startX: 0,
  startY: 0,
  lastX: 0,
  lastY: 0,
  baseSnapshot: null,
  pendingTextPosition: null
};

const elements = {
  fileManager: document.getElementById("file-manager"),
  createFlow: document.getElementById("create-flow"),
  editor2d: document.getElementById("editor-2d"),
  editor3d: document.getElementById("editor-3d"),
  filesList: document.getElementById("files-list"),
  fileCountPill: document.getElementById("file-count-pill"),
  statusLine: document.getElementById("status-line"),
  newFileBtn: document.getElementById("new-file-btn"),
  openFileBtn: document.getElementById("open-file-btn"),
  deleteFileBtn: document.getElementById("delete-file-btn"),
  backToFilesBtn: document.getElementById("back-to-files-btn"),
  confirmCreateBtn: document.getElementById("confirm-create-btn"),
  cancelCreateBtn: document.getElementById("cancel-create-btn"),
  newFileName: document.getElementById("new-file-name"),
  saveLocationInput: document.getElementById("save-location-input"),
  chooseLocationBtn: document.getElementById("choose-location-btn"),
  textEntryPanel: document.getElementById("text-entry-panel"),
  textEntryInput: document.getElementById("text-entry-input"),
  textEntryApplyBtn: document.getElementById("text-entry-apply-btn"),
  textEntryCancelBtn: document.getElementById("text-entry-cancel-btn"),
  editor2dTitle: document.getElementById("editor-2d-title"),
  editor3dTitle: document.getElementById("editor-3d-title"),
  save2dBtn: document.getElementById("save-2d-btn"),
  clear2dBtn: document.getElementById("clear-2d-btn"),
  strokeColor: document.getElementById("stroke-color"),
  strokeOpacity: document.getElementById("stroke-opacity"),
  strokeSize: document.getElementById("stroke-size"),
  opacityValue: document.getElementById("opacity-value"),
  sizeValue: document.getElementById("size-value"),
  canvas: document.getElementById("draw-canvas")
};

const context = elements.canvas.getContext("2d");

const three3d = {
  initialized: false,
  scene: null,
  camera: null,
  renderer: null,
  orbitControls: null,
  transformControls: null,
  objects: [],
  selectedObject: null,
  transformMode: "translate",
  animFrameId: null,
  resizeObserver: null,
  mouseDownPos: null,
  suppressNextClick: false
};

function setStatus(message) {
  elements.statusLine.textContent = String(message || "").trim() || "Ready.";
}

async function apiRequest(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json();
  return {
    ok: response.ok,
    payload
  };
}

function formatDate(value) {
  const time = Date.parse(String(value || ""));
  if (!Number.isFinite(time)) {
    return "unknown";
  }

  return new Date(time).toLocaleString();
}

function setMode(mode) {
  state.mode = mode;
  elements.fileManager.classList.toggle("hidden", mode !== "files");
  elements.createFlow.classList.toggle("hidden", mode !== "create");
  elements.editor2d.classList.toggle("hidden", mode !== "editor-2d");
  elements.editor3d.classList.toggle("hidden", mode !== "editor-3d");
  elements.backToFilesBtn.classList.toggle("hidden", mode === "files" || mode === "create");
}

function updateSelectionActions() {
  const hasSelection = Number.isFinite(state.selectedFileId) && state.selectedFileId > 0;
  elements.openFileBtn.disabled = !hasSelection;
  elements.deleteFileBtn.disabled = !hasSelection;
}

function renderFiles() {
  const files = Array.isArray(state.files) ? state.files : [];
  elements.fileCountPill.textContent = `${files.length} file${files.length === 1 ? "" : "s"}`;

  if (!files.length) {
    elements.filesList.innerHTML = '<li class="file-item"><span class="file-name">No drawing files yet. Create your first file.</span></li>';
    updateSelectionActions();
    return;
  }

  elements.filesList.innerHTML = files
    .map((file) => {
      const selectedClass = file.id === state.selectedFileId ? "is-selected" : "";
      return `
        <li class="file-item ${selectedClass}" data-file-id="${file.id}">
          <span class="file-mode">${file.mode}</span>
          <div>
            <div class="file-name">${escapeHtml(file.name)}</div>
            <div class="file-meta">Updated ${escapeHtml(formatDate(file.updatedAt))}</div>
            <div class="file-meta">${escapeHtml(file.locationPath || "Default location")}</div>
          </div>
          <span class="file-meta">#${file.id}</span>
        </li>
      `;
    })
    .join("");

  updateSelectionActions();
}

function syncCreateLocationUI() {
  elements.saveLocationInput.value = state.createLocationPath || "";
}

function openTextEntry(x, y) {
  state.pendingTextPosition = { x, y };
  elements.textEntryInput.value = "";
  elements.textEntryPanel.classList.remove("hidden");
  elements.textEntryInput.focus();
}

function closeTextEntry() {
  state.pendingTextPosition = null;
  elements.textEntryInput.value = "";
  elements.textEntryPanel.classList.add("hidden");
}

function applyTextEntry() {
  const text = String(elements.textEntryInput.value || "").trim();
  if (!text || !state.pendingTextPosition) {
    closeTextEntry();
    return;
  }

  configureContext();
  context.font = `${Math.max(12, state.size * 4)}px Bahnschrift, Segoe UI, sans-serif`;
  context.fillText(text, state.pendingTextPosition.x, state.pendingTextPosition.y);
  closeTextEntry();
}

async function chooseSaveLocation() {
  if (window.controlCenterDesktop?.runtime === "electron" && window.controlCenterDesktop.chooseDirectory) {
    try {
      const result = await window.controlCenterDesktop.chooseDirectory(state.createLocationPath || undefined);
      if (result?.ok && !result?.canceled && result?.path) {
        state.createLocationPath = String(result.path).trim();
        syncCreateLocationUI();
        setStatus("Save location selected.");
        return;
      }

      if (result?.ok && result?.canceled) {
        setStatus("Folder selection canceled.");
        return;
      }

      if (result?.message) {
        setStatus(result.message);
      }
    } catch (error) {
      setStatus(error?.message || "Desktop folder picker was unavailable.");
    }
  }

  const apiPicker = await apiRequest("/api/system/choose-directory", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ defaultPath: state.createLocationPath || undefined })
  });

  if (apiPicker.ok && apiPicker.payload?.ok && !apiPicker.payload?.canceled && apiPicker.payload?.path) {
    state.createLocationPath = String(apiPicker.payload.path).trim();
    syncCreateLocationUI();
    setStatus("Save location selected.");
    return;
  }

  if (apiPicker.payload?.ok && apiPicker.payload?.canceled) {
    setStatus("Folder selection canceled.");
    return;
  }

  if (apiPicker.payload?.message) {
    setStatus(`${apiPicker.payload.message} Type the folder path directly in the save location field if needed.`);
    return;
  }

  setStatus("No save location was selected. Type the folder path directly if needed.");
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function loadFiles() {
  const result = await apiRequest("/api/apps/drawing-app/files");
  if (!result.ok || !result.payload?.ok) {
    setStatus(result.payload?.message || "Could not load drawing files.");
    return;
  }

  state.files = result.payload.files || [];

  if (!state.files.some((file) => file.id === state.selectedFileId)) {
    state.selectedFileId = state.files[0]?.id || null;
  }

  renderFiles();
}

function getSelectedModeValue() {
  const selected = document.querySelector('input[name="drawing-mode"]:checked');
  return String(selected?.value || "2d");
}

async function createNewFile() {
  const name = String(elements.newFileName.value || "").trim();
  const mode = getSelectedModeValue();

  if (!name) {
    setStatus("Enter a file name first.");
    return;
  }

  const result = await apiRequest("/api/apps/drawing-app/files", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      name,
      mode,
      locationPath: state.createLocationPath
    })
  });

  if (!result.ok || !result.payload?.ok) {
    setStatus(result.payload?.message || "Could not create drawing file.");
    return;
  }

  const created = result.payload.file;
  state.selectedFileId = created.id;
  await loadFiles();
  setStatus(`Created ${created.name} (${created.mode.toUpperCase()}) at ${created.locationPath || "default location"}.`);
  await openFileById(created.id);
}

async function deleteSelectedFile() {
  if (!state.selectedFileId) {
    setStatus("Select a file first.");
    return;
  }

  const target = state.files.find((file) => file.id === state.selectedFileId);
  if (!target) {
    setStatus("Selected file was not found.");
    return;
  }

  const confirmed = window.confirm(`Delete '${target.name}'?`);
  if (!confirmed) {
    return;
  }

  const result = await apiRequest(`/api/apps/drawing-app/files/${target.id}`, {
    method: "DELETE"
  });

  if (!result.ok || !result.payload?.ok) {
    setStatus(result.payload?.message || "Could not delete drawing file.");
    return;
  }

  setStatus(`Deleted ${target.name}.`);
  state.selectedFileId = null;
  await loadFiles();
}

async function openSelectedFile() {
  if (!state.selectedFileId) {
    setStatus("Select a file first.");
    return;
  }

  await openFileById(state.selectedFileId);
}

async function openFileById(fileId) {
  const result = await apiRequest(`/api/apps/drawing-app/files/${fileId}`);
  if (!result.ok || !result.payload?.ok) {
    setStatus(result.payload?.message || "Could not open drawing file.");
    return;
  }

  const file = result.payload.file;
  state.activeFile = file;
  state.selectedFileId = file.id;
  renderFiles();

  if (file.mode === "2d") {
    elements.editor2dTitle.textContent = `2D Editor - ${file.name}`;
    setMode("editor-2d");
    load2dContent(file.content || {});
    setStatus(`Opened ${file.name} in 2D editor.`);
    return;
  }

  elements.editor3dTitle.textContent = `3D Editor - ${file.name}`;
  setMode("editor-3d");
  load3dContent(file.content || {});
  setStatus(`Opened ${file.name} in 3D editor.`);
}

function toCanvasPoint(event) {
  const rect = elements.canvas.getBoundingClientRect();
  const scaleX = elements.canvas.width / rect.width;
  const scaleY = elements.canvas.height / rect.height;
  return {
    x: (event.clientX - rect.left) * scaleX,
    y: (event.clientY - rect.top) * scaleY
  };
}

function getStrokeColor() {
  const color = state.color;
  const alpha = Math.max(0.05, Math.min(1, state.opacity));
  const r = parseInt(color.slice(1, 3), 16);
  const g = parseInt(color.slice(3, 5), 16);
  const b = parseInt(color.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function configureContext() {
  context.lineCap = "round";
  context.lineJoin = "round";
  context.strokeStyle = getStrokeColor();
  context.fillStyle = getStrokeColor();
  context.lineWidth = state.size;
}

function drawArrow(startX, startY, endX, endY) {
  const headLength = Math.max(10, state.size * 2.4);
  const angle = Math.atan2(endY - startY, endX - startX);

  context.beginPath();
  context.moveTo(startX, startY);
  context.lineTo(endX, endY);
  context.stroke();

  context.beginPath();
  context.moveTo(endX, endY);
  context.lineTo(
    endX - headLength * Math.cos(angle - Math.PI / 6),
    endY - headLength * Math.sin(angle - Math.PI / 6)
  );
  context.lineTo(
    endX - headLength * Math.cos(angle + Math.PI / 6),
    endY - headLength * Math.sin(angle + Math.PI / 6)
  );
  context.closePath();
  context.fill();
}

function drawShape(tool, startX, startY, endX, endY) {
  if (tool === "line") {
    context.beginPath();
    context.moveTo(startX, startY);
    context.lineTo(endX, endY);
    context.stroke();
    return;
  }

  if (tool === "arrow") {
    drawArrow(startX, startY, endX, endY);
    return;
  }

  const width = endX - startX;
  const height = endY - startY;

  if (tool === "rect") {
    context.strokeRect(startX, startY, width, height);
    return;
  }

  if (tool === "ellipse") {
    context.beginPath();
    context.ellipse(
      startX + width / 2,
      startY + height / 2,
      Math.abs(width / 2),
      Math.abs(height / 2),
      0,
      0,
      Math.PI * 2
    );
    context.stroke();
  }
}

function startDrawing(event) {
  if (state.mode !== "editor-2d") {
    return;
  }

  const { x, y } = toCanvasPoint(event);
  state.drawing = true;
  state.startX = x;
  state.startY = y;
  state.lastX = x;
  state.lastY = y;

  configureContext();

  if (state.tool === "pen") {
    context.beginPath();
    context.moveTo(x, y);
    return;
  }

  if (state.tool === "text") {
    state.drawing = false;
    openTextEntry(x, y);
    return;
  }

  state.baseSnapshot = context.getImageData(0, 0, elements.canvas.width, elements.canvas.height);
}

function continueDrawing(event) {
  if (!state.drawing) {
    return;
  }

  const { x, y } = toCanvasPoint(event);
  configureContext();

  if (state.tool === "pen") {
    context.beginPath();
    context.moveTo(state.lastX, state.lastY);
    context.lineTo(x, y);
    context.stroke();
    state.lastX = x;
    state.lastY = y;
    return;
  }

  if (state.baseSnapshot) {
    context.putImageData(state.baseSnapshot, 0, 0);
  }

  drawShape(state.tool, state.startX, state.startY, x, y);
}

function stopDrawing(event) {
  if (!state.drawing) {
    return;
  }

  if (state.tool !== "pen" && state.tool !== "text" && event) {
    const { x, y } = toCanvasPoint(event);
    if (state.baseSnapshot) {
      context.putImageData(state.baseSnapshot, 0, 0);
    }
    configureContext();
    drawShape(state.tool, state.startX, state.startY, x, y);
  }

  state.drawing = false;
  state.baseSnapshot = null;
}

function fitCanvasToContainer() {
  const container = elements.canvas.parentElement;
  const rect = container.getBoundingClientRect();
  const width = Math.max(960, Math.floor(rect.width));
  const height = Math.max(620, Math.floor(window.innerHeight * 0.62));

  if (elements.canvas.width === width && elements.canvas.height === height) {
    return;
  }

  const snapshot = elements.canvas.toDataURL("image/png");
  elements.canvas.width = width;
  elements.canvas.height = height;

  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);

  if (snapshot && snapshot !== "data:,") {
    const image = new Image();
    image.onload = () => {
      context.drawImage(image, 0, 0, width, height);
    };
    image.src = snapshot;
  }
}

function load2dContent(content) {
  fitCanvasToContainer();
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, elements.canvas.width, elements.canvas.height);

  const imageDataUrl = String(content?.imageDataUrl || "").trim();
  if (!imageDataUrl) {
    return;
  }

  const image = new Image();
  image.onload = () => {
    context.drawImage(image, 0, 0, elements.canvas.width, elements.canvas.height);
  };
  image.src = imageDataUrl;
}

// ─── 3D Editor ──────────────────────────────────────────────────────────────

function makeGeometry(type) {
  switch (type) {
    case "sphere":   return new THREE.SphereGeometry(0.65, 32, 16);
    case "cylinder": return new THREE.CylinderGeometry(0.5, 0.5, 1.5, 32);
    case "cone":     return new THREE.ConeGeometry(0.6, 1.5, 32);
    case "torus":    return new THREE.TorusGeometry(0.55, 0.22, 16, 48);
    default:         return new THREE.BoxGeometry(1, 1, 1);
  }
}

function primitiveRestingY(type) {
  switch (type) {
    case "sphere":   return 0.65;
    case "cylinder":
    case "cone":     return 0.75;
    case "torus":    return 0.22;
    default:         return 0.5;
  }
}

function init3dEditor() {
  if (three3d.initialized) return;

  const container = document.getElementById("viewport-3d");

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0c1b25);
  scene.add(new THREE.GridHelper(20, 20, 0x1a3040, 0x152535));
  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.4);
  sun.position.set(5, 10, 7);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0x8899cc, 0.35);
  fill.position.set(-5, 2, -5);
  scene.add(fill);

  const w = container.clientWidth || 900;
  const h = container.clientHeight || 520;
  const camera = new THREE.PerspectiveCamera(50, w / h, 0.1, 1000);
  camera.position.set(8, 6, 10);
  camera.lookAt(0, 0, 0);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(w, h);
  container.appendChild(renderer.domElement);

  const orbitControls = new OrbitControls(camera, renderer.domElement);
  orbitControls.enableDamping = true;
  orbitControls.dampingFactor = 0.08;
  orbitControls.target.set(0, 0.5, 0);

  const transformControls = new TransformControls(camera, renderer.domElement);
  transformControls.setMode("translate");
  transformControls.addEventListener("dragging-changed", (e) => {
    orbitControls.enabled = !e.value;
    if (!e.value) {
      three3d.suppressNextClick = true;
      requestAnimationFrame(() => { three3d.suppressNextClick = false; });
    }
  });
  scene.add(transformControls);

  three3d.scene = scene;
  three3d.camera = camera;
  three3d.renderer = renderer;
  three3d.orbitControls = orbitControls;
  three3d.transformControls = transformControls;
  three3d.initialized = true;

  function animate() {
    three3d.animFrameId = requestAnimationFrame(animate);
    if (state.mode === "editor-3d") {
      orbitControls.update();
      renderer.render(scene, camera);
    }
  }
  animate();

  const ro = new ResizeObserver(() => {
    const rw = container.clientWidth;
    const rh = container.clientHeight;
    if (rw && rh) {
      camera.aspect = rw / rh;
      camera.updateProjectionMatrix();
      renderer.setSize(rw, rh);
    }
  });
  ro.observe(container);
  three3d.resizeObserver = ro;

  renderer.domElement.addEventListener("mousedown", (e) => {
    three3d.mouseDownPos = { x: e.clientX, y: e.clientY };
  });
  renderer.domElement.addEventListener("click", onViewportClick);
}

function clearScene3d() {
  if (!three3d.scene) return;
  deselectObject3d();
  [...three3d.objects].forEach(({ mesh }) => {
    three3d.scene.remove(mesh);
    mesh.geometry.dispose();
    (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).forEach(m => m.dispose());
  });
  three3d.objects = [];
}

function addPrimitive(type) {
  if (!three3d.initialized) return;
  const geometry = makeGeometry(type);
  const color = document.getElementById("object-color")?.value || "#18d6b5";
  const material = new THREE.MeshStandardMaterial({ color });
  const mesh = new THREE.Mesh(geometry, material);

  mesh.position.set(
    (Math.random() - 0.5) * 6,
    primitiveRestingY(type),
    (Math.random() - 0.5) * 6
  );

  const id = `obj_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  mesh.userData.objectId = id;
  mesh.userData.objectType = type;
  three3d.scene.add(mesh);
  three3d.objects.push({ id, type, mesh });

  selectObject3d(mesh);
  renderObjectList();
  setStatus(`Added ${type}.`);
}

function selectObject3d(mesh) {
  if (!three3d.transformControls) return;
  if (three3d.selectedObject === mesh) return;
  deselectObject3d();
  three3d.selectedObject = mesh;
  three3d.transformControls.attach(mesh);

  if (mesh?.material?.emissive) {
    mesh.userData._prevEmissive = mesh.material.emissive.getHex();
    mesh.material.emissive.setHex(0x223344);
  }

  const colorInput = document.getElementById("object-color");
  if (colorInput && mesh?.material?.color) {
    colorInput.value = `#${mesh.material.color.getHexString()}`;
  }

  document.getElementById("delete-object-btn").disabled = false;
  document.getElementById("deselect-object-btn").disabled = false;
  renderObjectList();
}

function deselectObject3d() {
  if (!three3d.transformControls) return;
  if (three3d.selectedObject?.material?.emissive) {
    three3d.selectedObject.material.emissive.setHex(three3d.selectedObject.userData._prevEmissive ?? 0);
  }
  three3d.transformControls.detach();
  three3d.selectedObject = null;
  const del = document.getElementById("delete-object-btn");
  const des = document.getElementById("deselect-object-btn");
  if (del) del.disabled = true;
  if (des) des.disabled = true;
  renderObjectList();
}

function deleteSelectedObject() {
  if (!three3d.selectedObject) return;
  const mesh = three3d.selectedObject;
  const id = mesh.userData.objectId;
  deselectObject3d();
  three3d.scene.remove(mesh);
  mesh.geometry.dispose();
  (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).forEach(m => m.dispose());
  three3d.objects = three3d.objects.filter(o => o.id !== id);
  renderObjectList();
  setStatus("Object deleted.");
}

function setTransformMode(mode) {
  three3d.transformMode = mode;
  three3d.transformControls?.setMode(mode);
  document.querySelectorAll("[data-transform-mode]").forEach(btn => {
    btn.classList.toggle("is-active", btn.dataset.transformMode === mode);
  });
  setStatus(`Transform: ${mode}.`);
}

function onViewportClick(event) {
  if (!three3d.renderer || !three3d.camera) return;
  if (three3d.suppressNextClick) return;

  if (three3d.mouseDownPos) {
    const dx = event.clientX - three3d.mouseDownPos.x;
    const dy = event.clientY - three3d.mouseDownPos.y;
    if (Math.sqrt(dx * dx + dy * dy) > 5) return;
  }

  const rect = three3d.renderer.domElement.getBoundingClientRect();
  const pointer = new THREE.Vector2(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1
  );

  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(pointer, three3d.camera);
  const hits = raycaster.intersectObjects(three3d.objects.map(o => o.mesh), false);

  if (hits.length > 0) {
    selectObject3d(hits[0].object);
  } else {
    deselectObject3d();
  }
}

function serializeScene() {
  return {
    objects: three3d.objects.map(({ id, type, mesh }) => ({
      id,
      type,
      position: mesh.position.toArray(),
      rotation: [mesh.rotation.x, mesh.rotation.y, mesh.rotation.z],
      scale: mesh.scale.toArray(),
      color: `#${mesh.material.color.getHexString()}`
    }))
  };
}

function load3dContent(content) {
  init3dEditor();
  clearScene3d();

  const objects = Array.isArray(content?.objects) ? content.objects : [];
  objects.forEach(obj => {
    try {
      const geometry = makeGeometry(obj.type || "box");
      const material = new THREE.MeshStandardMaterial({ color: obj.color || "#18d6b5" });
      const mesh = new THREE.Mesh(geometry, material);

      if (Array.isArray(obj.position)) mesh.position.fromArray(obj.position);
      if (Array.isArray(obj.rotation)) mesh.rotation.set(obj.rotation[0], obj.rotation[1], obj.rotation[2]);
      if (Array.isArray(obj.scale)) mesh.scale.fromArray(obj.scale);

      mesh.userData.objectId = obj.id;
      mesh.userData.objectType = obj.type;
      three3d.scene.add(mesh);
      three3d.objects.push({ id: obj.id, type: obj.type, mesh });
    } catch (_) { /* skip malformed object */ }
  });

  renderObjectList();
}

async function save3dFile() {
  if (!state.activeFile || state.activeFile.mode !== "3d") {
    setStatus("No active 3D file to save.");
    return;
  }

  const result = await apiRequest(`/api/apps/drawing-app/files/${state.activeFile.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: serializeScene() })
  });

  if (!result.ok || !result.payload?.ok) {
    setStatus(result.payload?.message || "Could not save 3D file.");
    return;
  }

  state.activeFile = result.payload.file;
  await loadFiles();
  setStatus(`Saved ${state.activeFile.name}.`);
}

function exportStl() {
  if (!three3d.scene || !three3d.objects.length) {
    setStatus("No objects to export. Add primitives first.");
    return;
  }

  const exporter = new STLExporter();
  const group = new THREE.Group();
  three3d.objects.forEach(({ mesh }) => {
    const clone = mesh.clone();
    clone.updateMatrixWorld(true);
    group.add(clone);
  });

  const stlString = exporter.parse(group, { binary: false });
  const blob = new Blob([stlString], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const safeName = (state.activeFile?.name || "model").replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
  a.download = `${safeName}.stl`;
  a.href = url;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  setStatus("STL exported.");
}

function renderObjectList() {
  const list = document.getElementById("objects-list");
  const pill = document.getElementById("object-count-pill");
  if (!list) return;

  if (pill) pill.textContent = String(three3d.objects.length);

  if (!three3d.objects.length) {
    list.innerHTML = '<li class="object-item muted">No objects yet. Add a primitive above.</li>';
    return;
  }

  list.innerHTML = three3d.objects.map(({ id, type, mesh }) => {
    const isSelected = three3d.selectedObject === mesh;
    const p = mesh.position;
    return `<li class="object-item ${isSelected ? "is-selected" : ""}" data-object-id="${escapeHtml(id)}">
      <span class="obj-type-badge">${escapeHtml(type)}</span>
      <span class="obj-label">${escapeHtml(type)}<br/><small>(${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)})</small></span>
    </li>`;
  }).join("");
}

// ─── End 3D Editor ───────────────────────────────────────────────────────────

async function save2dFile() {
  if (!state.activeFile || state.activeFile.mode !== "2d") {
    setStatus("No active 2D file to save.");
    return;
  }

  const content = {
    imageDataUrl: elements.canvas.toDataURL("image/png"),
    width: elements.canvas.width,
    height: elements.canvas.height
  };

  const result = await apiRequest(`/api/apps/drawing-app/files/${state.activeFile.id}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ content })
  });

  if (!result.ok || !result.payload?.ok) {
    setStatus(result.payload?.message || "Could not save drawing file.");
    return;
  }

  state.activeFile = result.payload.file;
  await loadFiles();
  setStatus(`Saved ${state.activeFile.name}.`);
}

function clearCanvas() {
  if (state.mode !== "editor-2d") {
    return;
  }

  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, elements.canvas.width, elements.canvas.height);
  setStatus("Canvas cleared.");
}

function bindEvents() {
  elements.newFileBtn.addEventListener("click", () => {
    setMode("create");
    state.createLocationPath = state.createLocationPath || "";
    syncCreateLocationUI();
    setStatus("Choose a file name and mode.");
    elements.newFileName.focus();
  });

  elements.chooseLocationBtn.addEventListener("click", () => {
    chooseSaveLocation().catch(() => {
      setStatus("Could not choose save location.");
    });
  });

  elements.saveLocationInput.addEventListener("input", () => {
    state.createLocationPath = String(elements.saveLocationInput.value || "").trim();
  });

  elements.textEntryApplyBtn.addEventListener("click", applyTextEntry);
  elements.textEntryCancelBtn.addEventListener("click", closeTextEntry);
  elements.textEntryInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      applyTextEntry();
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      closeTextEntry();
    }
  });

  elements.cancelCreateBtn.addEventListener("click", () => {
    setMode("files");
    setStatus("Create canceled.");
  });

  elements.confirmCreateBtn.addEventListener("click", () => {
    createNewFile().catch(() => {
      setStatus("Create file failed.");
    });
  });

  elements.openFileBtn.addEventListener("click", () => {
    openSelectedFile().catch(() => {
      setStatus("Open file failed.");
    });
  });

  elements.deleteFileBtn.addEventListener("click", () => {
    deleteSelectedFile().catch(() => {
      setStatus("Delete file failed.");
    });
  });

  elements.backToFilesBtn.addEventListener("click", () => {
    setMode("files");
    setStatus("Back to file manager.");
  });

  elements.filesList.addEventListener("click", (event) => {
    const item = event.target.closest("[data-file-id]");
    if (!item) {
      return;
    }

    state.selectedFileId = Number(item.dataset.fileId);
    renderFiles();
  });

  elements.save2dBtn.addEventListener("click", () => {
    save2dFile().catch(() => {
      setStatus("Save failed.");
    });
  });

  elements.clear2dBtn.addEventListener("click", clearCanvas);

  document.querySelectorAll("[data-tool]").forEach((button) => {
    button.addEventListener("click", () => {
      state.tool = String(button.dataset.tool || "pen");
      document.querySelectorAll("[data-tool]").forEach((candidate) => {
        candidate.classList.toggle("is-active", candidate === button);
      });
      setStatus(`Tool set to ${state.tool}.`);
    });
  });

  elements.strokeColor.addEventListener("input", () => {
    state.color = elements.strokeColor.value;
  });

  elements.strokeOpacity.addEventListener("input", () => {
    state.opacity = Number(elements.strokeOpacity.value);
    elements.opacityValue.textContent = `${Math.round(state.opacity * 100)}%`;
  });

  elements.strokeSize.addEventListener("input", () => {
    state.size = Number(elements.strokeSize.value);
    elements.sizeValue.textContent = `${state.size}px`;
  });

  elements.canvas.addEventListener("pointerdown", startDrawing);
  elements.canvas.addEventListener("pointermove", continueDrawing);
  elements.canvas.addEventListener("pointerup", stopDrawing);
  elements.canvas.addEventListener("pointerleave", stopDrawing);

  // 3D editor events
  document.querySelectorAll("[data-add-primitive]").forEach(btn => {
    btn.addEventListener("click", () => addPrimitive(btn.dataset.addPrimitive));
  });

  document.querySelectorAll("[data-transform-mode]").forEach(btn => {
    btn.addEventListener("click", () => setTransformMode(btn.dataset.transformMode));
  });

  document.getElementById("delete-object-btn")?.addEventListener("click", deleteSelectedObject);
  document.getElementById("deselect-object-btn")?.addEventListener("click", deselectObject3d);

  document.getElementById("save-3d-btn")?.addEventListener("click", () => {
    save3dFile().catch(() => setStatus("Save failed."));
  });

  document.getElementById("export-stl-btn")?.addEventListener("click", exportStl);

  document.getElementById("object-color")?.addEventListener("input", (e) => {
    if (three3d.selectedObject?.material) {
      three3d.selectedObject.material.color.set(e.target.value);
    }
  });

  document.getElementById("objects-list")?.addEventListener("click", (e) => {
    const item = e.target.closest("[data-object-id]");
    if (!item) return;
    const found = three3d.objects.find(o => o.id === item.dataset.objectId);
    if (found) selectObject3d(found.mesh);
  });

  window.addEventListener("keydown", (e) => {
    if (state.mode === "editor-3d" && (e.key === "Delete" || e.key === "Backspace")) {
      if (!e.target.matches("input, textarea, select")) {
        e.preventDefault();
        deleteSelectedObject();
      }
    }
  });

  window.addEventListener("resize", () => {
    if (state.mode === "editor-2d") {
      fitCanvasToContainer();
    }
  });
}

async function init() {
  bindEvents();
  syncCreateLocationUI();
  setMode("files");
  await loadFiles();
  setStatus("Ready.");
}

init().catch(() => {
  setStatus("Drawing App failed to initialize.");
});
