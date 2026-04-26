# Control Center App

Desktop runtime for the Control Center system (Electron + local Express backend).

## What is included

- Dark-mode GUI with smooth tab navigation
- App tabs and standalone windows for modular apps
- Calendar app with month view + agenda, local persistence, and CRUD/read APIs
- Drawing app with 2D canvas, 3D primitives, transform controls, and STL export
- Movie app with folder import, poster-style library, and inline desktop playback
- Server Manager app with local server inventory, SSH config, and PowerShell SSH launch
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

## Google Calendar setup (optional)

By default, calendar data is local (`server/data/calendar-events.json`).

To connect to Google Calendar API:

1. Copy `.env.example` to `.env` in `control-app/`.
2. Set `CALENDAR_PROVIDER=google`.
3. Configure one auth method:
   - API key only: `GOOGLE_CALENDAR_API_KEY` (read-only)
   - Service account (recommended): `GOOGLE_CALENDAR_CLIENT_EMAIL` + `GOOGLE_CALENDAR_PRIVATE_KEY`
   - OAuth refresh token: `GOOGLE_CALENDAR_CLIENT_ID`, `GOOGLE_CALENDAR_CLIENT_SECRET`, `GOOGLE_CALENDAR_REFRESH_TOKEN`
4. Set `GOOGLE_CALENDAR_ID` (or keep `primary`).
5. Restart the app.

Notes:

- API key mode supports calendar reads only; create/delete requires service account or OAuth credentials.
- Service-account calendar access requires sharing the target Google Calendar with the service account email.
- If your private key is pasted into `.env`, keep embedded newlines escaped as `\\n`.
- You can set `CALENDAR_PROVIDER=auto` to use Google only when credentials are present; otherwise local storage is used.

## Optional web-only runtime (development fallback)

If you want to run only the backend and open it manually:

npm run start:web

## Current API endpoints

- GET `/api/health`
- GET `/api/system`
- GET `/api/apps`
- GET `/api/apps/:appId`
- POST `/api/apps/:appId/connect` (stub)
- GET `/api/events`
- POST `/api/events`
- GET `/api/events/stream`
- GET `/api/chat/messages`
- POST `/api/chat/messages`
- POST `/api/system/choose-directory`
- POST `/api/system/choose-file`
- POST `/api/system/ssh-connect`
- POST `/api/shutdown`
- GET `/api/apps/calendar-app/month`
- GET `/api/apps/calendar-app/events`
- GET `/api/apps/calendar-app/events/remaining`
- POST `/api/apps/calendar-app/events`
- DELETE `/api/apps/calendar-app/events/:eventId`

## Notes

- Calendar reads are designed to avoid opening the calendar app unless explicitly requested.
- Calendar provider supports both local storage and Google Calendar API (configurable by env).
- Local calendar event data is stored in `server/data/calendar-events.json` when provider is `local`.
- Standalone app windows use a shared Electron preload bridge and common open/close IPC wiring.
- Server Manager SSH launch is routed through the local server so browser and Electron paths use the same behavior.
- Mutable runtime state now consolidates into `logs/control-center-runtime.json`, and dynamic agent context consolidates into `control-app/agent/AGENT_RUNTIME_CONTEXT.txt`.
- Voice services and assets exist under `server/services/*voice*` and `voice/` for local runtime integration.