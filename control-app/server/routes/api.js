import { Router } from "express";
import { systemConfig } from "../config.js";
import { getAllApps, getAppById } from "../services/appRegistry.js";
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
import { getChatMessages, postUserMessage } from "../services/chatService.js";

const router = Router();

router.get("/health", (req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

router.get("/system", (req, res) => {
  res.json({
    ...systemConfig,
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

router.get("/chat/messages", (req, res) => {
  const limit = req.query.limit;
  res.json({ messages: getChatMessages(limit) });
});

router.post("/chat/messages", (req, res) => {
  const result = postUserMessage(req.body?.text);
  if (!result.ok) {
    res.status(400).json(result);
    return;
  }

  publishEvent({
    source: "chat",
    appId: "control-center",
    type: "chat",
    message: "Text chat exchange completed.",
    meta: {
      userMessageId: result.userMessage.id,
      agentMessageId: result.agentMessage.id
    }
  });

  res.status(201).json(result);
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