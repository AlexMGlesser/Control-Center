import { readRuntimeSection, writeRuntimeSection } from "./runtimePersistenceService.js";
import { getCalendarTimeZone, getZonedParts, zonedPartsToUtcMs, getRemainingCalendarEvents } from "./calendarService.js";
import { getNewsBriefing, formatNewsSummary } from "./newsService.js";
import { publishEvent } from "./eventBus.js";
import { addAgentMessage } from "./chatService.js";
import { broadcastSpokenMessage } from "./voiceService.js";

const CALENDAR_TIMEZONE = getCalendarTimeZone();
const CHECK_INTERVAL_MS = 15000;
const MISSED_ALARM_GRACE_MS = 5 * 60 * 1000;
const WEEKDAY_CODES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

let nextId = 1;
let alarms = loadAlarms();
const ringingAlarmIds = new Set();
let checkTimer = null;
let preciseTimer = null;

// Relative alarms ("in 30 seconds", "a 2 minute alarm") are capped at a week.
const MAX_RELATIVE_SECONDS = 7 * 24 * 60 * 60;

/**
 * Creates an alarm. Either `time` (local HH:mm, with optional `date` and
 * recurrence) or `inSeconds` (fires that many seconds from now, once).
 * `device` ({ id, kind, name }) is where it was asked from: an alarm set from
 * a paired phone rings on that phone, one set on the PC rings on the PC.
 */
export function createAlarm({ time, date, recurrence = "once", daysOfWeek = [], label = "", kind = "alarm", inSeconds, device = null } = {}) {
  const ringsOn = device && device.kind !== "desktop" ? { deviceId: device.id, deviceName: device.name || "phone" } : {};

  if (inSeconds !== undefined && inSeconds !== null && inSeconds !== "") {
    const seconds = Math.round(Number(inSeconds));
    if (!Number.isFinite(seconds) || seconds < 1 || seconds > MAX_RELATIVE_SECONDS) {
      throw alarmError("INVALID_DURATION", "inSeconds must be a whole number of seconds from 1 to 604800 (7 days).");
    }
    const fireAt = new Date(Date.now() + seconds * 1000);
    const parts = getZonedParts(fireAt);
    const alarm = {
      id: `alarm_${nextId++}`,
      label: String(label || "").trim() || "Alarm",
      kind: kind === "wakeup" ? "wakeup" : "alarm",
      time: `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`,
      recurrence: { type: "once", date: null },
      enabled: true,
      createdAt: new Date().toISOString(),
      // Exact instant, to the second, for relative alarms.
      fireAt: fireAt.toISOString(),
      nextFireAt: fireAt.toISOString(),
      ...ringsOn
    };
    alarms.push(alarm);
    persistAlarms();
    alarmsChanged(alarm);
    return describeAlarm(alarm);
  }

  const timeMatch = String(time || "").trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!timeMatch) {
    throw alarmError("INVALID_TIME", "time must be in HH:mm 24-hour format.");
  }
  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  if (hour > 23 || minute > 59) {
    throw alarmError("INVALID_TIME", "time must be a valid 24-hour HH:mm value.");
  }

  const normalizedRecurrence = normalizeRecurrence(recurrence, daysOfWeek, date);

  const alarm = {
    id: `alarm_${nextId++}`,
    label: String(label || "").trim() || (kind === "wakeup" ? "Wake up" : "Alarm"),
    kind: kind === "wakeup" ? "wakeup" : "alarm",
    time: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
    recurrence: normalizedRecurrence,
    enabled: true,
    createdAt: new Date().toISOString(),
    ...ringsOn
  };

  alarm.nextFireAt = computeNextFireAt(alarm, new Date()).toISOString();

  alarms.push(alarm);
  persistAlarms();
  alarmsChanged(alarm);
  return describeAlarm(alarm);
}

export function getAlarm(id) {
  const alarm = alarms.find((entry) => entry.id === id);
  return alarm ? describeAlarm(alarm) : null;
}

export function listAlarms() {
  return alarms.map(describeAlarm);
}

export function cancelAlarm(id) {
  const index = alarms.findIndex((alarm) => alarm.id === id);
  if (index < 0) {
    throw alarmError("ALARM_NOT_FOUND", `No alarm found for id '${id}'.`);
  }
  const [removed] = alarms.splice(index, 1);
  ringingAlarmIds.delete(id);
  persistAlarms();
  alarmsChanged(removed);
  return describeAlarm(removed);
}

// Adds a pre-formatted local-timezone date/time string alongside the raw UTC
// ISO timestamp, so callers (including the LLM reading tool results) never
// have to interpret/convert the UTC string themselves — misreading a UTC
// evening timestamp as "the next day" is an easy, systematic mistake since
// LA evenings are already the next calendar day in UTC.
function describeAlarm(alarm) {
  // Relative alarms ("in 30 seconds") get seconds in the time and a plain
  // "firesIn", so Jarvis doesn't say "in about a minute" for 30 seconds.
  const relative = Boolean(alarm.fireAt);
  return {
    ...alarm,
    nextFireAtLocal: alarm.nextFireAt
      ? new Intl.DateTimeFormat("en-US", { timeZone: CALENDAR_TIMEZONE, dateStyle: "full", timeStyle: relative ? "medium" : "short" }).format(
          new Date(alarm.nextFireAt)
        )
      : null,
    ...(relative && alarm.enabled ? { firesIn: describeDuration(new Date(alarm.nextFireAt).getTime() - Date.now()) } : {})
  };
}

/** 30000 -> "30 seconds", 120000 -> "2 minutes", 5400000 -> "1 hour 30 minutes". */
function describeDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const unit = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
  const parts = [];
  if (hours) parts.push(unit(hours, "hour"));
  if (minutes) parts.push(unit(minutes, "minute"));
  if (seconds && !hours) parts.push(unit(seconds, "second"));
  return parts.join(" ") || "now";
}

export function getRingingAlarms() {
  return alarms.filter((alarm) => ringingAlarmIds.has(alarm.id)).map(describeAlarm);
}

export function stopAlarm(id) {
  const targets = alarms.filter((alarm) => ringingAlarmIds.has(alarm.id) && (!id || alarm.id === id));

  if (id && !targets.length) {
    throw alarmError("ALARM_NOT_RINGING", `Alarm '${id}' is not currently ringing.`);
  }

  for (const alarm of targets) {
    ringingAlarmIds.delete(alarm.id);
    publishEvent({
      source: "alarm",
      appId: "control-center",
      type: "alarm-stopped",
      message: `Alarm stopped: ${alarm.label}.`,
      meta: { alarmId: alarm.id, label: alarm.label, kind: alarm.kind, ...targetMeta(alarm) }
    });

    if (alarm.kind === "wakeup") {
      deliverWakeUpBriefing().catch((error) => {
        console.error("[Alarm] Wake-up briefing failed:", error?.message || error);
      });
    }
  }

  return targets.map(describeAlarm);
}

export function startAlarmScheduler() {
  if (checkTimer) {
    return;
  }
  checkAlarms();
  checkTimer = setInterval(checkAlarms, CHECK_INTERVAL_MS);
}

export function stopAlarmScheduler() {
  if (checkTimer) {
    clearInterval(checkTimer);
    checkTimer = null;
  }
  clearTimeout(preciseTimer);
  preciseTimer = null;
}

// --- Internal ---

function checkAlarms() {
  const now = Date.now();
  let changed = false;

  for (const alarm of alarms) {
    if (!alarm.enabled || ringingAlarmIds.has(alarm.id)) {
      continue;
    }
    if (new Date(alarm.nextFireAt).getTime() <= now) {
      fireAlarm(alarm);
      changed = true;
    }
  }

  if (changed) {
    persistAlarms();
  }
  schedulePreciseCheck();
}

// The 15 s interval alone would let a 30-second alarm ring up to 15 s late,
// so there's also a timer for exactly when the next alarm is due.
function schedulePreciseCheck() {
  clearTimeout(preciseTimer);
  preciseTimer = null;
  if (!checkTimer) {
    return;
  }
  const next = alarms
    .filter((alarm) => alarm.enabled && !ringingAlarmIds.has(alarm.id))
    .map((alarm) => new Date(alarm.nextFireAt).getTime())
    .filter(Number.isFinite)
    .sort((a, b) => a - b)[0];
  if (next === undefined) {
    return;
  }
  // setTimeout can't take more than ~24.8 days; the interval covers the rest.
  const delay = Math.min(Math.max(next - Date.now(), 0) + 50, 2 ** 31 - 1);
  preciseTimer = setTimeout(checkAlarms, delay);
}

/** Who should ring: a phone's alarm carries its device id; PC alarms carry none. */
function targetMeta(alarm) {
  return alarm.deviceId ? { targetDeviceId: alarm.deviceId } : {};
}

/** Lets open screens and paired phones resync their alarm lists. */
function alarmsChanged(alarm) {
  publishEvent({
    source: "alarm",
    appId: "alarms",
    type: "data-changed",
    message: `Alarms changed (${alarm.label}).`,
    meta: { entity: "alarm", id: alarm.id, ...targetMeta(alarm) }
  });
  schedulePreciseCheck();
}

function fireAlarm(alarm) {
  ringingAlarmIds.add(alarm.id);

  publishEvent({
    source: "alarm",
    appId: "control-center",
    type: "alarm-fired",
    message: `Alarm fired: ${alarm.label}.`,
    meta: { alarmId: alarm.id, label: alarm.label, kind: alarm.kind, time: alarm.time, firedFor: alarm.nextFireAt, ...targetMeta(alarm) }
  });

  if (alarm.recurrence.type === "once") {
    alarm.enabled = false;
  } else {
    alarm.nextFireAt = computeNextFireAt(alarm, new Date(Date.now() + 60000)).toISOString();
  }
  alarmsChanged(alarm);
}

async function deliverWakeUpBriefing() {
  const parts = [];

  try {
    const briefing = await getNewsBriefing();
    if (briefing?.ok) {
      const summary = formatNewsSummary(briefing);
      if (summary) {
        parts.push(summary);
      }
    }
  } catch (error) {
    console.error("[Alarm] Wake-up news fetch failed:", error?.message || error);
  }

  try {
    const remaining = await getRemainingCalendarEvents({});
    if (remaining.count > 0) {
      const items = remaining.events.map((event) => `${event.startLabel} ${event.title}`).join(", ");
      parts.push(`You have ${remaining.count} thing${remaining.count === 1 ? "" : "s"} on your calendar today: ${items}.`);
    } else {
      parts.push("Your calendar is clear for the rest of today.");
    }
  } catch (error) {
    console.error("[Alarm] Wake-up calendar fetch failed:", error?.message || error);
  }

  const text = ["Good morning!", ...parts].join(" ");
  const persisted = addAgentMessage(text);

  publishEvent({
    source: "alarm",
    appId: "control-center",
    type: "chat",
    message: "Wake-up briefing delivered.",
    meta: { agentMessageId: persisted?.message?.id || null }
  });

  broadcastSpokenMessage(text);
}

function normalizeRecurrence(recurrence, daysOfWeek, date) {
  const type = String(recurrence || "once").trim().toLowerCase();

  if (type === "once") {
    const isoDate = String(date || "").trim();
    if (isoDate && !/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) {
      throw alarmError("INVALID_DATE", "date must be in YYYY-MM-DD format.");
    }
    return { type: "once", date: isoDate || null };
  }

  if (type === "daily") {
    return { type: "daily" };
  }

  if (type === "weekly") {
    const days = (Array.isArray(daysOfWeek) ? daysOfWeek : [])
      .map((day) => String(day).trim().toLowerCase().slice(0, 3))
      .filter((day) => WEEKDAY_CODES.includes(day));
    if (!days.length) {
      throw alarmError("INVALID_DAYS_OF_WEEK", "weekly recurrence requires at least one valid day in daysOfWeek.");
    }
    return { type: "weekly", daysOfWeek: [...new Set(days)] };
  }

  throw alarmError("INVALID_RECURRENCE", "recurrence must be 'once', 'daily', or 'weekly'.");
}

function computeNextFireAt(alarm, from) {
  const [hour, minute] = alarm.time.split(":").map(Number);

  if (alarm.recurrence.type === "once") {
    let year;
    let month;
    let day;

    if (alarm.recurrence.date) {
      [year, month, day] = alarm.recurrence.date.split("-").map(Number);
    } else {
      // No date given — default to the next upcoming occurrence of this time.
      const todayParts = getZonedParts(from);
      const todayMs = zonedPartsToUtcMs({ ...todayParts, hour, minute, second: 0 });
      ({ year, month, day } = todayMs > from.getTime() ? todayParts : addCalendarDays(todayParts, 1));
    }

    return new Date(zonedPartsToUtcMs({ year, month, day, hour, minute, second: 0 }));
  }

  const fromParts = getZonedParts(from);
  for (let offset = 0; offset < 8; offset += 1) {
    const candidateParts = addCalendarDays(fromParts, offset);
    const candidateMs = zonedPartsToUtcMs({ ...candidateParts, hour, minute, second: 0 });
    if (candidateMs <= from.getTime()) {
      continue;
    }

    if (alarm.recurrence.type === "daily") {
      return new Date(candidateMs);
    }

    // Determine the weekday of the candidate date in the configured timezone,
    // not the server's local timezone.
    const weekdayInZone = new Intl.DateTimeFormat("en-US", { timeZone: CALENDAR_TIMEZONE, weekday: "short" })
      .format(new Date(candidateMs))
      .toLowerCase()
      .slice(0, 3);

    if (alarm.recurrence.daysOfWeek.includes(weekdayInZone)) {
      return new Date(candidateMs);
    }
  }

  // Should not happen (weekly always matches within 7 days), but fail safe.
  return new Date(from.getTime() + 24 * 60 * 60 * 1000);
}

function addCalendarDays(zonedParts, days) {
  const baseUtcMs = Date.UTC(zonedParts.year, zonedParts.month - 1, zonedParts.day, 12, 0, 0);
  const shifted = new Date(baseUtcMs + days * 24 * 60 * 60 * 1000);
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

function loadAlarms() {
  const stored = readRuntimeSection("alarms", null);
  const list = Array.isArray(stored) ? stored : [];
  const now = new Date();

  for (const alarm of list) {
    const id = Number(String(alarm.id || "").replace("alarm_", ""));
    if (Number.isFinite(id) && id >= nextId) {
      nextId = id + 1;
    }

    if (!alarm.enabled) {
      continue;
    }

    const overdueMs = now.getTime() - new Date(alarm.nextFireAt).getTime();
    if (overdueMs > MISSED_ALARM_GRACE_MS) {
      if (alarm.recurrence.type === "once") {
        alarm.enabled = false;
      } else {
        alarm.nextFireAt = computeNextFireAt(alarm, now).toISOString();
      }
    }
  }

  return list;
}

function persistAlarms() {
  writeRuntimeSection("alarms", alarms);
}

function alarmError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
