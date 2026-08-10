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

export function createAlarm({ time, date, recurrence = "once", daysOfWeek = [], label = "", kind = "alarm" } = {}) {
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
    createdAt: new Date().toISOString()
  };

  alarm.nextFireAt = computeNextFireAt(alarm, new Date()).toISOString();

  alarms.push(alarm);
  persistAlarms();
  return alarm;
}

export function listAlarms() {
  return alarms.slice();
}

export function cancelAlarm(id) {
  const index = alarms.findIndex((alarm) => alarm.id === id);
  if (index < 0) {
    throw alarmError("ALARM_NOT_FOUND", `No alarm found for id '${id}'.`);
  }
  const [removed] = alarms.splice(index, 1);
  ringingAlarmIds.delete(id);
  persistAlarms();
  return removed;
}

export function getRingingAlarms() {
  return alarms.filter((alarm) => ringingAlarmIds.has(alarm.id));
}

export function stopAlarm(id) {
  const targets = id ? alarms.filter((alarm) => alarm.id === id && ringingAlarmIds.has(alarm.id)) : getRingingAlarms();

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
      meta: { alarmId: alarm.id, label: alarm.label, kind: alarm.kind }
    });

    if (alarm.kind === "wakeup") {
      deliverWakeUpBriefing().catch((error) => {
        console.error("[Alarm] Wake-up briefing failed:", error?.message || error);
      });
    }
  }

  return targets;
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
}

function fireAlarm(alarm) {
  ringingAlarmIds.add(alarm.id);

  publishEvent({
    source: "alarm",
    appId: "control-center",
    type: "alarm-fired",
    message: `Alarm fired: ${alarm.label}.`,
    meta: { alarmId: alarm.id, label: alarm.label, kind: alarm.kind, time: alarm.time }
  });

  if (alarm.recurrence.type === "once") {
    alarm.enabled = false;
  } else {
    alarm.nextFireAt = computeNextFireAt(alarm, new Date(Date.now() + 60000)).toISOString();
  }
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
