import { existsSync, readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { filterAgentOutput } from "./agentCommandFilter.js";
import { getAppMessageContext } from "./appMessageService.js";
import { buildAgentContextBundle } from "./agentContextLoader.js";
import { getChatHistoryContext } from "./chatService.js";
import {
  getLmStudioState,
  requestLmStudioChatCompletion
} from "./lmStudioService.js";
import {
  executeToolCall,
  getToolDefinitions,
  getToolNamesSet
} from "./agentToolInterface.js";

let pendingProjectCreation = null;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const contextFilePath = path.join(__dirname, "..", "..", "agent", "AGENT_TOOL_CONTEXT.txt");

export function getAgentContextText() {
  return readFileSync(contextFilePath, "utf-8");
}

export function getAgentToolCatalog() {
  return getToolDefinitions();
}

export function getAgentRuntimeStatus() {
  return {
    lmStudio: getLmStudioState()
  };
}

export async function runAgentTurn({ userText, llmOutput, origin = { type: "user" } }) {
  const projectCreationResult = await handleProjectCreationConversation(userText, origin);
  if (projectCreationResult) {
    return projectCreationResult;
  }

  const timeResponse = buildDeterministicTimeResponse(userText, origin);
  if (timeResponse) {
    return timeResponse;
  }

  // Fast path: try deterministic tool calls BEFORE hitting the LLM
  let toolCalls = [];
  let safeMessages = [];
  let safeText = "";
  let rawOutput = "";

  const deterministicCalls = buildDeterministicToolCalls(userText, origin);
  if (deterministicCalls.length > 0) {
    toolCalls = deterministicCalls;
    safeMessages = buildMessagesForToolCalls(deterministicCalls);
    safeText = safeMessages[0] || "Executing command...";
  } else {
    // No deterministic match — fall back to LLM
    const providedOutput = String(llmOutput || "").trim();
    rawOutput = providedOutput || (await generateLmStudioOutput(userText, origin));
    const filterResult = filterAgentOutput(rawOutput, getToolNamesSet());

    if (!filterResult.ok) {
      return {
        ok: false,
        code: filterResult.code,
        message: filterResult.message,
        agentText: filterResult.safeText,
        agentMessages: filterResult.safeText ? [filterResult.safeText] : [],
        toolSummary: "",
        toolResults: []
      };
    }

    // Filter succeeded, use its tool calls and messages
    let resolvedToolCalls = ensureNewsOpenCall(filterResult.toolCalls, userText, origin);
    resolvedToolCalls = ensureNamedProjectOpenCall(resolvedToolCalls, userText, origin);
    resolvedToolCalls = ensureWorkProjectOpenCall(resolvedToolCalls, userText, origin);
    toolCalls = resolvedToolCalls;
    safeMessages = Array.isArray(filterResult.safeMessages) ? [...filterResult.safeMessages] : [];

    if (toolCalls.length > filterResult.toolCalls.length && !safeMessages.length) {
      safeMessages = buildMessagesForToolCalls(toolCalls.slice(filterResult.toolCalls.length));
    }
    safeText = safeMessages[0] || filterResult.safeText || "";
  }

  const seenOpenAppTargets = new Set();
  const seenCloseAppTargets = new Set();
  const safeToolCalls = normalizeToolCallsForSafety(userText, toolCalls);
  const dedupedToolCalls = safeToolCalls.filter((call) => {
    if (call?.tool === "open_app") {
      const target = String(call?.args?.target || call?.args?.appId || call?.args?.app_name || "").trim();
      if (!target || seenOpenAppTargets.has(target)) {
        return false;
      }
      seenOpenAppTargets.add(target);
    }
    if (call?.tool === "close_app") {
      const target = String(call?.args?.target || call?.args?.appId || call?.args?.app_name || "").trim();
      if (!target || seenCloseAppTargets.has(target)) {
        return false;
      }
      seenCloseAppTargets.add(target);
    }
    return true;
  });

  const toolResults = await Promise.all(
    dedupedToolCalls.map(async (call) => {
      const result = await executeToolCall(call.tool, call.args);
      return { tool: call.tool, args: call.args, result };
    })
  );

  let postToolAgentMessage = "";
  const llmMusicIntent = origin?.type === "user"
    ? await inferMusicPlaybackIntentWithLlm(userText, toolResults)
    : null;
  const playlistIntent = llmMusicIntent?.kind === "playlist"
    ? { playlistName: llmMusicIntent.requestedName }
    : null;
  const artistIntent = llmMusicIntent?.kind === "artist"
    ? { artistName: llmMusicIntent.requestedName }
    : null;
  if (playlistIntent || artistIntent) {
    const alreadyOpeningMusic = toolResults.some(
      (entry) =>
        entry?.tool === "open_app" &&
        entry?.result?.ok &&
        String(entry?.args?.target || entry?.args?.appId || "") === "music-app"
    );

    if (!alreadyOpeningMusic) {
      const openMusicResult = await executeToolCall("open_app", { target: "music-app" });
      toolResults.push({
        tool: "open_app",
        args: { target: "music-app" },
        result: openMusicResult
      });
    }

    const orchestration = await resolveRequestedMusicPlayback(toolResults, {
      playlistIntent,
      artistIntent
    });
    if (orchestration.playResult) {
      toolResults.push(orchestration.playResult);
    }
    if (orchestration.extraLookupResult) {
      toolResults.push(orchestration.extraLookupResult);
    }
    postToolAgentMessage = orchestration.agentMessage || "";
  }

  const summary = summarizeToolResults(toolResults);
  let agentMessages = safeMessages;
  if (postToolAgentMessage) {
    agentMessages = [postToolAgentMessage];
  } else {
    const synthesized = synthesizeToolMessages(toolResults);
    if (synthesized.length) {
      agentMessages = synthesized;
    } else if (!agentMessages.length || /executing command/i.test(agentMessages[0])) {
      agentMessages = [];
    }
  }
  const agentText = agentMessages[0] || safeText || "";

  return {
    ok: true,
    agentText,
    agentMessages,
    toolSummary: summary,
    toolResults,
    rawOutput
  };
}

async function handleProjectCreationConversation(userText, origin) {
  if (origin?.type !== "user") {
    return null;
  }

  const rawText = String(userText || "").trim();
  if (!rawText) {
    return null;
  }

  const prompt = rawText.toLowerCase();

  if (/\b(cancel|never mind|nevermind|stop)\b/.test(prompt) && pendingProjectCreation) {
    pendingProjectCreation = null;
    return {
      ok: true,
      agentText: "Project creation canceled.",
      agentMessages: ["Project creation canceled."],
      toolSummary: "",
      toolResults: []
    };
  }

  const explicitCreateIntent = /\b(create|make|start|new)\b.*\b(project)\b|\bnew project\b/.test(prompt);

  if (!pendingProjectCreation && !explicitCreateIntent) {
    return null;
  }

  if (!pendingProjectCreation) {
    const appType = /\b(work|work app|work project)\b/.test(prompt) ? "work-app" : "project-app";
    const extractedPath = extractWindowsPath(rawText);
    const extractedDrive = extractDriveLetter(rawText);
    const driveBasedPath = extractedDrive ? getDefaultProjectBasePath(appType, extractedDrive) : null;
    const extractedName = extractProjectName(rawText);
    const basePath = extractedPath || driveBasedPath;

    pendingProjectCreation = {
      appType,
      basePath: basePath || null,
      driveLetter: extractedDrive || null,
      projectName: extractedName || null,
      awaiting: basePath ? "name" : "path"
    };

    if (!basePath) {
      return {
        ok: true,
        agentText: "Where do you want to save it? You can send just a drive letter like D, or a full folder path.",
        agentMessages: [
          "Where do you want to save it? You can send just a drive letter like D, or a full folder path.",
          "If you send only a drive letter, I will use a default folder there automatically.",
          "After that, I will ask for the project name and create it automatically."
        ],
        toolSummary: "",
        toolResults: []
      };
    }

    if (!extractedName) {
      return {
        ok: true,
        agentText: "What should I name the project?",
        agentMessages: ["What should I name the project?"],
        toolSummary: "",
        toolResults: []
      };
    }
  }

  if (pendingProjectCreation?.awaiting === "path") {
    const pathFromReply = extractWindowsPath(rawText);
    const driveFromReply = extractDriveLetter(rawText);
    const pathFromDrive = driveFromReply
      ? getDefaultProjectBasePath(pendingProjectCreation.appType, driveFromReply)
      : null;

    if (!pathFromReply && !pathFromDrive) {
      return {
        ok: true,
        agentText: "I still need a save location. Send a drive letter like C, D, or E, or send a full path.",
        agentMessages: [
          "I still need a save location. Send a drive letter like C, D, or E, or send a full path."
        ],
        toolSummary: "",
        toolResults: []
      };
    }

    pendingProjectCreation.basePath = pathFromReply || pathFromDrive;
    pendingProjectCreation.driveLetter = driveFromReply || pendingProjectCreation.driveLetter;
    const inferredNameFromReply = sanitizeProjectName(extractProjectName(rawText));

    if (inferredNameFromReply) {
      pendingProjectCreation.projectName = inferredNameFromReply;
      pendingProjectCreation.awaiting = "name";

      const createArgs = {
        appType: pendingProjectCreation.appType,
        basePath: pendingProjectCreation.basePath,
        projectName: pendingProjectCreation.projectName,
        openApp: true
      };

      const createResult = await executeToolCall("create_project", createArgs);
      const toolResults = [{ tool: "create_project", args: createArgs, result: createResult }];
      const toolSummary = summarizeToolResults(toolResults);

      if (!createResult.ok) {
        pendingProjectCreation = {
          ...pendingProjectCreation,
          awaiting: "path"
        };

        return {
          ok: true,
          agentText: `I couldn't create that project yet: ${createResult.message}. Please send another drive letter or save path.`,
          agentMessages: [
            `I couldn't create that project yet: ${createResult.message}.`,
            "Please send another drive letter or full save path and I will retry."
          ],
          toolSummary,
          toolResults
        };
      }

      const createdProject = createResult.project;
      pendingProjectCreation = null;

      return {
        ok: true,
        agentText: `Created ${createdProject.name} at ${createdProject.path} and opened ${createArgs.appType === "work-app" ? "Work App" : "Personal Projects"}.`,
        agentMessages: [
          `Created ${createdProject.name} at ${createdProject.path}.`,
          `Opened ${createArgs.appType === "work-app" ? "Work App" : "Personal Projects"} so you can start working immediately.`
        ],
        toolSummary,
        toolResults
      };
    }

    pendingProjectCreation.awaiting = "name";

    const locationMessage = pathFromDrive
      ? `Great. I will save it under ${pathFromDrive}. What should I name the project?`
      : "Great. What should I name the project?";

    return {
      ok: true,
      agentText: locationMessage,
      agentMessages: [locationMessage],
      toolSummary: "",
      toolResults: []
    };
  }

  if (pendingProjectCreation?.awaiting === "name") {
    const nameFromReply = extractProjectName(rawText) || rawText;
    const cleanName = sanitizeProjectName(nameFromReply);

    if (!cleanName) {
      return {
        ok: true,
        agentText: "Please provide a project name, for example: Inventory API.",
        agentMessages: ["Please provide a project name, for example: Inventory API."],
        toolSummary: "",
        toolResults: []
      };
    }

    pendingProjectCreation.projectName = cleanName;

    const createArgs = {
      appType: pendingProjectCreation.appType,
      basePath: pendingProjectCreation.basePath,
      projectName: pendingProjectCreation.projectName,
      openApp: true
    };

    const createResult = await executeToolCall("create_project", createArgs);
    const toolResults = [{ tool: "create_project", args: createArgs, result: createResult }];
    const toolSummary = summarizeToolResults(toolResults);

    if (!createResult.ok) {
      pendingProjectCreation = {
        ...pendingProjectCreation,
        awaiting: "path"
      };

      return {
        ok: true,
        agentText: `I couldn't create that project yet: ${createResult.message}. Please send another drive letter or save path.`,
        agentMessages: [
          `I couldn't create that project yet: ${createResult.message}.`,
          "Please send another drive letter or full save path and I will retry."
        ],
        toolSummary,
        toolResults
      };
    }

    const createdProject = createResult.project;
    pendingProjectCreation = null;

    return {
      ok: true,
      agentText: `Created ${createdProject.name} at ${createdProject.path} and opened ${createArgs.appType === "work-app" ? "Work App" : "Personal Projects"}.`,
      agentMessages: [
        `Created ${createdProject.name} at ${createdProject.path}.`,
        `Opened ${createArgs.appType === "work-app" ? "Work App" : "Personal Projects"} so you can start working immediately.`
      ],
      toolSummary,
      toolResults
    };
  }

  return null;
}

function extractWindowsPath(text) {
  const match = String(text || "").match(/[A-Za-z]:\\[^"'\n\r]+/);
  return match ? match[0].trim() : null;
}

function extractDriveLetter(text) {
  const raw = String(text || "").trim();
  if (!raw) {
    return null;
  }

  const patterns = [
    /\b([a-z])\s*:\s*(?:drive)?\b/i,
    /\bdrive\s*([a-z])\b/i,
    /\b([a-z])\s*drive\b/i,
    /\bin\s+my\s+([a-z])\s*drive\b/i,
    /\buse\s+([a-z])\b/i,
    /^\s*([a-z])\s*$/i
  ];

  for (const pattern of patterns) {
    const driveMatch = raw.match(pattern);
    if (!driveMatch || !driveMatch[1]) {
      continue;
    }

    const driveLetter = driveMatch[1].toUpperCase();
    if (driveExists(driveLetter)) {
      return driveLetter;
    }
  }

  return null;
}

function driveExists(driveLetter) {
  if (!driveLetter) {
    return false;
  }

  const rootPath = `${driveLetter}:\\`;
  return existsSync(rootPath);
}

function getDefaultProjectBasePath(appType, driveLetter) {
  const safeDrive = String(driveLetter || "").toUpperCase();
  if (!driveExists(safeDrive)) {
    return null;
  }

  const groupFolder = appType === "work-app" ? "Work Projects" : "Personal Projects";
  return path.join(`${safeDrive}:\\`, "Control-Center Projects", groupFolder);
}

function extractProjectName(text) {
  const raw = String(text || "").trim();
  if (!raw) {
    return null;
  }

  const commandOnlyPatterns = [
    /^\s*(create|make|start|new)\b.*\bproject\b\s*$/i,
    /^\s*(project|new project)\s*$/i
  ];
  if (commandOnlyPatterns.some((pattern) => pattern.test(raw))) {
    return null;
  }

  const quoted = raw.match(/"([^"]+)"|'([^']+)'/);
  if (quoted) {
    return (quoted[1] || quoted[2] || "").trim();
  }

  const namedPattern = raw.match(/(?:called|named|name it|project name is)\s+(.+)$/i);
  if (namedPattern) {
    let candidate = namedPattern[1].trim();
    // Strip trailing drive/path location phrases
    candidate = candidate
      .replace(/\b(?:and\s+)?(?:put|place|save|store)\s+(?:it\s+)?(?:in|on|at|into|to|under)\s+(?:my\s+)?(?:[a-z]\s*:?\s*(?:drive)?|[a-z]:\\[^\s]*)\b.*/i, "")
      .replace(/\b(?:in|on|at|into|to|under)\s+(?:my\s+)?(?:[a-z]\s*:?\s*(?:drive)?|[a-z]:\\[^\s]*)\b.*/i, "")
      .trim();
    if (candidate) {
      return candidate;
    }
  }

  const driveAndNamePattern = raw.match(
    /\b(?:in|on|use)\s+(?:my\s+)?(?:[a-z]\s*:|[a-z])\s*(?:drive)?\b[\s,.-]*(?:it(?:\s+will)?\s+be|it'?ll\s+be|project\s+name\s+is|named|called)\s+(.+)$/i
  );
  if (driveAndNamePattern) {
    return driveAndNamePattern[1].trim();
  }

  const genericCreatePattern = raw.match(/(?:create|make|new|start)\s+(?:a\s+)?(?:new\s+)?project\s+(.+)$/i);
  if (genericCreatePattern) {
    let candidate = genericCreatePattern[1].trim();
    // Strip drive/path location phrases so they don't become the project name
    candidate = candidate
      .replace(/\b(?:and\s+)?(?:put|place|save|store)\s+(?:it\s+)?(?:in|on|at|into|to|under)\s+(?:my\s+)?(?:[a-z]\s*:?\s*(?:drive)?|[a-z]:\\[^\s]*)\b.*/i, "")
      .replace(/\b(?:in|on|at|into|to|under)\s+(?:my\s+)?(?:[a-z]\s*:?\s*(?:drive)?|[a-z]:\\[^\s]*)\b.*/i, "")
      .trim();
    if (candidate) {
      return candidate;
    }
    // If stripping left nothing, the user only specified a location — no name yet
    return null;
  }

  if (/^[\w\s\-.]{2,}$/.test(raw) && !raw.includes("\\") && !raw.includes("/")) {
    return raw;
  }

  return null;
}

function sanitizeProjectName(name) {
  return String(name || "")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildDeterministicToolCalls(userText, origin) {
  if (origin?.type !== "user") {
    return [];
  }

  const rawText = String(userText || "").trim();
  const prompt = String(userText || "").toLowerCase();
  const calls = [];

  const closeAppTarget = extractCloseAppTarget(prompt);
  if (closeAppTarget) {
    calls.push({ tool: "close_app", args: { target: closeAppTarget } });
    return calls;
  }

  // Check for explicit system shutdown intent only.
  if (extractSystemShutdownIntent(prompt)) {
    calls.push({ tool: "shutdown_app", args: {} });
    return calls;
  }

  if (extractCalendarOpenIntent(prompt)) {
    calls.push({ tool: "open_app", args: { target: "calendar-app" } });
    return calls;
  }

  const calendarCreateIntent = extractCalendarCreateIntent(rawText);
  if (calendarCreateIntent) {
    calls.push({
      tool: "create_calendar_event",
      args: calendarCreateIntent
    });
    return calls;
  }

  const calendarDeleteIntent = extractCalendarDeleteIntent(rawText);
  if (calendarDeleteIntent) {
    calls.push({
      tool: "delete_calendar_event",
      args: calendarDeleteIntent
    });
    return calls;
  }

  if (extractRemainingCalendarIntent(prompt)) {
    calls.push({ tool: "get_remaining_calendar_events", args: {} });
    return calls;
  }

  const calendarRangeIntent = extractCalendarRangeIntent(prompt);
  if (calendarRangeIntent) {
    calls.push({
      tool: "list_calendar_events",
      args: {
        start: calendarRangeIntent.start,
        end: calendarRangeIntent.end,
        limit: 50,
        summaryLabel: calendarRangeIntent.label
      }
    });
    return calls;
  }

  const calendarSpecificDateIntent = extractCalendarSpecificDateIntent(rawText);
  if (calendarSpecificDateIntent) {
    calls.push({
      tool: "list_calendar_events",
      args: {
        start: calendarSpecificDateIntent.start,
        end: calendarSpecificDateIntent.end,
        limit: 50,
        summaryLabel: calendarSpecificDateIntent.label
      }
    });
    return calls;
  }

  if (extractCalendarReadIntent(prompt)) {
    const range = getTodayIsoRange();
    calls.push({
      tool: "list_calendar_events",
      args: {
        start: range.start,
        end: range.end,
        limit: 25
      }
    });
    return calls;
  }

  const openProjectTarget = extractProjectOpenTarget(prompt);
  if (openProjectTarget) {
    calls.push({
      tool: "open_project",
      args: {
        appType: openProjectTarget.appType,
        projectName: openProjectTarget.projectName,
        openApp: true
      }
    });
    return calls;
  }

  // Check for news intent
  if (/\b(news|headline|headlines?|what'?s the news|show me news|open news|read me.*(news|headlines?)|brief me|briefing)\b/.test(prompt)) {
    const isNegative = /\b(don't|do not|no|not)\b.*\b(news|headlines?|open)\b/.test(prompt);
    if (!isNegative) {
      const shouldOpenNewsApp = /\b(open|launch|start)\b.*\b(news|headlines?|news app)\b/.test(prompt) || /\bshow\b.*\b(news app)\b/.test(prompt);
      if (shouldOpenNewsApp) {
        calls.push({ tool: "open_app", args: { target: "news-app" } });
      }
      calls.push({ tool: "get_news_summary", args: {} });
    }
  }

  // Check for work app intent
  if (/\b(work|work app|open work|show work|my work)\b/.test(prompt)) {
    calls.push({ tool: "open_app", args: { target: "work-app" } });
  }

  // Check for project app intent (including plurals)
  if (/\b(projects?|project app|open project|show project|my project|personal projects?)\b/.test(prompt)) {
    calls.push({ tool: "open_app", args: { target: "project-app" } });
  }

  // Check for movie app intent
  if (/\b(movie|movies|movie app|open movie|show movie|watch movie|film app|open films?)\b/.test(prompt)) {
    calls.push({ tool: "open_app", args: { target: "movie-app" } });
  }

  // Check for server manager app intent
  if (/\b(server manager|server-manager|servers|server app|open server manager|manage servers?)\b/.test(prompt)) {
    calls.push({ tool: "open_app", args: { target: "server-manager-app" } });
  }

  return calls;
}

function buildDeterministicTimeResponse(userText, origin) {
  if (origin?.type !== "user") {
    return null;
  }

  const prompt = String(userText || "").trim().toLowerCase();
  if (!prompt) {
    return null;
  }

  const asksForTime = /\b(what time is it|what'?s the time|tell me the time|current time|time right now|time is it|do you know the time)\b/.test(prompt);
  if (!asksForTime) {
    return null;
  }

  const localTime = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true
  }).format(new Date());

  return {
    ok: true,
    agentText: `It is ${localTime}.`,
    agentMessages: [`It is ${localTime}.`],
    toolSummary: "",
    toolResults: []
  };
}

function buildMessagesForToolCalls(calls) {
  if (!Array.isArray(calls) || calls.length === 0) {
    return [];
  }

  return calls.map((call) => {
    const target = call?.args?.target || call?.args?.appId || "";
    if (target === "calendar-app") {
      return "Opening Calendar App.";
    } else if (target === "news-app") {
      return "Opening News App.";
    } else if (target === "work-app") {
      return "Opening Work App.";
    } else if (target === "music-app") {
      return "Opening Music App.";
    } else if (target === "drawing-app") {
      return "Opening Drawing App.";
    } else if (target === "movie-app") {
      return "Opening Movie App.";
    } else if (target === "server-manager-app") {
      return "Opening Server Manager App.";
    } else if (target === "project-app") {
      return "Opening Personal Projects.";
    } else if (call?.tool === "close_app") {
      const closeTarget = String(call?.args?.target || "").trim();
      if (closeTarget === "all-apps") {
        return "Closing all app windows.";
      }
      if (closeTarget === "news-app") return "Closing News App.";
      if (closeTarget === "calendar-app") return "Closing Calendar App.";
      if (closeTarget === "work-app") return "Closing Work App.";
      if (closeTarget === "project-app") return "Closing Personal Projects.";
      if (closeTarget === "music-app") return "Closing Music App.";
      if (closeTarget === "drawing-app") return "Closing Drawing App.";
      if (closeTarget === "movie-app") return "Closing Movie App.";
      if (closeTarget === "server-manager-app") return "Closing Server Manager App.";
      return "Closing that app.";
    } else if (call?.tool === "list_music_genres") {
      return "Checking available music genres.";
    } else if (call?.tool === "list_music_artists") {
      return "Checking available artists.";
    } else if (call?.tool === "list_music_playlists") {
      return "Checking your playlists.";
    } else if (call?.tool === "create_music_playlist") {
      return "Creating that playlist now.";
    } else if (call?.tool === "add_track_to_playlist") {
      return "Adding that track to your playlist.";
    } else if (call?.tool === "list_music_tracks") {
      return "Fetching matching tracks.";
    } else if (call?.tool === "get_remaining_calendar_events" || call?.tool === "list_calendar_events") {
      return "Checking your calendar.";
    } else if (call?.tool === "create_calendar_event") {
      return "Adding that to your calendar.";
    } else if (call?.tool === "delete_calendar_event") {
      return "Removing that from your calendar.";
    } else if (call?.tool === "publish_event" && String(call?.args?.type || "") === "music-command") {
      const action = String(call?.args?.meta?.action || "");
      if (action === "play-pause") return "Done.";
      if (action === "next") return "Skipping to the next track.";
      if (action === "prev") return "Going back to the previous track.";
      return "Starting that playlist now.";
    }
    return "Executing command...";
  });
}

function synthesizeToolMessages(toolResults) {
  if (!Array.isArray(toolResults) || !toolResults.length) {
    return [];
  }

  // Check for news summary anywhere in results (may come alongside open_app)
  const newsResult = toolResults.find((r) => r?.tool === "get_news_summary" && r?.result?.ok);
  if (newsResult) {
    const summary = newsResult.result.summary || newsResult.result.digest || "No news available right now.";
    return [`Sir, here's your news briefing. ${summary}`];
  }

  const primary = toolResults[0];
  const result = primary?.result || {};

  if (!result.ok) {
    return [];
  }

  if (primary.tool === "list_music_genres") {
    const genres = Array.isArray(result.genres) ? result.genres : [];
    if (!genres.length) {
      return ["Sir, no genres are available yet."];
    }
    return [`Sir, available genres are: ${genres.join(", ")}.`];
  }

  if (primary.tool === "list_music_artists") {
    const artists = Array.isArray(result.artists) ? result.artists : [];
    if (!artists.length) {
      return ["Boss Man, no artists are available yet."];
    }
    return [`Boss Man, available artists are: ${artists.join(", ")}.`];
  }

  if (primary.tool === "list_music_playlists") {
    const rawPlaylists = Array.isArray(result.playlists) ? result.playlists : [];
    const localOnlyRequested = Boolean(primary?.args?.localOnly);
    const playlists = localOnlyRequested
      ? rawPlaylists.filter((playlist) => String(playlist?.source || "").toLowerCase() === "local-saved")
      : rawPlaylists;
    if (!playlists.length) {
      return ["Sir, you do not have any playlists yet. Say 'create playlist <name>' to start one."];
    }
    const summary = playlists.map((playlist) => `${playlist.name} (${playlist.count || 0})`).join(", ");
    return [`Sir, your playlists are: ${summary}.`];
  }

  if (primary.tool === "create_music_playlist") {
    const name = result.playlist?.name || "that playlist";
    return [`Boss Man, created playlist ${name}.`];
  }

  if (primary.tool === "add_track_to_playlist") {
    const playlistName = result.playlist?.name || "the playlist";
    const trackTitle = result.track?.title || "that track";
    return [`Sir, added ${trackTitle} to ${playlistName}.`];
  }

  if (primary.tool === "list_music_tracks") {
    const tracks = Array.isArray(result.tracks) ? result.tracks : [];
    if (!tracks.length) {
      return ["Boss Man, I found no matching tracks."];
    }
    const preview = tracks.slice(0, 6).map((track) => `${track.title} by ${track.artist}`).join(", ");
    return [`Boss Man, here are matching tracks: ${preview}.`];
  }

  if (primary.tool === "get_remaining_calendar_events") {
    const events = Array.isArray(result.events) ? result.events : [];
    if (!events.length) {
      return ["Sir, the rest of your day is clear."];
    }

    return [`Sir, for the rest of ${result.dateLabel || "today"}, you have ${formatCalendarEventSummary(events)}.`];
  }

  if (primary.tool === "list_calendar_events") {
    const events = Array.isArray(result.events) ? result.events : [];
    const summaryLabel = String(primary?.args?.summaryLabel || "that window").trim();
    if (!events.length) {
      return [`Boss Man, your calendar is clear for ${summaryLabel}.`];
    }

    return [`Boss Man, for ${summaryLabel}, I found ${formatCalendarEventSummary(events)}.`];
  }

  if (primary.tool === "create_calendar_event") {
    const event = result.event || result?.result?.event;
    if (!event?.title) {
      return ["Sir, I added that calendar event."];
    }

    return [`Sir, added ${event.title} for ${event.startLabel} on ${formatCalendarDateKey(event.startDateKey)}.`];
  }

  if (primary.tool === "delete_calendar_event") {
    const event = result.event || result?.result?.event;
    if (!event?.title) {
      return ["Sir, I removed that calendar event."];
    }

    return [`Sir, removed ${event.title} from your calendar.`];
  }

  if (primary.tool === "close_app") {
    if (result.closeAll) {
      return ["Sir, closed all app windows."];
    }
    return [`Sir, closed ${result.label || "that app"}.`];
  }

  return [];
}

async function generateLmStudioOutput(userText, origin = { type: "user" }) {
  const toolContract = buildToolContractSnippet();
  const contextBundle = buildAgentContextBundle(userText);
  const chatHistoryContext = getChatHistoryContext(14);
  const appMessageContext = getAppMessageContext(16);
  const originType = origin?.type === "app" ? "app" : "user";
  const appOriginInstruction =
    originType === "app"
      ? [
          "The current inbound message is from an app module, not the human user.",
          "App-origin messages use the format {Origin App}[message].",
          "Only notify the user in chat if the app message is useful, actionable, or time-sensitive.",
          "If the app message is not worth surfacing, return tool='none' and an empty second object {}."
        ].join("\n")
      : "The current inbound message is from the human user.";

  const messages = [
    {
      role: "system",
      content: [
        "You are the Control Center assistant running in a local desktop app.",
        "Adopt a hyper-intelligent J.A.R.V.I.S.-style voice: clear, precise, professional, proactive, and confident.",
        "Be conversational, helpful, and direct without sounding robotic.",
        "Default to one concise response message unless the user explicitly asks for a long or structured breakdown.",
        "Avoid unsolicited long-form ideas, frameworks, or brainstorming unless requested.",
        "For news requests, provide a short answer only and avoid multi-section formatting by default.",
        "Use subtle wit only when appropriate and never let humor reduce clarity.",
        "Think step-by-step internally, but do not reveal chain-of-thought; provide concise rationale-focused explanations.",
        "You must follow the exact output envelope and tool rules.",
        "Output MUST be only two JSON objects and no prose outside those objects.",
        "If no tool is needed, use tool='none'.",
        "Do not send filler like 'I'll check now' or 'one moment'.",
        "If a tool is required, wait until after the tool call to provide useful user-facing messages.",
        "Prefer a single second object with 'response' rather than a 'messages' array.",
        "Messages may arrive either from the user or from apps posting background updates."
      ].join("\n")
    },
    {
      role: "system",
      content: toolContract
    },
    {
      role: "system",
      content: `Project context files:\n${contextBundle.text || "No project context files were loaded."}`
    },
    {
      role: "system",
      content: `Recent chat history context:\n${chatHistoryContext}`
    },
    {
      role: "system",
      content: `Recent app message context:\n${appMessageContext}`
    },
    {
      role: "system",
      content: appOriginInstruction
    },
    {
      role: "user",
      content: String(userText || "")
    }
  ];

  const llmResult = await requestLmStudioChatCompletion({ messages, temperature: 0.2 });
  if (llmResult.ok) {
    return llmResult.content;
  }

  return generateLocalLlmOutput(userText);
}

function buildToolContractSnippet() {
  const toolNames = getToolDefinitions()
    .map((tool) => tool.name)
    .join(", ");

  return [
    "Response envelope format:",
    '{"tool":"<tool_or_none>","args":{...}}{"response":"<user message>"}',
    'Or for multiple messages: {"tool":"<tool_or_none>","args":{...}}{"messages":["<message 1>","<message 2>"]}',
    "For parallel tool calls use:",
    '{{"tool":"a","args":{}} | {"tool":"b","args":{}}}{"response":"..."}',
    `Allowed tools: ${toolNames}`
  ].join("\n");
}

function generateLocalLlmOutput(userText) {
  const prompt = String(userText || "").toLowerCase();
  const appMessageMatch = String(userText || "").match(/^\{([^}]+)\}\[(.*)\]$/s);

  if (appMessageMatch) {
    const appName = String(appMessageMatch[1] || "App").trim();
    const appText = String(appMessageMatch[2] || "").trim();
    const notifyWords = /\b(alert|urgent|warning|error|failed|failure|deadline|meeting|starting|reminder|offline|down|problem)\b/i;

    if (notifyWords.test(appText)) {
      return [
        '{"tool":"none","args":{}}',
        `{"messages":["${escapeJsonString(`${appName}: ${appText}`)}"]}`
      ].join("\n");
    }

    return ['{"tool":"none","args":{}}', "{}"].join("\n");
  }

  if (prompt.includes("news") || prompt.includes("headline") || prompt.includes("headlines")) {
    return [
      '{"tool":"open_app","args":{"target":"news-app"}}',
      '{"response":"Opening News App."}'
    ].join("\n");
  }

  if (extractCalendarOpenIntent(prompt)) {
    return [
      '{"tool":"open_app","args":{"target":"calendar-app"}}',
      '{"response":"Opening Calendar App."}'
    ].join("\n");
  }

  if (extractRemainingCalendarIntent(prompt)) {
    return [
      '{"tool":"get_remaining_calendar_events","args":{}}',
      '{"response":"Checking the rest of your day."}'
    ].join("\n");
  }

  const calendarRangeIntent = extractCalendarRangeIntent(prompt);
  if (calendarRangeIntent) {
    return [
      `{"tool":"list_calendar_events","args":{"start":"${calendarRangeIntent.start}","end":"${calendarRangeIntent.end}","limit":50,"summaryLabel":"${escapeJsonString(calendarRangeIntent.label)}"}}`,
      `{"response":"Checking ${escapeJsonString(calendarRangeIntent.label)}."}`
    ].join("\n");
  }

  const calendarSpecificDateIntent = extractCalendarSpecificDateIntent(String(userText || ""));
  if (calendarSpecificDateIntent) {
    return [
      `{"tool":"list_calendar_events","args":{"start":"${calendarSpecificDateIntent.start}","end":"${calendarSpecificDateIntent.end}","limit":50,"summaryLabel":"${escapeJsonString(calendarSpecificDateIntent.label)}"}}`,
      `{"response":"Checking ${escapeJsonString(calendarSpecificDateIntent.label)}."}`
    ].join("\n");
  }

  if (extractCalendarReadIntent(prompt)) {
    const todayRange = getTodayIsoRange();
    return [
      `{"tool":"list_calendar_events","args":{"start":"${todayRange.start}","end":"${todayRange.end}","limit":25}}`,
      '{"response":"Checking your calendar."}'
    ].join("\n");
  }

  const openProjectTarget = extractProjectOpenTarget(prompt);
  if (openProjectTarget) {
    return [
      `{"tool":"open_project","args":{"appType":"${escapeJsonString(openProjectTarget.appType)}","projectName":"${escapeJsonString(openProjectTarget.projectName)}","openApp":true}}`,
      `{"response":"Opening project ${escapeJsonString(openProjectTarget.projectName)}."}`
    ].join("\n");
  }

  if (prompt.includes("switch") && prompt.includes("mobile")) {
    return [
      '{"tool":"switch_mode","args":{"targetMode":"mobile","source":"agent-runtime"}}',
      '{"response":"I switched Control Center to Mobile Mode."}'
    ].join("\n");
  }

  if (prompt.includes("switch") && prompt.includes("desktop")) {
    return [
      '{"tool":"switch_mode","args":{"targetMode":"desktop","source":"agent-runtime"}}',
      '{"response":"I switched Control Center to Desktop Mode."}'
    ].join("\n");
  }

  if (prompt.includes("list") && prompt.includes("app")) {
    return ['{"tool":"list_apps","args":{}}', '{"response":"I retrieved the app registry."}'].join("\n");
  }

  if (prompt.includes("setting")) {
    return [
      '{"tool":"get_settings","args":{}}',
      '{"response":"I retrieved the current settings."}'
    ].join("\n");
  }

  if (prompt.includes("status") || prompt.includes("system")) {
    return [
      '{{"tool":"get_system_state","args":{}} | {"tool":"list_events","args":{"limit":5}}}',
      '{"response":"I retrieved system state and recent events."}'
    ].join("\n");
  }

  return [
    '{"tool":"none","args":{}}',
    `{"response":"I received your message: \"${escapeJsonString(String(userText || "").trim())}\". No tool call was required."}`
  ].join("\n");
}

function ensureNewsOpenCall(toolCalls, userText, origin) {
  const currentCalls = Array.isArray(toolCalls) ? [...toolCalls] : [];

  if (!shouldAutoOpenNewsForUser(userText, origin)) {
    return currentCalls;
  }

  const alreadyOpeningNews = currentCalls.some(
    (call) =>
      call?.tool === "open_app" &&
      String(call?.args?.target || call?.args?.appId || "") === "news-app"
  );

  if (alreadyOpeningNews) {
    return currentCalls;
  }

  return [...currentCalls, { tool: "open_app", args: { target: "news-app" } }];
}

function ensureWorkProjectOpenCall(toolCalls, userText, origin) {
  const currentCalls = Array.isArray(toolCalls) ? [...toolCalls] : [];
  const prompt = String(userText || "").toLowerCase();
  const hasSpecificProjectOpen = currentCalls.some((call) => call?.tool === "open_project");

  if (origin?.type !== "user") {
    return currentCalls;
  }

  // Check for work app intent
  if (/\b(work|work app|open work|show work|my work)\b/.test(prompt)) {
    const alreadyOpen = currentCalls.some(
      (call) =>
        call?.tool === "open_app" &&
        String(call?.args?.target || call?.args?.appId || "") === "work-app"
    );
    if (!alreadyOpen) {
      return [...currentCalls, { tool: "open_app", args: { target: "work-app" } }];
    }
  }

  // Check for project app intent (including plurals)
  if (/\b(projects?|project app|open project|show project|my project|personal projects?)\b/.test(prompt)) {
    if (hasSpecificProjectOpen) {
      return currentCalls;
    }

    const alreadyOpen = currentCalls.some(
      (call) =>
        call?.tool === "open_app" &&
        String(call?.args?.target || call?.args?.appId || "") === "project-app"
    );
    if (!alreadyOpen) {
      return [...currentCalls, { tool: "open_app", args: { target: "project-app" } }];
    }
  }

  return currentCalls;
}

function shouldAutoOpenNewsForUser(userText, origin) {
  if (origin?.type !== "user") {
    return false;
  }

  const prompt = String(userText || "").toLowerCase();
  const hasExplicitOpenIntent =
    /\b(open|launch|start)\b.*\b(news|headlines?|news app)\b/.test(prompt) ||
    /\bshow\b.*\b(news app)\b/.test(prompt);
  const isNegative = /\b(don't|do not|no|not)\b.*\b(news|headlines|open)\b/.test(prompt);

  return hasExplicitOpenIntent && !isNegative;
}

function ensureNamedProjectOpenCall(toolCalls, userText, origin) {
  const currentCalls = Array.isArray(toolCalls) ? [...toolCalls] : [];
  if (origin?.type !== "user") {
    return currentCalls;
  }

  const target = extractProjectOpenTarget(userText);
  if (!target) {
    return currentCalls;
  }

  const alreadyPresent = currentCalls.some((call) => {
    if (call?.tool !== "open_project") {
      return false;
    }
    const currentName = String(call?.args?.projectName || "").toLowerCase();
    return currentName === target.projectName.toLowerCase();
  });

  if (alreadyPresent) {
    return currentCalls;
  }

  return [
    ...currentCalls,
    {
      tool: "open_project",
      args: {
        appType: target.appType,
        projectName: target.projectName,
        openApp: true
      }
    }
  ];
}

function extractMusicControlAction(prompt) {
  const text = String(prompt || "").toLowerCase();
  if (/\b(pause|unpause|un-?pause|resume)\b.*\b(music|song|track|player|playback)\b/.test(text) ||
      /\b(music|song|track|player|playback)\b.*\b(pause|unpause|un-?pause|resume)\b/.test(text) ||
      /^\s*(pause|unpause|un-?pause|resume)\b/.test(text)) {
    return "play-pause";
  }
  if (/\b(next|skip)\b.*\b(song|track|music)\b/.test(text) ||
      /\b(song|track|music)\b.*\b(next|skip)\b/.test(text) ||
      /^\s*(next|skip)\s*(song|track)?/i.test(text) ||
      /\bskip\s*(this)?\b/.test(text)) {
    return "next";
  }
  if (/\b(prev|previous|go back|last)\b.*\b(song|track|music)\b/.test(text) ||
      /\b(song|track|music)\b.*\b(prev|previous|go back)\b/.test(text) ||
      /^\s*(prev|previous)\s*(song|track)?/i.test(text)) {
    return "prev";
  }
  return null;
}

function extractCalendarOpenIntent(prompt) {
  const text = String(prompt || "").toLowerCase();
  return /\b(open|launch)\b.*\b(calendar|calendar app)\b/.test(text);
}

function extractRemainingCalendarIntent(prompt) {
  const text = String(prompt || "").toLowerCase();
  return /\b(what do i have planned for the rest of the day|rest of the day|later today|what'?s left today|what is left today)\b/.test(text);
}

function extractCalendarRangeIntent(prompt) {
  const text = String(prompt || "").toLowerCase();
  if (extractCalendarOpenIntent(text) || extractRemainingCalendarIntent(text)) {
    return null;
  }
  if (/\b(add|create|schedule|put)\b/.test(text) && /\b(calendar|my\s+calendar)\b/.test(text)) {
    return null;
  }

  const tomorrowPattern = /\b(read|what|what'?s|what is|tell me|show me)?\b.*\b(tomorrow(?:'s)?|tomorrows)\b.*\b(plan|plans|calendar|schedule|calendar instances?)\b|\b(read|what|what'?s|what is|tell me|show me)\b.*\b(plan|plans|calendar|schedule|calendar instances?)\b.*\bfor tomorrow\b/;
  if (tomorrowPattern.test(text)) {
    const range = getTomorrowIsoRange();
    return { ...range, label: "tomorrow" };
  }

  const weekPattern = /\b(read|what|what'?s|what is|tell me|show me)\b.*\b(this week|the rest of the week|rest of the week|this week's|weeks plan|week plan)\b.*\b(plan|plans|calendar|schedule|calendar instances?)?\b|\b(read|what|what'?s|what is|tell me|show me)\b.*\b(plan|plans|calendar|schedule|calendar instances?)\b.*\b(this week|the rest of the week|rest of the week)\b/;
  if (weekPattern.test(text)) {
    const range = /rest of the week/.test(text) ? getRestOfWeekIsoRange() : getThisWeekIsoRange();
    return {
      ...range,
      label: /rest of the week/.test(text) ? "the rest of the week" : "this week"
    };
  }

  return null;
}

function extractCalendarSpecificDateIntent(rawText) {
  const text = String(rawText || "").trim();
  const lower = text.toLowerCase();
  if (!text) {
    return null;
  }

  const hasReadIntent = /\b(read|what|what'?s|what is|tell me|show me)\b/.test(lower);
  const hasScheduleNoun = /\b(calendar|schedule|calendar instances?|plan|plans)\b/.test(lower);
  const hasImplicitCalendarRead = /\bwhat\s+do\s+i\s+have\b/.test(lower) || /\bwhat'?s\s+on\b/.test(lower);
  if (!hasReadIntent || (!hasScheduleNoun && !hasImplicitCalendarRead)) {
    return null;
  }

  if (extractCalendarOpenIntent(lower) || extractRemainingCalendarIntent(lower) || extractCalendarRangeIntent(lower)) {
    return null;
  }

  const onForMatch = text.match(/\b(?:on|for)\s+([^?.!]+)$/i);
  const dateCandidate = onForMatch?.[1] || text;
  const parsedDate = parseCalendarSpecificDate(dateCandidate);
  if (!parsedDate) {
    return null;
  }

  const range = getDateIsoRange(parsedDate);
  return {
    ...range,
    label: formatHumanDate(parsedDate)
  };
}

function extractCalendarReadIntent(prompt) {
  const text = String(prompt || "").toLowerCase();
  if (extractCalendarOpenIntent(text) || extractRemainingCalendarIntent(text) || extractCalendarRangeIntent(text)) {
    return false;
  }

  return /\b(read|what|what'?s|what is|tell me|show me)\b.*\b(calendar|schedule|calendar instances?|plan|plans)\b/.test(text);
}

function extractCalendarCreateIntent(rawText) {
  const text = String(rawText || "").trim();
  if (!text) {
    return null;
  }

  const patterns = [
    /^(?:add|create|schedule)\s+(.+?)\s+to\s+my\s+calendar(?:\s+(?:for|on)\s+(.+))?$/i,
    /^(?:add|create|schedule)\s+(.+?)\s+(?:for|on)\s+(.+?)\s+to\s+my\s+calendar$/i,
    /^(?:add|create|schedule)\s+(.+?)\s+to\s+my\s+calendar\s+(.+)$/i,
    /^(?:put)\s+(.+?)\s+(?:for|on)\s+(.+?)\s+on\s+my\s+calendar$/i,
    /^(?:put)\s+(.+?)\s+on\s+my\s+calendar(?:\s+(?:for|on)\s+(.+))?$/i,
    /^(?:put)\s+(.+?)\s+on\s+my\s+calendar\s+(.+)$/i
  ];

  let title = "";
  let whenText = "";
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match || !match[1]) {
      continue;
    }

    title = String(match[1] || "").trim();
    whenText = String(match[2] || "").trim();
    break;
  }

  if (!title) {
    return null;
  }

  if (!whenText) {
    const inlineWhenMatch = title.match(/\b(today|tomorrow|next\s+(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)|sunday|monday|tuesday|wednesday|thursday|friday|saturday|january|february|march|april|may|june|july|august|september|october|november|december|\d{4}-\d{1,2}-\d{1,2}|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\b.*$/i);
    if (inlineWhenMatch && inlineWhenMatch.index > 0) {
      whenText = inlineWhenMatch[0].trim();
      title = title.slice(0, inlineWhenMatch.index).trim();
      title = title.replace(/\b(for|on)\s*$/i, "").trim();
    }
  }

  const startDate = parseNaturalCalendarDateTime(whenText);
  if (!title || !startDate) {
    return null;
  }

  const endDate = new Date(startDate.getTime() + 60 * 60 * 1000);
  return {
    title,
    startsAt: startDate.toISOString(),
    endsAt: endDate.toISOString()
  };
}

function extractCalendarDeleteIntent(rawText) {
  const text = String(rawText || "").trim();
  const match = text.match(/^(?:remove|delete|cancel)\s+(.+?)\s+from\s+my\s+calendar$/i);
  if (!match || !match[1]) {
    return null;
  }

  return { title: match[1].trim() };
}

function parseNaturalCalendarDateTime(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return null;
  }

  const lower = raw.toLowerCase();
  let base = new Date();
  base.setSeconds(0, 0);

  if (/\btomorrow\b/.test(lower)) {
    base.setDate(base.getDate() + 1);
  } else if (!/\btoday\b/.test(lower)) {
    const parsedDate = parseCalendarSpecificDate(raw);
    if (parsedDate) {
      base = new Date(parsedDate);
    } else {
      return null;
    }
  }

  const explicitAtTimeMatch = lower.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);
  const allTimeMatches = Array.from(lower.matchAll(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/g));
  const timeMatch = explicitAtTimeMatch || (allTimeMatches.length ? allTimeMatches[allTimeMatches.length - 1] : null);
  const hasNoon = /\bnoon\b/.test(lower);
  const hasMidnight = /\bmidnight\b/.test(lower);
  const hourPart = Number(timeMatch?.[1] || (hasNoon ? 12 : hasMidnight ? 12 : 9));
  const minutePart = Number(timeMatch?.[2] || 0);
  const meridiem = hasNoon ? "pm" : hasMidnight ? "am" : String(timeMatch?.[3] || "").toLowerCase();
  let hour = Number.isFinite(hourPart) ? hourPart : 9;

  if (!meridiem && (hour < 0 || hour > 23)) {
    return null;
  }

  if (meridiem === "pm" && hour < 12) {
    hour += 12;
  }

  if (meridiem === "am" && hour === 12) {
    hour = 0;
  }

  base.setHours(hour, minutePart, 0, 0);
  return Number.isNaN(base.getTime()) ? null : base;
}

function getTodayIsoRange() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setHours(23, 59, 59, 999);
  return {
    start: start.toISOString(),
    end: end.toISOString()
  };
}

function getTomorrowIsoRange() {
  const start = new Date();
  start.setDate(start.getDate() + 1);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setHours(23, 59, 59, 999);
  return {
    start: start.toISOString(),
    end: end.toISOString()
  };
}

function getThisWeekIsoRange() {
  const now = new Date();
  const start = new Date(now);
  start.setDate(start.getDate() - start.getDay());
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  end.setHours(23, 59, 59, 999);
  return {
    start: start.toISOString(),
    end: end.toISOString()
  };
}

function getRestOfWeekIsoRange() {
  const now = new Date();
  const start = new Date(now);
  const end = new Date(now);
  end.setDate(end.getDate() + (6 - end.getDay()));
  end.setHours(23, 59, 59, 999);
  return {
    start: start.toISOString(),
    end: end.toISOString()
  };
}

function getDateIsoRange(date) {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setHours(23, 59, 59, 999);
  return {
    start: start.toISOString(),
    end: end.toISOString()
  };
}

function parseCalendarSpecificDate(value) {
  const raw = String(value || "")
    .replace(/\b(out|please|for me)\b/gi, " ")
    .replace(/[,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!raw) {
    return null;
  }

  const lower = raw.toLowerCase();
  if (/\b(today|tomorrow|this week|rest of the week|next week)\b/.test(lower)) {
    return null;
  }

  const isoMatch = raw.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (isoMatch) {
    const parsed = new Date(Number(isoMatch[1]), Number(isoMatch[2]) - 1, Number(isoMatch[3]));
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }

  const slashMatch = raw.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (slashMatch) {
    const month = Number(slashMatch[1]) - 1;
    const day = Number(slashMatch[2]);
    const providedYear = Number(slashMatch[3]);
    const currentYear = new Date().getFullYear();
    const year = Number.isFinite(providedYear) && providedYear > 0
      ? (providedYear < 100 ? 2000 + providedYear : providedYear)
      : currentYear;
    const parsed = new Date(year, month, day);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }

  const monthNameMatch = raw.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:\s+(\d{2,4}))?\b/i);
  if (monthNameMatch) {
    const monthMap = {
      january: 0,
      february: 1,
      march: 2,
      april: 3,
      may: 4,
      june: 5,
      july: 6,
      august: 7,
      september: 8,
      october: 9,
      november: 10,
      december: 11
    };
    const month = monthMap[String(monthNameMatch[1]).toLowerCase()];
    const day = Number(monthNameMatch[2]);
    const providedYear = Number(monthNameMatch[3]);
    const currentYear = new Date().getFullYear();
    const year = Number.isFinite(providedYear) && providedYear > 0
      ? (providedYear < 100 ? 2000 + providedYear : providedYear)
      : currentYear;
    const parsed = new Date(year, month, day);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }

  const weekdayMatch = lower.match(/\b(next\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  if (weekdayMatch) {
    const weekdayMap = {
      sunday: 0,
      monday: 1,
      tuesday: 2,
      wednesday: 3,
      thursday: 4,
      friday: 5,
      saturday: 6
    };
    const now = new Date();
    const parsed = new Date(now);
    const targetDay = weekdayMap[weekdayMatch[2]];
    let delta = targetDay - parsed.getDay();
    if (delta < 0 || weekdayMatch[1]) {
      delta += 7;
    }
    parsed.setDate(parsed.getDate() + delta);
    parsed.setHours(0, 0, 0, 0);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }

  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed;
  }

  return null;
}

function formatHumanDate(date) {
  const parsed = new Date(date);
  if (Number.isNaN(parsed.getTime())) {
    return "that day";
  }

  return parsed.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric"
  });
}

function formatCalendarEventSummary(events) {
  const items = (Array.isArray(events) ? events : []).slice(0, 6).map((event) => {
    const title = String(event?.title || "calendar item").trim();
    const time = String(event?.startLabel || "soon").trim();
    const location = String(event?.location || "").trim();
    return location ? `${title} at ${time} in ${location}` : `${title} at ${time}`;
  });

  if (!items.length) {
    return "nothing scheduled";
  }

  return items.join(", ");
}

function formatCalendarDateKey(value) {
  const parsed = new Date(`${String(value || "").trim()}T12:00:00`);
  if (Number.isNaN(parsed.getTime())) {
    return "that day";
  }

  return parsed.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric"
  });
}

function extractProjectOpenTarget(prompt) {
  const text = String(prompt || "").toLowerCase();
  const openIntent = /\b(open|show|load|go to)\b/.test(text);
  const projectWord = /\bproject(s)?\b/.test(text);

  if (!openIntent || !projectWord) {
    return null;
  }

  const appType = /\bwork\b/.test(text) ? "work-app" : "project-app";
  const match = text.match(
    /\b(?:open(?:\s+up)?|show|load|go to)\b\s+(?:my\s+)?(?:work\s+)?projects?\b(?:\s+(?:called|named))?\s*(.*)$/
  );

  if (!match || !match[1]) {
    return null;
  }

  const projectName = match[1]
    .replace(/^(called|named)\s+/, "")
    .replace(/^the\s+/, "")
    .replace(/[.?!]+$/, "")
    .trim();

  if (!projectName || /^(app|tab|window|list|all)$/i.test(projectName)) {
    return null;
  }

  if (!projectName || projectName.length < 2) {
    return null;
  }

  return { appType, projectName };
}

function extractCloseAppTarget(prompt) {
  const text = String(prompt || "").toLowerCase();
  if (!text) {
    return null;
  }

  const hasCloseVerb = /\b(close|quit|exit|dismiss|shut(?:\s*down)?)\b/.test(text);
  if (!hasCloseVerb) {
    return null;
  }

  if (/\b(all|every|everything)\b.*\b(app|apps|windows)\b/.test(text) || /\b(?:close|quit|exit|shut(?:\s*down)?)\s+apps\b/.test(text)) {
    return "all-apps";
  }

  if (/\b(news|news app|headlines?)\b/.test(text)) {
    return "news-app";
  }

  if (/\b(calendar|calendar app)\b/.test(text)) {
    return "calendar-app";
  }

  if (/\b(work|work app)\b/.test(text)) {
    return "work-app";
  }

  if (/\b(project|projects|project app|personal projects)\b/.test(text)) {
    return "project-app";
  }

  if (/\b(music|music app|player)\b/.test(text)) {
    return "music-app";
  }

  if (/\b(drawing|drawing app|sketch)\b/.test(text)) {
    return "drawing-app";
  }

  if (/\b(movie|movies|movie app|film|films)\b/.test(text)) {
    return "movie-app";
  }

  if (/\b(server manager|server-manager|servers|server app)\b/.test(text)) {
    return "server-manager-app";
  }

  return null;
}

function extractSystemShutdownIntent(prompt) {
  const text = String(prompt || "").toLowerCase();
  if (!text) {
    return false;
  }

  const mentionsSpecificApp = /\b(news|calendar|work|project|music|drawing|movie|movies|server manager|servers?)\b.*\b(app|window)?\b/.test(text);
  if (mentionsSpecificApp) {
    return false;
  }

  const shutdownVerb = /\b(shut\s*down|power\s*off|turn\s*(?:your\s*)?self\s*off|quit|exit|close)\b/.test(text);
  if (!shutdownVerb) {
    return false;
  }

  // Plain shutdown command should shut down everything, per user expectation.
  if (/^\s*(shut\s*down|shutdown)\s*[.!?]*\s*$/.test(text)) {
    return true;
  }

  return /\b(control\s*center|system|everything|yourself|this\s*app|all)\b/.test(text);
}

function normalizeToolCallsForSafety(userText, calls) {
  const safeCalls = Array.isArray(calls) ? [...calls] : [];
  const prompt = String(userText || "").toLowerCase();
  const appCloseTarget = extractCloseAppTarget(prompt);
  const explicitSystemShutdown = extractSystemShutdownIntent(prompt);

  return safeCalls
    .map((call) => {
      if (!call || typeof call !== "object") {
        return null;
      }

      if (call.tool !== "shutdown_app") {
        return call;
      }

      // Never allow broad shutdown when user is clearly referring to an app window.
      if (appCloseTarget) {
        return { tool: "close_app", args: { target: appCloseTarget } };
      }

      // Require system-level shutdown intent for full shutdown.
      if (!explicitSystemShutdown) {
        return null;
      }

      return call;
    })
    .filter(Boolean);
}

function summarizeToolResults(toolResults) {
  if (!toolResults.length) {
    return "";
  }

  const lines = toolResults.map((entry) => {
    if (entry.result?.ok) {
      return `- ${entry.tool}: success`;
    }
    return `- ${entry.tool}: failed (${entry.result?.code || "UNKNOWN_ERROR"})`;
  });

  return `Tool execution summary:\n${lines.join("\n")}`;
}

async function resolveRequestedMusicPlayback(toolResults, { playlistIntent, artistIntent }) {
  const requestedName = String(playlistIntent?.playlistName || artistIntent?.artistName || "").trim();
  if (!requestedName) {
    return {
      playResult: null,
      extraLookupResult: null,
      agentMessage: "Sir, tell me which playlist to play."
    };
  }

  let lookupEntry = Array.isArray(toolResults)
    ? toolResults.find(
      (entry) =>
        entry?.tool === "list_music_playlists" &&
        entry?.result?.ok &&
        Boolean(entry?.args?.localOnly)
    )
    : null;
  let extraLookupResult = null;

  if (!lookupEntry) {
    const lookupResult = await executeToolCall("list_music_playlists", { localOnly: true });
    extraLookupResult = {
      tool: "list_music_playlists",
      args: { localOnly: true },
      result: lookupResult
    };
    lookupEntry = lookupResult?.ok ? extraLookupResult : null;
  }

  const playlists = Array.isArray(lookupEntry?.result?.playlists) ? lookupEntry.result.playlists : [];
  const availablePlaylists = playlists.filter((playlist) => String(playlist?.name || "").trim());

  if (!availablePlaylists.length) {
    if (artistIntent) {
      const fallbackArtistCall = buildPlayArtistCall(requestedName);
      const fallbackArtistResult = await executeToolCall(fallbackArtistCall.tool, fallbackArtistCall.args);
      return {
        playResult: { ...fallbackArtistCall, result: fallbackArtistResult },
        extraLookupResult,
        agentMessage: fallbackArtistResult?.ok
          ? `Playing tracks by ${requestedName} now, sir.`
          : `Sir, I could not start playback for ${requestedName}.`
      };
    }

    return {
      playResult: null,
      extraLookupResult,
      agentMessage: "Sir, I could not find any playlists to play yet."
    };
  }

  const selection = await selectPlaylistWithLlm(requestedName, availablePlaylists);
  if (!selection?.playlist) {
    if (artistIntent) {
      const fallbackArtistCall = buildPlayArtistCall(requestedName);
      const fallbackArtistResult = await executeToolCall(fallbackArtistCall.tool, fallbackArtistCall.args);
      return {
        playResult: { ...fallbackArtistCall, result: fallbackArtistResult },
        extraLookupResult,
        agentMessage: fallbackArtistResult?.ok
          ? `I could not map that to a playlist, so I am playing tracks by ${requestedName}, sir.`
          : `Sir, I could not map ${requestedName} to a playlist or start artist playback.`
      };
    }

    const options = availablePlaylists.slice(0, 6).map((item) => item.name).join(", ");
    return {
      playResult: null,
      extraLookupResult,
      agentMessage: `Sir, I could not match '${requestedName}' to a playlist. Available playlists: ${options}.`
    };
  }

  const selectedName = String(selection.playlist?.name || requestedName).trim();
  const playCall = buildPlayPlaylistCall(selectedName, requestedName, selection.confidence, selection.playlist);
  const playResult = await executeToolCall(playCall.tool, playCall.args);

  if (!playResult?.ok) {
    return {
      playResult: { ...playCall, result: playResult },
      extraLookupResult,
      agentMessage: `Sir, I found playlist ${selectedName}, but playback failed: ${playResult.message || "unknown error"}.`
    };
  }

  return {
    playResult: { ...playCall, result: playResult },
    extraLookupResult,
    agentMessage: `Starting playlist ${selectedName} now, sir.`
  };
}

async function inferMusicPlaybackIntentWithLlm(userText, toolResults) {
  const requestText = String(userText || "").trim();
  if (!requestText) {
    return null;
  }

  const entries = Array.isArray(toolResults) ? toolResults : [];
  const alreadyHasMusicCommand = entries.some(
    (entry) =>
      entry?.tool === "publish_event" &&
      String(entry?.args?.appId || "") === "music-app" &&
      String(entry?.args?.type || "") === "music-command"
  );
  if (alreadyHasMusicCommand) {
    return null;
  }

  const messages = [
    {
      role: "system",
      content: [
        "Classify the user's music intent.",
        "Respond with JSON only.",
        'Format: {"intent":"play_playlist|play_artist|list_playlists|other","requestedName":"<name or empty>"}',
        "Use play_playlist when the user asks to open/play/start a specific playlist.",
        "Use list_playlists only when the user asks to list/show/what playlists they have.",
        "Use other for non-playlist playback commands like pause/next/resume or unrelated requests."
      ].join("\n")
    },
    {
      role: "user",
      content: requestText
    }
  ];

  const llmResult = await requestLmStudioChatCompletion({ messages, temperature: 0 });
  if (!llmResult?.ok) {
    return null;
  }

  const parsed = parseSimpleJsonObject(llmResult.content);
  const intent = String(parsed?.intent || "").trim().toLowerCase();
  const requestedName = String(parsed?.requestedName || "")
    .replace(/[.?!]+$/, "")
    .trim();

  if (intent === "play_playlist" && requestedName) {
    return { kind: "playlist", requestedName };
  }

  if (intent === "play_artist" && requestedName) {
    return { kind: "artist", requestedName };
  }

  return null;
}

function parseSimpleJsonObject(content) {
  const raw = String(content || "").trim();
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    // Try extracting first JSON object.
  }

  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");
  if (firstBrace < 0 || lastBrace <= firstBrace) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw.slice(firstBrace, lastBrace + 1));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function buildPlayPlaylistCall(selectedName, requestedName, matchScore, playlist = null) {
  return {
    tool: "publish_event",
    args: {
      appId: "music-app",
      source: "agent",
      type: "music-command",
      message: `Agent requested playlist playback: ${selectedName}.`,
      meta: {
        action: "play-playlist",
        playlistName: selectedName,
        requestedName,
        matchScore: Number.isFinite(matchScore) ? matchScore : null,
        tracks: Array.isArray(playlist?.tracks)
          ? playlist.tracks.map((track) => ({
              name: String(track?.name || track?.title || "").trim(),
              title: String(track?.title || "").trim(),
              artist: String(track?.artist || "").trim(),
              sourcePath: String(track?.sourcePath || "").trim(),
              audioUrl: String(track?.audioUrl || "").trim()
            }))
          : [],
        openApp: true
      }
    }
  };
}

function buildPlayArtistCall(artistName) {
  return {
    tool: "publish_event",
    args: {
      appId: "music-app",
      source: "agent",
      type: "music-command",
      message: `Agent requested artist playback: ${artistName}.`,
      meta: {
        action: "play-artist",
        artistName,
        openApp: true
      }
    }
  };
}

async function selectPlaylistWithLlm(requestedName, playlists) {
  const candidates = Array.isArray(playlists) ? playlists : [];
  if (!requestedName || !candidates.length) {
    return { playlist: null, confidence: null, reason: "NO_CANDIDATES" };
  }

  const optionsText = candidates
    .map((playlist, index) => {
      const tracks = Array.isArray(playlist?.tracks) ? playlist.tracks : [];
      const artistPreview = Array.from(
        new Set(
          tracks
            .map((track) => String(track?.artist || "").trim())
            .filter(Boolean)
        )
      )
        .slice(0, 4)
        .join(", ");
      return `${index + 1}. ${String(playlist?.name || "").trim()}${artistPreview ? ` | artists: ${artistPreview}` : ""}`;
    })
    .join("\n");

  const messages = [
    {
      role: "system",
      content: [
        "You map a user's music request to exactly one playlist option.",
        "Respond using JSON only.",
        "Output format:",
        '{"playlistIndex":<number_or_0>,"confidence":<0_to_100_integer>,"reason":"<short reason>"}',
        "Use playlistIndex=0 if no option is a good match."
      ].join("\n")
    },
    {
      role: "user",
      content: [
        `User request: ${requestedName}`,
        "Playlist options:",
        optionsText
      ].join("\n")
    }
  ];

  const llmResult = await requestLmStudioChatCompletion({ messages, temperature: 0 });
  if (!llmResult?.ok) {
    return { playlist: null, confidence: null, reason: "LLM_UNAVAILABLE" };
  }

  const parsed = parsePlaylistSelectionJson(llmResult.content);
  const pickedIndex = Number(parsed?.playlistIndex);
  if (!Number.isInteger(pickedIndex) || pickedIndex < 1 || pickedIndex > candidates.length) {
    return { playlist: null, confidence: Number(parsed?.confidence) || null, reason: parsed?.reason || "NO_MATCH" };
  }

  return {
    playlist: candidates[pickedIndex - 1],
    confidence: Number.isFinite(Number(parsed?.confidence)) ? Number(parsed.confidence) : null,
    reason: parsed?.reason || ""
  };
}

function parsePlaylistSelectionJson(content) {
  const raw = String(content || "").trim();
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch {
    // Continue and try to extract the first JSON object from a wrapped response.
  }

  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");
  if (firstBrace < 0 || lastBrace <= firstBrace) {
    return null;
  }

  const candidate = raw.slice(firstBrace, lastBrace + 1);
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

function escapeJsonString(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
