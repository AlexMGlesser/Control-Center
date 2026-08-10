import { Router } from "express";
import { existsSync, statSync } from "fs";
import { spawn } from "child_process";
import path from "path";
import { systemConfig } from "../config.js";
import { getAllApps, getAppById } from "../services/appRegistry.js";
import { addAppMessage } from "../services/appMessageService.js";
import { connectApp, getOrchestratorStatus } from "../services/orchestrator.js";
import { getModeState, switchMode } from "../services/modeStateMachine.js";
import {
  getRecentEvents,
  publishEvent,
  subscribeToEvents,
  getConsoleLogs
} from "../services/eventBus.js";
import {
  getSettings,
  getDesktopSettingsLabelValueMap,
  getSettingsOptions,
  updateDesktopSettings
} from "../services/settingsService.js";
import { addUserMessage, getChatMessages } from "../services/chatService.js";
import { getAgentContextText, getAgentRuntimeStatus, getAgentToolCatalog } from "../services/agentRuntime.js";
import { startOllama, stopOllama, startOllamaProbe, stopOllamaProbe } from "../services/ollamaService.js";
import { getVoiceStatus } from "../services/voiceService.js";
import { enqueueUserTurn, getQueueStatus, onReplyDelivered } from "../services/queueWorker.js";
import {
  createAlarm,
  listAlarms,
  cancelAlarm,
  stopAlarm,
  getRingingAlarms,
  startAlarmScheduler,
  stopAlarmScheduler
} from "../services/alarmService.js";
import {
  getWorkProjects,
  getPersonalProjects,
  getProjectById,
  createProject,
  removeProject,
  buildFileTree,
  createProjectNode,
  deleteProjectNode,
  copyProjectNode,
  moveProjectNode,
  openProjectNode,
  launchApp
} from "../services/projectService.js";
import {
  createCalendarEvent,
  deleteCalendarEvent,
  getCalendarMonthView,
  getRemainingCalendarEvents,
  listCalendarEvents
} from "../services/calendarService.js";
import {
  addTrackToPlaylist,
  createMusicPlaylist,
  getMusicLibraryState,
  listMusicArtists,
  listMusicGenres,
  listMusicPlaylists,
  listMusicTracks,
  syncLocalMusicPlaylists
} from "../services/musicLibraryService.js";
import {
  createDrawingFile,
  deleteDrawingFile,
  getDrawingFile,
  listDrawingFiles,
  updateDrawingFile
} from "../services/drawingFileService.js";
import { getAllSkills, getSkillById, createSkill, updateSkill, deleteSkill } from "../services/skillsService.js";

const router = Router();
let shutdownCallback = null;

export function onShutdownRequested(cb) {
  shutdownCallback = cb;
}

export function initializeAgentSystem() {
  startOllama();
  startOllamaProbe();
  startAlarmScheduler();
  return { ok: true, message: "Agent system initialized" };
}

export function shutdownAgentSystem() {
  stopOllamaProbe();
  stopAlarmScheduler();
  return { ok: true, message: "Agent system shut down" };
}

router.get("/health", (req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

router.post("/ollama/start", async (req, res) => {
  const state = await startOllama();
  publishEvent({
    source: "ollama",
    appId: "control-center",
    type: "ollama",
    message: `Ollama ${state.status === "connected" ? "connected" : "failed to connect"}.`,
    meta: state
  });
  res.json({ ok: state.status === "connected", state });
});

router.post("/ollama/stop", async (req, res) => {
  const result = await stopOllama();
  publishEvent({
    source: "ollama",
    appId: "control-center",
    type: "ollama",
    message: "Ollama model unloaded.",
    meta: {}
  });
  res.json(result);
});

router.get("/system", (req, res) => {
  const runtimeStatus = getAgentRuntimeStatus();

  res.json({
    ...systemConfig,
    ollama: runtimeStatus.ollama,
    voice: getVoiceStatus(),
    mode: getModeState().currentMode,
    modeState: getModeState(),
    orchestrator: getOrchestratorStatus()
  });
});

router.get("/mode", (req, res) => {
  res.json({ mode: getModeState() });
});

router.get("/settings", (req, res) => {
  res.json({ settings: getSettings(), options: getSettingsOptions() });
});

router.put("/settings/desktop", (req, res) => {
  const result = updateDesktopSettings(req.body || {});

  if (!result.ok) {
    res.status(400).json(result);
    return;
  }

  publishEvent({
    source: "settings",
    appId: "control-center",
    type: "settings",
    message: "Desktop settings updated.",
    meta: { desktop: result.settings.desktop }
  });

  res.json(result);
});

router.post("/settings/desktop/test-voice", (req, res) => {
  const desktopSettings = getDesktopSettingsLabelValueMap();
  const sampleText = String(req.body?.sampleText || "").trim() || "Voice test complete. Desktop voice settings are active.";

  publishEvent({
    source: "settings",
    appId: "control-center",
    type: "voice-test",
    message: `Voice test triggered using ${desktopSettings.voiceLabel} at ${desktopSettings.voiceSpeed} speed on ${desktopSettings.audioDeviceLabel}.`,
    meta: { ...desktopSettings, sampleText }
  });

  res.json({ ok: true, message: "Voice test queued.", sampleText, settings: desktopSettings });
});

router.post("/system/choose-directory", async (req, res) => {
  const defaultPath = typeof req.body?.defaultPath === "string" ? req.body.defaultPath.trim() : "";
  const result = await openDirectoryDialog(defaultPath || undefined);
  if (!result.ok) {
    res.status(result.status || 500).json(result);
    return;
  }
  res.json(result);
});

router.post("/system/choose-file", async (req, res) => {
  const defaultPath = typeof req.body?.defaultPath === "string" ? req.body.defaultPath.trim() : "";
  const result = await openFileDialog(defaultPath || undefined);
  if (!result.ok) {
    res.status(result.status || 500).json(result);
    return;
  }
  res.json(result);
});

router.post("/system/ssh-connect", (req, res) => {
  const host = String(req.body?.host || "").trim();
  const username = String(req.body?.username || "").trim();
  const keyPath = String(req.body?.keyPath || "").trim();
  const portRaw = Number(req.body?.port || 22);
  const port = Number.isInteger(portRaw) && portRaw >= 1 && portRaw <= 65535 ? portRaw : 22;

  if (!host || !username) {
    res.status(400).json({ ok: false, message: "Host and username are required." });
    return;
  }

  const sshParts = ["ssh", "-p", String(port)];
  if (keyPath) {
    sshParts.push("-i", `"${keyPath.replace(/"/g, '\\"')}"`);
  }
  sshParts.push(`${username}@${host}`);
  const sshCommand = sshParts.join(" ");

  try {
    const child = spawn(
      "cmd.exe",
      ["/c", "start", "", "powershell.exe", "-NoLogo", "-NoProfile", "-NoExit", "-ExecutionPolicy", "Bypass", "-Command", sshCommand],
      { detached: true, stdio: "ignore", windowsHide: false }
    );
    child.unref();
    res.json({ ok: true, message: `Opening SSH session for ${username}@${host}.` });
  } catch (error) {
    res.status(500).json({ ok: false, message: error?.message || "Failed to spawn PowerShell." });
  }
});

router.get("/chat/messages", (req, res) => {
  res.json({ messages: getChatMessages(req.query.limit) });
});

router.get("/agent/context", (req, res) => {
  res.type("text/plain").send(getAgentContextText());
});

router.get("/agent/tools", (req, res) => {
  res.json({ tools: getAgentToolCatalog() });
});

router.get("/agent/queue/status", (req, res) => {
  res.json({ ok: true, queue: getQueueStatus() });
});

router.post("/agent/respond", async (req, res) => {
  const userText = String(req.body?.userText || "").trim();
  if (!userText) {
    res.status(400).json({ ok: false, code: "EMPTY_USER_MESSAGE", message: "userText is required." });
    return;
  }

  const { turnId } = enqueueUserTurn(userText, { origin: { type: "user" } });
  const agentText = await new Promise((resolve) => {
    const unsubscribe = onReplyDelivered(({ turnId: completedTurnId, message }) => {
      if (completedTurnId !== turnId) {
        return;
      }
      unsubscribe();
      resolve(message);
    });
  });

  res.json({ ok: true, agentText });
});

router.post("/chat/messages", (req, res) => {
  const userText = String(req.body?.text || "").trim();
  if (!userText) {
    res.status(400).json({ ok: false, code: "EMPTY_MESSAGE", message: "Message text is required." });
    return;
  }

  const userMessageResult = addUserMessage(userText);
  if (!userMessageResult.ok) {
    res.status(400).json(userMessageResult);
    return;
  }

  const { task, turnId } = enqueueUserTurn(userText, { origin: { type: "user" } });

  publishEvent({
    source: "chat",
    appId: "control-center",
    type: "chat-queued",
    message: "Message queued for the agent.",
    meta: { userMessageId: userMessageResult.message.id, taskId: task.task_id, turnId }
  });

  res.status(202).json({
    ok: true,
    queued: true,
    userMessage: userMessageResult.message,
    task,
    queue: getQueueStatus()
  });
});

router.post("/apps/:appId/agent-message", async (req, res) => {
  const app = getAppById(req.params.appId);
  if (!app) {
    res.status(404).json({ ok: false, code: "APP_NOT_FOUND", message: `Unknown appId '${req.params.appId}'.` });
    return;
  }

  const message = String(req.body?.message || "").trim();
  if (!message) {
    res.status(400).json({ ok: false, code: "EMPTY_APP_MESSAGE", message: "message is required." });
    return;
  }

  const appMessageResult = addAppMessage({
    appId: app.id,
    appName: app.name,
    message,
    meta: req.body?.meta && typeof req.body.meta === "object" ? req.body.meta : {}
  });

  if (!appMessageResult.ok) {
    res.status(400).json(appMessageResult);
    return;
  }

  publishEvent({
    source: "app-inbox",
    appId: app.id,
    type: "agent-message",
    message: `${app.name} sent a background message to the agent inbox.`,
    meta: { appMessageId: appMessageResult.entry.id }
  });

  const { task } = enqueueUserTurn(appMessageResult.entry.formattedText, {
    origin: { type: "app", appId: app.id, appName: app.name }
  });

  res.status(202).json({
    ok: true,
    appMessage: appMessageResult.entry,
    task,
    queue: getQueueStatus()
  });
});

router.post("/shutdown", (req, res) => {
  res.json({ ok: true, message: "Shutting down Control Center." });
  setTimeout(() => {
    if (shutdownCallback) {
      shutdownCallback();
    } else {
      process.exit(0);
    }
  }, 500);
});

router.post("/mode/switch", (req, res) => {
  const targetMode = String(req.body?.targetMode || "").toLowerCase();
  const source = String(req.body?.source || "ui");
  const result = switchMode(targetMode, source);

  if (!result.ok) {
    res.status(400).json(result);
    return;
  }

  if (result.changed) {
    publishEvent({
      source,
      appId: "control-center",
      type: "mode",
      message: `Mode switched to ${result.mode.currentMode}.`,
      meta: { from: result.transition.from, to: result.transition.to, action: result.transition.action }
    });
  }

  res.json(result);
});

router.get("/apps", (req, res) => {
  res.json({ apps: getAllApps() });
});

router.get("/apps/:appId", (req, res) => {
  const app = getAppById(req.params.appId);
  if (!app) {
    res.status(404).json({ ok: false, message: "App not found." });
    return;
  }
  res.json({ app });
});

router.get("/apps/news-app/briefing", async (req, res) => {
  const location = String(req.query.location || "Placentia, CA").trim() || "Placentia, CA";
  const forceRefresh = String(req.query.refresh || "").toLowerCase() === "true";

  try {
    const { getNewsBriefing } = await import("../services/newsService.js");
    const briefing = await getNewsBriefing(location, { forceRefresh });
    res.json(briefing);
  } catch (error) {
    res.status(502).json({
      ok: false,
      code: "NEWS_BRIEFING_UNAVAILABLE",
      message: "News briefing is unavailable right now.",
      details: error.message
    });
  }
});

router.get("/apps/music-app/library", (req, res) => {
  res.json(getMusicLibraryState());
});

router.get("/apps/music-app/library/tracks", (req, res) => {
  res.json(listMusicTracks({ artist: req.query.artist, genre: req.query.genre, query: req.query.query, limit: req.query.limit }));
});

router.get("/apps/music-app/library/artists", (req, res) => {
  res.json({ ok: true, artists: listMusicArtists() });
});

router.get("/apps/music-app/library/genres", (req, res) => {
  res.json({ ok: true, genres: listMusicGenres() });
});

router.get("/apps/music-app/local-file", (req, res) => {
  const rawPath = String(req.query.path || "").trim();
  if (!rawPath) {
    res.status(400).json({ ok: false, code: "MUSIC_FILE_PATH_REQUIRED", message: "Query parameter 'path' is required." });
    return;
  }

  let resolvedPath = "";
  try {
    resolvedPath = path.resolve(rawPath);
  } catch {
    res.status(400).json({ ok: false, code: "MUSIC_FILE_PATH_INVALID", message: "Invalid local file path." });
    return;
  }

  if (!existsSync(resolvedPath)) {
    res.status(404).json({ ok: false, code: "MUSIC_FILE_NOT_FOUND", message: "Local music file was not found." });
    return;
  }

  try {
    if (!statSync(resolvedPath).isFile()) {
      res.status(400).json({ ok: false, code: "MUSIC_FILE_NOT_A_FILE", message: "Path does not point to a file." });
      return;
    }
  } catch {
    res.status(500).json({ ok: false, code: "MUSIC_FILE_STAT_FAILED", message: "Could not read local file metadata." });
    return;
  }

  res.sendFile(resolvedPath, (error) => {
    if (error && !res.headersSent) {
      res.status(500).json({ ok: false, code: "MUSIC_FILE_STREAM_FAILED", message: "Could not stream local music file." });
    }
  });
});

router.get("/apps/music-app/playlists", (req, res) => {
  res.json(listMusicPlaylists());
});

router.post("/apps/music-app/local-playlists/sync", (req, res) => {
  try {
    res.json(syncLocalMusicPlaylists(req.body?.playlists));
  } catch (error) {
    res.status(error.status || 500).json({
      ok: false,
      code: error.code || "MUSIC_LOCAL_PLAYLIST_SYNC_FAILED",
      message: error.message || "Could not sync local music playlists."
    });
  }
});

router.post("/apps/music-app/playlists", (req, res) => {
  handleProjectAction(res, () => createMusicPlaylist(req.body?.name));
});

router.post("/apps/music-app/playlists/:playlistName/tracks", (req, res) => {
  handleProjectAction(res, () =>
    addTrackToPlaylist({ playlistName: req.params.playlistName, trackId: req.body?.trackId, trackName: req.body?.trackName })
  );
});

router.get("/apps/drawing-app/files", (req, res) => {
  try {
    res.json(listDrawingFiles());
  } catch (error) {
    res.status(error.status || 500).json({ ok: false, code: error.code || "DRAWING_FILES_LIST_FAILED", message: error.message || "Could not list drawing files." });
  }
});

router.get("/apps/drawing-app/files/:fileId", (req, res) => {
  try {
    res.json(getDrawingFile(req.params.fileId));
  } catch (error) {
    res.status(error.status || 500).json({ ok: false, code: error.code || "DRAWING_FILE_READ_FAILED", message: error.message || "Could not read drawing file." });
  }
});

router.post("/apps/drawing-app/files", (req, res) => {
  try {
    res.status(201).json(createDrawingFile({ name: req.body?.name, mode: req.body?.mode, locationPath: req.body?.locationPath }));
  } catch (error) {
    res.status(error.status || 500).json({ ok: false, code: error.code || "DRAWING_FILE_CREATE_FAILED", message: error.message || "Could not create drawing file." });
  }
});

router.put("/apps/drawing-app/files/:fileId", (req, res) => {
  try {
    res.json(updateDrawingFile(req.params.fileId, { content: req.body?.content }));
  } catch (error) {
    res.status(error.status || 500).json({ ok: false, code: error.code || "DRAWING_FILE_UPDATE_FAILED", message: error.message || "Could not update drawing file." });
  }
});

router.delete("/apps/drawing-app/files/:fileId", (req, res) => {
  try {
    res.json(deleteDrawingFile(req.params.fileId));
  } catch (error) {
    res.status(error.status || 500).json({ ok: false, code: error.code || "DRAWING_FILE_DELETE_FAILED", message: error.message || "Could not delete drawing file." });
  }
});

router.get("/apps/calendar-app/month", async (req, res) => {
  try {
    res.json(await getCalendarMonthView({ year: req.query.year, month: req.query.month }));
  } catch (error) {
    res.status(error.status || 500).json({ ok: false, code: error.code || "CALENDAR_MONTH_FAILED", message: error.message || "Could not load calendar month." });
  }
});

router.get("/apps/calendar-app/events", async (req, res) => {
  try {
    res.json(await listCalendarEvents({ start: req.query.start, end: req.query.end, limit: req.query.limit }));
  } catch (error) {
    res.status(error.status || 500).json({ ok: false, code: error.code || "CALENDAR_EVENTS_FAILED", message: error.message || "Could not load calendar events." });
  }
});

router.get("/apps/calendar-app/events/remaining", async (req, res) => {
  try {
    res.json(await getRemainingCalendarEvents({ now: req.query.now }));
  } catch (error) {
    res.status(error.status || 500).json({ ok: false, code: error.code || "CALENDAR_REMAINING_FAILED", message: error.message || "Could not load the rest of today's calendar." });
  }
});

router.post("/apps/calendar-app/events", async (req, res) => {
  try {
    res.status(201).json(
      await createCalendarEvent({
        title: req.body?.title,
        startsAt: req.body?.startsAt,
        endsAt: req.body?.endsAt,
        location: req.body?.location,
        notes: req.body?.notes
      })
    );
  } catch (error) {
    res.status(error.status || 500).json({ ok: false, code: error.code || "CALENDAR_CREATE_FAILED", message: error.message || "Could not create calendar event." });
  }
});

router.delete("/apps/calendar-app/events/:eventId", async (req, res) => {
  try {
    res.json(await deleteCalendarEvent({ eventId: req.params.eventId }));
  } catch (error) {
    res.status(error.status || 500).json({ ok: false, code: error.code || "CALENDAR_DELETE_FAILED", message: error.message || "Could not delete calendar event." });
  }
});

router.get("/apps/work-app/projects", (req, res) => {
  res.json({ ok: true, projects: getWorkProjects() });
});

router.post("/apps/work-app/projects", (req, res) => {
  handleProjectAction(res, () => createProject("work-app", req.body?.name, req.body?.path));
});

router.delete("/apps/work-app/projects/:projectId", (req, res) => {
  handleProjectAction(res, () => removeProject("work-app", req.params.projectId));
});

router.get("/apps/work-app/projects/:projectId/tree", (req, res) => {
  const project = getProjectById("work-app", req.params.projectId);
  if (!project) {
    res.status(404).json({ ok: false, code: "PROJECT_NOT_FOUND", message: `Project '${req.params.projectId}' not found.` });
    return;
  }
  res.json({ ok: true, project, tree: buildFileTree(project.path) });
});

router.post("/apps/work-app/projects/:projectId/files/create", (req, res) => {
  handleProjectFileAction(req, res, "work-app", () =>
    createProjectNode("work-app", req.params.projectId, req.body?.parentPath, req.body?.name, req.body?.nodeType)
  );
});

router.post("/apps/work-app/projects/:projectId/files/delete", (req, res) => {
  handleProjectFileAction(req, res, "work-app", () => deleteProjectNode("work-app", req.params.projectId, req.body?.targetPath));
});

router.post("/apps/work-app/projects/:projectId/files/copy", (req, res) => {
  handleProjectFileAction(req, res, "work-app", () =>
    copyProjectNode("work-app", req.params.projectId, req.body?.sourcePath, req.body?.destinationPath)
  );
});

router.post("/apps/work-app/projects/:projectId/files/move", (req, res) => {
  handleProjectFileAction(req, res, "work-app", () =>
    moveProjectNode("work-app", req.params.projectId, req.body?.sourcePath, req.body?.destinationPath)
  );
});

router.post("/apps/work-app/projects/:projectId/files/open", (req, res) => {
  handleProjectFileAction(req, res, "work-app", () => openProjectNode("work-app", req.params.projectId, req.body?.targetPath));
});

router.post("/apps/work-app/launch-tool", (req, res) => {
  res.json(launchApp(String(req.body?.tool || "").trim()));
});

router.get("/apps/project-app/projects", (req, res) => {
  res.json({ ok: true, projects: getPersonalProjects() });
});

router.post("/apps/project-app/projects", (req, res) => {
  handleProjectAction(res, () => createProject("project-app", req.body?.name, req.body?.path));
});

router.delete("/apps/project-app/projects/:projectId", (req, res) => {
  handleProjectAction(res, () => removeProject("project-app", req.params.projectId));
});

router.get("/apps/project-app/projects/:projectId/tree", (req, res) => {
  const project = getProjectById("project-app", req.params.projectId);
  if (!project) {
    res.status(404).json({ ok: false, code: "PROJECT_NOT_FOUND", message: `Project '${req.params.projectId}' not found.` });
    return;
  }
  res.json({ ok: true, project, tree: buildFileTree(project.path) });
});

router.post("/apps/project-app/projects/:projectId/files/create", (req, res) => {
  handleProjectFileAction(req, res, "project-app", () =>
    createProjectNode("project-app", req.params.projectId, req.body?.parentPath, req.body?.name, req.body?.nodeType)
  );
});

router.post("/apps/project-app/projects/:projectId/files/delete", (req, res) => {
  handleProjectFileAction(req, res, "project-app", () => deleteProjectNode("project-app", req.params.projectId, req.body?.targetPath));
});

router.post("/apps/project-app/projects/:projectId/files/copy", (req, res) => {
  handleProjectFileAction(req, res, "project-app", () =>
    copyProjectNode("project-app", req.params.projectId, req.body?.sourcePath, req.body?.destinationPath)
  );
});

router.post("/apps/project-app/projects/:projectId/files/move", (req, res) => {
  handleProjectFileAction(req, res, "project-app", () =>
    moveProjectNode("project-app", req.params.projectId, req.body?.sourcePath, req.body?.destinationPath)
  );
});

router.post("/apps/project-app/projects/:projectId/files/open", (req, res) => {
  handleProjectFileAction(req, res, "project-app", () => openProjectNode("project-app", req.params.projectId, req.body?.targetPath));
});

router.post("/apps/project-app/launch-tool", (req, res) => {
  res.json(launchApp(String(req.body?.tool || "").trim()));
});

router.post("/apps/:appId/connect", (req, res) => {
  const result = connectApp(req.params.appId);
  if (!result.ok) {
    res.status(404).json(result);
    return;
  }

  publishEvent({
    source: "orchestrator",
    appId: req.params.appId,
    type: "connector",
    message: `${req.params.appId} connector handshake called (stub).`,
    meta: { code: result.code }
  });

  res.json(result);
});

router.get("/events", (req, res) => {
  const includeConsole = req.query.includeConsole === "true";
  const events = getRecentEvents(req.query.limit);
  const consoleLogs = includeConsole ? getConsoleLogs(30) : [];

  res.json({
    events,
    consoleLogs,
    eventCount: events.length,
    consoleLogCount: consoleLogs.length,
    timestamp: new Date().toISOString()
  });
});

router.get("/events/console", (req, res) => {
  const consoleLogs = getConsoleLogs(req.query.limit || 50);
  res.json({ consoleLogs, count: consoleLogs.length, timestamp: new Date().toISOString() });
});

router.post("/events", (req, res) => {
  const appId = String(req.body?.appId || "control-center");
  if (appId !== "control-center" && !getAppById(appId)) {
    res.status(404).json({ ok: false, code: "APP_NOT_FOUND", message: `Cannot publish event. Unknown appId '${appId}'.` });
    return;
  }

  const result = publishEvent({
    appId,
    source: String(req.body?.source || "app-module"),
    type: String(req.body?.type || "status"),
    message: req.body?.message,
    meta: req.body?.meta || {}
  });

  if (!result.ok) {
    res.status(400).json(result);
    return;
  }

  res.status(201).json(result);
});

router.get("/events/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  res.write(`data: ${JSON.stringify({ type: "snapshot", events: getRecentEvents(15) })}\n\n`);

  const unsubscribe = subscribeToEvents((event) => {
    res.write(`data: ${JSON.stringify({ type: "event", event })}\n\n`);
  });

  const keepAliveId = setInterval(() => {
    res.write(`event: ping\ndata: ${Date.now()}\n\n`);
  }, 20000);

  req.on("close", () => {
    clearInterval(keepAliveId);
    unsubscribe();
  });
});

router.get("/skills", (req, res) => {
  res.json({ ok: true, skills: getAllSkills() });
});

router.get("/skills/:skillId", (req, res) => {
  const skill = getSkillById(req.params.skillId);
  if (!skill) {
    res.status(404).json({ ok: false, code: "SKILL_NOT_FOUND", message: `Skill "${req.params.skillId}" not found` });
    return;
  }
  res.json({ ok: true, skill });
});

router.post("/skills", (req, res) => {
  const skillName = String(req.body?.skillName || "").trim();
  const content = String(req.body?.content || "").trim();

  if (!skillName) {
    res.status(400).json({ ok: false, code: "SKILL_NAME_REQUIRED", message: "Skill name is required" });
    return;
  }
  if (!content) {
    res.status(400).json({ ok: false, code: "SKILL_CONTENT_REQUIRED", message: "Skill content is required" });
    return;
  }

  const result = createSkill(skillName, content);
  if (!result.success) {
    res.status(400).json({ ok: false, error: result.error });
    return;
  }

  publishEvent({ source: "skills", appId: "control-center", type: "skill-created", message: `New skill "${skillName}" created`, meta: { skillName } });
  res.status(201).json(result);
});

router.put("/skills/:skillId", (req, res) => {
  const content = String(req.body?.content || "").trim();
  if (!content) {
    res.status(400).json({ ok: false, code: "SKILL_CONTENT_REQUIRED", message: "Skill content is required" });
    return;
  }

  const result = updateSkill(req.params.skillId, content);
  if (!result.success) {
    res.status(400).json({ ok: false, error: result.error });
    return;
  }

  publishEvent({ source: "skills", appId: "control-center", type: "skill-updated", message: `Skill "${req.params.skillId}" updated`, meta: { skillId: req.params.skillId } });
  res.json(result);
});

router.delete("/skills/:skillId", (req, res) => {
  const result = deleteSkill(req.params.skillId);
  if (!result.success) {
    res.status(400).json({ ok: false, error: result.error });
    return;
  }

  publishEvent({ source: "skills", appId: "control-center", type: "skill-deleted", message: `Skill "${req.params.skillId}" deleted`, meta: { skillId: req.params.skillId } });
  res.json(result);
});

router.get("/alarms", (req, res) => {
  res.json({ ok: true, alarms: listAlarms() });
});

router.get("/alarms/ringing", (req, res) => {
  res.json({ ok: true, alarms: getRingingAlarms() });
});

router.post("/alarms", (req, res) => {
  try {
    const alarm = createAlarm(req.body || {});
    res.status(201).json({ ok: true, alarm });
  } catch (error) {
    res.status(400).json({ ok: false, code: error.code || "CREATE_ALARM_FAILED", message: error.message });
  }
});

router.delete("/alarms/:id", (req, res) => {
  try {
    const alarm = cancelAlarm(req.params.id);
    res.json({ ok: true, alarm });
  } catch (error) {
    res.status(error.code === "ALARM_NOT_FOUND" ? 404 : 400).json({ ok: false, code: error.code || "CANCEL_ALARM_FAILED", message: error.message });
  }
});

router.post("/alarms/:id/stop", (req, res) => {
  try {
    const alarms = stopAlarm(req.params.id);
    res.json({ ok: true, alarms });
  } catch (error) {
    res.status(error.code === "ALARM_NOT_RINGING" ? 409 : 400).json({ ok: false, code: error.code || "STOP_ALARM_FAILED", message: error.message });
  }
});

export default router;

function handleProjectFileAction(req, res, appId, action) {
  const project = getProjectById(appId, req.params.projectId);
  if (!project) {
    res.status(404).json({ ok: false, code: "PROJECT_NOT_FOUND", message: `Project '${req.params.projectId}' not found.` });
    return;
  }

  try {
    res.json(action());
  } catch (error) {
    res.status(error.status || 500).json({ ok: false, code: error.code || "PROJECT_FILE_ACTION_FAILED", message: error.message || "Project file action failed." });
  }
}

function handleProjectAction(res, action) {
  try {
    res.json(action());
  } catch (error) {
    res.status(Number(error.status || 500)).json({ ok: false, code: error.code || "PROJECT_ACTION_FAILED", message: error.message || "Project action failed." });
  }
}

async function openDirectoryDialog(defaultPath) {
  try {
    const electron = await import("electron");
    const focusedWindow = electron.BrowserWindow.getFocusedWindow() || undefined;
    const result = await electron.dialog.showOpenDialog(focusedWindow, {
      title: "Choose destination folder",
      properties: ["openDirectory", "createDirectory", "promptToCreate"],
      defaultPath
    });

    if (result.canceled || !result.filePaths?.length) {
      return { ok: true, canceled: true, path: null };
    }
    return { ok: true, canceled: false, path: result.filePaths[0] };
  } catch (error) {
    return {
      ok: false,
      status: 503,
      code: "DESKTOP_PICKER_UNAVAILABLE",
      message: "Desktop folder picker is unavailable in this mode.",
      details: error?.message || "Failed to load Electron dialog API."
    };
  }
}

async function openFileDialog(defaultPath) {
  try {
    const electron = await import("electron");
    const focusedWindow = electron.BrowserWindow.getFocusedWindow() || undefined;
    const result = await electron.dialog.showOpenDialog(focusedWindow, {
      title: "Choose file",
      properties: ["openFile"],
      defaultPath
    });

    if (result.canceled || !result.filePaths?.length) {
      return { ok: true, canceled: true, path: null };
    }
    return { ok: true, canceled: false, path: result.filePaths[0] };
  } catch (error) {
    return {
      ok: false,
      status: 503,
      code: "DESKTOP_FILE_PICKER_UNAVAILABLE",
      message: "Desktop file picker is unavailable in this mode.",
      details: error?.message || "Failed to load Electron dialog API."
    };
  }
}
