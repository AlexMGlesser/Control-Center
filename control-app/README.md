# Control Center App

Initial shell for the Control Center desktop app.

## What is included

- Dark-mode GUI with smooth tab navigation
- App tabs for all planned modules (marked Work in Progress)
- Backend API scaffold for app orchestration and health checks
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

## Notes

The backend is intentionally scaffolded and integration-ready, but does not yet implement real cross-app connectors.