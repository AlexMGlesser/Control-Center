import path from "path";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "fs";
import { systemConfig } from "../config.js";
import { connectApp, getOrchestratorStatus } from "./orchestrator.js";
import { getAllApps, getAppById } from "./appRegistry.js";
import { getModeState, switchMode } from "./modeStateMachine.js";
import {
  getSettings,
  getDesktopSettingsLabelValueMap,
  getSettingsOptions,
  updateDesktopSettings
} from "./settingsService.js";
import { getRecentEvents, publishEvent } from "./eventBus.js";
import { getOllamaState } from "./ollamaService.js";
import {
  createProject,
  getPersonalProjects,
  getProjectById as getManagedProjectById,
  getWorkProjects,
  openProjectNode
} from "./projectService.js";
import {
  createCalendarEvent,
  deleteCalendarEvent,
  getCalendarMonthView,
  getCalendarTimeZone,
  getRemainingCalendarEvents,
  listCalendarEvents
} from "./calendarService.js";
import {
  addTrackToPlaylist,
  createMusicPlaylist,
  listMusicArtists,
  listMusicGenres,
  listMusicPlaylists,
  listMusicTracks
} from "./musicLibraryService.js";
import { getNewsBriefing, formatNewsSummary } from "./newsService.js";
import { closeAppWindow } from "./windowControlBridge.js";
import { createAlarm, listAlarms, cancelAlarm, stopAlarm } from "./alarmService.js";

const CALENDAR_TIMEZONE = getCalendarTimeZone();

const WINDOW_APPS = [
  "calendar-app",
  "news-app",
  "work-app",
  "project-app",
  "music-app",
  "drawing-app",
  "movie-app",
  "server-manager-app"
];
const SYSTEM_TABS = ["overview", "settings", "chatbot", "event-bus", "agent-core", "integration-hub"];

// JSON-schema tool definitions in Ollama's native function-calling format.
export const TOOL_DEFINITIONS = [
  tool("get_system_state", "Get Control Center system runtime state (Ollama connection, mode, orchestrator).", {}),
  tool("list_apps", "List all registered apps.", {}),
  tool("get_app", "Get one app's details by appId.", { appId: { type: "string" } }, ["appId"]),
  tool(
    "open_app",
    `Open an app tab or system tab in the Control Center UI. To open every app at once, call this ONCE with target "all" — do not call it once per app.`,
    { target: { type: "string", description: `One of: ${[...SYSTEM_TABS, ...WINDOW_APPS].join(", ")}, or "all" to open every app.` } },
    ["target"]
  ),
  tool(
    "close_app",
    "Close an open app window.",
    { target: { type: "string", description: `One of: ${WINDOW_APPS.join(", ")}, or 'all-apps'.` } },
    ["target"]
  ),
  tool("connect_app", "Run the connector handshake for one app.", { appId: { type: "string" } }, ["appId"]),
  tool("get_mode", "Get current desktop/mobile mode state.", {}),
  tool(
    "switch_mode",
    "Switch between desktop and mobile mode.",
    { targetMode: { type: "string", enum: ["desktop", "mobile"] } },
    ["targetMode"]
  ),
  tool("get_settings", "Get desktop settings (audio device, voice, voice speed) and available options.", {}),
  tool(
    "update_desktop_settings",
    "Update desktop settings.",
    {
      audioDevice: { type: "string" },
      voice: { type: "string" },
      voiceSpeed: { type: "string", enum: ["slow", "normal", "fast"] }
    }
  ),
  tool("test_voice", "Run a voice test with the current desktop voice settings.", {
    sampleText: { type: "string" }
  }),
  tool("shutdown_app", "Shut down Control Center. Only call this if the user explicitly asks to quit or shut down.", {}),
  tool("list_events", "List recent event bus entries.", { limit: { type: "integer" } }),
  tool(
    "publish_event",
    "Publish a custom event to the event bus.",
    {
      appId: { type: "string" },
      type: { type: "string" },
      message: { type: "string" }
    },
    ["message"]
  ),
  tool(
    "get_calendar_month",
    "Get the calendar month view (all events grouped by day) for a given year/month.",
    { year: { type: "integer" }, month: { type: "integer", description: "1-12" } }
  ),
  tool(
    "list_calendar_events",
    "List calendar events between two local date/times.",
    {
      start: { type: "string", description: `Local ${CALENDAR_TIMEZONE} wall-clock time, format YYYY-MM-DDTHH:mm:ss. No timezone offset, no "Z" — do not convert, the server assumes ${CALENDAR_TIMEZONE}.` },
      end: { type: "string", description: `Local ${CALENDAR_TIMEZONE} wall-clock time, same format as start.` },
      limit: { type: "integer" }
    },
    ["start", "end"]
  ),
  tool("get_remaining_calendar_events", "Get the rest of today's remaining calendar events.", {}),
  tool(
    "create_calendar_event",
    `Add an event to the calendar. Resolve relative dates ("tomorrow", "next Tuesday") against the current date/time given in context, but always pass startsAt/endsAt as a plain local ${CALENDAR_TIMEZONE} wall-clock time — never add a timezone offset or "Z" suffix, and never convert to UTC yourself. The server assumes every naive timestamp is ${CALENDAR_TIMEZONE}.`,
    {
      title: { type: "string" },
      startsAt: { type: "string", description: `Local ${CALENDAR_TIMEZONE} wall-clock time, format YYYY-MM-DDTHH:mm:ss (no offset, no "Z").` },
      endsAt: { type: "string", description: "Same format as startsAt. Omit to default to 1 hour after startsAt." },
      location: { type: "string" },
      notes: { type: "string" }
    },
    ["title", "startsAt"]
  ),
  tool(
    "delete_calendar_event",
    "Remove a calendar event by id or by matching title.",
    { eventId: { type: "string" }, title: { type: "string" } }
  ),
  tool(
    "create_project",
    "Create and register a new project folder. If basePath is not given, ask the user where to save it before calling this.",
    {
      appType: { type: "string", enum: ["project-app", "work-app"], description: "project-app for personal, work-app for work/school" },
      basePath: { type: "string", description: "Folder the project directory will be created inside" },
      projectName: { type: "string" }
    },
    ["basePath", "projectName"]
  ),
  tool(
    "open_project",
    "Open an existing managed project by name (fuzzy-matched) or id.",
    { appType: { type: "string", enum: ["project-app", "work-app"] }, projectId: { type: "string" }, projectName: { type: "string" } }
  ),
  tool(
    "list_music_tracks",
    "List music tracks, optionally filtered by artist, genre, or search query.",
    { artist: { type: "string" }, genre: { type: "string" }, query: { type: "string" }, limit: { type: "integer" } }
  ),
  tool("list_music_artists", "List available artists in the music library.", {}),
  tool("list_music_genres", "List available genres in the music library.", {}),
  tool("list_music_playlists", "List playlists and their tracks.", {}),
  tool("create_music_playlist", "Create a new empty playlist by name.", { name: { type: "string" } }, ["name"]),
  tool(
    "add_track_to_playlist",
    "Add a track to a playlist by trackId or trackName.",
    { playlistName: { type: "string" }, trackId: { type: "string" }, trackName: { type: "string" } },
    ["playlistName"]
  ),
  tool(
    "control_music",
    "Control music playback in the running Music App: toggle play/pause, skip, or start a playlist/artist.",
    {
      action: { type: "string", enum: ["play-pause", "next", "prev", "play-playlist", "play-artist"] },
      playlistName: { type: "string" },
      artistName: { type: "string" }
    },
    ["action"]
  ),
  tool("get_news_summary", "Fetch the latest weather, headlines, and tech news and return a spoken-style summary.", {}),
  tool(
    "set_alarm",
    `Create an alarm or timer. "kind":"wakeup" plays a spoken news + today's-schedule briefing once the alarm is turned off, otherwise it's a plain alarm.`,
    {
      time: { type: "string", description: "Local 24-hour time, format HH:mm, e.g. '07:00'." },
      date: {
        type: "string",
        description: "Local YYYY-MM-DD date. Only used when recurrence is 'once'; if omitted, defaults to the next upcoming occurrence of that time."
      },
      recurrence: { type: "string", enum: ["once", "daily", "weekly"] },
      daysOfWeek: {
        type: "array",
        items: { type: "string" },
        description: "Only used when recurrence is 'weekly': array of 'mon'..'sun'."
      },
      label: { type: "string" },
      kind: { type: "string", enum: ["alarm", "wakeup"] }
    },
    ["time", "recurrence"]
  ),
  tool("list_alarms", "List all scheduled alarms.", {}),
  tool("cancel_alarm", "Cancel and delete an alarm by id.", { alarmId: { type: "string" } }, ["alarmId"]),
  tool(
    "stop_alarm",
    "Stop a currently ringing alarm. Omit alarmId to stop every alarm that's ringing right now.",
    { alarmId: { type: "string" } }
  )
];

function tool(name, description, properties, required = []) {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: {
        type: "object",
        properties,
        required
      }
    }
  };
}

export function getToolDefinitions() {
  return TOOL_DEFINITIONS;
}

export async function executeToolCall(toolName, args = {}) {
  switch (toolName) {
    case "get_system_state":
      return ok({
        ...systemConfig,
        ollama: getOllamaState(),
        mode: getModeState().currentMode,
        modeState: getModeState(),
        orchestrator: getOrchestratorStatus()
      });

    case "list_apps":
      return ok({ apps: getAllApps() });

    case "get_app": {
      const appId = String(args.appId || "");
      const app = getAppById(appId);
      if (!app) {
        return fail("APP_NOT_FOUND", `No app found for appId '${appId}'.`);
      }
      return ok({ app });
    }

    case "open_app": {
      const target = String(args.target || "").trim().toLowerCase();
      if (!target) {
        return fail("INVALID_OPEN_TARGET", "open_app requires a target.");
      }

      if (["all", "apps", "all-apps", "everything", "window-apps"].includes(target)) {
        const opened = WINDOW_APPS.map((appId) => openSingleApp(appId));
        return ok({ target: "all-apps", opened, count: opened.length });
      }

      const result = openSingleApp(target);
      if (!result.ok) {
        return result;
      }
      return ok(result);
    }

    case "close_app": {
      const target = String(args.target || "").trim().toLowerCase();
      if (!target) {
        return fail("INVALID_CLOSE_TARGET", "close_app requires a target.");
      }

      const closeAll = ["all", "apps", "all-apps", "window-apps"].includes(target);
      if (!closeAll && !WINDOW_APPS.includes(target)) {
        return fail("INVALID_CLOSE_TARGET", `close_app supports ${WINDOW_APPS.join(", ")}, or 'all-apps'.`);
      }

      const app = closeAll ? null : getAppById(target);
      const label = closeAll ? "all app windows" : app?.name || target;
      const closeTarget = closeAll ? "all-apps" : target;
      const closeResult = closeAppWindow(closeTarget);
      const eventResult = publishEvent({
        appId: closeAll ? "control-center" : target,
        source: "agent",
        type: "close-app",
        message: `Agent closed ${label}.`,
        meta: { target: closeTarget, label, closeAll, directCloseOk: Boolean(closeResult?.ok) }
      });

      return ok({ target: closeTarget, label, closeAll, directClose: closeResult, event: eventResult.event });
    }

    case "connect_app":
      return connectApp(String(args.appId || ""));

    case "get_mode":
      return ok({ mode: getModeState() });

    case "switch_mode":
      return switchMode(String(args.targetMode || "").toLowerCase(), "agent-tool");

    case "get_settings":
      return ok({ settings: getSettings(), options: getSettingsOptions() });

    case "update_desktop_settings":
      return updateDesktopSettings(args);

    case "test_voice": {
      const desktopSettings = getDesktopSettingsLabelValueMap();
      const sampleText = String(args.sampleText || "").trim() || "Voice test complete. Desktop voice settings are active.";
      return ok({ message: "Voice test queued.", sampleText, settings: desktopSettings });
    }

    case "shutdown_app": {
      publishEvent({ appId: "control-center", source: "agent", type: "shutdown", message: "Agent-initiated shutdown." });
      setTimeout(async () => {
        try {
          const http = await import("http");
          const req = http.request({
            hostname: "127.0.0.1",
            port: 3100,
            path: "/api/shutdown",
            method: "POST",
            headers: { "Content-Type": "application/json" }
          });
          req.end();
        } catch {
          process.exit(0);
        }
      }, 1000);
      return ok({ message: "Shutting down Control Center." });
    }

    case "list_events":
      return ok({ events: getRecentEvents(Number(args.limit || 25)) });

    case "publish_event":
      return publishEvent({
        appId: String(args.appId || "control-center"),
        source: "agent",
        type: String(args.type || "status"),
        message: String(args.message || ""),
        meta: {}
      });

    case "get_calendar_month":
      return ok(await getCalendarMonthView({ year: args.year, month: args.month }));

    case "list_calendar_events":
      return ok(await listCalendarEvents({ start: args.start, end: args.end, limit: args.limit }));

    case "get_remaining_calendar_events":
      return ok(await getRemainingCalendarEvents({}));

    case "create_calendar_event": {
      try {
        return ok(
          await createCalendarEvent({
            title: args.title,
            startsAt: args.startsAt,
            endsAt: args.endsAt,
            location: args.location,
            notes: args.notes
          })
        );
      } catch (error) {
        return fail(error?.code || "CREATE_CALENDAR_EVENT_FAILED", error?.message || "Failed to create calendar event.");
      }
    }

    case "delete_calendar_event": {
      try {
        return ok(await deleteCalendarEvent({ eventId: args.eventId, title: args.title }));
      } catch (error) {
        return fail(error?.code || "DELETE_CALENDAR_EVENT_FAILED", error?.message || "Failed to delete calendar event.");
      }
    }

    case "create_project": {
      try {
        return await createProjectTool(args);
      } catch (error) {
        return fail(error?.code || "CREATE_PROJECT_FAILED", error?.message || "Failed to create project.");
      }
    }

    case "open_project": {
      try {
        return await openProjectTool(args);
      } catch (error) {
        return fail(error?.code || "OPEN_PROJECT_FAILED", error?.message || "Failed to open project.");
      }
    }

    case "list_music_tracks":
      return ok(listMusicTracks({ artist: args.artist, genre: args.genre, query: args.query, limit: args.limit }));

    case "list_music_artists":
      return ok({ artists: listMusicArtists() });

    case "list_music_genres":
      return ok({ genres: listMusicGenres() });

    case "list_music_playlists":
      return ok(listMusicPlaylists());

    case "create_music_playlist": {
      try {
        return ok(createMusicPlaylist(args.name));
      } catch (error) {
        return fail(error?.code || "CREATE_PLAYLIST_FAILED", error?.message || "Failed to create playlist.");
      }
    }

    case "add_track_to_playlist": {
      try {
        return ok(addTrackToPlaylist({ playlistName: args.playlistName, trackId: args.trackId, trackName: args.trackName }));
      } catch (error) {
        return fail(error?.code || "ADD_TRACK_FAILED", error?.message || "Failed to add track to playlist.");
      }
    }

    case "control_music": {
      const action = String(args.action || "").trim();
      if (!["play-pause", "next", "prev", "play-playlist", "play-artist"].includes(action)) {
        return fail("INVALID_MUSIC_ACTION", "action must be one of play-pause, next, prev, play-playlist, play-artist.");
      }
      const eventResult = publishEvent({
        appId: "music-app",
        source: "agent",
        type: "music-command",
        message: `Agent sent music command: ${action}.`,
        meta: { action, playlistName: args.playlistName, artistName: args.artistName }
      });
      return ok({ action, event: eventResult.event });
    }

    case "get_news_summary": {
      try {
        return await newsSummaryTool();
      } catch (error) {
        return fail("NEWS_FETCH_FAILED", error?.message || "Failed to fetch news.");
      }
    }

    case "set_alarm": {
      try {
        return ok({ alarm: createAlarm(args) });
      } catch (error) {
        return fail(error?.code || "SET_ALARM_FAILED", error?.message || "Failed to create alarm.");
      }
    }

    case "list_alarms":
      return ok({ alarms: listAlarms() });

    case "cancel_alarm": {
      try {
        return ok({ alarm: cancelAlarm(String(args.alarmId || "")) });
      } catch (error) {
        return fail(error?.code || "CANCEL_ALARM_FAILED", error?.message || "Failed to cancel alarm.");
      }
    }

    case "stop_alarm": {
      try {
        return ok({ alarms: stopAlarm(args.alarmId ? String(args.alarmId) : undefined) });
      } catch (error) {
        return fail(error?.code || "STOP_ALARM_FAILED", error?.message || "Failed to stop alarm.");
      }
    }

    default:
      return fail("UNKNOWN_TOOL", `Tool '${toolName}' is not supported.`);
  }
}

async function createProjectTool(args) {
  const appType = String(args.appType || "project-app").trim() === "work-app" ? "work-app" : "project-app";
  const basePath = String(args.basePath || "").trim();
  const requestedName = String(args.projectName || "").trim();

  if (!basePath) {
    return fail("INVALID_BASE_PATH", "create_project requires basePath.");
  }
  if (!requestedName) {
    return fail("INVALID_PROJECT_NAME", "create_project requires projectName.");
  }

  const safeProjectName = sanitizeProjectName(requestedName);
  if (!safeProjectName) {
    return fail("INVALID_PROJECT_NAME", "Project name contains only unsupported characters.");
  }

  const projectFolderPath = path.resolve(basePath, safeProjectName);

  try {
    mkdirSync(basePath, { recursive: true });
  } catch {
    return fail("INVALID_BASE_PATH", `Base path is not accessible: ${basePath}`);
  }

  if (existsSync(projectFolderPath) && !isDirectoryPath(projectFolderPath)) {
    return fail("INVALID_PROJECT_PATH", `A file exists at ${projectFolderPath}.`);
  }

  const createdNewFolder = !existsSync(projectFolderPath);
  mkdirSync(projectFolderPath, { recursive: true });

  if (createdNewFolder) {
    scaffoldProjectFolder(projectFolderPath, safeProjectName);
  }

  const projectResult = createProject(appType, safeProjectName, projectFolderPath);
  const appId = appType === "work-app" ? "work-app" : "project-app";
  const tab = `app:${appId}`;
  const openEvent = publishEvent({
    appId,
    source: "agent",
    type: "open-app",
    message: `Agent opened ${appType === "work-app" ? "Work App" : "Personal Projects"}.`,
    meta: { target: appId, tab, label: appType === "work-app" ? "Work App" : "Personal Projects", isWindowApp: true }
  }).event;

  return ok({ appType, project: projectResult.project, createdNewFolder, event: openEvent });
}

async function openProjectTool(args) {
  const requestedAppType = String(args.appType || "").trim();
  const appType = requestedAppType === "work-app" || requestedAppType === "project-app" ? requestedAppType : null;
  const projectId = String(args.projectId || "").trim();
  const projectName = String(args.projectName || "").trim();

  if (!projectId && !projectName) {
    return fail("INVALID_PROJECT_TARGET", "open_project requires projectId or projectName.");
  }

  const match = findManagedProject({ appType, projectId, projectName });
  if (!match) {
    return fail("PROJECT_NOT_FOUND", "No matching project found. Try a more specific project name.");
  }

  const openResult = openProjectNode(match.appType, match.project.id, match.project.path);
  const targetAppId = match.appType === "work-app" ? "work-app" : "project-app";
  const tab = `app:${targetAppId}`;
  const openEvent = publishEvent({
    appId: targetAppId,
    source: "agent",
    type: "open-app",
    message: `Agent opened ${match.project.name}.`,
    meta: {
      target: targetAppId,
      tab,
      label: targetAppId === "work-app" ? "Work App" : "Personal Projects",
      isWindowApp: true,
      projectId: match.project.id,
      projectPath: match.project.path
    }
  }).event;

  return ok({ appType: match.appType, project: match.project, message: openResult.message, event: openEvent });
}

async function newsSummaryTool() {
  const briefing = await getNewsBriefing();
  if (!briefing.ok) {
    return fail("NEWS_FETCH_FAILED", "Could not fetch news at this time.");
  }

  return ok({ summary: formatNewsSummary(briefing), digest: briefing.chatbotDigest });
}

function openSingleApp(target) {
  const isSystemTab = SYSTEM_TABS.includes(target);
  const app = isSystemTab ? null : getAppById(target);

  if (!isSystemTab && !app) {
    return fail("APP_NOT_FOUND", `No app found for target '${target}'.`);
  }

  const isWindowApp = WINDOW_APPS.includes(target);
  const tab = isSystemTab ? target : `app:${app.id}`;
  const label = isSystemTab ? target : app.name;
  const eventResult = publishEvent({
    appId: isSystemTab ? "control-center" : app.id,
    source: "agent",
    type: "open-app",
    message: `Agent opened ${label}.`,
    meta: { target, tab, label, isWindowApp }
  });

  return { ok: true, target, tab, label, isWindowApp, event: eventResult.event };
}

function ok(data) {
  return { ok: true, ...data };
}

function fail(code, message) {
  return { ok: false, code, message };
}

function sanitizeProjectName(name) {
  const safeName = String(name || "")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!safeName || safeName === "." || safeName === "..") {
    return "";
  }
  return safeName;
}

function isDirectoryPath(targetPath) {
  try {
    return readdirSync(targetPath) && true;
  } catch {
    return false;
  }
}

function scaffoldProjectFolder(projectPath, projectName) {
  mkdirSync(path.join(projectPath, "src"), { recursive: true });
  mkdirSync(path.join(projectPath, "docs"), { recursive: true });
  const readmePath = path.join(projectPath, "README.md");
  if (!existsSync(readmePath)) {
    writeFileSync(readmePath, `# ${projectName}\n\nCreated from Control Center chatbot.\n`);
  }
}

function findManagedProject({ appType, projectId, projectName }) {
  if (projectId && appType) {
    const direct = getManagedProjectById(appType, projectId);
    if (direct) {
      return { appType, project: direct };
    }
  }

  const pools = appType
    ? [{ appType, projects: appType === "work-app" ? getWorkProjects() : getPersonalProjects() }]
    : [
        { appType: "project-app", projects: getPersonalProjects() },
        { appType: "work-app", projects: getWorkProjects() }
      ];

  const normalizedName = String(projectName || "").trim().toLowerCase();

  for (const pool of pools) {
    if (projectId) {
      const byId = pool.projects.find((project) => project.id === projectId);
      if (byId) {
        return { appType: pool.appType, project: byId };
      }
    }
    if (normalizedName) {
      const exact = pool.projects.find((project) => project.name.toLowerCase() === normalizedName);
      if (exact) {
        return { appType: pool.appType, project: exact };
      }
      const partial = pool.projects.find((project) => project.name.toLowerCase().includes(normalizedName));
      if (partial) {
        return { appType: pool.appType, project: partial };
      }
    }
  }

  return null;
}
