// File System control panel. The app itself is a native Python window run
// by Control Center (fileSystemService.js); this page only launches/stops it
// and shows status.

const API = "/api/apps/file-system-app";
const POLL_MS = 2000;
const SUGGESTED_LABELS = ["select", "back_swipe", "reset_pointer", "scroll_up", "scroll_down", "none"];

const el = (id) => document.getElementById(id);
const feedback = el("feedback");
let busy = false;

async function request(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options
  });
  return res.json();
}

function setFeedback(text) {
  feedback.textContent = text || "";
}

function renderProcess(kind, info) {
  const status = el(`${kind}-status`);
  const output = el(`${kind}-output`);
  const running = Boolean(info?.running);

  status.className = `status ${running ? "ready" : "muted"}`;
  status.textContent = running ? `Running (pid ${info.pid})` : "Stopped";
  el(`${kind}-launch`).disabled = busy || running;
  el(`${kind}-stop`).disabled = busy || !running;

  // Surface the output tail only when something went wrong (non-zero exit
  // that Control Center didn't cause), so a crash isn't silent.
  const lastExit = info?.lastExit;
  const crashed = !running && lastExit && !lastExit.stoppedByControlCenter && lastExit.code !== 0;
  if (crashed && lastExit.outputTail?.length) {
    output.textContent = `Last exit code ${lastExit.code}:\n${lastExit.outputTail.join("\n")}`;
    output.classList.remove("hidden");
  } else {
    output.classList.add("hidden");
  }
}

function renderDataset(dataset, dataDir) {
  const labels = Object.entries(dataset?.labels || {});
  el("dataset-total").textContent = `${dataset?.totalSamples || 0} samples`;
  el("dataset-labels").innerHTML = labels.length
    ? labels.map(([name, count]) => `<li>${escapeHtml(name)}: <strong>${count}</strong></li>`).join("")
    : "<li>No samples recorded yet.</li>";
  el("data-dir").textContent = dataDir || "—";

  const options = new Set([...SUGGESTED_LABELS, ...labels.map(([name]) => name)]);
  el("label-options").innerHTML = [...options].map((name) => `<option value="${escapeHtml(name)}"></option>`).join("");
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}

async function refresh() {
  try {
    const status = await request("/status");
    if (!status.ok) {
      throw new Error(status.message || "Status unavailable.");
    }
    el("version-pill").textContent = `v${status.version}`;
    renderProcess("explorer", status.processes.explorer);
    renderProcess("recorder", status.processes.recorder);
    renderDataset(status.dataset, status.dataDir);
  } catch (error) {
    setFeedback(`Could not reach Control Center: ${error.message}`);
  }
}

async function runAction(label, action) {
  if (busy) {
    return;
  }
  busy = true;
  setFeedback(`${label}…`);
  await refresh();
  try {
    const result = await action();
    setFeedback(result.ok ? `${label}: done.` : `${label} failed: ${result.message || result.code}`);
  } catch (error) {
    setFeedback(`${label} failed: ${error.message}`);
  } finally {
    busy = false;
    await refresh();
  }
}

el("explorer-launch").addEventListener("click", () => {
  runAction("Launching explorer", () => request("/launch", { method: "POST", body: "{}" }));
});

el("explorer-stop").addEventListener("click", () => {
  runAction("Stopping explorer", () => request("/stop", { method: "POST", body: JSON.stringify({ process: "explorer" }) }));
});

el("recorder-launch").addEventListener("click", () => {
  const body = {
    label: el("rec-label").value.trim() || undefined,
    reps: Number(el("rec-reps").value) || undefined,
    duration: Number(el("rec-duration").value) || undefined,
    saveVideo: el("rec-video").checked,
    autostart: el("rec-autostart").checked && Boolean(el("rec-label").value.trim())
  };
  runAction("Starting recorder", () => request("/recorder/launch", { method: "POST", body: JSON.stringify(body) }));
});

el("recorder-stop").addEventListener("click", () => {
  runAction("Stopping recorder", () => request("/stop", { method: "POST", body: JSON.stringify({ process: "recorder" }) }));
});

el("recorder-form").addEventListener("submit", (event) => event.preventDefault());

refresh();
setInterval(() => {
  if (!busy) {
    refresh();
  }
}, POLL_MS);
