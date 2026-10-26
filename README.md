# Control Center

A personal hub that runs on a home PC: a desktop app with its own apps
(calendar, music, movies, projects and more) and a local AI assistant,
Jarvis. The phone app and the laptop app (Control Center Remote) reach all
of it from anywhere, over a private Tailscale network.

```
 Phone (Android app) ──┐
                       │  Tailscale (private network, HTTPS)
 Laptop (Remote app) ──┤
                       ▼
 Home PC: Control Center (Electron + Express on 127.0.0.1:3100)
   ├─ Jarvis: local AI agent on Ollama (qwen3.5:9b), with tools for the apps
   ├─ Apps: Projects, Calendar, News, Music, Movies, Drawing,
   │        Server Manager, Wikipedia (offline), File System
   └─ Data stays on the PC: nothing is synced to a cloud service
```

## What's in this repo

| Folder | What it is |
|---|---|
| [`control-app/`](control-app/) | The desktop app: Electron window, Express server, Jarvis, tests |
| [`mobile-app/`](mobile-app/) | Control Center Mobile, the native Android app (Kotlin, Jetpack Compose) |
| [`desktop-client/`](desktop-client/) | Control Center Remote, for a laptop or another desktop (Windows and Linux): the phone app's features, with install and start scripts |
| `project-app/`, `calendar-app/`, `news-app/`, `music-app/`, `movie-app/`, `drawing-app/`, `server-manager-app/` | The desktop apps' windows |
| [`wikipedia-app/`](wikipedia-app/) | Offline Wikipedia: a Python "librarian" server over a local archive (the archive itself stays where it is) |
| [`file-system-app/`](file-system-app/) | Hand-tracking file explorer and gesture recorder (Python, PC only) |
| [`design-documents/`](design-documents/) | PRDs, designs and architecture, including the mobile app's |

## The apps

| App | On the PC | On the phone |
|---|---|---|
| Jarvis | Chat and voice | Chat; replies arrive as notifications |
| Projects | Personal and work project folders: browse, edit text files, rename, copy, move, Recycle Bin, open in VS Code | Browse, edit and save text files, new files and folders |
| Calendar | Month view and agenda | Agenda, month grid, add and delete; reminders scheduled on the phone |
| Alarms | Ring on the PC | "Set an alarm in 30 seconds" rings on the device that asked |
| News | Weather and headlines | Same, with pull to refresh |
| Music | Player and playlists | Streams to the phone with lock-screen controls, or acts as a remote for the PC |
| Movies | Saved library from your movie folders | Streams with subtitles; warns before using mobile data |
| Drawing | 2D and 3D editor | View 2D drawings |
| Server Manager | Server list, SSH from the PC | List and Open SSH in an Android SSH app |
| Wikipedia | Offline search and articles | Same, through the PC |
| File System | Hand-tracking file explorer | Read-only browsing of the whole PC: previews, download, share; behind a fingerprint lock |
| IDE | — | A VS Code-style editor for the PC's `scripts/` folder: explorer, tabs, syntax colors, Save / Save As. Its AI tab on the right reads the open file and proposes changes as a diff you apply or discard (local model, nothing saved until you tap Save) |
| Hack the mainframe | — | Just for fun: a full-screen fake hacker console with six animated panels (tap one to make it the big one). Built into the phone, works offline |

### Things to ask Jarvis

Besides answering questions with the apps' data (schedule, news, music,
projects, Wikipedia), Jarvis can:

- set alarms and timers ("set an alarm in 30 seconds"), which ring on the
  device you asked from
- open and close apps (from the phone, they open on the phone)
- control music on the PC
- run a **process check**: it lists the PC's running processes into a
  temporary log, looks for common malware signs (system process names in
  the wrong place, look-alike names, hidden or download-and-run script
  commands, unsigned programs in Temp or Downloads), reports anything worth
  a look or "All processes normal", and deletes the log. These are warning
  signs, not proof; without admin rights Windows hides some processes'
  paths, so those are checked by name only
- **check hardware health**: "check my CPU", "do a GPU scan", "how are my
  drives", "check my RAM", or "any hardware errors" each run that one check;
  "full system sweep" / "full system scan" runs them all. Reports the CPU
  (load, clocks), GPU (temperature, load, VRAM, power), drive health (SMART),
  memory use, and recent hardware/disk errors from the event log. Read-only,
  no admin needed. CPU temperature has no built-in Windows source, so it
  isn't included
- run a **system diagnostic**: the process check plus whether the apps are
  online and whether Ollama is connected with its model loaded
- "hack the mainframe" (from the phone)

## Running it

On the home PC (Windows), from `control-app/`:

```
npm install
npm start
```

Needs [Node.js](https://nodejs.org) and [Ollama](https://ollama.com) with
`ollama pull qwen3.5:9b` (the default; any other installed model can be
picked from the Ollama card on the Overview tab, or in the phone's
Settings). Optional settings are in
`control-app/.env.example`. See [`control-app/README.md`](control-app/README.md)
for the details and the Windows build.

Tests: `npm test` in `control-app/` (server, security and Jarvis-tool tests). The phone app
builds and runs Android lint with `gradlew assembleDebug lintDebug` in `mobile-app/`.

## Using it away from home

1. Install [Tailscale](https://tailscale.com) on the PC and on your phone or
   laptop, signed in to the same account.
2. On the PC: `tailscale serve --bg 3100`. This publishes Control Center at
   `https://<pc-name>.<tailnet>.ts.net`, reachable only by your own devices.
3. In Control Center: Settings > Devices > **Pair a device**, then scan the QR
   code with the phone app, or enter the address and code in Control Center
   Remote on a laptop.

Build and install the phone app from `mobile-app/` with Android Studio, or
`gradlew assembleDebug` and `adb install`. Install the laptop app with
`desktop-client/install.ps1` (Windows) or `desktop-client/install.sh` (Linux);
see [`desktop-client/README.md`](desktop-client/README.md).

## Security in short

- The server listens on `127.0.0.1` only. Remote devices come in through
  Tailscale.
- Every API call needs credentials: the desktop window uses a local session
  cookie; each paired device gets its own token, stored hashed on the PC and
  encrypted on the phone. Pairing codes last 5 minutes and work once.
- Paired devices only get an allowlist of endpoints. Opening dialogs or
  programs on the PC, shutting down, settings, and file changes outside
  Projects and the IDE's `scripts/` folder stay desktop-only. File System on the phone is read-only and can
  be switched off on the PC.
- Remove a device any time from Settings > Devices.
