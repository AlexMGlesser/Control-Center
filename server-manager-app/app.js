const STORAGE_KEY = "control-center-server-manager-v1";

const state = {
  servers: [],
  selectedServerId: null,
  configTargetServerId: null
};

const elements = {
  serversGrid: document.getElementById("servers-grid"),
  serverCount: document.getElementById("server-count"),
  selectedServerTitle: document.getElementById("selected-server-title"),
  selectedServerSubtitle: document.getElementById("selected-server-subtitle"),
  addServerBtn: document.getElementById("add-server-btn"),
  connectSshBtn: document.getElementById("connect-ssh-btn"),
  connectTeamViewerBtn: document.getElementById("connect-teamviewer-btn"),
  openConfigBtn: document.getElementById("open-config-btn"),
  statusLine: document.getElementById("status-line"),
  configOverlay: document.getElementById("config-overlay"),
  cfgServerName: document.getElementById("cfg-server-name"),
  cfgSshHost: document.getElementById("cfg-ssh-host"),
  cfgSshUsername: document.getElementById("cfg-ssh-username"),
  cfgSshPort: document.getElementById("cfg-ssh-port"),
  cfgSshKey: document.getElementById("cfg-ssh-key"),
  browseKeyBtn: document.getElementById("browse-key-btn"),
  saveConfigBtn: document.getElementById("save-config-btn"),
  cancelConfigBtn: document.getElementById("cancel-config-btn")
};

function setStatus(message) {
  elements.statusLine.textContent = String(message || "").trim() || "Ready.";
}

function loadServers() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }

    // Drop previously-seeded starter data so only user-defined servers remain.
    return parsed.filter((server) => !String(server?.id || "").startsWith("srv-"));
  } catch {
    return [];
  }
}

function saveServers() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.servers));
}

function getSelectedServer() {
  return state.servers.find((server) => server.id === state.selectedServerId) || null;
}

function updateSelectedPanel() {
  const selected = getSelectedServer();
  const hasSelection = Boolean(selected);

  elements.connectSshBtn.disabled = !hasSelection;
  elements.openConfigBtn.disabled = !hasSelection;

  if (!hasSelection) {
    elements.selectedServerTitle.textContent = "Select a Server";
    elements.selectedServerSubtitle.textContent = "Use Add Server, then configure SSH settings.";
    return;
  }

  elements.selectedServerTitle.textContent = selected.name;
  elements.selectedServerSubtitle.textContent = `${selected.environment} | ${selected.ssh.username || "(no user)"}@${selected.ssh.host || "(no host)"}`;
}

function renderServers() {
  elements.serverCount.textContent = String(state.servers.length);

  if (!state.servers.length) {
    elements.serversGrid.innerHTML = '<article class="server-card"><p class="server-name">No servers yet</p><p class="server-meta">Click Add Server to create one.</p></article>';
    updateSelectedPanel();
    return;
  }

  elements.serversGrid.innerHTML = state.servers
    .map((server) => {
      const selectedClass = server.id === state.selectedServerId ? "is-selected" : "";
      return `
        <article class="server-card ${selectedClass}" data-server-id="${escapeHtml(server.id)}">
          <p class="server-name">${escapeHtml(server.name)}</p>
          <p class="server-meta">${escapeHtml(server.environment)} | ${escapeHtml(server.status)}</p>
          <p class="server-meta">${escapeHtml(server.ssh.username || "(user)")}@${escapeHtml(server.ssh.host || "(host)")}</p>
        </article>
      `;
    })
    .join("");

  updateSelectedPanel();
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function selectServer(serverId) {
  state.selectedServerId = serverId;
  renderServers();
}

function openConfigMenu() {
  const selected = getSelectedServer();
  const isNewServer = !selected;
  state.configTargetServerId = selected?.id || null;

  elements.cfgServerName.value = isNewServer ? "" : selected.name || "";
  elements.cfgSshHost.value = isNewServer ? "" : selected.ssh.host || "";
  elements.cfgSshUsername.value = isNewServer ? "" : selected.ssh.username || "";
  elements.cfgSshPort.value = isNewServer ? "22" : String(selected.ssh.port || 22);
  elements.cfgSshKey.value = isNewServer ? "" : selected.ssh.keyPath || "";
  elements.configOverlay.classList.remove("hidden");
  elements.configOverlay.setAttribute("aria-hidden", "false");
}

function openCreateServerMenu() {
  state.configTargetServerId = null;
  elements.cfgServerName.value = "";
  elements.cfgSshHost.value = "";
  elements.cfgSshUsername.value = "";
  elements.cfgSshPort.value = "22";
  elements.cfgSshKey.value = "";
  elements.configOverlay.classList.remove("hidden");
  elements.configOverlay.setAttribute("aria-hidden", "false");
}

function closeConfigMenu() {
  elements.configOverlay.classList.add("hidden");
  elements.configOverlay.setAttribute("aria-hidden", "true");
  state.configTargetServerId = null;
}

function saveConfig() {
  const selected = state.configTargetServerId
    ? state.servers.find((server) => server.id === state.configTargetServerId) || null
    : null;

  const name = String(elements.cfgServerName.value || "").trim();
  const host = String(elements.cfgSshHost.value || "").trim();
  const username = String(elements.cfgSshUsername.value || "").trim();
  const keyPath = String(elements.cfgSshKey.value || "").trim();
  const portValue = Number(elements.cfgSshPort.value || 22);
  const port = Number.isInteger(portValue) && portValue >= 1 && portValue <= 65535 ? portValue : 22;

  if (selected) {
    selected.name = name || selected.name;
    selected.ssh.host = host;
    selected.ssh.username = username;
    selected.ssh.keyPath = keyPath;
    selected.ssh.port = port;
  } else {
    const newId = `server-${Date.now()}`;
    const created = {
      id: newId,
      name: name || "New Server",
      environment: "Custom",
      status: "running",
      ssh: {
        host,
        username,
        port,
        keyPath
      }
    };
    state.servers.push(created);
    state.selectedServerId = created.id;
  }

  saveServers();
  renderServers();
  closeConfigMenu();
  const saved = getSelectedServer();
  setStatus(`Saved config for ${saved?.name || "server"}.`);
}

async function browseSshKey() {
  if (window.controlCenterDesktop?.runtime === "electron" && window.controlCenterDesktop.chooseFile) {
    try {
      const result = await window.controlCenterDesktop.chooseFile(elements.cfgSshKey.value || undefined);
      if (result?.ok && !result?.canceled && result?.path) {
        elements.cfgSshKey.value = String(result.path).trim();
        setStatus("SSH key selected.");
        return;
      }

      if (result?.message) {
        setStatus(result.message);
      }
    } catch (error) {
      setStatus(error?.message || "Desktop file picker was unavailable.");
    }
  }

  try {
    const response = await fetch("/api/system/choose-file", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ defaultPath: elements.cfgSshKey.value || undefined })
    });
    const payload = await response.json();
    if (response.ok && payload?.ok && !payload?.canceled && payload?.path) {
      elements.cfgSshKey.value = String(payload.path).trim();
      setStatus("SSH key selected.");
      return;
    }

    if (payload?.message) {
      setStatus(payload.message);
    }
  } catch {
    setStatus("File picker unavailable — type the key path directly in the field above.");
  }
}

async function connectViaSsh() {
  const selected = getSelectedServer();
  if (!selected) {
    setStatus("Select a server first.");
    return;
  }

  const host = String(selected.ssh.host || "").trim();
  const username = String(selected.ssh.username || "").trim();
  const keyPath = String(selected.ssh.keyPath || "").trim();
  const port = Number(selected.ssh.port || 22);

  if (!host || !username) {
    setStatus("Set SSH host and username in Config first.");
    openConfigMenu();
    return;
  }

  try {
    const response = await fetch("/api/system/ssh-connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ host, username, keyPath, port })
    });
    const result = await response.json();
    setStatus(result?.message || (response.ok ? `Opening SSH for ${selected.name}.` : "Could not open SSH session."));
  } catch (error) {
    setStatus(error?.message || "Could not open SSH session.");
  }
}

function bindEvents() {
  elements.serversGrid.addEventListener("click", (event) => {
    const card = event.target.closest("[data-server-id]");
    if (!card) {
      return;
    }

    selectServer(String(card.dataset.serverId || ""));
  });

  elements.addServerBtn?.addEventListener("click", openCreateServerMenu);
  elements.openConfigBtn?.addEventListener("click", openConfigMenu);
  elements.cancelConfigBtn?.addEventListener("click", closeConfigMenu);
  elements.saveConfigBtn?.addEventListener("click", saveConfig);
  elements.browseKeyBtn?.addEventListener("click", () => {
    browseSshKey().catch(() => {
      setStatus("Could not browse for SSH key.");
    });
  });

  elements.connectSshBtn?.addEventListener("click", () => {
    connectViaSsh().catch((error) => {
      setStatus(error?.message || "Could not start SSH session.");
    });
  });

  elements.connectTeamViewerBtn?.addEventListener("click", () => {
    setStatus("TeamViewer integration is work in progress.");
  });

  elements.configOverlay?.addEventListener("click", (event) => {
    if (event.target === elements.configOverlay) {
      closeConfigMenu();
    }
  });
}

function init() {
  state.servers = loadServers();
  state.selectedServerId = state.servers[0]?.id || null;
  renderServers();
  bindEvents();
  setStatus(state.servers.length ? "Select a server panel and choose an option." : "No servers loaded. Click Add Server.");
}

init();
