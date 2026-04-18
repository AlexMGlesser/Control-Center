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

  const providedOutput = String(llmOutput || "").trim();
  const rawOutput = providedOutput || (await generateLmStudioOutput(userText, origin));
  const filterResult = filterAgentOutput(rawOutput, getToolNamesSet());

  // Fallback: if filter failed but we detect keywords, inject tool calls deterministically
  let toolCalls = [];
  let safeMessages = [];
  let safeText = "";

  if (!filterResult.ok) {
    // Try deterministic tool injection even if LLM output was invalid
    const fallbackCalls = buildDeterministicToolCalls(userText, origin);
    
    if (fallbackCalls.length > 0) {
      // We detected keywords, so generate tool calls deterministically
      toolCalls = fallbackCalls;
      safeMessages = buildMessagesForToolCalls(fallbackCalls);
      safeText = safeMessages[0] || filterResult.safeText || "Executing command...";
    } else {
      // No keywords detected, return the filter error
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
  } else {
    // Filter succeeded, use its tool calls and messages
    let resolvedToolCalls = ensureNewsOpenCall(filterResult.toolCalls, userText, origin);
    resolvedToolCalls = ensureMusicOpenCall(resolvedToolCalls, userText, origin);
    resolvedToolCalls = ensureNamedProjectOpenCall(resolvedToolCalls, userText, origin);
    resolvedToolCalls = ensureWorkProjectOpenCall(resolvedToolCalls, userText, origin);
    resolvedToolCalls = ensureMusicPlaybackCommandCall(resolvedToolCalls, userText, origin);
    toolCalls = resolvedToolCalls;
    safeMessages = Array.isArray(filterResult.safeMessages) ? [...filterResult.safeMessages] : [];
    
    if (toolCalls.length > filterResult.toolCalls.length && !safeMessages.length) {
      safeMessages = buildMessagesForToolCalls(toolCalls.slice(filterResult.toolCalls.length));
    }
    safeText = safeMessages[0] || filterResult.safeText || "";
  }

  const toolResults = await Promise.all(
    toolCalls.map(async (call) => {
      const result = executeToolCall(call.tool, call.args);
      return { tool: call.tool, args: call.args, result };
    })
  );

  let postToolAgentMessage = "";
  const explicitPlaylistIntent = origin?.type === "user" ? extractPlaylistPlayTarget(userText) : null;
  const implicitPlaylistIntent = origin?.type === "user" ? extractImplicitPlaylistPlayTarget(userText) : null;
  const playlistIntent = explicitPlaylistIntent || implicitPlaylistIntent;
  const artistIntent = origin?.type === "user" ? extractArtistPlayTarget(userText) : null;
  if (playlistIntent || artistIntent) {
    const orchestration = resolveRequestedMusicPlayback(toolResults, {
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
  } else if (!agentMessages.length || /executing command/i.test(agentMessages[0])) {
    const synthesized = synthesizeToolMessages(toolResults);
    if (synthesized.length) {
      agentMessages = synthesized;
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

      const createResult = executeToolCall("create_project", createArgs);
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

    const createResult = executeToolCall("create_project", createArgs);
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
    return namedPattern[1].trim();
  }

  const driveAndNamePattern = raw.match(
    /\b(?:in|on|use)\s+(?:my\s+)?(?:[a-z]\s*:|[a-z])\s*(?:drive)?\b[\s,.-]*(?:it(?:\s+will)?\s+be|it'?ll\s+be|project\s+name\s+is|named|called)\s+(.+)$/i
  );
  if (driveAndNamePattern) {
    return driveAndNamePattern[1].trim();
  }

  const genericCreatePattern = raw.match(/(?:create|make|new|start)\s+(?:a\s+)?(?:new\s+)?project\s+(.+)$/i);
  if (genericCreatePattern) {
    return genericCreatePattern[1].trim();
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

  const prompt = String(userText || "").toLowerCase();
  const calls = [];

  const explicitPlaylistTarget = extractPlaylistPlayTarget(prompt);
  const implicitPlaylistTarget = explicitPlaylistTarget || extractImplicitPlaylistPlayTarget(prompt);
  const playlistPlayTarget = explicitPlaylistTarget || implicitPlaylistTarget;
  if (playlistPlayTarget) {
    calls.push({ tool: "open_app", args: { target: "music-app" } });
    calls.push({ tool: "list_music_playlists", args: {} });
    return calls;
  }

  const artistPlayTarget = extractArtistPlayTarget(prompt);
  if (artistPlayTarget) {
    calls.push({ tool: "open_app", args: { target: "music-app" } });
    calls.push({
      tool: "publish_event",
      args: {
        appId: "music-app",
        source: "agent",
        type: "music-command",
        message: `Agent requested local artist playback: ${artistPlayTarget.artistName}.`,
        meta: {
          action: "play-artist",
          artistName: artistPlayTarget.artistName,
          localOnly: true,
          openApp: true
        }
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
  if (/\b(news|headline|headlines?|what'?s the news|show me news|open news)\b/.test(prompt)) {
    const isNegative = /\b(don't|do not|no|not)\b.*\b(news|headlines?|open)\b/.test(prompt);
    if (!isNegative) {
      calls.push({ tool: "open_app", args: { target: "news-app" } });
    }
  }

  // Check for work app intent
  if (/\b(work|work app|open work|show work|my work)\b/.test(prompt)) {
    calls.push({ tool: "open_app", args: { target: "work-app" } });
  }

  // Check for music app open intent
  if (/\b(open|launch|start|show)\b.*\b(music|music app|player)\b/.test(prompt)) {
    calls.push({ tool: "open_app", args: { target: "music-app" } });
  }

  if (/\b(list|show|what)\b.*\bgenres?\b|\bgenres?\b.*\b(music|songs|tracks)\b/.test(prompt)) {
    calls.push({ tool: "list_music_genres", args: {} });
    return calls;
  }

  if (/\b(list|show|what)\b.*\bartists?\b|\bartists?\b.*\b(music|songs|tracks)\b/.test(prompt)) {
    calls.push({ tool: "list_music_artists", args: {} });
    return calls;
  }

  if (/\b(list|show|what|my)\b.*\bplaylists?\b/.test(prompt)) {
    calls.push({ tool: "list_music_playlists", args: {} });
    return calls;
  }

  const createPlaylistMatch = prompt.match(/\b(?:create|make)\s+(?:a\s+)?playlist\s+(.+)$/);
  if (createPlaylistMatch && createPlaylistMatch[1]) {
    calls.push({ tool: "create_music_playlist", args: { name: createPlaylistMatch[1].trim() } });
    return calls;
  }

  const addTrackMatch = prompt.match(/\badd\s+(.+?)\s+to\s+playlist\s+(.+)$/);
  if (addTrackMatch && addTrackMatch[1] && addTrackMatch[2]) {
    calls.push({
      tool: "add_track_to_playlist",
      args: {
        trackName: addTrackMatch[1].trim(),
        playlistName: addTrackMatch[2].trim()
      }
    });
    return calls;
  }

  const byArtistMatch = prompt.match(/\b(?:songs|tracks)\s+(?:by|from)\s+(.+)$/);
  if (byArtistMatch && byArtistMatch[1]) {
    calls.push({ tool: "list_music_tracks", args: { artist: byArtistMatch[1].trim() } });
    return calls;
  }

  const byGenreMatch = prompt.match(/\b(?:songs|tracks)\s+(?:in|for)\s+(.+?)\s+genre\b/);
  if (byGenreMatch && byGenreMatch[1]) {
    calls.push({ tool: "list_music_tracks", args: { genre: byGenreMatch[1].trim() } });
    return calls;
  }

  // Check for project app intent (including plurals)
  if (/\b(projects?|project app|open project|show project|my project|personal projects?)\b/.test(prompt)) {
    calls.push({ tool: "open_app", args: { target: "project-app" } });
  }

  return calls;
}

function buildMessagesForToolCalls(calls) {
  if (!Array.isArray(calls) || calls.length === 0) {
    return [];
  }

  return calls.map((call) => {
    const target = call?.args?.target || call?.args?.appId || "";
    if (target === "news-app") {
      return "Opening News App.";
    } else if (target === "work-app") {
      return "Opening Work App.";
    } else if (target === "music-app") {
      return "Opening Music App.";
    } else if (target === "project-app") {
      return "Opening Personal Projects.";
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
    } else if (call?.tool === "publish_event" && String(call?.args?.type || "") === "music-command") {
      return "Starting that playlist now.";
    }
    return "Executing command...";
  });
}

function synthesizeToolMessages(toolResults) {
  if (!Array.isArray(toolResults) || !toolResults.length) {
    return [];
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
    const playlists = Array.isArray(result.playlists) ? result.playlists : [];
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

  const explicitPlaylistPlayTarget = extractPlaylistPlayTarget(prompt);
  const implicitPlaylistPlayTarget = explicitPlaylistPlayTarget || extractImplicitPlaylistPlayTarget(prompt);
  const playlistPlayTarget = explicitPlaylistPlayTarget || implicitPlaylistPlayTarget;
  if (playlistPlayTarget) {
    return [
      '{{"tool":"open_app","args":{"target":"music-app"}} | {"tool":"list_music_playlists","args":{}}}',
      '{"response":"Finding the best playlist match now."}'
    ].join("\n");
  }

  const artistPlayTarget = extractArtistPlayTarget(prompt);
  if (artistPlayTarget) {
    return [
      '{{"tool":"open_app","args":{"target":"music-app"}} | {"tool":"publish_event","args":{"appId":"music-app","source":"agent","type":"music-command","message":"Agent requested local artist playback","meta":{"action":"play-artist","artistName":"' + escapeJsonString(artistPlayTarget.artistName) + '","localOnly":true,"openApp":true}}}}',
      '{"response":"Playing local tracks by ' + escapeJsonString(artistPlayTarget.artistName) + '."}'
    ].join("\n");
  }

  if (/\b(open|launch|start|show)\b.*\b(music|music app|player)\b/.test(prompt)) {
    return [
      '{"tool":"open_app","args":{"target":"music-app"}}',
      '{"response":"Opening Music App."}'
    ].join("\n");
  }

  if (/(list|show|what).*(genres?)|genres?.*(music|songs|tracks)/.test(prompt)) {
    return [
      '{"tool":"list_music_genres","args":{}}',
      '{"response":"Fetching music genres."}'
    ].join("\n");
  }

  if (/(list|show|what).*(artists?)|artists?.*(music|songs|tracks)/.test(prompt)) {
    return [
      '{"tool":"list_music_artists","args":{}}',
      '{"response":"Fetching music artists."}'
    ].join("\n");
  }

  if (/(list|show|what|my).*(playlists?)/.test(prompt)) {
    return [
      '{"tool":"list_music_playlists","args":{}}',
      '{"response":"Fetching your playlists."}'
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

function ensureMusicOpenCall(toolCalls, userText, origin) {
  const currentCalls = Array.isArray(toolCalls) ? [...toolCalls] : [];
  if (!shouldAutoOpenMusicForUser(userText, origin)) {
    return currentCalls;
  }

  const alreadyOpen = currentCalls.some(
    (call) =>
      call?.tool === "open_app" &&
      String(call?.args?.target || call?.args?.appId || call?.args?.app_name || "") === "music-app"
  );

  if (alreadyOpen) {
    return currentCalls;
  }

  return [...currentCalls, { tool: "open_app", args: { target: "music-app" } }];
}

function shouldAutoOpenNewsForUser(userText, origin) {
  if (origin?.type !== "user") {
    return false;
  }

  const prompt = String(userText || "").toLowerCase();
  const hasNewsIntent = /\b(news|headline|headlines|what'?s the news|show me news|open news)\b/.test(prompt);
  const isNegative = /\b(don't|do not|no|not)\b.*\b(news|headlines|open)\b/.test(prompt);

  return hasNewsIntent && !isNegative;
}

function shouldAutoOpenMusicForUser(userText, origin) {
  if (origin?.type !== "user") {
    return false;
  }

  const prompt = String(userText || "").toLowerCase();
  const hasMusicIntent =
    /\b(open|launch|start|show)\b.*\b(music|music app|player)\b/.test(prompt) ||
    /\bplay\b.*\b(music|song|songs|playlist|playlists)\b/.test(prompt) ||
    Boolean(extractArtistPlayTarget(prompt));
  const isNegative = /\b(don'?t|do not|no|not)\b.*\b(open|launch|start|show|play)\b.*\b(music|player|playlist)\b/.test(prompt);

  return hasMusicIntent && !isNegative;
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

function ensureMusicPlaybackCommandCall(toolCalls, userText, origin) {
  const currentCalls = Array.isArray(toolCalls) ? [...toolCalls] : [];
  if (origin?.type !== "user") {
    return currentCalls;
  }

  const explicitPlaylistTarget = extractPlaylistPlayTarget(userText);
  const implicitPlaylistTarget = explicitPlaylistTarget || extractImplicitPlaylistPlayTarget(userText);
  const playlistTarget = explicitPlaylistTarget || implicitPlaylistTarget;
  const artistTarget = extractArtistPlayTarget(userText);
  if (!playlistTarget && !artistTarget) {
    return currentCalls;
  }

  const sanitizedCalls = currentCalls.filter(
    (call) =>
      call?.tool !== "publish_event" &&
      call?.tool !== "list_music_tracks"
  );

  const hasOpenMusic = sanitizedCalls.some(
    (call) =>
      call?.tool === "open_app" &&
      String(call?.args?.target || call?.args?.appId || call?.args?.app_name || "") === "music-app"
  );

  const hasPlaylistLookup = sanitizedCalls.some((call) => call?.tool === "list_music_playlists");
  const hasMusicCommand = sanitizedCalls.some(
    (call) =>
      call?.tool === "publish_event" &&
      String(call?.args?.appId || "") === "music-app" &&
      String(call?.args?.type || "") === "music-command"
  );

  const nextCalls = [...sanitizedCalls];
  if (!hasOpenMusic) {
    nextCalls.push({ tool: "open_app", args: { target: "music-app" } });
  }

  if (playlistTarget) {
    if (!hasPlaylistLookup) {
      nextCalls.push({ tool: "list_music_playlists", args: {} });
    }
    return nextCalls;
  }

  if (artistTarget) {
    if (!hasMusicCommand) {
      nextCalls.push({
        tool: "publish_event",
        args: {
          appId: "music-app",
          source: "agent",
          type: "music-command",
          message: `Agent requested local artist playback: ${artistTarget.artistName}.`,
          meta: {
            action: "play-artist",
            artistName: artistTarget.artistName,
            localOnly: true,
            openApp: true
          }
        }
      });
    }
    return nextCalls;
  }

  return nextCalls;
}

function extractPlaylistPlayTarget(prompt) {
  const text = String(prompt || "").toLowerCase();
  if (!/\b(play|start)\b/.test(text) || !/\bplaylist\b/.test(text)) {
    return null;
  }

  const patterns = [
    /\b(?:play|start)\s+(?:the\s+)?playlist\s*[,:-]?\s*(.+)$/,
    /\b(?:play|start)\s+(?:my\s+)?(.+?)\s+playlist\b(?:\s+for\s+me)?$/,
    /\bplaylist\s*[,:-]?\s*(.+)$/
  ];

  let playlistName = "";
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      playlistName = match[1];
      break;
    }
  }

  if (!playlistName) {
    return null;
  }

  playlistName = playlistName
    .replace(/[.?!]+$/, "")
    .replace(/\b(for me|please)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!playlistName || playlistName.length < 2) {
    return null;
  }

  return { playlistName };
}

function extractImplicitPlaylistPlayTarget(prompt) {
  const text = String(prompt || "").toLowerCase();

  if (!/\b(play|start)\b/.test(text)) {
    return null;
  }

  if (/\bplaylist\b/.test(text)) {
    return null;
  }

  if (/\b(next|previous|prev|pause|resume|stop|shuffle|loop|volume)\b/.test(text)) {
    return null;
  }

  const match = text.match(/\b(?:play|start)\s+(.+?)\s*$/);
  if (!match || !match[1]) {
    return null;
  }

  const playlistName = match[1]
    .replace(/\b(for me|please)\b/gi, "")
    .replace(/^\s*(?:my|the)\s+/i, "")
    .replace(/\b(song|songs|track|tracks|music)\b/gi, "")
    .replace(/[.?!]+$/, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!playlistName || playlistName.length < 2) {
    return null;
  }

  if (/^(music|song|songs|something|anything)$/i.test(playlistName)) {
    return null;
  }

  return { playlistName, implicit: true };
}

function extractArtistPlayTarget(prompt) {
  const text = String(prompt || "").toLowerCase();

  if (/\bplaylist\b/.test(text)) {
    return null;
  }

  let match = text.match(/\b(?:play|start)\s+(?:some\s+)?(.+?)\s+(?:for me|please)\s*$/);
  if (!match || !match[1]) {
    match = text.match(/\b(?:play|start)\s+(?:some\s+)?(.+)$/);
  }

  if (!match || !match[1]) {
    return null;
  }

  const artistName = match[1]
    .replace(/\b(music|song|songs|track|tracks)\b/g, "")
    .replace(/[.?!]+$/, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!artistName || artistName.length < 2) {
    return null;
  }

  if (/^(music|song|songs|something|anything)$/i.test(artistName)) {
    return null;
  }

  return { artistName };
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

function normalizePlaylistName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/["']/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\b(the|my|some|playlist|playlists|for me|please|song|songs|track|tracks|music)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function scorePlaylistMatch(requestedName, candidateName) {
  const requested = normalizePlaylistName(requestedName);
  const candidate = normalizePlaylistName(candidateName);
  if (!requested || !candidate) {
    return 0;
  }

  if (requested === candidate) {
    return 100;
  }

  if (candidate.includes(requested)) {
    return 90;
  }

  if (requested.includes(candidate)) {
    return 80;
  }

  const requestTokens = new Set(requested.split(" ").filter(Boolean));
  const candidateTokens = new Set(candidate.split(" ").filter(Boolean));
  if (!requestTokens.size || !candidateTokens.size) {
    return 0;
  }

  let overlap = 0;
  requestTokens.forEach((token) => {
    if (candidateTokens.has(token)) {
      overlap += 1;
    }
  });

  const overlapRatio = overlap / Math.max(requestTokens.size, candidateTokens.size);
  if (overlapRatio <= 0) {
    return 0;
  }

  return Math.round(overlapRatio * 70);
}

function resolveRequestedMusicPlayback(toolResults, { playlistIntent, artistIntent }) {
  const requestedName = String(playlistIntent?.playlistName || artistIntent?.artistName || "").trim();
  if (!requestedName) {
    return {
      playResult: null,
      extraLookupResult: null,
      agentMessage: "Sir, tell me which playlist to play."
    };
  }

  let lookupEntry = Array.isArray(toolResults)
    ? toolResults.find((entry) => entry?.tool === "list_music_playlists" && entry?.result?.ok)
    : null;
  let extraLookupResult = null;

  if (!lookupEntry) {
    const lookupResult = executeToolCall("list_music_playlists", {});
    extraLookupResult = {
      tool: "list_music_playlists",
      args: {},
      result: lookupResult
    };
    lookupEntry = lookupResult?.ok ? extraLookupResult : null;
  }

  const playlists = Array.isArray(lookupEntry?.result?.playlists) ? lookupEntry.result.playlists : [];
  const localPlaylists = playlists.filter((playlist) => String(playlist?.source || "") === "local-saved");

  if (!localPlaylists.length) {
    if (artistIntent) {
      const fallbackArtistCall = buildPlayArtistCall(requestedName);
      const fallbackArtistResult = executeToolCall(fallbackArtistCall.tool, fallbackArtistCall.args);
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
      agentMessage: "Sir, I could not find any saved local playlists to play yet."
    };
  }

  let best = null;
  localPlaylists.forEach((playlist) => {
    const nameScore = scorePlaylistMatch(requestedName, playlist?.name || "");
    const contentScore = scorePlaylistContentMatch(requestedName, playlist);
    const score = Math.max(nameScore, contentScore);
    if (!best || score > best.score) {
      best = { playlist, score };
    }
  });

  if (!best || best.score < 35) {
    if (artistIntent) {
      const fallbackArtistCall = buildPlayArtistCall(requestedName);
      const fallbackArtistResult = executeToolCall(fallbackArtistCall.tool, fallbackArtistCall.args);
      return {
        playResult: { ...fallbackArtistCall, result: fallbackArtistResult },
        extraLookupResult,
        agentMessage: fallbackArtistResult?.ok
          ? `I could not find a close playlist match, so I am playing tracks by ${requestedName}, sir.`
          : `Sir, I could not match ${requestedName} to a playlist or start artist playback.`
      };
    }

    const options = localPlaylists.slice(0, 6).map((item) => item.name).join(", ");
    return {
      playResult: null,
      extraLookupResult,
      agentMessage: `Sir, I could not match '${requestedName}' to a playlist. Available playlists: ${options}.`
    };
  }

  const selectedName = String(best.playlist?.name || requestedName).trim();
  const playCall = buildPlayPlaylistCall(selectedName, requestedName, best.score, best.playlist);
  const playResult = executeToolCall(playCall.tool, playCall.args);

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
        matchScore,
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

function scorePlaylistContentMatch(requestedName, playlist) {
  const tracks = Array.isArray(playlist?.tracks) ? playlist.tracks : [];
  if (!tracks.length) {
    return 0;
  }

  let bestScore = 0;
  tracks.forEach((track) => {
    const artistScore = scorePlaylistMatch(requestedName, track?.artist || "");
    const titleScore = scorePlaylistMatch(requestedName, track?.title || "");
    const nameScore = scorePlaylistMatch(requestedName, track?.name || "");
    bestScore = Math.max(bestScore, artistScore, titleScore, nameScore);
  });

  return bestScore;
}

function escapeJsonString(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
