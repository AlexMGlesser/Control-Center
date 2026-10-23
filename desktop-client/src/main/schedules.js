import { BrowserWindow, Notification, screen } from "electron";
import path from "path";
import { fileURLToPath } from "url";
import { api } from "./api.js";
import { currentSession, getSettings, readCache, writeCache } from "./store.js";

// Alarms set from this computer ring here, and calendar reminders, the same
// way the phone does them (mobile architecture 7.3): the PC is the source of
// truth, and a copy is kept locally so both still fire when the PC can't be
// reached. A tick checks every few seconds, which also catches up after the
// laptop wakes from sleep.

const TICK_MS = 5_000;
const REMINDER_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
/** After sleep, alarms and reminders this late still fire; older ones are skipped. */
const LATE_LIMIT_MS = 10 * 60 * 1000;
const PRELOAD = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "preload.cjs");

let alarms = readCache("alarms", []); // [{ id, label, fireAtMs }]
let reminders = readCache("reminders", []); // [{ id, title, startMs, endMs }]
let rung = new Set(readCache("rung", []));
const ringWindows = new Map(); // alarmId -> BrowserWindow
let onOpenCalendar = () => {};

function remember(key) {
  rung.add(key);
  rung = new Set([...rung].slice(-200));
  writeCache("rung", [...rung]);
}

/* ---------------- Alarms ---------------- */

/** Mirror the PC's list: this computer's enabled alarms. */
export async function syncAlarms() {
  const session = currentSession();
  if (!session) return;
  const result = await api("/api/alarms").catch(() => null);
  if (!result) return;
  alarms = (result.alarms || [])
    .filter((alarm) => alarm.deviceId === session.deviceId && alarm.enabled !== false && alarm.nextFireAt)
    .map((alarm) => ({ id: alarm.id, label: alarm.label || "Alarm", fireAtMs: Date.parse(alarm.nextFireAt) }))
    .filter((alarm) => Number.isFinite(alarm.fireAtMs));
  writeCache("alarms", alarms);
}

/** Each occurrence rings once, whether from the local tick or the PC's "alarm-fired" backup. */
export function ringAlarm(alarmId, label, fireAtMs) {
  const key = `${alarmId}@${Math.floor(fireAtMs / 60_000)}`;
  if (rung.has(key) || ringWindows.has(alarmId)) return;
  remember(key);

  const { workArea } = screen.getPrimaryDisplay();
  const win = new BrowserWindow({
    width: 420,
    height: 260,
    x: workArea.x + workArea.width - 440,
    y: workArea.y + 20,
    alwaysOnTop: true,
    frame: false,
    resizable: false,
    skipTaskbar: false,
    backgroundColor: "#07070d",
    title: label,
    webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true, backgroundThrottling: false }
  });
  win.setAlwaysOnTop(true, "screen-saver");
  win.loadURL(`cc://app/alarm.html?id=${encodeURIComponent(alarmId)}&label=${encodeURIComponent(label)}`);
  win.on("closed", () => ringWindows.delete(alarmId));
  ringWindows.set(alarmId, win);
}

/** Stop pressed here: close it and tell the PC (so other screens stop tracking it). */
export async function stopAlarm(alarmId) {
  ringWindows.get(alarmId)?.close();
  await api(`/api/alarms/${encodeURIComponent(alarmId)}/stop`, { method: "POST", body: {} }).catch(() => {});
}

/** Stopped somewhere else (the PC): just close it here. */
export function closeAlarm(alarmId) {
  ringWindows.get(alarmId)?.close();
}

/* ---------------- Calendar reminders ---------------- */

export async function refreshReminders() {
  if (!currentSession()) return;
  const now = Date.now();
  const start = new Date(now).toISOString();
  const end = new Date(now + REMINDER_WINDOW_MS).toISOString();
  const result = await api(`/api/apps/calendar-app/events?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&limit=500`).catch(() => null);
  if (!result) return;
  reminders = (result.events || [])
    .map((event) => ({ id: event.id, title: event.title, startMs: Date.parse(event.startAt), endMs: Date.parse(event.endAt) }))
    .filter((event) => Number.isFinite(event.startMs));
  writeCache("reminders", reminders);
}

function timeLabel(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function remind(event, leadMinutes) {
  const minutesAway = Math.round((event.startMs - Date.now()) / 60_000);
  const when = minutesAway <= 0 ? "starts now" : `in ${minutesAway} min`;
  if (!Notification.isSupported()) return;
  const notification = new Notification({
    title: `${event.title} · ${when}`,
    body: `${timeLabel(event.startMs)} – ${timeLabel(event.endMs || event.startMs)}`,
    urgency: "critical",
    timeoutType: "never"
  });
  notification.on("click", () => onOpenCalendar());
  notification.show();
  remember(`reminder:${event.id}:${event.startMs}:${leadMinutes}`);
}

/* ---------------- The tick ---------------- */

function tick() {
  const now = Date.now();
  for (const alarm of alarms) {
    if (alarm.fireAtMs <= now && now - alarm.fireAtMs < LATE_LIMIT_MS) ringAlarm(alarm.id, alarm.label, alarm.fireAtMs);
  }
  const settings = getSettings();
  if (!settings.calendarReminders) return;
  const leadMs = settings.remindMinutes * 60_000;
  for (const event of reminders) {
    const due = event.startMs - leadMs;
    if (due <= now && now - due < LATE_LIMIT_MS && !rung.has(`reminder:${event.id}:${event.startMs}:${settings.remindMinutes}`)) {
      remind(event, settings.remindMinutes);
    }
  }
}

export function startSchedules({ openCalendar }) {
  onOpenCalendar = openCalendar;
  setInterval(tick, TICK_MS);
  // Calendar changes made while offline are picked up within 6 hours.
  setInterval(() => refreshReminders(), 6 * 60 * 60 * 1000);
  tick();
}

export function clearSchedules() {
  alarms = [];
  reminders = [];
  writeCache("alarms", alarms);
  writeCache("reminders", reminders);
  for (const win of ringWindows.values()) win.close();
}
