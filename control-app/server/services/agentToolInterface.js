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
  { name: "create_project", description: "Create and register a new project folder, with optional app open." },
  { name: "open_project", description: "Open a managed project by name or id and optionally open the app UI." }
];

export function getToolDefinitions() {
  return TOOL_DEFINITIONS;
}

export function getToolNamesSet() {
  return new Set(TOOL_DEFINITIONS.map((tool) => tool.name));
}

export function executeToolCall(toolName, args = {}) {
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
      const target = String(args.target || args.appId || "").trim();
      if (!target) {
        return fail("INVALID_OPEN_TARGET", "open_app requires a target or appId.");
      }

      const isSystemTab = ["overview", "settings", "chatbot", "event-bus", "agent-core", "integration-hub"].includes(target);
      const windowApps = ["news-app", "work-app", "project-app"];
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

    case "list_events": {
      const limit = Number(args.limit || 25);
      return ok({ events: getRecentEvents(limit) });
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
