# Control Center App

Desktop runtime for the Control Center system (Electron + local Express backend).

## What is included

- Dark-mode GUI with smooth tab navigation
- App tabs and standalone windows for modular apps
- Calendar app with month view + agenda, local persistence, and CRUD/read APIs
- Agent runtime with deterministic tool routing for common commands
- Backend API surface for orchestration, events, chat, and calendar
- Style guide for consistent visual language

## Run

1. Install dependencies:

   npm install

2. Start the desktop app:

   npm start

This launches an Electron desktop window and starts the internal backend automatically.

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
- GET `/api/apps/calendar-app/month`
- GET `/api/apps/calendar-app/events`
- GET `/api/apps/calendar-app/events/remaining`
- POST `/api/apps/calendar-app/events`
- DELETE `/api/apps/calendar-app/events/:eventId`

## Notes

- Calendar reads are designed to avoid opening the calendar app unless explicitly requested.
- Calendar event data is stored locally in `server/data/calendar-events.json`.
- Voice services and assets exist under `server/services/*voice*` and `voice/` for local runtime integration.