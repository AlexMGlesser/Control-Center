import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataDirectory = path.join(__dirname, "..", "data");
const calendarPath = path.join(dataDirectory, "calendar-events.json");

const DEFAULT_DAY_START_HOUR = 8;
const DEFAULT_DAY_END_HOUR = 18;

const calendarState = loadCalendarState();

export function getCalendarMonthView({ year, month } = {}) {
  const reference = new Date();
  const resolvedYear = Number.isInteger(Number(year)) ? Number(year) : reference.getFullYear();
  const resolvedMonth = Number.isInteger(Number(month)) ? Number(month) : reference.getMonth() + 1;
  const firstDay = new Date(resolvedYear, resolvedMonth - 1, 1);

  if (Number.isNaN(firstDay.getTime())) {
    throw createCalendarError("INVALID_MONTH", "Month view requires a valid year and month.", 400);
  }

  const gridStart = startOfWeek(firstDay);
  const monthEnd = new Date(resolvedYear, resolvedMonth, 0, 23, 59, 59, 999);
  const gridEnd = endOfWeek(monthEnd);
  const events = filterEvents({
    start: gridStart.toISOString(),
    end: gridEnd.toISOString(),
    limit: 500
  });
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

  const monthStart = new Date(resolvedYear, resolvedMonth - 1, 1, 0, 0, 0, 0);
  const monthEvents = filterEvents({
    start: monthStart.toISOString(),
    end: monthEnd.toISOString(),
    limit: 500
  });

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

export function listCalendarEvents({ start, end, limit = 25 } = {}) {
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

export function getRemainingCalendarEvents({ now } = {}) {
  const reference = parseDateInput(now) || new Date();
  const dayEnd = new Date(reference);
  dayEnd.setHours(23, 59, 59, 999);

  const events = filterEvents({
    start: reference.toISOString(),
    end: dayEnd.toISOString(),
    limit: 50
  });

  return {
    ok: true,
    now: reference.toISOString(),
    date: dateKey(reference),
    dateLabel: reference.toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric"
    }),
    events,
    count: events.length
  };
}

export function createCalendarEvent({ title, startsAt, endsAt, location = "", notes = "" } = {}) {
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

  return {
    ok: true,
    event
  };
}

export function deleteCalendarEvent({ eventId, title } = {}) {
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
    throw createCalendarError(
      "EVENT_AMBIGUOUS",
      `Multiple calendar events match '${title}'. Remove by id instead.`,
      409
    );
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
  ensureDataDirectory();

  if (!existsSync(calendarPath)) {
    const seeded = {
      events: buildSeedEvents(new Date()),
      updatedAt: new Date().toISOString()
    };
    writeFileSync(calendarPath, JSON.stringify(seeded, null, 2));
    return seeded;
  }

  try {
    const parsed = JSON.parse(readFileSync(calendarPath, "utf-8"));
    const events = Array.isArray(parsed?.events)
      ? parsed.events.map(normalizeEvent).filter(Boolean)
      : [];

    const safeState = {
      events: events.length ? events : buildSeedEvents(new Date()),
      updatedAt: String(parsed?.updatedAt || new Date().toISOString())
    };

    writeFileSync(calendarPath, JSON.stringify(safeState, null, 2));
    return safeState;
  } catch {
    const fallback = {
      events: buildSeedEvents(new Date()),
      updatedAt: new Date().toISOString()
    };
    writeFileSync(calendarPath, JSON.stringify(fallback, null, 2));
    return fallback;
  }
}

function persistCalendarState() {
  calendarState.updatedAt = new Date().toISOString();
  ensureDataDirectory();
  writeFileSync(calendarPath, JSON.stringify(calendarState, null, 2));
}

function ensureDataDirectory() {
  mkdirSync(dataDirectory, { recursive: true });
}

function buildSeedEvents(referenceDate) {
  const year = referenceDate.getFullYear();
  const month = referenceDate.getMonth();
  const base = [];
  const addSeedEvent = (day, startHour, startMinute, durationMinutes, title, extras = {}) => {
    const startAt = new Date(year, month, day, startHour, startMinute, 0, 0);
    const endAt = new Date(startAt.getTime() + durationMinutes * 60 * 1000);
    base.push(
      normalizeEvent({
        id: `seed-${day}-${startHour}-${startMinute}-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
        title,
        startAt: startAt.toISOString(),
        endAt: endAt.toISOString(),
        location: extras.location || "",
        notes: extras.notes || "",
        accent: extras.accent || "azure"
      })
    );
  };

  const today = Math.min(referenceDate.getDate(), daysInMonth(year, month + 1));
  const safeToday = Math.max(1, today);
  const safeTomorrow = Math.min(daysInMonth(year, month + 1), safeToday + 1);
  const safeLater = Math.min(daysInMonth(year, month + 1), safeToday + 3);
  const safeNextWeek = Math.min(daysInMonth(year, month + 1), safeToday + 7);

  addSeedEvent(safeToday, 9, 0, 45, "Inbox Zero Sprint", {
    location: "Desk",
    notes: "Clear priority email and prep status notes.",
    accent: "gold"
  });
  addSeedEvent(safeToday, 11, 30, 30, "Weekly Control Center Sync", {
    location: "Studio Call",
    notes: "Check app integration blockers.",
    accent: "teal"
  });
  addSeedEvent(safeToday, 15, 0, 60, "Calendar App UI Review", {
    location: "Focus Block",
    notes: "Finalize layout and voice behaviors.",
    accent: "coral"
  });
  addSeedEvent(safeToday, 19, 0, 90, "Gym Session", {
    location: "Fitness Center",
    notes: "Leg day and recovery stretch.",
    accent: "plum"
  });
  addSeedEvent(safeTomorrow, 10, 0, 60, "Deep Work: Agent Runtime", {
    location: "Home Office",
    notes: "Stabilize deterministic command routing.",
    accent: "azure"
  });
  addSeedEvent(safeTomorrow, 14, 30, 45, "Lunch with Jordan", {
    location: "Eastside Cafe",
    notes: "Talk through roadmap priorities.",
    accent: "gold"
  });
  addSeedEvent(safeLater, 8, 30, 30, "Morning Planning", {
    location: "Desk",
    notes: "Set top three outcomes for the day.",
    accent: "teal"
  });
  addSeedEvent(safeLater, 13, 0, 120, "Build Calendar Backend Connector", {
    location: "Sprint Block",
    notes: "Prepare external API integration adapter.",
    accent: "coral"
  });
  addSeedEvent(safeNextWeek, 16, 0, 45, "Dentist Appointment", {
    location: "Main Street Dental",
    notes: "Routine cleaning.",
    accent: "plum"
  });

  for (let day = 1; day <= daysInMonth(year, month + 1); day += 7) {
    addSeedEvent(day, DEFAULT_DAY_START_HOUR, 30, 20, "Weekly Planning Reset", {
      location: "Desk",
      notes: "Review calendar load and rebalance focus time.",
      accent: "teal"
    });
  }

  return base
    .filter(Boolean)
    .sort((left, right) => left.startAt.localeCompare(right.startAt));
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
  return Number.isFinite(parsedLimit)
    ? Math.max(1, Math.min(Math.trunc(parsedLimit), 500))
    : 25;
}

function parseDateInput(value) {
  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  const parsed = new Date(String(value));
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
  const value = new Date(date);
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatTime(date) {
  return new Date(date).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit"
  });
}

function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

function createCalendarError(code, message, status = 500) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}