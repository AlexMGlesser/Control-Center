import { Router } from "express";
import { existsSync, realpathSync, statSync } from "fs";
import { spawn } from "child_process";
import os from "os";
import path from "path";
import QRCode from "qrcode";
import { systemConfig } from "../config.js";
import {
  cancelPairingCode,
  createPairingCode,
  listDevices,
  pairDevice,
  requestSource,
  revokeDevice
} from "../services/authService.js";
import { getRemoteAccessStatus } from "../services/remoteAccessService.js";
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
import { getWikipediaStatus, startWikipedia, stopWikipedia } from "../services/wikipediaService.js";
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
  isSyncedLocalTrackPath,
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
import {
  getFileSystemStatus,
  launchGestureRecorder,
  launchFileExplorer,
  shutdownFileSystem,
  stopFileSystem
} from "../services/fileSystemService.js";

const router = Router();

// Live event streams per paired device, so removing a device cuts it off.
const deviceStreams = new Map(); // deviceId -> Set<close function>

// Files /apps/music-app/local-file will stream (the music app imports
// audio/*; video formats are allowed for music videos).
const MEDIA_FILE_EXTENSIONS = new Set([
  ".mp3", ".m4a", ".aac", ".flac", ".ogg", ".oga", ".opus", ".wav", ".wma", ".aif", ".aiff", ".ape", ".alac",
  ".mp4", ".m4v", ".webm", ".mkv", ".mov"
]);
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

export async function shutdownAgentSystem() {
  stopOllamaProbe();
  stopAlarmScheduler();
  // Only tears down Ollama if this process is the one that spawned it
  // (stopOllama() no-ops the kill otherwise) — without this, a daemon we
  // started on launch is detached/unref'd and outlives Electron entirely.
  await stopOllama();
  // Same rule for the Wikipedia App's librarian server: only killed if this
  // process spawned it (it's started lazily, when the app is opened).
  await stopWikipedia();
  // File System's Python processes are plain (non-detached) children, but a
  // GUI window keeps them alive after we exit unless they're closed here.
  await shutdownFileSystem();
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

  const { turnId } = enqueueUserTurn(userText, { origin: { type: "user", device: req.auth?.device } });
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

  // req.auth is set by apiAuthMiddleware: the PC, or the paired device that sent it.
  const device = req.auth?.device || null;
  const userMessageResult = addUserMessage(userText, device);
  if (!userMessageResult.ok) {
    res.status(400).json(userMessageResult);
    return;
  }

  const { task, turnId } = enqueueUserTurn(userText, { origin: { type: "user", device } });

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

router.get("/apps/wikipedia-app/server", async (req, res) => {
  res.json({ ok: true, ...(await getWikipediaStatus()) });
});

router.post("/apps/wikipedia-app/server/start", async (req, res) => {
  const result = await startWikipedia();
  if (result.ok && !result.alreadyRunning) {
    publishEvent({
      source: "wikipedia-app",
      appId: "wikipedia-app",
      type: "status",
      message: "Wikipedia librarian server started.",
      meta: { url: result.url }
    });
  }
  res.status(result.ok ? 200 : 503).json(result);
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

  // This used to serve any file on disk. Now: media files only (judged on
  // the real target, so a renamed symlink/junction can't point elsewhere),
  // and remote devices only get tracks that are in a synced playlist.
  let realPath = resolvedPath;
  try {
    realPath = realpathSync(resolvedPath);
  } catch {
    res.status(500).json({ ok: false, code: "MUSIC_FILE_STAT_FAILED", message: "Could not read local file metadata." });
    return;
  }
  if (!MEDIA_FILE_EXTENSIONS.has(path.extname(realPath).toLowerCase())) {
    res.status(403).json({ ok: false, code: "MUSIC_FILE_NOT_MEDIA", message: "Only audio and video files can be streamed." });
    return;
  }
  if (req.auth?.scope === "remote" && !isSyncedLocalTrackPath(resolvedPath) && !isSyncedLocalTrackPath(realPath)) {
    res.status(403).json({ ok: false, code: "MUSIC_FILE_NOT_IN_LIBRARY", message: "That file isn't in your music library." });
    return;
  }

  res.sendFile(realPath, (error) => {
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

router.get("/apps/file-system-app/status", (req, res) => {
  res.json(getFileSystemStatus());
});

router.post("/apps/file-system-app/launch", async (req, res) => {
  const result = await launchFileExplorer();
  res.status(result.ok ? 200 : 500).json(result);
});

router.post("/apps/file-system-app/recorder/launch", async (req, res) => {
  const result = await launchGestureRecorder({
    label: req.body?.label,
    reps: req.body?.reps,
    duration: req.body?.duration,
    saveVideo: req.body?.saveVideo === true,
    autostart: req.body?.autostart === true
  });
  const isLaunchFailure = ["FILE_SYSTEM_START_FAILED", "FILE_SYSTEM_SPAWN_FAILED", "FILE_SYSTEM_SCRIPT_MISSING"].includes(result.code);
  res.status(result.ok ? 200 : isLaunchFailure ? 500 : 400).json(result);
});

router.post("/apps/file-system-app/stop", async (req, res) => {
  const result = await stopFileSystem(String(req.body?.process || "all").trim().toLowerCase());
  res.status(result.ok ? 200 : 400).json(result);
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

  // Never write to a stream that has ended (e.g. its device was just
  // removed): that throws "write after end" and would crash the server.
  const send = (chunk) => {
    if (!res.writableEnded && !res.destroyed) {
      res.write(chunk);
    }
  };

  send(`data: ${JSON.stringify({ type: "snapshot", events: getRecentEvents(15) })}\n\n`);

  const unsubscribe = subscribeToEvents((event) => {
    send(`data: ${JSON.stringify({ type: "event", event })}\n\n`);
  });

  // Heartbeat: lets a phone tell a quiet connection from a dead one.
  const keepAliveId = setInterval(() => {
    send(`event: ping\ndata: ${Date.now()}\n\n`);
  }, 20000);

  const deviceId = req.auth?.scope === "remote" ? req.auth.device.id : null;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(keepAliveId);
    unsubscribe();
    deviceStreams.get(deviceId)?.delete(close);
    if (!res.writableEnded) {
      res.end();
    }
  };

  if (deviceId) {
    if (!deviceStreams.has(deviceId)) {
      deviceStreams.set(deviceId, new Set());
    }
    deviceStreams.get(deviceId).add(close);
  }

  req.on("close", close);
});

/* Paired devices (mobile app). Management is desktop-only via the remote
   allowlist; POST /devices/pair is the one public route. */

router.get("/devices", (req, res) => {
  res.json({ ok: true, devices: listDevices() });
});

router.delete("/devices/:deviceId(dev_[a-f0-9]+)", (req, res) => {
  const deviceId = String(req.params.deviceId || "");
  if (!revokeDevice(deviceId)) {
    res.status(404).json({ ok: false, code: "DEVICE_NOT_FOUND", message: "No paired device with that id." });
    return;
  }
  // A removed device loses its live event stream now, not on its next request.
  for (const closeStream of [...(deviceStreams.get(deviceId) || [])]) {
    closeStream();
  }
  deviceStreams.delete(deviceId);
  publishEvent({ source: "auth", appId: "control-center", type: "device-revoked", message: "A paired device was removed.", meta: { deviceId } });
  res.json({ ok: true });
});

router.get("/devices/remote-access", async (req, res) => {
  res.json({ ok: true, remoteAccess: await getRemoteAccessStatus({ fresh: req.query.fresh === "1" }) });
});

router.post("/devices/pairing-codes", async (req, res) => {
  const remoteAccess = await getRemoteAccessStatus({ fresh: true });
  const { code, expiresAt } = createPairingCode();
  const serverName = remoteAccess.dnsName ? remoteAccess.dnsName.split(".")[0] : os.hostname();
  // The QR code carries everything the phone needs: where to connect and the code.
  const payload = JSON.stringify({ v: 1, url: remoteAccess.publicUrl, code, name: serverName });
  const qrSvg = await QRCode.toString(payload, { type: "svg", errorCorrectionLevel: "M", margin: 1 });
  res.json({ ok: true, code, expiresAt, serverName, url: remoteAccess.publicUrl, qrSvg, remoteAccess });
});

router.delete("/devices/pairing-codes", (req, res) => {
  cancelPairingCode();
  res.json({ ok: true });
});

router.post("/devices/pair", async (req, res) => {
  const result = pairDevice({
    code: req.body?.code,
    deviceName: req.body?.deviceName,
    kind: req.body?.kind === "laptop" ? "laptop" : "phone",
    source: requestSource(req)
  });
  if (!result.ok) {
    console.warn(`[Auth] Pairing failed (${result.code}) from ${requestSource(req)}`);
    res.status(result.status).json({ ok: false, code: result.code, message: result.message });
    return;
  }
  publishEvent({
    source: "auth",
    appId: "control-center",
    type: "device-paired",
    message: `Paired ${result.device.name}.`,
    meta: { deviceId: result.device.id, name: result.device.name }
  });
  const remoteAccess = await getRemoteAccessStatus();
  const serverName = remoteAccess.dnsName ? remoteAccess.dnsName.split(".")[0] : os.hostname();
  res.json({ ok: true, deviceId: result.device.id, token: result.token, device: result.device, serverName });
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
