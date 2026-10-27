const statusPanel = document.getElementById("status-panel");
const statusText = document.getElementById("status-text");
const statusDetail = document.getElementById("status-detail");
const retryButton = document.getElementById("retry-btn");
const frame = document.getElementById("librarian-frame");

// Asks Control Center to start (or reuse) the librarian server, then shows its
// UI. The librarian serves on 127.0.0.1 only, so the iframe points straight at
// it rather than being proxied through Control Center.
async function startArchive() {
  statusText.textContent = "Starting the offline archive…";
  statusDetail.textContent = "";
  retryButton.hidden = true;
  statusPanel.hidden = false;
  frame.hidden = true;

  try {
    const res = await fetch("/api/apps/wikipedia-app/server/start", { method: "POST" });
    const result = await res.json();
    if (!result.ok) {
      showError(result.message || "The archive server could not be started.", result.code);
      return;
    }

    frame.src = result.url;
    frame.hidden = false;
    statusPanel.hidden = true;
  } catch (error) {
    showError("Control Center did not respond.", error?.message);
  }
}

function showError(message, detail) {
  statusText.textContent = message;
  statusDetail.textContent = detail ? `(${detail})` : "";
  retryButton.hidden = false;
}

retryButton.addEventListener("click", startArchive);
startArchive();
