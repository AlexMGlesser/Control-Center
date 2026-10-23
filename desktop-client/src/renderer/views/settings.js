import { confirmDialog, dialog, el, esc, toast } from "../lib.js";
import { frame } from "./frame.js";

// Settings: connection, this computer, notifications, security, music, about.

const REMIND_OPTIONS = [
  [0, "At start"],
  [5, "5 min before"],
  [10, "10 min before"],
  [15, "15 min before"],
  [30, "30 min before"]
];

export async function render(host, ctx) {
  const view = frame(host, { title: "Settings" });
  const [settings, info] = await Promise.all([window.cc.settings.get(), window.cc.info()]);
  const session = ctx.state.session;
  const connection = ctx.state.connection;
  const status =
    connection.status === "connected"
      ? "Online"
      : connection.status === "disconnected"
        ? `Offline: ${connection.cause}`
        : connection.status === "idle"
          ? "Offline"
          : "Reconnecting…";

  const toggle = (key, title, detail) => `
    <label class="row" style="cursor:pointer">
      <div class="grow"><div>${esc(title)}</div><div class="muted small">${esc(detail)}</div></div>
      <input type="checkbox" class="switch" data-key="${key}" ${settings[key] ? "checked" : ""} />
    </label>`;
  const infoRow = (label, value) => `<div class="row" style="cursor:default"><span class="grow muted">${esc(label)}</span><span>${esc(value)}</span></div>`;

  view.content.append(
    el(`
    <div style="max-width:640px">
      <div class="section-label">Connection</div>
      ${infoRow("Home PC", session.serverName)}
      ${infoRow("Address", session.baseUrl.replace(/^https?:\/\//, ""))}
      ${infoRow("Status", status)}
      ${toggle("keepRunningInTray", "Keep running in the tray", "Closing the window keeps the connection, notifications, alarms and music going.")}
      ${toggle("startAtLogin", "Start when I sign in", "Opens in the tray, so reminders and alarms work without opening it.")}

      <div class="section-label">This computer</div>
      ${infoRow("Name", session.deviceName)}
      ${infoRow("Paired", new Date(session.pairedAt).toLocaleDateString([], { dateStyle: "medium" }))}
      ${infoRow("Token storage", ctx.state.tokenEncrypted ? "Encrypted by the OS keychain" : "File readable only by you (no keychain found)")}

      <div class="section-label">Notifications</div>
      ${toggle("calendarReminders", "Calendar reminders", "A notification when an event is about to start.")}
      <div class="row" style="cursor:default" ${settings.calendarReminders ? "" : "hidden"} id="remind-row">
        <span class="grow">Remind me</span>
        <select id="remind">${REMIND_OPTIONS.map(([value, label]) => `<option value="${value}" ${value === settings.remindMinutes ? "selected" : ""}>${label}</option>`).join("")}</select>
      </div>
      ${toggle("connectionAlerts", "Connection alerts", "When the connection to the PC is lost or comes back.")}
      ${toggle("jarvisReplies", "Jarvis replies", "When Jarvis answers while this window isn't in front.")}

      <div class="section-label">Security</div>
      ${toggle(
        "lockFileSystem",
        "Lock File System",
        info.platform === "win32" ? "Ask for Windows Hello (or your File System PIN) before showing the PC's files." : "Ask for your File System PIN before showing the PC's files."
      )}
      <div class="row" style="cursor:default">
        <span class="grow">File System PIN <span class="muted small">${settings.hasPin ? "· set" : "· not set"}</span></span>
        <button class="btn small" id="set-pin">${settings.hasPin ? "Change PIN" : "Set PIN"}</button>
      </div>

      <div class="section-label">Music</div>
      ${toggle("musicOnPc", "Play music on the PC", "Off: music plays on this computer. On: this is a remote for the PC's speakers.")}

      <div class="section-label">About</div>
      ${infoRow("Control Center Remote", info.version)}
      <div style="margin-top:24px"><button class="btn danger" id="sign-out">Sign out of this computer</button></div>
    </div>`)
  );

  for (const input of view.content.querySelectorAll("[data-key]")) {
    input.addEventListener("change", async () => {
      try {
        await window.cc.settings.update({ [input.dataset.key]: input.checked });
        if (input.dataset.key === "calendarReminders") view.content.querySelector("#remind-row").hidden = !input.checked;
      } catch (error) {
        toast(error.message, { tone: "error" });
      }
    });
  }
  view.content.querySelector("#remind").addEventListener("change", (event) => {
    window.cc.settings.update({ remindMinutes: Number(event.target.value) });
  });
  view.content.querySelector("#set-pin").addEventListener("click", async () => {
    const values = await dialog({
      title: "File System PIN",
      text: "4 to 12 digits. It unlocks File System on this computer.",
      ok: "Save",
      fields: [{ name: "pin", label: "PIN", type: "password" }]
    });
    if (!values) return;
    try {
      await window.cc.lock.setPin(values.pin);
      toast("PIN saved.");
      ctx.selectTab("settings");
    } catch (error) {
      toast(error.message, { tone: "error" });
    }
  });
  view.content.querySelector("#sign-out").addEventListener("click", async () => {
    if (!(await confirmDialog("Sign out?", "This computer will be removed from Control Center and will need to pair again.", "Sign out", true))) return;
    await window.cc.session.signOut();
    location.reload();
  });
}
