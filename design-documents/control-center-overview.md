# Control Center — Overview & Product Spec

*Replaces `control-center-design.txt`, `control-center-prd.txt`, and
`control-center-functional-spec.txt`, which described the same product in
three near-identical formats. This is the single source of truth for what
Control Center is meant to do.*

## What it is

Control Center is a desktop AI system hub: a single Electron app that gives
one primary user access to a set of independent apps (calendar, projects,
work, drawing, news, music, server management, movies, offline Wikipedia,
hand tracking), plus a local AI
agent (via Ollama) that can act across those apps through tool calls. The
user is always the higher authority — the agent only acts through approved
tools, never direct system access.

## Interaction modes

- **Desktop Mode** (current): the user is at the computer, speaks or types
  to the agent, audio plays through desktop speakers/headset. VS Code and
  other desktop software can be launched from here.
- **Mobile Mode** (planned, not yet built): an audio-only companion client
  connecting to the desktop-hosted backend. Mode switching would work via a
  UI toggle or voice command. Treat any mention of mobile behavior elsewhere
  in these docs as forward-looking, not implemented.

## Layout

Panel-based UI: a left navigation panel (system tabs, app tabs, tools) and a
larger right panel showing the active app or system view, scrollable as more
apps are added. Shared dark-mode style guide across all apps.

## Apps

### project-app
Personal project folders, editable by the user or the agent. Opens VS Code
in Desktop Mode. *Planned:* prompting GitHub Copilot Chat directly and
reporting back a summary — not implemented today; currently the agent can
open a project/file but does not drive Copilot itself.

### work-app
Same model as project-app, separate storage root, scoped to work/school
projects instead of personal ones.

### calendar-app
Local-only calendar (no external account, no Google Calendar). Month view,
agenda view, and CRUD for events — the agent can read, create, and delete
events, resolving relative dates ("tomorrow", "next Tuesday") against the
current date/time. Example:

> User: "What do I have scheduled later?"
> Agent: "You have your computer science class at 3:45 PM."
> User: "Put Meet with Max into my calendar Friday at 5 PM."
> Agent: "Meet with Max has been scheduled for Friday at 5:00 PM."

### drawing-app
2D canvas + 3D primitive editor with transform controls and STL export.
Designs are saved to a user-chosen directory; not currently shared as
managed assets between apps (that cross-app asset linking is aspirational,
not implemented).

### news-app
Aggregates weather, headlines, tech news, and a daily STEM item on request
(not yet on a background refresh schedule). Desktop layout: weather along
the bottom, headlines top/middle-left, extra articles top-right, tech
middle-right.

### music-app
Local-only playback (imported files + local playlists). No streaming
service integration. Playback always runs on the desktop; a future Mobile
Mode would stream from the desktop rather than opening a mobile music app.

### server-manager-app
Inventory of the user's own servers: SSH config and one-click PowerShell SSH
launch, server metadata display. Remote power control and richer
storage/telemetry integration are planned, not implemented.

### movie-app
Local movie server with folder import, a poster-style library, and inline
in-app playback. Library state is per-session (rebuilt from the imported
folder each time), not a persistent indexed database — that's a planned
improvement.

### wikipedia-app
Offline English Wikipedia: the GLESSER ARCHIVE librarian (a Python server
Control Center starts on demand) with ranked search, an article reader, and
its own librarian chat page, shown in the app window. The archive is read in
place from a local folder, read-only. It's an app the user prompts directly;
Control Center's agent can open and close it like any other app but doesn't
query the archive itself.

### hand-tracker-app (v0.1)
The one app that isn't a web UI: a native Python/Tkinter window using the
webcam and MediaPipe hand landmarks, ported from a standalone project.
Two programs:
- **Gesture file explorer** — browse folders with hand gestures (pointer
  ray from the index finger, other-hand "point" to select, open-hand swipes
  to scroll/go back, wave to recenter), with a calibration wizard whose
  recordings tune the gesture thresholds.
- **Gesture recorder** — guided capture of labeled training data (countdown,
  fixed-length clip, rest, repeat; redo/discard last rep) into
  `dataset/<label>/` plus a manifest, including a `none` background class.
  It is the data-collection half of a planned custom gesture classifier;
  the training script itself doesn't exist yet.

It opens and closes exactly like the other apps: its card, tab, launch
button, the agent's `open_app` / `close_app` (so "Jarvis, open the file
explorer"), "open all" / "close all", and shutdown. The difference is that
"opening" launches the native explorer window as a managed child process and
"closing" stops it. Its tab content is a small status panel (running state,
recorder settings, dataset label counts). The agent can also start the
recorder for a given label. Gestures only drive the explorer's own window;
they don't control Control Center or other apps (yet).

## Cross-cutting requirements

- The agent maintains conversation context and should recognize when to
  stop listening (voice barge-in/cancel).
- Every app keeps its own data/API boundary; the agent only touches an app
  through its defined tools, never by reaching into another app's storage
  directly.
- All apps follow the shared style guide (`control-app/docs/style-guide.md`)
  unless there's a specific reason not to.
