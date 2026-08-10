# Control Center — Architecture & Status

*Replaces `control-center-architecture.txt` and `CONTROL_CENTER_PROJECT_STATUS.txt`.
The old architecture doc described many subsystems (Tool Policy Engine,
Session Manager, Copilot Automation Adapter, Movie Server Control Service,
etc.) that were never built. This doc describes what actually exists, plus
current status and how to run it, so it doesn't drift from reality again.*

**Last updated:** 2026-08-08

## Principles

- **Centralized orchestration:** one Express backend (`control-app/server`)
  coordinates everything; the Electron shell is a thin presentation layer.
- **App modularity:** each app (`*-app/` at the workspace root) owns its own
  data and API surface.
- **Tool-gated AI access:** the agent never touches the system directly —
  it only acts through the tool catalog in `agentTools.js`.
- **Desktop-first:** all processing runs on the desktop host today; mobile
  is a planned client, not a current one.

## System layers

```
Electron shell (control-app/electron) — window/IPC only
        |
Express backend (control-app/server, localhost:3100)
        |
   server/routes/api.js — the only HTTP entry point
        |
   server/services/*.js — one file per concern (see below)
        |
   *-app/ static bundles served per-route, or standalone Electron windows
```

## Backend services (`control-app/server/services/`)

| Service | Role |
|---|---|
| `eventBus.js` | In-memory event log + SSE broadcast (`/api/events/stream`). Intercepts `console.*` too. This is the system's notification backbone — the UI listens here to know when async agent work (queued chat/voice replies) has landed, and apps can publish/subscribe to cross-cutting events (e.g. music playback commands). |
| `queueManager.js` / `queueWorker.js` | Priority queue where every step of a request's lifecycle — not just the initial message — is its own entry (`user`, `system`, `returned`, `reply`). `queueWorker.js` dispatches each dequeued entry by type, driving multi-step tool-call chains one queue cycle at a time; voice gets high priority on every entry of its turn. |
| `agentRuntime.js` | Builds the agent's system prompt (role doc + tool catalog description + static docs + chat history + app messages + current date/time) and seeds each new turn's message history. No fast path — every request reaches Ollama. |
| `envelopeProtocol.js` | The `{type \| message}` envelope grammar: a brace/quote-aware parser for the model's raw text output, renderers for the system-authored `user`/`returned` envelopes, and the tool-catalog-to-text renderer used in the system prompt. |
| `agentTools.js` | The tool catalog (JSON-schema-shaped function defs, now rendered as prompt text rather than passed to Ollama's structured tool-calling API) and the dispatcher that executes them — calendar CRUD, app open/close (including bulk `target: "all"`), music control, project create/open, settings, mode switch, news summary, event publish. This is the actual permission boundary: if a tool isn't defined here, the agent cannot do it. |
| `agentContextLoader.js` | Ranks and trims excerpts from this design-documents folder into a small context bundle for the system prompt (capped ~2200 chars). |
| `ollamaService.js` | Talks to a local Ollama daemon (`OLLAMA_BASE_URL`, default `http://127.0.0.1:11434`) — status probing, start/stop lifecycle, and plain chat completions (no `tools` parameter — tool-call intent is expressed in the model's text via the envelope grammar). Default model `qwen3.5:9b` (configurable via `OLLAMA_MODEL`). |
| `voiceService.js` | WebSocket at `/voice`. Wake word ("Jarvis") gates commands; transcribed speech is enqueued through the same task queue as chat, then spoken back via Piper. |
| `whisperService.js` / `piperService.js` | Local STT/TTS binaries under `control-app/voice/`. |
| `chatService.js` | In-memory chat history. |
| `appMessageService.js` | Background app-to-agent message inbox, formatted as `{App}[message]` and folded into the agent's context. |
| `runtimePersistenceService.js` | Reads/writes `logs/control-center-runtime.json` (chat, app messages, mode, session state) — the one mutable runtime state file, gitignored. |
| `calendarService.js`, `projectService.js`, `musicLibraryService.js`, `drawingFileService.js`, `newsService.js`, `skillsService.js`, `settingsService.js`, `modeStateMachine.js`, `appRegistry.js`, `orchestrator.js`, `windowControlBridge.js` | One service per app/concern, each owning its own data access. All entirely local — no external accounts or APIs required for any of them. |

## Agent architecture

Every request — chat message, voice command, or app background message —
becomes a `user` envelope entry on the task queue, and every subsequent step
of processing it is its own separate queue entry too, not one blocking
function call. `queueWorker.js` dispatches each dequeued entry by its `type`:

1. **`user`** — a new turn starts. `agentRuntime.buildInitialMessages()` seeds
   the conversation (system prompt + prior history, itself rendered in
   envelope form) and one Ollama chat completion runs.
2. The model's raw text response is parsed (`envelopeProtocol.parseEnvelopes`)
   into one or more envelopes. There is no structured tool-calling API in use
   — the model produces `{system | request | [...]}` / `{reply | ...}` as
   plain text, and each parsed envelope is enqueued as its own new entry.
3. **`system`** — the requested tool call(s) execute via `agentTools.js`, and
   a `{returned | success/failure | ...}` entry is enqueued with the outcome.
4. **`returned`** — the outcome is fed back to the model as the next message;
   it responds with either another `system` request (chaining further calls)
   or a `reply`. A per-turn step counter forces a `reply` past a fixed cap so
   a confused model can't loop forever.
5. **`reply`** — the final text is persisted to chat history and a `chat`
   event is published on the event bus, which is what tells the UI to
   refresh. This also ends the turn (its in-memory state is cleaned up once
   nothing else for that turn remains queued).

Because every step is a real queue entry, other work (a different chat
message, another voice command) can interleave between the steps of a single
turn rather than only between whole turns — priority (`high` for voice) is
set once on a turn's initial `user` entry and carried through every
subsequent entry it produces.

This is a deliberate, explicit design choice: the raw-text envelope grammar
is less robust than Ollama's structured tool-calling API would be (a
malformed model response has to be detected and surfaced rather than being
structurally impossible), in exchange for the entire pipeline — including
mid-turn steps — being visible and inspectable as queue/event-bus entries.

## Data storage

Everything is local. No cloud accounts, no external calendar/API credentials
required for core functionality.

- `logs/control-center-runtime.json` — chat history, app messages, mode
  state (gitignored)
- `control-app/server/data/calendar-events.json` — calendar events
- `control-app/agent/AGENT_RUNTIME_CONTEXT.txt` — agent continuity log,
  regenerated from runtime state (gitignored)
- Drawing/music/movie apps read/write user-chosen local directories

## Security model

The agent's only path to affecting the system is the tool catalog in
`agentTools.js` — there's no separate "permission engine," the catalog
itself *is* the permission boundary (a tool not defined there cannot be
called). Destructive-ish tools (`shutdown_app`) still exist as regular
tools; there's no additional confirmation step today, which is an accepted
tradeoff for a single-user local desktop tool, not a multi-tenant system.

## Current status

All 8 apps are implemented and wired into the app registry. Voice
(Whisper STT + Piper TTS) is functional end-to-end through the task queue.
The agent runs on Ollama via the raw-text envelope protocol described above.

**Known limits:**
- The envelope grammar depends on the model reliably hand-formatting
  `{type | ...}` text. A malformed response is not an immediate dead end: the
  raw output is logged, a corrective reminder is appended to the turn's
  history, and the LLM step is retried (bounded by the same per-turn step
  cap used for tool-call chaining). Only if the model keeps failing past
  that cap does it fall back to an honest "couldn't format a proper
  response" reply — this can't be made structurally impossible the way
  Ollama's native tool-calling would make it, but it isn't a single-shot
  failure either.
- Movie-app library state is rebuilt per-session from the imported folder,
  not a persistent indexed database.
- Server Manager covers SSH launch and config; power control and richer
  telemetry are not implemented.
- Mobile Mode is a UI/state-machine toggle only — there is no actual mobile
  client yet.

**Possible next priorities:**
1. Recurring events and event editing in calendar-app.
2. Persistent movie library indexing instead of per-session folder import.
3. Server Manager power actions and richer metadata.
4. A real Mobile Mode client.

## How to run

From `control-app/`:
- Desktop app: `.\start-control-center.ps1`, or `npm start`
- Backend only (web dev fallback): `npm run start:web`

Requires a local Ollama daemon with the configured model pulled
(`ollama pull qwen3.5:9b`, or whatever `OLLAMA_MODEL` is set to) — Control
Center will spawn `ollama serve` itself if it isn't already running, but it
won't pull a missing model for you.
