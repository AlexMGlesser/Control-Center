import { systemConfig } from "../config.js";
import { connectApp, getOrchestratorStatus } from "./orchestrator.js";
import { getAllApps, getAppById } from "./appRegistry.js";
import { getModeState, switchMode } from "./modeStateMachine.js";
import path from "path";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "fs";
import {
  getSettings,
  getDesktopSettingsLabelValueMap,
  getSettingsOptions,
  updateDesktopSettings
} from "./settingsService.js";
import { getRecentEvents, publishEvent } from "./eventBus.js";
import { getLmStudioState } from "./lmStudioService.js";
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
  getRemainingCalendarEvents,
  listCalendarEvents,
} from "./calendarService.js";
import {
  addTrackToPlaylist,
  createMusicPlaylist,
  listMusicArtists,
  listMusicGenres,
  listMusicPlaylists,
  listMusicTracks
} from "./musicLibraryService.js";
import { getNewsBriefing } from "./newsService.js";

const TOOL_DEFINITIONS = [
  { name: "get_system_state", description: "Get Control Center system runtime state." },
  { name: "list_apps", description: "List all registered apps." },
  { name: "get_app", description: "Get one app by appId." },
  { name: "open_app", description: "Open an app or system tab in the Control Center UI." },
  { name: "connect_app", description: "Run connector handshake for one app." },
  { name: "get_mode", description: "Get current mode state." },
  { name: "switch_mode", description: "Switch desktop/mobile mode." },
  { name: "get_settings", description: "Get settings and options." },
  { name: "update_desktop_settings", description: "Update desktop settings." },
  { name: "test_voice", description: "Run voice test with current desktop settings." },
  { name: "list_events", description: "List recent event bus entries." },
  { name: "publish_event", description: "Publish an event to event bus." },
  { name: "get_calendar_month", description: "Get the calendar month view with events for the month grid." },
  { name: "list_calendar_events", description: "List calendar events in a date range." },
  { name: "get_remaining_calendar_events", description: "Read the rest of today's calendar events without opening the app." },
  { name: "create_calendar_event", description: "Add an event to the calendar." },
  { name: "delete_calendar_event", description: "Remove an event from the calendar by id or title." },
  { name: "create_project", description: "Create and register a new project folder, with optional app open." },
  { name: "open_project", description: "Open a managed project by name or id and optionally open the app UI." },
  { name: "list_music_tracks", description: "List music tracks with optional genre, artist, or query filters." },
  { name: "list_music_artists", description: "List available artists in the music catalog." },
  { name: "list_music_genres", description: "List available genres in the music catalog." },
  { name: "list_music_playlists", description: "List playlists and included tracks." },
  { name: "create_music_playlist", description: "Create a new playlist by name." },
  { name: "add_track_to_playlist", description: "Add a track to a playlist using trackId or trackName." },
  { name: "get_news_summary", description: "Fetch latest news headlines and return a spoken summary." }
];

export function getToolDefinitions() {
  return TOOL_DEFINITIONS;
}

export function getToolNamesSet() {
  return new Set(TOOL_DEFINITIONS.map((tool) => tool.name));
}

export async function executeToolCall(toolName, args = {}) {
  switch (toolName) {
    case "get_system_state":
      return ok({
        ...systemConfig,
        lmStudio: getLmStudioState(),
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
      const target = String(args.target || args.appId || args.app_name || "").trim();
      if (!target) {
        return fail("INVALID_OPEN_TARGET", "open_app requires a target or appId.");
      }

      const isSystemTab = ["overview", "settings", "chatbot", "event-bus", "agent-core", "integration-hub"].includes(target);
      const windowApps = ["calendar-app", "news-app", "work-app", "project-app", "music-app"];
      const isWindowApp = windowApps.includes(target);
      const app = isSystemTab ? null : getAppById(target);

      if (!isSystemTab && !app) {
        return fail("APP_NOT_FOUND", `No app found for target '${target}'.`);
      }

      const tab = isSystemTab ? target : `app:${app.id}`;
      const label = isSystemTab ? target : app.name;
      const eventResult = publishEvent({
        appId: isSystemTab ? "control-center" : app.id,
        source: "agent",
        type: "open-app",
        message: `Agent opened ${label}.`,
        meta: {
          target,
          tab,
          label,
          isWindowApp
        }
      });

      return ok({
        target,
        tab,
        label,
        isWindowApp,
        event: eventResult.event
      });
    }

    case "connect_app": {
      const appId = String(args.appId || "");
      return connectApp(appId);
    }

    case "get_mode":
      return ok({ mode: getModeState() });

    case "switch_mode": {
      const targetMode = String(args.targetMode || "").toLowerCase();
      const source = String(args.source || "agent-tool");
      return switchMode(targetMode, source);
    }

    case "get_settings":
      return ok({ settings: getSettings(), options: getSettingsOptions() });

    case "update_desktop_settings":
      return updateDesktopSettings(args);

    case "test_voice": {
      const desktopSettings = getDesktopSettingsLabelValueMap();
      const sampleText =
        String(args.sampleText || "").trim() ||
        "Voice test complete. Desktop voice settings are active.";
      return ok({
        message: "Voice test queued.",
        sampleText,
        settings: desktopSettings
      });
    }

    case "shutdown_app": {
      publishEvent({
        appId: "control-center",
        source: "agent",
        type: "shutdown",
        message: "Agent-initiated shutdown."
      });

      setTimeout(async () => {
        try {
          const http = await import("http");
          const req = http.request({ hostname: "127.0.0.1", port: 3100, path: "/api/shutdown", method: "POST", headers: { "Content-Type": "application/json" } });
          req.end();
        } catch { process.exit(0); }
      }, 1000);

      return ok({ message: "Shutting down Control Center." });
    }

    case "list_events": {
      const limit = Number(args.limit || 25);
      return ok({ events: getRecentEvents(limit) });
    }

    case "get_calendar_month":
      return ok(getCalendarMonthView({ year: args.year, month: args.month }));

    case "list_calendar_events":
      return ok(listCalendarEvents({ start: args.start, end: args.end, limit: args.limit }));

    case "get_remaining_calendar_events":
      return ok(getRemainingCalendarEvents({ now: args.now }));

    case "create_calendar_event": {
      try {
        const normalized = normalizeCalendarCreateArgs(args);
        return ok(
          createCalendarEvent({
            title: normalized.title,
            startsAt: normalized.startsAt,
            endsAt: normalized.endsAt,
            location: normalized.location,
            notes: normalized.notes
          })
        );
      } catch (error) {
        return fail(error?.code || "CREATE_CALENDAR_EVENT_FAILED", error?.message || "Failed to create calendar event.");
      }
    }

    case "delete_calendar_event": {
      try {
        return ok(deleteCalendarEvent({ eventId: args.eventId, title: args.title }));
      } catch (error) {
        return fail(error?.code || "DELETE_CALENDAR_EVENT_FAILED", error?.message || "Failed to delete calendar event.");
      }
    }

    case "publish_event": {
      const appId = String(args.appId || "control-center");
      const source = String(args.source || "agent");
      const type = String(args.type || "status");
      const message = String(args.message || "");
      const meta = args.meta && typeof args.meta === "object" ? args.meta : {};
      return publishEvent({ appId, source, type, message, meta });
    }

    case "create_project": {
      try {
        const appType = String(args.appType || "project-app").trim() === "work-app" ? "work-app" : "project-app";
        const legacyPath = String(args.path || "").trim();
        let basePath = String(args.basePath || "").trim();
        let requestedName = String(args.projectName || args.project_name || "").trim();
        const shouldOpenApp = Boolean(args.openApp ?? true);

        if (!basePath && legacyPath) {
          const resolvedLegacyPath = path.resolve(legacyPath);

          if (requestedName) {
            basePath = resolvedLegacyPath;
          } else {
            basePath = path.dirname(resolvedLegacyPath);
            requestedName = path.basename(resolvedLegacyPath);
          }
        }

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

        let openEvent = null;
        if (shouldOpenApp) {
          const tab = `app:${appId}`;
          openEvent = publishEvent({
            appId,
            source: "agent",
            type: "open-app",
            message: `Agent opened ${appType === "work-app" ? "Work App" : "Personal Projects"}.`,
            meta: {
              target: appId,
              tab,
              label: appType === "work-app" ? "Work App" : "Personal Projects",
              isWindowApp: true
            }
          }).event;
        }

        return ok({
          appType,
          project: projectResult.project,
          createdNewFolder,
          openedApp: Boolean(openEvent),
          event: openEvent
        });
      } catch (error) {
        return fail(error?.code || "CREATE_PROJECT_FAILED", error?.message || "Failed to create project.");
      }
    }

    case "open_project": {
      try {
        const requestedAppType = String(args.appType || "").trim();
        const appType = requestedAppType === "work-app" || requestedAppType === "project-app" ? requestedAppType : null;
        const projectId = String(args.projectId || "").trim();
        const projectName = String(args.projectName || args.name || "").trim();
        const shouldOpenApp = Boolean(args.openApp ?? true);

        if (!projectId && !projectName) {
          return fail("INVALID_PROJECT_TARGET", "open_project requires projectId or projectName.");
        }

        const match = findManagedProject({ appType, projectId, projectName });
        if (!match) {
          return fail("PROJECT_NOT_FOUND", "No matching project found. Try a more specific project name.");
        }

        const openResult = openProjectNode(match.appType, match.project.id, match.project.path);

        let openEvent = null;
        if (shouldOpenApp) {
          const targetAppId = match.appType === "work-app" ? "work-app" : "project-app";
          const tab = `app:${targetAppId}`;
          openEvent = publishEvent({
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
        }

        return ok({
          appType: match.appType,
          project: match.project,
          openedApp: Boolean(openEvent),
          message: openResult.message,
          event: openEvent
        });
      } catch (error) {
        return fail(error?.code || "OPEN_PROJECT_FAILED", error?.message || "Failed to open project.");
      }
    }

    case "list_music_tracks": {
      const result = listMusicTracks({
        artist: args.artist,
        genre: args.genre,
        query: args.query,
        limit: args.limit
      });
      return ok(result);
    }

    case "list_music_artists":
      return ok({ artists: listMusicArtists() });

    case "list_music_genres":
      return ok({ genres: listMusicGenres() });

    case "list_music_playlists":
      return ok(listMusicPlaylists({ localOnly: Boolean(args.localOnly) }));

    case "create_music_playlist": {
      try {
        return ok(createMusicPlaylist(args.name));
      } catch (error) {
        return fail(error?.code || "CREATE_PLAYLIST_FAILED", error?.message || "Failed to create playlist.");
      }
    }

    case "add_track_to_playlist": {
      try {
        return ok(
          addTrackToPlaylist({
            playlistName: args.playlistName,
            trackId: args.trackId,
            trackName: args.trackName
          })
        );
      } catch (error) {
        return fail(error?.code || "ADD_TRACK_FAILED", error?.message || "Failed to add track to playlist.");
      }
    }

    case "get_news_summary": {
      try {
        const briefing = await getNewsBriefing();
        if (!briefing.ok) {
          return fail("NEWS_FETCH_FAILED", "Could not fetch news at this time.");
        }

        const lines = [];

        if (briefing.weather?.ok) {
          const w = briefing.weather.current;
          lines.push(`Weather in ${briefing.weather.location}: ${w.temperatureC}°C, ${w.label}.`);
        }

        if (briefing.headlines?.length) {
          lines.push("Top headlines:");
          for (const item of briefing.headlines.slice(0, 3)) {
            const desc = item.summary ? ` — ${item.summary}` : "";
            lines.push(`• ${item.title}${desc}`);
          }
        }

        if (briefing.technology?.length) {
          lines.push("In tech:");
          for (const item of briefing.technology.slice(0, 2)) {
            const desc = item.summary ? ` — ${item.summary}` : "";
            lines.push(`• ${item.title}${desc}`);
          }
        }

        if (briefing.stemFeature) {
          lines.push(`Science highlight: ${briefing.stemFeature.title}.`);
        }

        return ok({ summary: lines.join("\n"), digest: briefing.chatbotDigest });
      } catch (error) {
        return fail("NEWS_FETCH_FAILED", error?.message || "Failed to fetch news.");
      }
    }

    default:
      return fail("UNKNOWN_TOOL", `Tool '${toolName}' is not supported.`);
  }
}

function ok(data) {
  return {
    ok: true,
    ...data
  };
}

function fail(code, message) {
  return {
    ok: false,
    code,
    message
  };
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
  const srcPath = path.join(projectPath, "src");
  const docsPath = path.join(projectPath, "docs");
  mkdirSync(srcPath, { recursive: true });
  mkdirSync(docsPath, { recursive: true });

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

function normalizeCalendarCreateArgs(args = {}) {
  const title = firstNonEmpty(
    args.title,
    args.event_name,
    args.eventName,
    args.name,
    args.subject,
    args.summary
  );

  let startsAt = firstNonEmpty(
    args.startsAt,
    args.startAt,
    args.start_time,
    args.startTime,
    args.start,
    args.when,
    args.datetime,
    args.dateTime
  );

  let endsAt = firstNonEmpty(
    args.endsAt,
    args.endAt,
    args.end_time,
    args.endTime,
    args.end
  );

  const dateOnly = firstNonEmpty(args.date, args.day);
  const timeOnly = firstNonEmpty(args.time, args.at, args.clockTime);
  if (!startsAt && dateOnly) {
    const composed = String(`${dateOnly} ${timeOnly || "9:00 AM"}`).trim();
    startsAt = composed;
  }

  if (!endsAt && startsAt) {
    const durationMinutesRaw = Number(args.durationMinutes || args.duration_minutes || args.duration || 60);
    const durationMinutes = Number.isFinite(durationMinutesRaw) && durationMinutesRaw > 0 ? durationMinutesRaw : 60;
    const parsedStart = new Date(startsAt);
    if (!Number.isNaN(parsedStart.getTime())) {
      endsAt = new Date(parsedStart.getTime() + durationMinutes * 60 * 1000).toISOString();
    }
  }

  return {
    title,
    startsAt,
    endsAt,
    location: firstNonEmpty(args.location, args.where, args.place) || "",
    notes: firstNonEmpty(args.notes, args.note, args.description, args.details) || ""
  };
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) {
      return text;
    }
  }
  return "";
}
