# Control Center - Project Overview

**Last Updated:** 2026-06-22  
**Status:** (v0.2.3)

---

## 1. Project Summary

Control Center is a desktop-based AI system hub that combines:
- **Desktop Application:** Electron-based GUI (Windows)
- **Local AI Agent:** Ollama integration with native tool-calling, plus a small deterministic fast path for trivial commands
- **Modular App Ecosystem:** 8+ integrated applications with independent data/API access
- **Backend Server:** Express.js running locally, provides API surface and orchestration
- **Task Queue:** Chat/voice/app requests queue and drain in order instead of blocking on each other
- **Voice Pipeline:** Whisper (STT) + Piper (TTS) for audio interaction

**Primary Purpose:** Centralized app hub with AI orchestration, supporting both Desktop and Mobile modes.

---

## 2. Architecture Overview

### System Layers (Top to Bottom)

```
Desktop UI (Electron) ←→ IPC/HTTP
         ↓
   Express Backend (localhost:3000)
         ↓
┌─────────────────────────────────────┐
│ Services Layer                      │
├─────────────────────────────────────┤
│ • Orchestrator                      │
│ • App Registry & App Messages       │
│ • Event Bus (in-memory + SSE)       │
│ • Task Queue (chat/voice/app)       │
│ • Chat Service (AI integration)     │
│ • Ollama Integration                │
│ • Voice (Whisper/Piper)             │
│ • Mode State Machine                │
│ • Settings, Calendar, Drawing, etc. │
└─────────────────────────────────────┘
         ↓
   App Modules (8 apps)
   + Local File System
```

### Design Principles
- **Centralized Orchestration:** One Control Center runtime coordinates the system
- **App Modularity:** Each app has isolated services and data access rules
- **Tool-Gated AI Access:** Agent acts through approved tools, not directly
- **Desktop-First Execution:** All core processing runs on the desktop host
- **Mobile as Client:** Phone connects to desktop-hosted backend (future)
- **Shared UI Language:** Consistent dark-mode visual style across apps

---

## 3. Desktop Application (Electron)

### File Structure
```
control-app/
├── electron/
│   ├── main.js           (Electron main process, window creation)
│   └── preload.js        (IPC bridge for security)
├── client/               (Vite-bundled frontend)
│   ├── app.js            (Tab system, UI state)
│   ├── voice.js          (Audio interaction)
│   ├── index.html
│   └── styles.css        (Dark theme)
├── server/               (Express backend)
├── agent/
│   ├── AGENT_RUNTIME_CONTEXT.txt    (AI continuity)
│   └── AGENT_TOOL_CONTEXT.txt       (Tool definitions)
└── package.json          (Dependencies)
```

### Launch Process
1. `npm start` or `start-control-center.ps1` (PowerShell)
2. Electron spawns main window (1400×900, min 1050×700)
3. Loads `http://localhost:3000` (backend auto-starts)
4. On close: graceful shutdown of backend, voice sockets, Ollama probe

### Main Features
- **Tab System:** System tabs (Overview, Settings, Chatbot, Event Bus, Agent Core, Integration Hub) + Dynamic app tabs
- **Mode Switching:** Desktop ↔ Mobile mode toggle in header
- **Status Cards:** App registry display with smooth navigation
- **Settings Tab:** Audio device selection, voice model selection, voice speed adjustment
- **Chatbot Tab:** Desktop-only text chat with local AI agent (Mobile shows desktop-required notice)
- **Event Bus:** Real-time scrollable event stream with SSE connection

---

## 4. Backend Services (Express Server)

### Core Config
- **Port:** localhost:3000 (configurable via `server/config.js`)
- **Static Routes:** `/calendar-app`, `/news-app`, `/work-app`, `/project-app`, `/music-app`, `/drawing-app`, `/movie-app`, `/server-manager-app`, `/wikipedia-app`
- **API Route:** `/api/*` (main orchestration endpoint)

### Service Modules (`server/services/`)

| Service | Purpose |
|---------|---------|
| **orchestrator.js** | Core orchestration status, app connection lifecycle |
| **appRegistry.js** | Maintains list of 8 modular apps and their metadata |
| **appMessageService.js** | In-memory app event logging with bounded history |
| **eventBus.js** | System-wide event broadcasting (in-memory + SSE streaming) |
| **chatService.js** | Local AI chat state and message history |
| **ollamaService.js** | Ollama status probing, lifecycle (start/stop), tool-calling chat completions |
| **voiceService.js** | WebSocket attachment for voice I/O, audio stream handling |
| **whisperService.js** | Speech-to-text (local or remote) |
| **piperService.js** | Text-to-speech synthesis (Piper engine) |
| **modeStateMachine.js** | Desktop ↔ Mobile mode state, transition history |
| **settingsService.js** | Audio device, voice model, speed preferences |
| **calendarService.js** | CRUD for calendar events, entirely local JSON storage |
| **drawingFileService.js** | Directory picker and path handling for drawing exports |
| **musicLibraryService.js** | Music folder scanning and library state |
| **newsService.js** | News feed integration |
| **projectService.js** | Project folder and metadata management |
| **agentRuntime.js** | Builds the agent's system prompt, runs the Ollama tool-calling loop, deterministic fast path |
| **agentTools.js** | Tool catalog (JSON-schema definitions) and dispatcher for tool execution |
| **agentContextLoader.js** | Builds context bundles from design docs for AI prompts |
| **queueManager.js** / **queueWorker.js** | Task queue (priority FIFO) and drain loop shared by chat, voice, and app messages |
| **runtimePersistenceService.js** | Reads/writes `logs/control-center-runtime.json` and agent context |
| **windowControlBridge.js** | IPC handler for opening/closing app windows |

---

## 5. Modular Applications

All apps follow a dark-mode visual style and can run either:
- **Embedded:** In tabs within Control Center
- **Standalone:** In dedicated Electron child windows

### Application Details

| App | Location | Features | Backend |
|-----|----------|----------|---------|
| **Calendar** | `calendar-app/` | Month view, agenda, CRUD events | Local JSON only |
| **Project** | `project-app/` | Folder browser, file management, IDE integration | Local file system |
| **Work** | `work-app/` | Work/school project management | Local file system |
| **Drawing** | `drawing-app/` | 2D canvas + 3D primitives, transform controls, STL export | Directory picker, local file save |
| **Movie** | `movie-app/` | Folder import, library cards, inline playback | Local folder scanning |
| **Music** | `music-app/` | Library management, playback controls | Local folder scanning |
| **News** | `news-app/` | Feed aggregation | External news APIs |
| **Server Manager** | `server-manager-app/` | SSH config, server inventory, PowerShell launch | Browser storage, SSH bridge |
| **Wikipedia** | `wikipedia-app/` | Offline Wikipedia search/reader (Python librarian server on 127.0.0.1:8766, started on demand); agent `search_wikipedia` / `read_wikipedia_article` tools | Read-only archive at `WIKIPEDIA_DATA_DIR` |

### App Lifecycle
- Each app is a standalone HTML/JS/CSS bundle
- Apps receive backend services via API calls
- Apps can request file/directory pickers through shared endpoints
- Apps emit messages to the app message service for logging

---

## 6. AI Agent Integration

### Agent Components
- **Ollama:** Local model hosting (`qwen3.5:9b` by default), native tool-calling
- **Task Queue:** Chat/voice/app requests enqueue and drain in order (voice gets priority) instead of blocking on each other
- **Deterministic Fast Path:** Trivial commands ("open X", "what time is it") skip the LLM entirely
- **Tool Catalog:** JSON-schema tool definitions the model can call directly (file ops, calendar CRUD, music control, etc.)
- **Conversation State:** In-memory chat history with context loading
- **Context Bundles:** Dynamically built from design documents for prompt enrichment

### Agent Execution Flow
1. User text → Chatbot input, Voice (Whisper STT), or an app's background message
2. Request is enqueued; the queue worker processes tasks one at a time (voice preempts text)
3. Deterministic fast path handles trivial commands with no LLM call
4. Otherwise, Ollama receives the conversation + tool catalog and returns either a reply or structured tool calls
5. Tool calls execute, results go back to Ollama, looping until a final reply is produced
6. Response → Chat history + Event bus + UI update

### Runtime Continuity
- Agent context persisted to `control-app/agent/AGENT_RUNTIME_CONTEXT.txt`
- Chat history maintained in-memory; logged to runtime persistence
- Tool execution audited in app message service

---

## 7. Voice Pipeline

### Components
- **Whisper (STT):** Transcribes user audio to text
- **Piper (TTS):** Synthesizes text responses to audio
- **Voice Service:** WebSocket management for bidirectional audio streams
- **Audio Devices:** Settings tab allows user to select input/output devices

### File Structure
```
control-app/voice/
├── piper/
│   ├── en_GB-alan-medium.onnx    (Model file)
│   ├── libtashkeel_model.ort     (Processing model)
│   └── espeak-ng-data/           (Language data)
├── whisper/                       (Whisper model)
└── setup-voice.ps1               (Voice setup script)
```

### Status
- WebSocket route active; clients can connect
- Local voice pipeline partially integrated
- Settings tab supports voice model and speed selection

---

## 8. Data Persistence & Storage

### Runtime State
- **`logs/control-center-runtime.json`** (ignored in git)
  - Current mode, Ollama connection state
  - Recent chat messages (last 60)
  - App message history (bounded)
  - Active session metadata

- **`control-app/agent/AGENT_RUNTIME_CONTEXT.txt`** (ignored in git)
  - AI agent continuity state
  - Recent interactions formatted for prompt context
  - Tool access history

### App Data
- **Calendar:** `control-app/server/data/calendar-events.json`, entirely local
- **Drawing:** User-selected directories (file picker integration)
- **Music/News:** Scanned from local folders or external APIs
- **Server Manager:** Browser storage (persists in Electron storage)
- **Project/Work:** Local file system access

---

## 9. Development & Build

### Scripts
```json
{
  "start": "electron .",              // Run desktop app with auto-starting backend
  "dev": "electron .",                // Same as start
  "start:web": "node server/index.js", // Backend only (for web testing)
  "pack": "electron-builder --dir",   // Package for distribution
  "dist": "electron-builder --win portable nsis" // Build Windows executable + installer
}
```

### Build Output
- **`control-app/dist/Control Center 1.0.0.exe`** (portable)
- **`control-app/dist/Control Center Setup 1.0.0.exe`** (installer with Start Menu/desktop shortcut)
- Data written to user profile (not install folder)

### Dependencies
```
Runtime: express, ws, dotenv, fast-xml-parser
Desktop: electron, electron-builder
```

---

## 10. External Integrations

### Ollama
- Runs as a local daemon; Control Center spawns/stops it if needed
- Backend polls `http://127.0.0.1:11434` for status
- Chat completions via Ollama's native tool-calling API (default model `qwen3.5:9b`)

### External APIs
- News aggregation services (news-app)
- Weather/STEM data (future integration points)
- SSH bridge for server management

---

## 11. Security & Permissions

### Design Principles
- **Tool Gateway:** AI agent cannot access system directly; only through approved tools
- **App Isolation:** Each app has its own data/API boundary
- **User Authority:** Primary user holds highest privileges (agent is secondary)
- **IPC Security:** Electron preload script enforces context isolation
- **File Access:** Directory picker endpoints validate paths before access

### Implementation
- Tool permission matrix enforced in `agentToolInterface.js`
- Command filter validates intent before execution
- App message service logs all operations for audit trail

---

## 12. Key Files & Paths

### Critical Files
| File | Purpose |
|------|---------|
| `control-app/electron/main.js` | Electron app entry, window management |
| `control-app/server/index.js` | Express server startup, static file routing |
| `control-app/server/routes/api.js` | Main API endpoint definitions |
| `control-app/package.json` | Dependencies, build config, scripts |
| `control-app/server/config.js` | Server configuration (port, host) |
| `design-documents/control-center-overview.md` | Product overview & per-app spec (used for AI context) |
| `design-documents/control-center-architecture.md` | Architecture, current status, how to run (used for AI context) |

### Data Directories
```
logs/                           (Runtime state, events log)
control-app/server/data/        (Calendar JSON, app data)
control-app/agent/              (AI context, tool definitions)
control-app/voice/              (Piper/Whisper models)
```

---

## 13. Deployment & Running

### Local Development
```bash
cd control-app
npm install
npm start
```
Launches Electron + embedded Express backend at `http://localhost:3000`

### Production Build
```bash
npm run dist
```
Creates portable `.exe` and installer in `dist/` folder

### Standalone Server
```bash
npm run start:web
```
Runs Express backend only (for mobile companion app development)

---

## 14. Future/Planned Features

- Mobile companion app (audio-only interface, connected to desktop backend)
- Cloud synchronization for calendar and project data
- Extended voice pipeline integration (wake words, continuous listening)
- Additional external API integrations (weather, STEM data)
- Plugin/extension system for custom apps
- Enhanced AI context with codebase understanding

---

## 15. Contact & Context

**Author:** Alex Glesser  
**Version:** 1.0.0  
**Repository Root:** `d:\Control-Center`  
**Core App:** `d:\Control-Center\control-app`  
**Design Docs:** `d:\Control-Center\design-documents`

For questions about specific features, consult the design documents or individual service modules in `control-app/server/services/`.
