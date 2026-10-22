# Control Center App

Desktop runtime for the Control Center system (Electron + local Express backend).

## What is included

- Dark-mode GUI with smooth tab navigation
- App tabs and standalone windows for modular apps
- Calendar app with month view + agenda, local persistence, and CRUD/read APIs
- Drawing app with 2D canvas, 3D primitives, transform controls, and STL export
- Projects app: personal and work project folders, a folder browser, a text editor, and VS Code / terminal launchers
- Movie app with a saved library of movie folders (posters, subtitles), streamed to the desktop and the phone
- Server Manager app with a server inventory saved on the PC, SSH config, and PowerShell SSH launch
- Wikipedia app (offline archive) and File System app (hand-tracking explorer)
- Paired devices (the Android app) over Tailscale: per-device tokens and an endpoint allowlist
- Agent runtime with deterministic tool routing for common commands
- Backend API surface for orchestration, events, chat, and calendar
- Shared desktop file/directory picker endpoints for windowed apps
- Owned desktop shutdown path for backend, voice sockets, and background polling
- Unified runtime persistence in one local log file plus one shared agent context file
- Style guide for consistent visual language

## Run

1. Install dependencies:

   npm install

2. Start the desktop app:

   npm start

This launches an Electron desktop window and starts the internal backend automatically.
Closing the Control Center window also shuts down the local backend runtime, voice websocket attachment, and background status polling owned by the desktop app.

## Build Windows executable

1. Build the portable executable and installer:

   npm run dist

2. Use either generated file from `control-app/dist/`:

   - `Control Center 1.0.0.exe` for a portable executable you can double-click directly
   - `Control Center Setup 1.0.0.exe` for an installer with Start Menu and desktop shortcut support

The packaged desktop build bundles the sibling app UIs and design documents, and it writes runtime data under your user profile instead of the install folder.

## AI integration (Ollama)

The agent talks to a local [Ollama](https://ollama.ai) daemon.

1. Install Ollama and pull the default model: `ollama pull qwen3.5:9b`.
2. Optionally copy `.env.example` to `.env` and adjust `OLLAMA_BASE_URL` / `OLLAMA_MODEL`.
3. Control Center will spawn `ollama serve` itself on launch if it isn't already running.

## Optional web-only runtime (development fallback)

If you want to run only the backend and open it manually:

npm run start:web

## API and security

The server listens on `127.0.0.1:3100`, and every `/api` route needs
credentials, except `GET /api/health` and pairing (`POST /api/devices/pair`):

- The desktop window: a local session cookie that Electron sets at startup.
  `npm run start:web` prints a one-time sign-in link for a browser on this PC.
- Paired devices: `Authorization: Bearer <token>`. They may only call the
  routes in `REMOTE_ALLOWLIST` (`server/services/authService.js`); anything
  else answers 403.

All routes are in `server/routes/api.js`. The phone's view of them is in
`../design-documents/mobile-app-architecture.md`.

## Tests

    npm test

Runs `tests/**/*.test.mjs` (auth, devices, alarms, files, projects, media)
against a server on a random port, with state in a temp folder.

## Notes

- Calendar reads are designed to avoid opening the calendar app unless explicitly requested.
- Calendar data is entirely local, stored in `server/data/calendar-events.json`.
- The installed desktop build stores mutable runtime data under `%APPDATA%/Control Center/` on Windows.
- Standalone app windows use a shared Electron preload bridge (`electron/preload.cjs`, CommonJS because sandboxed preloads can't load ES modules) and common open/close IPC wiring.
- Server Manager SSH launch is routed through the local server so browser and Electron paths use the same behavior.
- Mutable runtime state now consolidates into `logs/control-center-runtime.json`, and dynamic agent context consolidates into `control-app/agent/AGENT_RUNTIME_CONTEXT.txt`.
- Voice services and assets exist under `server/services/*voice*` and `voice/` for local runtime integration.