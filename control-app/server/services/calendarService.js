import { existsSync, readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { readRuntimeSection, writeRuntimeSection } from "./runtimePersistenceService.js";
import { publishEvent } from "./eventBus.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataDirectory = path.join(__dirname, "..", "data");
const calendarPath = path.join(dataDirectory, "calendar-events.json");

const CALENDAR_TIMEZONE = process.env.CALENDAR_TIMEZONE || "America/Los_Angeles";
// Matches a date or date/time with no timezone marker, e.g. "2026-08-08" or
// "2026-08-08T18:30" or "2026-08-08T18:30:00" — no trailing "Z" or "+HH:MM".
const NAIVE_DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?$/;

const calendarState = loadCalendarState();

export function getCalendarTimeZone() {
  return CALENDAR_TIMEZONE;
}

// Returns the wall-clock Y/M/D/H/M/S that `date` (a real UTC instant) shows
// as in `timeZone`.
export function getZonedParts(date, timeZone = CALENDAR_TIMEZONE) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  })
    .formatToParts(date)
    .reduce((acc, part) => {
      if (part.type !== "literal") {
        acc[part.type] = part.value;
      }
      return acc;
    }, {});

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: parts.hour === "24" ? 0 : Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second)
  };
}

// The current UTC-offset (in minutes) of `timeZone` at the instant `date`.
function getTimeZoneOffsetMinutes(date, timeZone) {
  const zoned = getZonedParts(date, timeZone);
  const asUtcMs = Date.UTC(zoned.year, zoned.month - 1, zoned.day, zoned.hour, zoned.minute, zoned.second);
  return Math.round((asUtcMs - date.getTime()) / 60000);
}

// Converts wall-clock components (assumed to be local time IN `timeZone`)
// into the correct UTC instant, in milliseconds.
export function zonedPartsToUtcMs({ year, month, day, hour = 0, minute = 0, second = 0 }, timeZone = CALENDAR_TIMEZONE) {
  const guessUtcMs = Date.UTC(year, month - 1, day, hour, minute, second);
  const offsetMinutes = getTimeZoneOffsetMinutes(new Date(guessUtcMs), timeZone);
  return guessUtcMs - offsetMinutes * 60000;
}

// Parses a naive "YYYY-MM-DD[THH:mm[:ss]]" string (no timezone marker) as LA
// wall-clock time, returning a correct UTC Date.
function parseNaiveAsCalendarZone(value) {
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!match) {
    return null;
  }
  const [, year, month, day, hour = "0", minute = "0", second = "0"] = match;
  const utcMs = zonedPartsToUtcMs({
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: Number(hour),
    minute: Number(minute),
    second: Number(second)
  });
  return new Date(utcMs);
}

export async function getCalendarMonthView({ year, month } = {}) {
  const reference = new Date();
  const referenceParts = getZonedParts(reference);
  const resolvedYear = Number.isInteger(Number(year)) ? Number(year) : referenceParts.year;
  const resolvedMonth = Number.isInteger(Number(month)) ? Number(month) : referenceParts.month;
  const firstDay = new Date(resolvedYear, resolvedMonth - 1, 1);

  if (Number.isNaN(firstDay.getTime())) {
    throw createCalendarError("INVALID_MONTH", "Month view requires a valid year and month.", 400);
  }

  const gridStart = startOfWeek(firstDay);
  const monthEnd = new Date(resolvedYear, resolvedMonth, 0, 23, 59, 59, 999);
  const gridEnd = endOfWeek(monthEnd);
  const eventsResult = await listCalendarEvents({
    start: gridStart.toISOString(),
    end: gridEnd.toISOString(),
    limit: 500
  });
  const events = Array.isArray(eventsResult?.events) ? eventsResult.events : [];
  const todayKey = dateKey(reference);
  const days = [];

  for (let cursor = new Date(gridStart); cursor <= gridEnd; cursor = addDays(cursor, 1)) {
    const key = dateKey(cursor);
    const dayEvents = events
      .filter((event) => event.startDateKey === key)
      .sort((left, right) => left.startAt.localeCompare(right.startAt));

    days.push({
      date: key,
      dayNumber: cursor.getDate(),
      inMonth: cursor.getMonth() === firstDay.getMonth(),
      isToday: key === todayKey,
      events: dayEvents,
      eventCount: dayEvents.length
    });
  }

  const monthPrefix = `${resolvedYear}-${String(resolvedMonth).padStart(2, "0")}`;
  const monthEvents = events.filter((event) => String(event.startDateKey || "").startsWith(monthPrefix));

  return {
    ok: true,
    year: resolvedYear,
    month: resolvedMonth,
    monthLabel: firstDay.toLocaleDateString("en-US", { month: "long", year: "numeric" }),
    today: todayKey,
    selectedDate: todayKey.startsWith(`${resolvedYear}-${String(resolvedMonth).padStart(2, "0")}`)
      ? todayKey
      : `${resolvedYear}-${String(resolvedMonth).padStart(2, "0")}-01`,
    days,
    events: monthEvents,
    summary: {
      totalEvents: monthEvents.length,
      busyDays: new Set(monthEvents.map((event) => event.startDateKey)).size,
      firstEvent: monthEvents[0] || null,
      lastEvent: monthEvents[monthEvents.length - 1] || null
    }
  };
}

export async function listCalendarEvents({ start, end, limit = 25 } = {}) {
  const events = filterEvents({ start, end, limit });
  return {
    ok: true,
    events,
    count: events.length,
    range: {
      start: normalizeIsoInput(start),
      end: normalizeIsoInput(end),
      limit: sanitizeLimit(limit)
    }
  };
}

export async function getRemainingCalendarEvents({ now } = {}) {
  const reference = parseDateInput(now) || new Date();
  const { year, month, day } = getZonedParts(reference);
  const dayEnd = new Date(zonedPartsToUtcMs({ year, month, day, hour: 23, minute: 59, second: 59 }));

  const eventsResult = await listCalendarEvents({
    start: reference.toISOString(),
    end: dayEnd.toISOString(),
    limit: 50
  });
  const events = Array.isArray(eventsResult?.events) ? eventsResult.events : [];

  return {
    ok: true,
    now: reference.toISOString(),
    date: dateKey(reference),
    dateLabel: reference.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: CALENDAR_TIMEZONE }),
    events,
    count: events.length
  };
}

export async function createCalendarEvent({ title, startsAt, endsAt, location = "", notes = "" } = {}) {
  const cleanTitle = String(title || "").replace(/\s+/g, " ").trim();
  if (!cleanTitle) {
    throw createCalendarError("INVALID_EVENT_TITLE", "Calendar event title is required.", 400);
  }

  const startDate = parseDateInput(startsAt);
  if (!startDate) {
    throw createCalendarError("INVALID_EVENT_START", "Calendar event start time is required.", 400);
  }

  const endDate = parseDateInput(endsAt) || new Date(startDate.getTime() + 60 * 60 * 1000);
  if (endDate <= startDate) {
    throw createCalendarError("INVALID_EVENT_RANGE", "Calendar event end time must be after the start time.", 400);
  }

  const event = normalizeEvent({
    id: `cal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title: cleanTitle,
    startAt: startDate.toISOString(),
    endAt: endDate.toISOString(),
    location,
    notes
  });

  calendarState.events.push(event);
  calendarState.events.sort((left, right) => left.startAt.localeCompare(right.startAt));
  persistCalendarState();

  return { ok: true, event };
}

export async function deleteCalendarEvent({ eventId, title } = {}) {
  const id = String(eventId || "").trim();

  if (id) {
    const index = calendarState.events.findIndex((event) => event.id === id);
    if (index < 0) {
      throw createCalendarError("EVENT_NOT_FOUND", `No calendar event found for id '${id}'.`, 404);
    }

    const [deletedEvent] = calendarState.events.splice(index, 1);
    persistCalendarState();
    return { ok: true, event: deletedEvent };
  }

  const rawTitle = String(title || "").replace(/\s+/g, " ").trim();
  const targetTitle = rawTitle.toLowerCase();
  if (!targetTitle) {
    throw createCalendarError("INVALID_EVENT_TARGET", "Calendar event id or title is required to delete an event.", 400);
  }

  const exactMatches = calendarState.events.filter((event) => event.title === rawTitle);
  const matches = exactMatches.length
    ? exactMatches
    : calendarState.events.filter((event) => event.title.toLowerCase() === targetTitle);
  if (!matches.length) {
    throw createCalendarError("EVENT_NOT_FOUND", `No calendar event found for '${title}'.`, 404);
  }

  if (matches.length > 1) {
    throw createCalendarError("EVENT_AMBIGUOUS", `Multiple calendar events match '${title}'. Remove by id instead.`, 409);
  }

  calendarState.events = calendarState.events.filter((event) => event.id !== matches[0].id);
  persistCalendarState();
  return { ok: true, event: matches[0] };
}

function filterEvents({ start, end, limit } = {}) {
  const safeLimit = sanitizeLimit(limit);
  const startDate = parseDateInput(start);
  const endDate = parseDateInput(end);

  return calendarState.events
    .filter((event) => {
      const eventStart = Date.parse(event.startAt);
      const eventEnd = Date.parse(event.endAt);

      if (startDate && eventEnd < startDate.getTime()) {
        return false;
      }
      if (endDate && eventStart > endDate.getTime()) {
        return false;
      }
      return true;
    })
    .sort((left, right) => left.startAt.localeCompare(right.startAt))
    .slice(0, safeLimit)
    .map((event) => ({ ...event }));
}

function loadCalendarState() {
  const runtimeState = readRuntimeSection("calendar", null);
  if (runtimeState && typeof runtimeState === "object") {
    return sanitizeCalendarState(runtimeState);
  }

  if (!existsSync(calendarPath)) {
    const empty = { events: [], updatedAt: new Date().toISOString() };
    writeRuntimeSection("calendar", empty);
    return empty;
  }

  try {
    const parsed = JSON.parse(readFileSync(calendarPath, "utf-8"));
    const events = Array.isArray(parsed?.events) ? parsed.events.map(normalizeEvent).filter(Boolean) : [];
    const safeState = { events, updatedAt: String(parsed?.updatedAt || new Date().toISOString()) };
    writeRuntimeSection("calendar", safeState);
    return safeState;
  } catch {
    const fallback = { events: [], updatedAt: new Date().toISOString() };
    writeRuntimeSection("calendar", fallback);
    return fallback;
  }
}

function persistCalendarState() {
  calendarState.updatedAt = new Date().toISOString();
  writeRuntimeSection("calendar", calendarState);
  // Open calendar screens on any device refresh, and phones reschedule reminders.
  publishEvent({
    source: "calendar",
    appId: "calendar-app",
    type: "data-changed",
    message: "Calendar changed.",
    meta: { entity: "event" }
  });
}

function normalizeEvent(event) {
  if (!event || typeof event !== "object") {
    return null;
  }

  const title = String(event.title || "").replace(/\s+/g, " ").trim();
  const startDate = parseDateInput(event.startAt);
  const endDate = parseDateInput(event.endAt);
  if (!title || !startDate || !endDate || endDate <= startDate) {
    return null;
  }

  return {
    id: String(event.id || `cal-${Date.now()}`),
    title,
    startAt: startDate.toISOString(),
    endAt: endDate.toISOString(),
    location: String(event.location || "").trim(),
    notes: String(event.notes || "").trim(),
    accent: String(event.accent || "azure").trim() || "azure",
    startDateKey: dateKey(startDate),
    startLabel: formatTime(startDate),
    endLabel: formatTime(endDate)
  };
}

function sanitizeLimit(limit) {
  const parsedLimit = Number(limit);
  return Number.isFinite(parsedLimit) ? Math.max(1, Math.min(Math.trunc(parsedLimit), 500)) : 25;
}

function parseDateInput(value) {
  if (!value) {
    return null;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  const raw = String(value).trim();
  if (NAIVE_DATETIME_PATTERN.test(raw)) {
    const zoned = parseNaiveAsCalendarZone(raw);
    if (zoned) {
      return zoned;
    }
  }

  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function normalizeIsoInput(value) {
  const parsed = parseDateInput(value);
  return parsed ? parsed.toISOString() : null;
}

function startOfWeek(date) {
  const value = new Date(date);
  const offset = value.getDay();
  value.setDate(value.getDate() - offset);
  value.setHours(0, 0, 0, 0);
  return value;
}

function endOfWeek(date) {
  const value = startOfWeek(date);
  value.setDate(value.getDate() + 6);
  value.setHours(23, 59, 59, 999);
  return value;
}

function addDays(date, count) {
  const value = new Date(date);
  value.setDate(value.getDate() + count);
  return value;
}

function dateKey(date) {
  const { year, month, day } = getZonedParts(new Date(date));
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function formatTime(date) {
  return new Date(date).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: CALENDAR_TIMEZONE });
}

function createCalendarError(code, message, status = 500) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function sanitizeCalendarState(state) {
  const events = Array.isArray(state?.events) ? state.events.map(normalizeEvent).filter(Boolean) : [];
  return { events, updatedAt: String(state?.updatedAt || new Date().toISOString()) };
}
