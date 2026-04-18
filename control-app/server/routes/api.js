import { Router } from "express";
import { existsSync, statSync } from "fs";
import path from "path";
import { systemConfig } from "../config.js";
import { getAllApps, getAppById } from "../services/appRegistry.js";
import { addAppMessage } from "../services/appMessageService.js";
import { connectApp, getOrchestratorStatus } from "../services/orchestrator.js";
import { getModeState, switchMode } from "../services/modeStateMachine.js";
import {
  getRecentEvents,
  publishEvent,
  subscribeToEvents
} from "../services/eventBus.js";
import {
  getSettings,
  getDesktopSettingsLabelValueMap,
  getSettingsOptions,
  updateDesktopSettings
} from "../services/settingsService.js";
import {
  addAgentMessage,
  addUserMessage,
  getChatMessages
} from "../services/chatService.js";
import {
  getAgentContextText,
  getAgentRuntimeStatus,
  getAgentToolCatalog,
  runAgentTurn
} from "../services/agentRuntime.js";
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
  addTrackToPlaylist,
  createMusicPlaylist,
  getMusicLibraryState,
  listMusicArtists,
  listMusicGenres,
  listMusicPlaylists,
  listMusicTracks,
  syncLocalMusicPlaylists
} from "../services/musicLibraryService.js";

const router = Router();
let honorificToggle = false;

router.get("/health", (req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

router.get("/system", (req, res) => {
  const runtimeStatus = getAgentRuntimeStatus();

  res.json({
    ...systemConfig,
    lmStudio: runtimeStatus.lmStudio,
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
  const sampleText =
    String(req.body?.sampleText || "").trim() ||
    "Voice test complete. Desktop voice settings are active.";

  publishEvent({
    source: "settings",
    appId: "control-center",
    type: "voice-test",
    message: `Voice test triggered using ${desktopSettings.voiceLabel} at ${desktopSettings.voiceSpeed} speed on ${desktopSettings.audioDeviceLabel}.`,
    meta: {
      ...desktopSettings,
      sampleText
    }
  });

  res.json({
    ok: true,
    message: "Voice test queued.",
    sampleText,
    settings: desktopSettings
  });
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

router.get("/chat/messages", (req, res) => {
  const limit = req.query.limit;
  res.json({ messages: getChatMessages(limit) });
});

router.get("/agent/context", (req, res) => {
  res.type("text/plain").send(getAgentContextText());
});

router.get("/agent/tools", (req, res) => {
  res.json({ tools: getAgentToolCatalog() });
});

router.post("/agent/respond", async (req, res) => {
  const userText = String(req.body?.userText || "").trim();
  const llmOutput = req.body?.llmOutput;

  if (!userText) {
    res.status(400).json({
      ok: false,
      code: "EMPTY_USER_MESSAGE",
      message: "userText is required."
    });
    return;
  }

  const result = await runAgentTurn({ userText, llmOutput });
  res.json(result);
});

router.post("/chat/messages", async (req, res) => {
  const userText = String(req.body?.text || "").trim();
  if (!userText) {
    res.status(400).json({
      ok: false,
      code: "EMPTY_MESSAGE",
      message: "Message text is required."
    });
    return;
  }

  const userMessageResult = addUserMessage(userText);
  if (!userMessageResult.ok) {
    res.status(400).json(userMessageResult);
    return;
  }

  const agentTurn = await runAgentTurn({ userText, llmOutput: req.body?.llmOutput });
  const persistedAgentMessages = persistAgentMessages(agentTurn);
  if (Array.isArray(agentTurn.agentMessages) && agentTurn.agentMessages.length && !persistedAgentMessages.length) {
    res.status(500).json({
      ok: false,
      code: "AGENT_MESSAGE_WRITE_FAILED",
      message: "Failed to persist agent response."
    });
    return;
  }

  const chatResult = {
    ok: true,
    userMessage: userMessageResult.message,
    agentMessage: persistedAgentMessages[0] || null,
    agentMessages: persistedAgentMessages,
    toolSummary: agentTurn.toolSummary,
    toolResults: agentTurn.toolResults,
    messages: getChatMessages(80)
  };

  publishEvent({
    source: "chat",
    appId: "control-center",
    type: "chat",
    message: "Text chat exchange completed through filtered agent runtime.",
    meta: {
      userMessageId: userMessageResult.message.id,
      agentMessageId: persistedAgentMessages[0]?.id || null,
      toolCalls: Array.isArray(agentTurn.toolResults) ? agentTurn.toolResults.length : 0,
      blocked: !agentTurn.ok,
      agentMessages: persistedAgentMessages.length
    }
  });

  res.status(201).json(chatResult);
});

router.post("/apps/:appId/agent-message", async (req, res) => {
  const app = getAppById(req.params.appId);
  if (!app) {
    res.status(404).json({
      ok: false,
      code: "APP_NOT_FOUND",
      message: `Unknown appId '${req.params.appId}'.`
    });
    return;
  }

  const message = String(req.body?.message || "").trim();
  if (!message) {
    res.status(400).json({
      ok: false,
      code: "EMPTY_APP_MESSAGE",
      message: "message is required."
    });
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
    meta: {
      appMessageId: appMessageResult.entry.id
    }
  });

  const agentTurn = await runAgentTurn({
    userText: appMessageResult.entry.formattedText,
    llmOutput: req.body?.llmOutput,
    origin: {
      type: "app",
      appId: app.id,
      appName: app.name
    }
  });

  const persistedAgentMessages = persistAgentMessages(agentTurn, {
    originAppId: app.id,
    originAppName: app.name,
    sourceKind: "app"
  });

  if (persistedAgentMessages.length) {
    publishEvent({
      source: "chat",
      appId: "control-center",
      type: "chat-app-notification",
      message: `Agent surfaced an update from ${app.name} to chat.`,
      meta: {
        originAppId: app.id,
        agentMessageId: persistedAgentMessages[0].id,
        totalMessages: persistedAgentMessages.length
      }
    });
  }

  res.status(202).json({
    ok: true,
    appMessage: appMessageResult.entry,
    notifiedUser: persistedAgentMessages.length > 0,
    agentMessages: persistedAgentMessages,
    toolSummary: agentTurn.toolSummary,
    toolResults: agentTurn.toolResults
  });
});

function scheduleFollowUpAgentMessages(messages, baseMeta) {
  messages.forEach((text, index) => {
    setTimeout(() => {
      const result = addAgentMessage(text, {
        ...baseMeta,
        sequence: index + 2,
        isFollowUp: true
      });

      if (!result.ok) {
        return;
      }

      publishEvent({
        source: "chat",
        appId: "control-center",
        type: "chat-followup",
        message: "Agent posted a follow-up chat message.",
        meta: {
          agentMessageId: result.message.id,
          sequence: index + 2
        }
      });
    }, (index + 1) * 500);
  });
}

function persistAgentMessages(agentTurn, metaOverrides = {}) {
  const sourceMessages = Array.isArray(agentTurn.agentMessages) ? agentTurn.agentMessages : [];
  const composedMessage = sourceMessages
    .map((message) => String(message || "").trim())
    .filter(Boolean)
    .join("\n\n");
  const agentMessages = composedMessage ? [applyHonorificToMessage(composedMessage)] : [];
  const persistedAgentMessages = [];

  if (!agentMessages.length) {
    return persistedAgentMessages;
  }

  const firstMessage = addAgentMessage(agentMessages[0], {
    toolResults: agentTurn.toolResults,
    toolSummary: agentTurn.toolSummary,
    code: agentTurn.code || "OK",
    sequence: 1,
    totalMessages: agentMessages.length,
    ...metaOverrides
  });

  if (!firstMessage.ok) {
    return [];
  }

  persistedAgentMessages.push(firstMessage.message);

  return persistedAgentMessages;
}

function applyHonorificToMessage(message) {
  const cleanMessage = String(message || "").trim();
  if (!cleanMessage) {
    return cleanMessage;
  }

  if (/\b(sir|boss man)\b/i.test(cleanMessage)) {
    return cleanMessage;
  }

  honorificToggle = !honorificToggle;
  const honorific = honorificToggle ? "Sir" : "Boss Man";
  return `${honorific}, ${cleanMessage}`;
}

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
      meta: {
        from: result.transition.from,
        to: result.transition.to,
        action: result.transition.action
      }
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
  const result = listMusicTracks({
    artist: req.query.artist,
    genre: req.query.genre,
    query: req.query.query,
    limit: req.query.limit
  });
  res.json(result);
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
    res.status(400).json({
      ok: false,
      code: "MUSIC_FILE_PATH_REQUIRED",
      message: "Query parameter 'path' is required."
    });
    return;
  }

  let resolvedPath = "";
  try {
    resolvedPath = path.resolve(rawPath);
  } catch {
    res.status(400).json({
      ok: false,
      code: "MUSIC_FILE_PATH_INVALID",
      message: "Invalid local file path."
    });
    return;
  }

  if (!existsSync(resolvedPath)) {
    res.status(404).json({
      ok: false,
      code: "MUSIC_FILE_NOT_FOUND",
      message: "Local music file was not found."
    });
    return;
  }

  try {
    const stat = statSync(resolvedPath);
    if (!stat.isFile()) {
      res.status(400).json({
        ok: false,
        code: "MUSIC_FILE_NOT_A_FILE",
        message: "Path does not point to a file."
      });
      return;
    }
  } catch {
    res.status(500).json({
      ok: false,
      code: "MUSIC_FILE_STAT_FAILED",
      message: "Could not read local file metadata."
    });
    return;
  }

  res.sendFile(resolvedPath, (error) => {
    if (!error) {
      return;
    }

    if (!res.headersSent) {
      res.status(500).json({
        ok: false,
        code: "MUSIC_FILE_STREAM_FAILED",
        message: "Could not stream local music file."
      });
    }
  });
});

router.get("/apps/music-app/playlists", (req, res) => {
  res.json(listMusicPlaylists());
});

router.post("/apps/music-app/local-playlists/sync", (req, res) => {
  try {
    const result = syncLocalMusicPlaylists(req.body?.playlists);
    res.json(result);
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
    addTrackToPlaylist({
      playlistName: req.params.playlistName,
      trackId: req.body?.trackId,
      trackName: req.body?.trackName
    })
  );
});

router.get("/apps/work-app/projects", (req, res) => {
  res.json({
    ok: true,
    projects: getWorkProjects()
  });
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
    res.status(404).json({
      ok: false,
      code: "PROJECT_NOT_FOUND",
      message: `Project '${req.params.projectId}' not found.`
    });
    return;
  }

  const tree = buildFileTree(project.path);
  res.json({
    ok: true,
    project,
    tree
  });
});

router.post("/apps/work-app/projects/:projectId/files/create", (req, res) => {
  handleProjectFileAction(req, res, "work-app", () =>
    createProjectNode(
      "work-app",
      req.params.projectId,
      req.body?.parentPath,
      req.body?.name,
      req.body?.nodeType
    )
  );
});

router.post("/apps/work-app/projects/:projectId/files/delete", (req, res) => {
  handleProjectFileAction(req, res, "work-app", () =>
    deleteProjectNode("work-app", req.params.projectId, req.body?.targetPath)
  );
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
  handleProjectFileAction(req, res, "work-app", () =>
    openProjectNode("work-app", req.params.projectId, req.body?.targetPath)
  );
});

router.post("/apps/work-app/launch-tool", (req, res) => {
  const toolName = String(req.body?.tool || "").trim();
  const result = launchApp(toolName);
  res.json(result);
});

router.get("/apps/project-app/projects", (req, res) => {
  res.json({
    ok: true,
    projects: getPersonalProjects()
  });
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
    res.status(404).json({
      ok: false,
      code: "PROJECT_NOT_FOUND",
      message: `Project '${req.params.projectId}' not found.`
    });
    return;
  }

  const tree = buildFileTree(project.path);
  res.json({
    ok: true,
    project,
    tree
  });
});

router.post("/apps/project-app/projects/:projectId/files/create", (req, res) => {
  handleProjectFileAction(req, res, "project-app", () =>
    createProjectNode(
      "project-app",
      req.params.projectId,
      req.body?.parentPath,
      req.body?.name,
      req.body?.nodeType
    )
  );
});

router.post("/apps/project-app/projects/:projectId/files/delete", (req, res) => {
  handleProjectFileAction(req, res, "project-app", () =>
    deleteProjectNode("project-app", req.params.projectId, req.body?.targetPath)
  );
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
  handleProjectFileAction(req, res, "project-app", () =>
    openProjectNode("project-app", req.params.projectId, req.body?.targetPath)
  );
});

router.post("/apps/project-app/launch-tool", (req, res) => {
  const toolName = String(req.body?.tool || "").trim();
  const result = launchApp(toolName);
  res.json(result);
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
  const limit = req.query.limit;
  res.json({ events: getRecentEvents(limit) });
});

router.post("/events", (req, res) => {
  const appId = String(req.body?.appId || "control-center");
  const source = String(req.body?.source || "app-module");
  const type = String(req.body?.type || "status");
  const message = req.body?.message;
  const meta = req.body?.meta || {};

  if (appId !== "control-center" && !getAppById(appId)) {
    res.status(404).json({
      ok: false,
      code: "APP_NOT_FOUND",
      message: `Cannot publish event. Unknown appId '${appId}'.`
    });
    return;
  }

  const result = publishEvent({ appId, source, type, message, meta });
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

export default router;

function handleProjectFileAction(req, res, appId, action) {
  const project = getProjectById(appId, req.params.projectId);
  if (!project) {
    res.status(404).json({
      ok: false,
      code: "PROJECT_NOT_FOUND",
      message: `Project '${req.params.projectId}' not found.`
    });
    return;
  }

  try {
    res.json(action());
  } catch (error) {
    res.status(error.status || 500).json({
      ok: false,
      code: error.code || "PROJECT_FILE_ACTION_FAILED",
      message: error.message || "Project file action failed."
    });
  }
}

function handleProjectAction(res, action) {
  try {
    res.json(action());
  } catch (error) {
    const status = Number(error.status || 500);
    res.status(status).json({
      ok: false,
      code: error.code || "PROJECT_ACTION_FAILED",
      message: error.message || "Project action failed."
    });
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