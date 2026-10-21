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
import { startWikipedia } from "./wikipediaService.js";
import { launchGestureRecorder, launchFileExplorer, stopFileSystem } from "./fileSystemService.js";

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
  "file-system-app"
];
// Window apps whose "window" is a native process rather than an Electron
// BrowserWindow. They go through exactly the same open/close paths as the
// rest (including "all"); opening additionally launches the process here on
// the server, so it works with no UI client connected (voice), and closing
// stops it. The client/Electron open path is idempotent (alreadyRunning).
const NATIVE_PROCESS_APPS = {
  "file-system-app": {
    launch: () => launchFileExplorer(),
    stop: () => stopFileSystem("all")
  }
};
const SYSTEM_TABS = ["overview", "settings", "chatbot", "event-bus", "agent-core", "integration-hub"];

// JSON-schema tool definitions in Ollama's native function-calling format.
export const TOOL_DEFINITIONS = [
  tool("get_system_state", "Get Control Center system runtime state (Ollama connection, mode, orchestrator).", {}),
  tool("list_apps", "List all registered apps.", {}),
  tool("get_app", "Get one app's details by appId.", { appId: { type: "string" } }, ["appId"]),
  tool(
    "open_app",
    `Open an app tab or system tab in the Control Center UI. Only call this when the user explicitly asks to open, show or launch an app ("open the calendar"). Never use it to answer a question: for "what do I have scheduled?" read the calendar tools and answer in your reply, without opening anything. This opens exactly ONE target per call. If the user names two or more SPECIFIC apps ("open calendar and music"), call this once per named app — do NOT use target "all" for that, it is not a shortcut for "several." Only use target "all" when the user asks for literally every app / everything, with no specific apps named.`,
    { target: { type: "string", description: `One of: ${[...SYSTEM_TABS, ...WINDOW_APPS].join(", ")}, or "all" — but ONLY "all" when the user did not name specific apps. file-system-app is the gesture-controlled "file system" / "file explorer" (formerly called the "hand tracker"; it turns on the webcam).` } },
    ["target"]
  ),
  tool(
    "close_app",
    "Close an open app window. For file-system-app this stops its running file explorer and gesture recorder.",
    { target: { type: "string", description: `One of: ${WINDOW_APPS.join(", ")}, or 'all-apps'.` } },
    ["target"]
  ),
  tool("connect_app", "Run the connector handshake for one app.", { appId: { type: "string" } }, ["appId"]),
  tool(
    "start_gesture_recorder",
    `Launch the File System gesture recorder, which records labeled training clips of the user's own hand gestures. Stops the File System app's file explorer if it is running (they share the webcam). Use label "none" for background/negative examples.`,
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
    `Create an alarm or timer. It rings on the device the user asked from (their phone or the PC). For relative requests ("set an alarm in 30 seconds", "a 2 minute alarm", "timer for an hour") pass inSeconds (30, 120, 3600) and omit time, date and recurrence. Defaults to a plain "alarm" — only use "wakeup" if the user's own words explicitly ask for a wake-up alarm (e.g. they say "wake-up alarm" or "wake me up"). A time like 7am by itself is NOT a reason to pick "wakeup" — plenty of plain alarms are set for the morning. The result includes "nextFireAtLocal", an already-local-timezone-formatted date/time string — always use that when telling the user when the alarm will go off, never the raw "nextFireAt" UTC value (reading a UTC timestamp directly will often show the wrong calendar day).`,
    {
      time: { type: "string", description: "Local 24-hour time, format HH:mm, e.g. '07:00'. Omit when using inSeconds." },
      inSeconds: {
        type: "integer",
        description: "For relative alarms and timers only: seconds from now (30 seconds = 30, 2 minutes = 120, 1 hour = 3600). Use this instead of time; never compute a clock time yourself for these."
      },
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
    []
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

const AGENT_DATE_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: CALENDAR_TIMEZONE,
  weekday: "long",
  year: "numeric",
  month: "long",
  day: "numeric"
});

/**
 * Calendar events store UTC instants (startAt "2026-10-22T02:00:00.000Z" is
 * 7 PM on Oct 21 in Los Angeles). Handed to the model raw, it reads the UTC
 * date and reports evening events as "tomorrow". So the model only ever sees
 * local wall-clock fields: date, start and end time, never the UTC instants.
 */
function localizeCalendarForAgent(value) {
  if (Array.isArray(value)) {
    return value.map(localizeCalendarForAgent);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  if (typeof value.startAt === "string" && "title" in value) {
    const { startAt, endAt, startDateKey, startLabel, endLabel, accent, ...rest } = value;
    const start = new Date(startAt);
    const end = endAt ? new Date(endAt) : null;
    const endDate = end ? AGENT_DATE_FORMAT.format(end) : null;
    const startDate = AGENT_DATE_FORMAT.format(start);
    return {
      ...rest,
      date: startDate,
      startTime: startLabel,
      ...(endLabel ? { endTime: endLabel } : {}),
      // Only for events that run past midnight.
      ...(endDate && endDate !== startDate ? { endDate } : {})
    };
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      // Any other UTC instant (query range, "now") gets the same treatment.
      typeof entry === "string" && UTC_INSTANT_PATTERN.test(entry)
        ? AGENT_DATE_TIME_FORMAT.format(new Date(entry))
        : localizeCalendarForAgent(entry)
    ])
  );
}

const UTC_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const AGENT_DATE_TIME_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: CALENDAR_TIMEZONE,
  weekday: "long",
  year: "numeric",
  month: "long",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit"
});

// Tools that act on the PC itself in ways a remote device must not trigger,
// even through Jarvis (so a prompt injection reaching Jarvis from the phone
// can't do anything the phone couldn't do directly).
const DESKTOP_ONLY_TOOLS = new Set([
  "shutdown_app",
  "update_desktop_settings",
  "test_voice",
  "switch_mode",
  "publish_event",
  "connect_app",
  "create_project",
  "open_project",
  "start_gesture_recorder"
]);

/** True when a turn came from a paired remote device rather than the PC. */
function isRemoteOrigin(origin) {
  return Boolean(origin?.device && origin.device.kind !== "desktop");
}

/**
 * `context.origin` is the turn's origin (see queueWorker) — it decides
 * whether desktop-only tools are allowed and which device open/close_app act on.
 */
export async function executeToolCall(toolName, args = {}, context = {}) {
  const remoteDevice = isRemoteOrigin(context.origin) ? context.origin.device : null;
  if (remoteDevice && DESKTOP_ONLY_TOOLS.has(toolName)) {
    return fail(
      "DESKTOP_ONLY_TOOL",
      `'${toolName}' only works when asked from the PC, not from ${remoteDevice.name || "a remote device"}.`
    );
  }

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
        if (remoteDevice) {
          return fail("ONE_APP_AT_A_TIME", "On the phone, apps open one at a time. Ask for a specific app.");
        }
        const opened = await Promise.all(WINDOW_APPS.map((appId) => openSingleApp(appId)));
        return ok({ target: "all-apps", opened, count: opened.filter((entry) => entry.ok).length });
      }

      const result = await openSingleApp(target, { targetDevice: remoteDevice });
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

      if (remoteDevice) {
        // Closing from the phone closes it on the phone; PC windows and
        // processes are left alone.
        const closeTarget = closeAll ? "all-apps" : target;
        const eventResult = publishEvent({
          appId: closeAll ? "control-center" : target,
          source: "agent",
          type: "close-app",
          message: `Agent closed ${closeAll ? "all apps" : getAppById(target)?.name || target} on ${remoteDevice.name}.`,
          meta: { target: closeTarget, closeAll, targetDeviceId: remoteDevice.id }
        });
        return ok({ target: closeTarget, closeAll, targetDeviceId: remoteDevice.id, event: eventResult.event });
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
      return ok(localizeCalendarForAgent(await getCalendarMonthView({ year: args.year, month: args.month })));

    case "list_calendar_events":
      return ok(localizeCalendarForAgent(await listCalendarEvents({ start: args.start, end: args.end, limit: args.limit })));

    case "get_remaining_calendar_events":
      return ok(localizeCalendarForAgent(await getRemainingCalendarEvents({})));

    case "create_calendar_event": {
      try {
        return ok(
          localizeCalendarForAgent(
            await createCalendarEvent({
              title: args.title,
              startsAt: args.startsAt,
              endsAt: args.endsAt,
              location: args.location,
              notes: args.notes
            })
          )
        );
      } catch (error) {
        return fail(error?.code || "CREATE_CALENDAR_EVENT_FAILED", error?.message || "Failed to create calendar event.");
      }
    }

    case "delete_calendar_event": {
      try {
        return ok(localizeCalendarForAgent(await deleteCalendarEvent({ eventId: args.eventId, title: args.title })));
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
        // The alarm rings on the device the user asked from.
        return ok({ alarm: createAlarm({ ...args, device: context.origin?.device || null }) });
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

async function openSingleApp(target, { targetDevice = null } = {}) {
  const isSystemTab = SYSTEM_TABS.includes(target);
  const app = isSystemTab ? null : getAppById(target);

  if (!isSystemTab && !app) {
    return fail("APP_NOT_FOUND", `No app found for target '${target}'.`);
  }

  if (targetDevice) {
    // Opening from the phone opens it on the phone: no PC window, no PC
    // process (e.g. the webcam-based File System explorer stays off).
    const tab = isSystemTab ? target : `app:${app.id}`;
    const label = isSystemTab ? target : app.name;
    const eventResult = publishEvent({
      appId: isSystemTab ? "control-center" : app.id,
      source: "agent",
      type: "open-app",
      message: `Agent opened ${label} on ${targetDevice.name}.`,
      meta: { target, tab, label, targetDeviceId: targetDevice.id }
    });
    return { ok: true, target, tab, label, targetDeviceId: targetDevice.id, event: eventResult.event };
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
