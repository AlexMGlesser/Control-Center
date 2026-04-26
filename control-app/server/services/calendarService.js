import { existsSync, readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { readRuntimeSection, writeRuntimeSection } from "./runtimePersistenceService.js";
import { google } from "googleapis";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataDirectory = path.join(__dirname, "..", "data");
const calendarPath = path.join(dataDirectory, "calendar-events.json");

const DEFAULT_DAY_START_HOUR = 8;
const DEFAULT_DAY_END_HOUR = 18;
const GOOGLE_CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar";

const calendarState = loadCalendarState();

export async function getCalendarMonthView({ year, month } = {}) {
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
  let useGoogle = false;
  try {
    useGoogle = shouldUseGoogleCalendar();
  } catch {
    // provider misconfigured — fall through to local
  }

  if (useGoogle) {
    try {
      const events = await listGoogleEvents({ start, end, limit });
      return {
        ok: true,
        provider: "google",
        events,
        count: events.length,
        range: {
          start: normalizeIsoInput(start),
          end: normalizeIsoInput(end),
          limit: sanitizeLimit(limit)
        }
      };
    } catch (googleError) {
      console.warn("[calendar] Google Calendar failed, falling back to local:", googleError.message);
      // fall through to local
    }
  }

  const events = filterEvents({ start, end, limit });
  return {
    ok: true,
    provider: "local",
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
  const dayEnd = new Date(reference);
  dayEnd.setHours(23, 59, 59, 999);

  const eventsResult = await listCalendarEvents({
    start: reference.toISOString(),
    end: dayEnd.toISOString(),
    limit: 50
  });
  const events = Array.isArray(eventsResult?.events) ? eventsResult.events : [];

  return {
    ok: true,
    provider: eventsResult?.provider || "local",
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

  if (shouldUseGoogleCalendar()) {
    const event = await createGoogleEvent({
      title: cleanTitle,
      startDate,
      endDate,
      location,
      notes
    });

    return {
      ok: true,
      provider: "google",
      event
    };
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
    provider: "local",
    event
  };
}

export async function deleteCalendarEvent({ eventId, title } = {}) {
  const id = String(eventId || "").trim();

  if (shouldUseGoogleCalendar()) {
    const event = id
      ? await deleteGoogleEventById(id)
      : await deleteGoogleEventByTitle(title);

    return {
      ok: true,
      provider: "google",
      event
    };
  }

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
  return { ok: true, provider: "local", event: matches[0] };
}

async function listGoogleEvents({ start, end, limit } = {}) {
  const calendar = await getGoogleCalendarClient();
  const safeLimit = sanitizeLimit(limit);
  const timeMin = normalizeIsoInput(start);
  const timeMax = normalizeIsoInput(end);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await calendar.events.list({
      calendarId: getGoogleCalendarId(),
      singleEvents: true,
      orderBy: "startTime",
      maxResults: safeLimit,
      timeMin: timeMin || undefined,
      timeMax: timeMax || undefined,
      signal: controller.signal
    });

    return Array.isArray(response.data?.items)
      ? response.data.items.map(normalizeGoogleEvent).filter(Boolean)
      : [];
  } catch (error) {
    if (error.name === "AbortError") {
      throw createCalendarError("GOOGLE_CALENDAR_TIMEOUT", "Google Calendar request timed out.", 504);
    }
    throw wrapGoogleCalendarError(error, "GOOGLE_CALENDAR_LIST_FAILED", "Could not read Google Calendar events.");
  } finally {
    clearTimeout(timeout);
  }
}

async function createGoogleEvent({ title, startDate, endDate, location, notes }) {
  ensureGoogleWriteAccess();
  const calendar = await getGoogleCalendarClient();

  try {
    const response = await calendar.events.insert({
      calendarId: getGoogleCalendarId(),
      requestBody: {
        summary: title,
        location: String(location || "").trim() || undefined,
        description: String(notes || "").trim() || undefined,
        start: {
          dateTime: startDate.toISOString(),
          timeZone: getCalendarTimeZone()
        },
        end: {
          dateTime: endDate.toISOString(),
          timeZone: getCalendarTimeZone()
        }
      }
    });

    return normalizeGoogleEvent(response.data);
  } catch (error) {
    throw wrapGoogleCalendarError(error, "GOOGLE_CALENDAR_CREATE_FAILED", "Could not create Google Calendar event.");
  }
}

async function deleteGoogleEventById(eventId) {
  ensureGoogleWriteAccess();
  const calendar = await getGoogleCalendarClient();

  try {
    const getResponse = await calendar.events.get({
      calendarId: getGoogleCalendarId(),
      eventId
    });

    await calendar.events.delete({
      calendarId: getGoogleCalendarId(),
      eventId
    });

    return normalizeGoogleEvent(getResponse.data) || { id: eventId, title: "Event" };
  } catch (error) {
    if (error?.code === 404) {
      throw createCalendarError("EVENT_NOT_FOUND", `No calendar event found for id '${eventId}'.`, 404);
    }

    throw wrapGoogleCalendarError(error, "GOOGLE_CALENDAR_DELETE_FAILED", "Could not delete Google Calendar event.");
  }
}

async function deleteGoogleEventByTitle(title) {
  const rawTitle = String(title || "").replace(/\s+/g, " ").trim();
  const targetTitle = rawTitle.toLowerCase();
  if (!targetTitle) {
    throw createCalendarError("INVALID_EVENT_TARGET", "Calendar event id or title is required to delete an event.", 400);
  }

  ensureGoogleWriteAccess();
  const calendar = await getGoogleCalendarClient();
  const searchStart = new Date();
  searchStart.setMonth(searchStart.getMonth() - 12);
  const searchEnd = new Date();
  searchEnd.setMonth(searchEnd.getMonth() + 24);

  try {
    const response = await calendar.events.list({
      calendarId: getGoogleCalendarId(),
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 2500,
      timeMin: searchStart.toISOString(),
      timeMax: searchEnd.toISOString()
    });

    const normalized = Array.isArray(response.data?.items)
      ? response.data.items.map(normalizeGoogleEvent).filter(Boolean)
      : [];

    const exactMatches = normalized.filter((event) => event.title === rawTitle);
    const matches = exactMatches.length
      ? exactMatches
      : normalized.filter((event) => event.title.toLowerCase() === targetTitle);

    if (!matches.length) {
      throw createCalendarError("EVENT_NOT_FOUND", `No calendar event found for '${title}'.`, 404);
    }

    if (matches.length > 1) {
      throw createCalendarError("EVENT_AMBIGUOUS", `Multiple calendar events match '${title}'. Remove by id instead.`, 409);
    }

    await calendar.events.delete({
      calendarId: getGoogleCalendarId(),
      eventId: matches[0].id
    });

    return matches[0];
  } catch (error) {
    if (error?.code && String(error.code).startsWith("EVENT_")) {
      throw error;
    }

    throw wrapGoogleCalendarError(error, "GOOGLE_CALENDAR_DELETE_FAILED", "Could not delete Google Calendar event.");
  }
}

function normalizeGoogleEvent(event) {
  if (!event || typeof event !== "object") {
    return null;
  }

  const title = String(event.summary || "").replace(/\s+/g, " ").trim();
  const startDate = parseGoogleDateValue(event.start, true);
  const endDate = parseGoogleDateValue(event.end, false);
  if (!title || !startDate || !endDate || endDate <= startDate) {
    return null;
  }

  return {
    id: String(event.id || `gcal-${Date.now()}`),
    title,
    startAt: startDate.toISOString(),
    endAt: endDate.toISOString(),
    location: String(event.location || "").trim(),
    notes: String(event.description || "").trim(),
    accent: "azure",
    startDateKey: dateKey(startDate),
    startLabel: formatTime(startDate),
    endLabel: formatTime(endDate)
  };
}

function parseGoogleDateValue(value, isStart) {
  if (!value || typeof value !== "object") {
    return null;
  }

  if (value.dateTime) {
    return parseDateInput(value.dateTime);
  }

  if (value.date) {
    const parsed = parseDateInput(`${value.date}T00:00:00`);
    if (!parsed) {
      return null;
    }

    if (!isStart) {
      return parsed;
    }

    return parsed;
  }

  return null;
}

function shouldUseGoogleCalendar() {
  const provider = String(process.env.CALENDAR_PROVIDER || "local").trim().toLowerCase();
  if (provider === "google") {
    if (!isGoogleCalendarConfigured()) {
      throw createCalendarError(
        "GOOGLE_CALENDAR_NOT_CONFIGURED",
        "Google Calendar provider is enabled but credentials are missing. Provide service/OAuth credentials or GOOGLE_CALENDAR_API_KEY for read-only access.",
        500
      );
    }
    return true;
  }

  if (provider === "auto") {
    return isGoogleCalendarConfigured();
  }

  return false;
}

function isGoogleCalendarConfigured() {
  return Boolean(getServiceAccountCredentials() || getOAuthCredentials() || getGoogleApiKey());
}

function getGoogleCalendarClient() {
  const auth = getGoogleAuthClientOrNull();
  if (auth) {
    return google.calendar({ version: "v3", auth });
  }

  const apiKey = getGoogleApiKey();
  if (apiKey) {
    return google.calendar({ version: "v3", auth: apiKey });
  }

  throw createCalendarError(
    "GOOGLE_CALENDAR_NOT_CONFIGURED",
    "Missing Google Calendar credentials. Configure service account, OAuth refresh token, or API key.",
    500
  );
}

function getGoogleAuthClient() {
  const auth = getGoogleAuthClientOrNull();
  if (auth) {
    return auth;
  }

  throw createCalendarError(
    "GOOGLE_CALENDAR_NOT_CONFIGURED",
    "Missing Google Calendar write credentials. Configure service account or OAuth refresh token.",
    500
  );
}

function getGoogleAuthClientOrNull() {
  const service = getServiceAccountCredentials();
  if (service) {
    return new google.auth.JWT({
      email: service.clientEmail,
      key: service.privateKey,
      scopes: [GOOGLE_CALENDAR_SCOPE]
    });
  }

  const oauth = getOAuthCredentials();
  if (oauth) {
    const auth = new google.auth.OAuth2(
      oauth.clientId,
      oauth.clientSecret,
      oauth.redirectUri
    );
    auth.setCredentials({ refresh_token: oauth.refreshToken });
    return auth;
  }

  return null;
}

function getServiceAccountCredentials() {
  const clientEmail = String(process.env.GOOGLE_CALENDAR_CLIENT_EMAIL || "").trim();
  const privateKeyRaw = String(process.env.GOOGLE_CALENDAR_PRIVATE_KEY || "").trim();
  if (!clientEmail || !privateKeyRaw) {
    return null;
  }

  return {
    clientEmail,
    privateKey: privateKeyRaw.replace(/\\n/g, "\n")
  };
}

function getOAuthCredentials() {
  const clientId = String(process.env.GOOGLE_CALENDAR_CLIENT_ID || "").trim();
  const clientSecret = String(process.env.GOOGLE_CALENDAR_CLIENT_SECRET || "").trim();
  const refreshToken = String(process.env.GOOGLE_CALENDAR_REFRESH_TOKEN || "").trim();
  if (!clientId || !clientSecret || !refreshToken) {
    return null;
  }

  return {
    clientId,
    clientSecret,
    refreshToken,
    redirectUri: String(process.env.GOOGLE_CALENDAR_REDIRECT_URI || "urn:ietf:wg:oauth:2.0:oob").trim()
  };
}

function getGoogleCalendarId() {
  return String(process.env.GOOGLE_CALENDAR_ID || process.env.GOOGLE_CALENDAR_CALENDAR_ID || "primary").trim() || "primary";
}

function getCalendarTimeZone() {
  return String(process.env.CALENDAR_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC").trim();
}

function wrapGoogleCalendarError(error, fallbackCode, fallbackMessage) {
  if (error?.code && String(error.code).startsWith("EVENT_")) {
    return error;
  }

  const status = Number(error?.code) || Number(error?.response?.status) || 502;
  const message = String(
    error?.response?.data?.error?.message ||
      error?.message ||
      fallbackMessage
  );

  return createCalendarError(fallbackCode, message, status);
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
    const empty = {
      events: [],
      updatedAt: new Date().toISOString()
    };
    writeRuntimeSection("calendar", empty);
    return empty;
  }

  try {
    const parsed = JSON.parse(readFileSync(calendarPath, "utf-8"));
    const events = Array.isArray(parsed?.events)
      ? parsed.events.map(normalizeEvent).filter(Boolean)
      : [];

    const safeState = {
      events,
      updatedAt: String(parsed?.updatedAt || new Date().toISOString())
    };

    writeRuntimeSection("calendar", safeState);
    return safeState;
  } catch {
    const fallback = {
      events: [],
      updatedAt: new Date().toISOString()
    };
    writeRuntimeSection("calendar", fallback);
    return fallback;
  }
}

function persistCalendarState() {
  calendarState.updatedAt = new Date().toISOString();
  writeRuntimeSection("calendar", calendarState);
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

function getGoogleApiKey() {
  const apiKey = String(process.env.GOOGLE_CALENDAR_API_KEY || process.env.GOOGLE_API_KEY || "").trim();
  return apiKey || null;
}

function ensureGoogleWriteAccess() {
  if (!getGoogleAuthClientOrNull()) {
    throw createCalendarError(
      "GOOGLE_CALENDAR_WRITE_REQUIRES_OAUTH",
      "Google Calendar write actions require service account or OAuth credentials. API key mode is read-only.",
      403
    );
  }
}

function sanitizeCalendarState(state) {
  const events = Array.isArray(state?.events) ? state.events.map(normalizeEvent).filter(Boolean) : [];
  return {
    events,
    updatedAt: String(state?.updatedAt || new Date().toISOString())
  };
}