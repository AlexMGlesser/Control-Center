# Control Center — Architecture & Status

*Replaces `control-center-architecture.txt` and `CONTROL_CENTER_PROJECT_STATUS.txt`.
The old architecture doc described many subsystems (Tool Policy Engine,
Session Manager, Copilot Automation Adapter, Movie Server Control Service,
etc.) that were never built. This doc describes what actually exists, plus
current status and how to run it, so it doesn't drift from reality again.*

**Last updated:** 2026-10-15

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
        |
   wikipedia-app only: a Python child process (librarian.py, 127.0.0.1:8766)
   started on demand by wikipediaService.js
   hand-tracker-app/ — native Python child processes (+ a static panel/)
```

## Backend services (`control-app/server/services/`)

| Service | Role |
|---|---|
| `eventBus.js` | In-memory event log + SSE broadcast (`/api/events/stream`). Intercepts `console.*` too. This is the system's notification backbone — the UI listens here to know when async agent work (queued chat/voice replies) has landed, and apps can publish/subscribe to cross-cutting events (e.g. music playback commands). |
| `queueManager.js` / `queueWorker.js` | Priority queue where every step of a request's lifecycle — not just the initial message — is its own entry (`user`, `system`, `returned`, `reply`). `queueWorker.js` dispatches each dequeued entry by type, driving multi-step tool-call chains one queue cycle at a time; voice gets high priority on every entry of its turn. |
| `agentRuntime.js` | Builds the agent's system prompt (role doc + tool catalog description + static docs + chat history + app messages + current date/time) and seeds each new turn's message history. No fast path — every request reaches Ollama. |
| `envelopeProtocol.js` | The `{type \| message}` envelope grammar: a brace/quote-aware parser for the model's raw text output, renderers for the system-authored `user`/`returned` envelopes, and the tool-catalog-to-text renderer used in the system prompt. |
| `agentTools.js` | The tool catalog (JSON-schema-shaped function defs, now rendered as prompt text rather than passed to Ollama's structured tool-calling API) and the dispatcher that executes them — calendar CRUD, app open/close (including bulk `target: "all"`), music control, project create/open, settings, mode switch, news summary, event publish, offline Wikipedia lookup (`search_wikipedia`, `read_wikipedia_article`), and `start_gesture_recorder`. `hand-tracker-app` is a regular `WINDOW_APPS` member (including `"all"` / `"all-apps"`); for it, `open_app` also launches its native process server-side (so it works with no UI connected, e.g. voice) and `close_app` stops it. This is the actual permission boundary: if a tool isn't defined here, the agent cannot do it. |
| `agentContextLoader.js` | Ranks and trims excerpts from this design-documents folder into a small context bundle for the system prompt (capped ~2200 chars). |
| `ollamaService.js` | Talks to a local Ollama daemon (`OLLAMA_BASE_URL`, default `http://127.0.0.1:11434`) — status probing, start/stop lifecycle, and plain chat completions (no `tools` parameter — tool-call intent is expressed in the model's text via the envelope grammar). Default model `qwen3.5:9b` (configurable via `OLLAMA_MODEL`). |
| `wikipediaService.js` | Lifecycle + HTTP client for the Wikipedia App's librarian server (`wikipedia-app/librarian/librarian.py`, stdlib Python). Starts it on demand as a child process (`WIKIPEDIA_PYTHON`, port `WIKIPEDIA_LIBRARIAN_PORT` = 8766), reuses one already answering on that port, and on shutdown kills it only if it spawned it — same rules as `ollamaService.js`. Points it at `WIKIPEDIA_DATA_DIR` (the archive's `organized` folder, read in place). `queryLibrarian()` calls its `/api/v1` endpoints for the wiki agent tools. |
| `voiceService.js` | WebSocket at `/voice`. Wake word ("Jarvis") gates commands; transcribed speech is enqueued through the same task queue as chat, then spoken back via Piper. |
| `whisperService.js` / `piperService.js` | Local STT/TTS binaries under `control-app/voice/`. |
| `chatService.js` | In-memory chat history. |
| `handTrackerService.js` | Launches/stops the Hand Tracker app's Python programs (`file_explorer.py`, `gesture_recorder.py`) as managed child processes — interpreter from `HAND_TRACKER_PYTHON` (default `pythonw`), user data dir passed as `HAND_TRACKER_DATA_DIR`. Waits ~2.5 s after spawn so a startup crash is reported as a failure with the output tail. Only one runs at a time (shared webcam). Stop = `taskkill /t` (WM_CLOSE, so the app releases the camera) then `/t /f` after 3 s; only PIDs it spawned are ever signalled. `shutdownAgentSystem()` stops them on Control Center exit, with a synchronous `process.on("exit")` fallback. |
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
- Wikipedia App reads an offline English Wikipedia archive in place from
  `WIKIPEDIA_DATA_DIR` (default `D:\Glesser-Industries-Database\Wikipedia\organized`;
  `en/enwiki.sqlite` + `en/search_index.sqlite` + article files, tens of GB).
  Never copied into the repo; the SQLite files are opened `mode=ro&immutable=1`
  so nothing in that folder is written (see `wikipedia-app/README.md`).
- `hand-tracker-app/gesture_profiles/` (calibration recordings + derived
  `profiles.json`) and `hand-tracker-app/dataset/` (gesture training
  samples + `manifest.json`) — both gitignored; in the packaged app they
  live under `%APPDATA%/Control Center/hand-tracker-app/` instead
  (`HAND_TRACKER_DATA_DIR` overrides either)

## Security model

The agent's only path to affecting the system is the tool catalog in
`agentTools.js` — there's no separate "permission engine," the catalog
itself *is* the permission boundary (a tool not defined there cannot be
called). Destructive-ish tools (`shutdown_app`) still exist as regular
tools; there's no additional confirmation step today, which is an accepted
tradeoff for a single-user local desktop tool, not a multi-tenant system.

## Current status

All 9 web apps (including `wikipedia-app`) are implemented and wired into the app registry, plus
`hand-tracker-app` (v0.1), a native Python app integrated as managed child
processes. It opens/closes through the same card/tab/IPC/agent paths as
the others; in Electron its `hand-tracker-app:open`/`:close` IPC launch/stop
the process instead of creating a BrowserWindow, and its tab shows a small
web status panel. It requires a local Python with
`hand-tracker-app/requirements.txt` installed. Voice
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
- Wikipedia lookups hit a 33 GB search index on a hard drive: a search whose
  index pages aren't cached yet can take from ~10 s to over a minute (common
  words), repeats are sub-second. The queue is sequential, so a slow lookup
  delays other agent work for that long.
- The librarian's plain-text conversion drops wikitext templates, so figures
  written as `{{convert|...}}` (heights, distances) are missing from article
  text the agent reads.
- Hand Tracker gestures are rule-based heuristics and only control the
  explorer's own window. The recorder collects data for a learned
  classifier, but no training script or model exists yet. Python
  dependencies aren't bundled in the packaged app.

**Possible next priorities:**
1. Recurring events and event editing in calendar-app.
2. Persistent movie library indexing instead of per-session folder import.
3. Server Manager power actions and richer metadata.
4. A real Mobile Mode client.

## How to run

From `control-app/`:
- Desktop app: `.\start-control-center.ps1`, or `npm start`
- Backend only (web dev fallback): `npm run start:web`

Hand Tracker additionally needs Python 3.12 with
`pip install -r hand-tracker-app/requirements.txt`; set `HAND_TRACKER_PYTHON`
in `control-app/.env` if `pythonw` on PATH isn't that interpreter.

Requires a local Ollama daemon with the configured model pulled
(`ollama pull qwen3.5:9b`, or whatever `OLLAMA_MODEL` is set to) — Control
Center will spawn `ollama serve` itself if it isn't already running, but it
won't pull a missing model for you.

The Wikipedia App additionally needs Python 3.8+ with SQLite FTS5 on `PATH`
(or `WIKIPEDIA_PYTHON`) and the prebuilt archive at `WIKIPEDIA_DATA_DIR`;
Control Center starts the librarian itself when the app is opened or the agent
first looks something up.
