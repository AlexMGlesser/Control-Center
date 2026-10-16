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
import { queryLibrarian, startWikipedia } from "./wikipediaService.js";
import { launchGestureRecorder, launchHandExplorer, stopHandTracker } from "./handTrackerService.js";

const CALENDAR_TIMEZONE = getCalendarTimeZone();

const WINDOW_APPS = [
  "calendar-app",
  "news-app",
  "work-app",
  "project-app",
  "music-app",
  "drawing-app",
  "movie-app",
  "server-manager-app",
  "wikipedia-app",
  "hand-tracker-app"
];
// Window apps whose "window" is a native process rather than an Electron
// BrowserWindow. They go through exactly the same open/close paths as the
// rest (including "all"); opening additionally launches the process here on
// the server, so it works with no UI client connected (voice), and closing
// stops it. The client/Electron open path is idempotent (alreadyRunning).
const NATIVE_PROCESS_APPS = {
  "hand-tracker-app": {
    launch: () => launchHandExplorer(),
    stop: () => stopHandTracker("all")
  }
};
const SYSTEM_TABS = ["overview", "settings", "chatbot", "event-bus", "agent-core", "integration-hub"];

// Size caps for wiki tool results — everything returned lands in the model's
// 16k-token context (see num_ctx in ollamaService.js) next to a large system
// prompt, so results are trimmed hard here rather than trusting the model to
// ask for little.
const WIKI_SEARCH_DEFAULT_LIMIT = 5;
const WIKI_SEARCH_MAX_LIMIT = 8;
const WIKI_SNIPPET_CHARS = 200;
const WIKI_ARTICLE_DEFAULT_CHARS = 3000;
const WIKI_ARTICLE_MAX_CHARS = 6000;
const WIKI_MAX_SECTION_NAMES = 25;

// JSON-schema tool definitions in Ollama's native function-calling format.
export const TOOL_DEFINITIONS = [
  tool("get_system_state", "Get Control Center system runtime state (Ollama connection, mode, orchestrator).", {}),
  tool("list_apps", "List all registered apps.", {}),
  tool("get_app", "Get one app's details by appId.", { appId: { type: "string" } }, ["appId"]),
  tool(
    "open_app",
    `Open an app tab or system tab in the Control Center UI. This opens exactly ONE target per call. If the user names two or more SPECIFIC apps ("open calendar and music"), call this once per named app — do NOT use target "all" for that, it is not a shortcut for "several." Only use target "all" when the user asks for literally every app / everything, with no specific apps named.`,
    { target: { type: "string", description: `One of: ${[...SYSTEM_TABS, ...WINDOW_APPS].join(", ")}, or "all" — but ONLY "all" when the user did not name specific apps. hand-tracker-app is the gesture-controlled "file explorer" / "hand tracker" (it turns on the webcam).` } },
    ["target"]
  ),
  tool(
    "close_app",
    "Close an open app window. For hand-tracker-app this stops its running file explorer and gesture recorder.",
    { target: { type: "string", description: `One of: ${WINDOW_APPS.join(", ")}, or 'all-apps'.` } },
    ["target"]
  ),
  tool("connect_app", "Run the connector handshake for one app.", { appId: { type: "string" } }, ["appId"]),
  tool(
    "start_gesture_recorder",
    `Launch the Hand Tracker gesture recorder, which records labeled training clips of the user's own hand gestures. Stops the hand-tracker file explorer if it is running (they share the webcam). Use label "none" for background/negative examples.`,
    {
      label: { type: "string", description: `Gesture label, e.g. "swipe_left". Lowercase letters, digits, '_' or '-'.` },
      reps: { type: "integer", description: "Number of repetitions to record (1-500). Omit for the recorder's default (10)." },
      autostart: { type: "boolean", description: "Start the countdown/record loop as soon as the camera is ready. Only if the user asks to start right away." }
    }
  ),
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
    `List tracks from the small built-in starter catalog only (not the user's real synced music — that lives in playlists, see list_music_playlists). Optionally filtered by artist, genre, or search query.`,
    { artist: { type: "string" }, genre: { type: "string" }, query: { type: "string" }, limit: { type: "integer" } }
  ),
  tool("list_music_artists", "List artists in the small built-in starter catalog only — NOT the user's real music. For \"what artists/songs do I have\" questions, use list_music_playlists instead; the user's actual local music is organized as playlists, not a flat artist/track catalog.", {}),
  tool("list_music_genres", "List genres in the small built-in starter catalog only (not the user's real music).", {}),
  tool(
    "list_music_playlists",
    `List the user's real playlists and their tracks — this is the authoritative source for "what music/songs/artists do I have" questions, NOT list_music_tracks/list_music_artists (those only cover a small unrelated starter catalog). Playlist names often ARE artist or album names (e.g. a playlist named "Sixx AM" contains that artist's songs) — check playlist names and their track lists before saying the user doesn't have something.`,
    {}
  ),
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
    `Create an alarm or timer. Defaults to a plain "alarm" — only use "wakeup" if the user's own words explicitly ask for a wake-up alarm (e.g. they say "wake-up alarm" or "wake me up"). A time like 7am by itself is NOT a reason to pick "wakeup" — plenty of plain alarms are set for the morning. The result includes "nextFireAtLocal", an already-local-timezone-formatted date/time string — always use that when telling the user when the alarm will go off, never the raw "nextFireAt" UTC value (reading a UTC timestamp directly will often show the wrong calendar day).`,
    {
      time: { type: "string", description: "Local 24-hour time, format HH:mm, e.g. '07:00'." },
      date: {
        type: "string",
        description: "Local YYYY-MM-DD date. Only set this if the user named a specific day (e.g. \"tomorrow\", \"next Friday\", a date). If they just gave a bare time with no day mentioned, omit this entirely — the server will correctly pick today if that time hasn't passed yet, or the next occurrence otherwise. Do not compute or guess a date yourself when none was mentioned."
      },
      recurrence: { type: "string", enum: ["once", "daily", "weekly"] },
      daysOfWeek: {
        type: "array",
        items: { type: "string" },
        description: "Only used when recurrence is 'weekly': array of 'mon'..'sun'."
      },
      label: { type: "string" },
      kind: {
        type: "string",
        enum: ["alarm", "wakeup"],
        description: `Default "alarm". Only set "wakeup" when the user explicitly said the words "wake up" / "wake-up alarm" themselves — never infer it from the time alone. "wakeup" plays a spoken news + today's-schedule briefing once turned off.`
      }
    },
    ["time", "recurrence"]
  ),
  tool(
    "search_wikipedia",
    `Search Alex's offline copy of English Wikipedia (stored on this computer, no internet needed). Use this FIRST for any factual, encyclopedic, historical, scientific, geographic or biographical question ("who was...", "what is...", "when did...", "how does X work", "how far/big/old is...") instead of answering from memory — your memory can be wrong or out of date; the archive is the source to trust. Pass 1-4 key words, not the whole question (e.g. "speed of light", not "how fast does light travel"). Returns ranked article titles with short snippets; then call read_wikipedia_article on the best-matching title to get the facts. A search can take a minute or more when the disk cache is cold — that is normal, don't repeat the same search.`,
    {
      query: { type: "string", description: "1-4 key words. Put an exact phrase in double quotes." },
      limit: { type: "integer", description: `Results to return, 1-${WIKI_SEARCH_MAX_LIMIT} (default ${WIKI_SEARCH_DEFAULT_LIMIT}).` }
    },
    ["query"]
  ),
  tool(
    "read_wikipedia_article",
    `Read an article from the offline Wikipedia archive by its exact title (as returned by search_wikipedia; redirects are followed). Returns the article's opening text (size-capped), whether it was cut off, and its section names. Pass "section" to read one specific section (e.g. "History") when the answer is further down. Answer the user from this text and name the article title(s) you used in your reply (e.g. "According to Wikipedia's article on Ada Lovelace, ..."). If the text doesn't contain the answer, say the archive didn't cover it rather than filling the gap from memory. Note: this offline text drops Wikipedia templates, so some figures (e.g. heights/distances written as unit conversions) are missing and a sentence can read "measured as ." — if the number you need is missing, say the archive's text leaves it out instead of writing an incomplete sentence.`,
    {
      title: { type: "string", description: "Exact article title, e.g. \"Ada Lovelace\"." },
      section: { type: "string", description: "Optional section name from the article's sections list." },
      maxChars: { type: "integer", description: `Max characters of text, up to ${WIKI_ARTICLE_MAX_CHARS} (default ${WIKI_ARTICLE_DEFAULT_CHARS}).` }
    },
    ["title"]
  ),
  tool("list_alarms", `List all scheduled alarms. Use each alarm's "nextFireAtLocal" field to report when it fires, not the raw "nextFireAt" UTC value.`, {}),
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
        const opened = await Promise.all(WINDOW_APPS.map((appId) => openSingleApp(appId)));
        return ok({ target: "all-apps", opened, count: opened.filter((entry) => entry.ok).length });
      }

      const result = await openSingleApp(target);
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

      // Native-process apps are stopped here (awaited), not only via the
      // desktop window bridge below, so closing works without Electron too.
      const nativeTargets = Object.keys(NATIVE_PROCESS_APPS).filter((appId) => closeAll || appId === target);
      const nativeStops = [];
      for (const appId of nativeTargets) {
        const stopResult = await NATIVE_PROCESS_APPS[appId].stop();
        nativeStops.push({ target: appId, ok: stopResult.ok, stopped: stopResult.stopped });
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

      return ok({
        target: closeTarget,
        label,
        closeAll,
        directClose: closeResult,
        event: eventResult.event,
        ...(nativeStops.length ? { nativeStops } : {})
      });
    }

    case "connect_app":
      return connectApp(String(args.appId || ""));

    case "start_gesture_recorder": {
      const result = await launchGestureRecorder({
        label: args.label,
        reps: args.reps,
        autostart: args.autostart === true
      });
      if (!result.ok) {
        return result;
      }
      return ok({
        process: "recorder",
        pid: result.pid,
        args: result.args,
        alreadyRunning: Boolean(result.alreadyRunning),
        stoppedExplorer: result.stoppedOther === "explorer",
        message: result.alreadyRunning
          ? "Gesture recorder was already running; its settings were not changed."
          : "Gesture recorder window launched."
      });
    }

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

      const needsAppOpen = action === "play-playlist" || action === "play-artist";
      let openResult = null;
      if (needsAppOpen) {
        // The music app has to actually be open (and have loaded its
        // command listener) to receive this. If it's already open, this is
        // a harmless no-op focus; if not, opening it now plus the
        // "openApp" flag below lets the music app's own startup replay
        // logic pick this exact command up once it finishes loading —
        // otherwise a play-playlist/play-artist command sent to a closed
        // app is silently lost with nothing listening for it.
        openResult = await openSingleApp("music-app");
      }

      const eventResult = publishEvent({
        appId: "music-app",
        source: "agent",
        type: "music-command",
        message: `Agent sent music command: ${action}.`,
        meta: { action, playlistName: args.playlistName, artistName: args.artistName, openApp: needsAppOpen }
      });
      return ok({ action, event: eventResult.event, openedApp: Boolean(openResult?.ok) });
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

    case "search_wikipedia":
      return await searchWikipediaTool(args);

    case "read_wikipedia_article":
      return await readWikipediaArticleTool(args);

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

async function searchWikipediaTool(args) {
  const query = String(args.query || "").trim();
  if (!query) {
    return fail("INVALID_WIKI_QUERY", "search_wikipedia requires a query.");
  }

  const limit = clampInt(args.limit, 1, WIKI_SEARCH_MAX_LIMIT, WIKI_SEARCH_DEFAULT_LIMIT);
  const response = await queryLibrarian("search", { q: query, limit });
  if (!response.ok) {
    return response;
  }
  if (response.data?.error) {
    return fail("WIKI_SEARCH_FAILED", String(response.data.error));
  }

  const results = (response.data.results || []).map((entry) => ({
    title: entry.title,
    snippet: trimText(entry.snippet, WIKI_SNIPPET_CHARS)
  }));
  return ok({
    query,
    totalMatches: response.data.total_matches,
    results,
    ...(response.data.note ? { note: response.data.note } : {}),
    ...(results.length ? {} : { hint: "Nothing found. Try fewer, broader or different key words." })
  });
}

async function readWikipediaArticleTool(args) {
  const title = String(args.title || "").trim();
  if (!title) {
    return fail("INVALID_WIKI_TITLE", "read_wikipedia_article requires a title.");
  }

  const maxChars = clampInt(args.maxChars, 500, WIKI_ARTICLE_MAX_CHARS, WIKI_ARTICLE_DEFAULT_CHARS);
  const section = String(args.section || "").trim();
  const response = await queryLibrarian("article", { title, section, max_chars: maxChars });
  if (!response.ok) {
    return response;
  }

  const data = response.data || {};
  if (data.error) {
    // The librarian reports a missing section with the article's section list,
    // and a missing article with "did you mean" title suggestions.
    const sectionMissing = Array.isArray(data.sections);
    return {
      ...fail(sectionMissing ? "WIKI_SECTION_NOT_FOUND" : "WIKI_ARTICLE_NOT_FOUND", String(data.error)),
      ...(data.did_you_mean?.length ? { didYouMean: data.did_you_mean } : {}),
      ...(sectionMissing ? { sections: data.sections.slice(0, WIKI_MAX_SECTION_NAMES) } : {}),
      hint: sectionMissing ? "Pick a section from the list." : "Use search_wikipedia to find the exact title."
    };
  }

  const sections = (data.sections || []).filter((name) => name !== "Introduction");
  return ok({
    title: data.title,
    ...(data.redirected_from ? { redirectedFrom: data.redirected_from } : {}),
    ...(section ? { section } : {}),
    text: String(data.text || "").slice(0, maxChars),
    truncated: Boolean(data.truncated),
    sections: sections.slice(0, WIKI_MAX_SECTION_NAMES).map((name) => trimText(name, 60)),
    source: `Wikipedia (offline archive): ${data.title}`
  });
}

function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}

function trimText(text, maxChars) {
  const clean = String(text || "")
    .replace(/\s+/g, " ")
    .replace(/\s*…\s*$/, "")
    .trim();
  return clean.length > maxChars ? `${clean.slice(0, maxChars - 1).trimEnd()}…` : clean;
}

async function openSingleApp(target) {
  const isSystemTab = SYSTEM_TABS.includes(target);
  const app = isSystemTab ? null : getAppById(target);

  if (!isSystemTab && !app) {
    return fail("APP_NOT_FOUND", `No app found for target '${target}'.`);
  }

  let nativeLaunch = null;
  if (NATIVE_PROCESS_APPS[target]) {
    nativeLaunch = await NATIVE_PROCESS_APPS[target].launch();
    if (!nativeLaunch.ok) {
      return { ...nativeLaunch, target };
    }
  }

  const isWindowApp = WINDOW_APPS.includes(target);
  if (target === "wikipedia-app") {
    // Start the librarian server now rather than waiting for the window's
    // wrapper page to ask for it, so open_app (including "all" and voice)
    // starts it even with no UI attached. Fire-and-forget: the wrapper page
    // shares the same in-flight start.
    startWikipedia().catch(() => {});
  }
  const tab = isSystemTab ? target : `app:${app.id}`;
  const label = isSystemTab ? target : app.name;
  const nativeMeta = nativeLaunch
    ? { isNativeApp: true, pid: nativeLaunch.pid, alreadyRunning: Boolean(nativeLaunch.alreadyRunning) }
    : {};
  const eventResult = publishEvent({
    appId: isSystemTab ? "control-center" : app.id,
    source: "agent",
    type: "open-app",
    message: `Agent opened ${label}.`,
    meta: { target, tab, label, isWindowApp, ...nativeMeta }
  });

  return {
    ok: true,
    target,
    tab,
    label,
    isWindowApp,
    ...nativeMeta,
    ...(nativeLaunch?.stoppedOther ? { stoppedOther: nativeLaunch.stoppedOther } : {}),
    event: eventResult.event
  };
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
