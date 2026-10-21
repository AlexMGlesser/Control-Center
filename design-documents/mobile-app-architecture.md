# Control Center Mobile: Architecture

**Status:** Draft for review, 2026-10-21
**Companion docs:** `mobile-app-prd.md` (scope), `mobile-app-design.md` (screens)

## 1. Overview

```
 Android phone: native app (Kotlin + Jetpack Compose)
   ├─ UI (open)                        ─┐
   ├─ Connection service (background)   ├─ bearer device token
   └─ Media player service (music)     ─┘
                    │
                    │  Tailscale (WireGuard), https://<pc-name>.<tailnet>.ts.net
                    ▼
 Home PC ─ tailscale serve (HTTPS, real cert) ─► http://127.0.0.1:3100
                                                     │
                       Express backend (control-app/server), unchanged role:
                       auth middleware ─► /api routes ─► services ─► data files
                                                     ▲
 Electron desktop UI ─ local session cookie ─────────┘  (same server, localhost)
```

The phone app is a real native Android app, written in Kotlin with Jetpack
Compose. It's installed like any other app and meant to be kept open; it
contains no web pages.

There's one server and one copy of the data, on the PC. The phone is a client
of the same `/api` the desktop UI already uses, plus a handful of new
endpoints. There's no new database and nothing to sync: every read and write
goes to the PC, and the event stream pushes changes to every connected client.
The one exception is calendar reminders, which the phone schedules locally so
they fire even when it's offline (section 7).

## 2. Networking

### 2.1 Tailscale
- Tailscale is installed on the PC and the phone, both signed in to the same
  account. On the phone, Tailscale runs as Android's VPN, so it stays up in
  the background on its own.
- **MagicDNS** gives the PC a stable name, and **HTTPS certificates** are
  turned on in the Tailscale admin console.
- **`tailscale serve`** on the PC publishes the PC's tailnet name over HTTPS
  and forwards to `http://127.0.0.1:3100`. The phone gets a real certificate,
  so no cleartext-traffic exception is needed. The exact command is confirmed
  when we implement this.
- Nothing is opened on the router. The server is reachable only by devices
  on the user's tailnet.

### 2.2 Server binding (fixes an existing exposure)
Today the server listens on `0.0.0.0:3100` with no authentication, so any
device on the home Wi-Fi can use the full API. The change:
- Default `HOST` becomes `127.0.0.1`. Electron loads `localhost` and is
  unaffected. The phone comes in only through `tailscale serve`, which
  connects from localhost.
- Because `tailscale serve` traffic also arrives from `127.0.0.1`, **the server
  never trusts a request because of its source address.** Every request
  authenticates (section 4).

### 2.3 Limitations
- The PC has to be on and awake. Windows sleep settings may need adjusting,
  and waking a sleeping PC remotely is out of scope.
- Control Center has to be running. Starting it at login is a separate,
  optional step (a Windows startup shortcut).

## 3. Clients

| Client | Auth | Event stream |
|---|---|---|
| Desktop (Electron), existing | Local session cookie (4.2) | `EventSource`; the cookie is sent automatically |
| Phone (native Android) | `Authorization: Bearer <device token>` on every request, including media | OkHttp's SSE client, run by the connection service (section 7) |

**Laptops (later).** Laptop access is out of v1. The proposed route is to give
the existing desktop Electron app a "connect to my home PC" mode. That reuses
every desktop app page as is, since they're served by the home PC's server
anyway. It needs device tokens to also work as cookies for that window. This
is a separate design when we get there.

## 4. Security

### 4.1 Threat model
- **In scope:** another device on the home Wi-Fi; a lost or stolen phone; a
  device left on the tailnet; a web page or file content trying to trick
  Jarvis (prompt injection) through a phone session.
- A lost, unlocked phone matters most for File System, which can read the
  whole PC; section 5.10 lists how that's contained.
- **Out of scope:** an attacker who already controls the PC or the user's
  Tailscale account.

### 4.2 Authentication
Every `/api` request and the `/voice` WebSocket require one of the following.

1. **Device token** (phone): a random 256-bit value issued at pairing and sent
   as a bearer header. The server stores only a SHA-256 hash in
   `data/devices.json`, alongside the id, name, type, created time, last-seen
   time and scope.
2. **Local session** (desktop): on each launch, Electron's main process
   creates a random secret, gives it to the in-process server, and sets it as
   a cookie on the Electron session for `localhost`. Every existing desktop
   page and window, `fetch` and `EventSource` sends it automatically, so **no
   desktop app code changes**. `npm run start:web` prints a one-time local
   URL that sets the cookie.

Requests with neither get `401`. A revoked or unknown token gets `401`, and
the phone shows the "device was removed" screen.

### 4.3 Pairing
```
PC (Settings > Devices > Pair)            Phone
 POST /api/devices/pairing-codes  ──►  code: 8 chars, base32 (~40 bits),
   (local session only)                single use, expires in 5 min
 shows QR: {"url": "https://pc.tailnet.ts.net", "code": "K7M2Q9TX"}
                                          scans QR (camera)
                               ◄──  POST /api/devices/pair {code, deviceName}
 validates code, creates device  ──►  {deviceId, token}  (token shown once)
                                          encrypts the token with a key held in
                                          the Android Keystore and saves it
```
- The pair endpoint is the only unauthenticated `/api` route. It allows 5 tries
  per code and is rate-limited per address. A code dies after one successful
  use or when it expires.
- `GET /api/devices` lists devices and `DELETE /api/devices/:id` revokes one.
  Both require a local session, so only the PC can manage devices.

### 4.4 Remote scope: deny by default
Device tokens carry the scope `remote`; the local session has `desktop`. A
remote token reaches only an explicit allowlist of routes. Everything not
listed returns `403` for the phone:

| Allowed for the phone (v1) | Desktop only |
|---|---|
| `GET /api/health`, `/system`, `/apps`, `/apps/:id` | `/system/choose-directory`, `/system/choose-file` (open dialogs on the PC) |
| Chat: `GET/POST /api/chat/messages`, `GET /api/agent/queue/status` | `/system/ssh-connect` (launches PowerShell on the PC) |
| Events: `GET /api/events/stream` | `/apps/*/launch-tool`, `/apps/*/files/open` (open IDE/files on the PC) |
| Calendar: read, create, delete | `/shutdown`, `/ollama/start`, `/ollama/stop`, `/mode/switch` |
| News: briefing | `PUT /settings/desktop`, `/settings/desktop/test-voice` |
| Wikipedia: proxy search/article (5.4) | `/devices/*` management, pairing codes |
| Projects/Work: list, tree, read file (5.5) | Project file create/delete/copy/move (v1) |
| Music: library, playlists, streaming (5.8), PC playback commands | `POST /api/events` (arbitrary event publishing) |
| Movie: library, streaming (5.6) | Movie folder setup |
| Drawing: list, read | Drawing write/delete (v1) |
| Server Manager: read servers (5.7) | Server Manager write (v1) |
| File System: roots, list, info, file content (read only, 5.10) | Skills create/update/delete |
| | File System hand tracking: launching or stopping the gesture explorer and recorder; the Phone file access switch |

The server sends no CORS headers at all. A native app doesn't need them, and
their absence stops any web page in a browser from calling the API.

### 4.5 Jarvis from the phone
A chat turn records where it came from: `origin: {type: "user", device: {id, kind: "phone"|"desktop"}}`.
`executeToolCall` receives that origin (today it only gets the tool name and
arguments). For turns from the phone:
- **Desktop-only tools are refused** with a clear error, so Jarvis can explain.
  These are `shutdown_app`, `update_desktop_settings`, `test_voice`,
  `switch_mode`, and `publish_event`. Each tool definition gets a
  `desktopOnly` flag.
- **`open_app` / `close_app` act on the phone.** They publish `open-app` with
  `meta.targetDeviceId` and don't open PC windows or launch PC processes.
  The desktop UI ignores events targeted at another device.
- **`control_music`** still controls the PC player. The reply says "on the PC".

This means a prompt injection that reaches Jarvis through the phone can't do
anything the phone couldn't already do directly.

### 4.6 File access
- `GET /api/apps/music-app/local-file?path=` currently serves **any file on
  the disk** to anyone who can reach the server. It changes, for every client,
  to serve only files that resolve (after following symlinks) inside the
  configured music library folders. Anything else returns 403.
- The new project file reader (5.5) and movie streaming (5.6) are limited the
  same way, to their own roots.
- File System (5.10) is the deliberate exception. It reads anywhere the
  Windows account can, and is read-only by construction.

### 4.7 Other hardening
- An auth audit log: pairings, revocations, and rejected requests (rate-limited)
  go to the event bus and the runtime log.
- On the phone, the token never leaves Keystore-backed encrypted storage. It's
  excluded from Android backups, so restoring a backup to another phone
  doesn't carry the pairing over.

## 5. API changes and additions

### 5.1 App registry
`appRegistry.js` entries gain two fields:
```js
icon: "calendar-days",          // Lucide icon name (design 3.2)
mobile: { view: "native" }      // "native" = phone view, "status" = status card, "none" = generic card
```
`GET /api/apps` already returns registry entries, so the phone grid is fully
data-driven. The phone ships the Lucide icons as Android vector drawables and
picks one by name, falling back to `app-window` for names it doesn't have.

### 5.2 Event stream
- `GET /api/events/stream` requires auth.
- **Heartbeat.** The server sends an SSE comment line every 25 s, so the phone
  can tell a quiet connection from a dead one (section 7.2).
- **Graceful shutdown notice.** When Control Center shuts down normally, it
  sends a `server-stopping` event to every connected client before closing.
  The phone can then say "Control Center was shut down on the PC" instead of
  guessing.
- **New `data-changed` events.** Today only a few actions publish events, and
  calendar changes publish none. Write routes for calendar, drawing files,
  playlists, project files and servers publish
  `{type: "data-changed", appId, entity, id}` so open screens on any device
  refresh and the phone reschedules reminders.
- **Device targeting.** Events can carry `meta.targetDeviceId`, and clients
  drop events addressed to someone else. This replaces "every UI reacts to
  every open-app".

### 5.3 Chat
No new endpoints. `POST /api/chat/messages` already queues a turn and returns
`202`. The phone then listens for the `chat` event and fetches
`GET /api/chat/messages`. Two changes: chat messages store the sending device
(for the "from Phone" label), and the turn origin carries the device (4.5).
The `chat` event includes the turn's origin device, so the phone knows which
replies answer its own messages (for reply notifications, 7.4).

### 5.4 Wikipedia proxy
The librarian listens on `127.0.0.1:8766`, which the phone can't reach.
`GET /api/apps/wikipedia-app/proxy/api/v1/{search|article|...}` starts the
librarian if needed (`startWikipedia()`), forwards the request, and returns
its JSON. Only the `/api/v1` read endpoints are proxied. The phone draws its
own search and article screens.

### 5.5 Project file reader
`GET /api/apps/{project-app|work-app}/projects/:id/file?path=<relative>`
- Resolves under the project root and rejects anything outside it.
- Returns `{text, size, truncated}` for text files up to 512 KB, and `415` with
  size and type for binary files.

### 5.6 Movie library (prerequisite for Movie on the phone)
The desktop Movie app keeps its library only inside the browser (object URLs
from an imported folder), so there's nothing on the PC to share. Adding:
- `data/movie-library.json`: the folders the user picked, plus a scanned
  index. Each entry has title, file, size, duration, container, video and
  audio codecs, subtitle tracks, and a poster if a matching image exists.
  Codec details come from `ffprobe` (FFmpeg) when it's installed; they let the
  phone warn before playing a file it can't decode (5.9).
- `GET /api/apps/movie-app/library` and `POST /api/apps/movie-app/folders`
  (desktop only), then a rescan.
- `GET /api/apps/movie-app/stream/:id`, which streams with HTTP Range support
  (Express's `sendFile` handles Range), so seeking works.
- The desktop Movie app switches to this library too. That's the "persistent
  movie library" item already on the roadmap.

### 5.7 Server Manager storage
Servers move from the desktop's `localStorage` to `data/servers.json` with
`GET` and `PUT /api/apps/server-manager-app/servers`. On first load after the
update, the desktop app uploads its existing `localStorage` list once, then
reads from the server.

### 5.8 Music
- Saved playlists already sync to the PC (`/apps/music-app/local-playlists/sync`).
  The PC copy becomes the source of truth, and the desktop app reads it from
  the server instead of `localStorage`.
- Phone playback streams `local-file` (now restricted, 4.6) with Range support.
- "Play on PC" reuses the existing `music-command` event path that
  `control_music` already uses.

### 5.9 Streaming music and movies: what to expect

Streaming is supported directly. The files play on the phone straight from
the PC, with no conversion step in v1.

- **Login on media requests.** The phone's player (AndroidX Media3, the
  standard Android media library) sends the bearer token on every media
  request, so media URLs need no tokens of their own.
- **Seeking** works through HTTP Range requests.
- **Music has no expected complications.**
  - Formats: MP3, AAC/M4A, FLAC, Ogg Vorbis, Opus and WAV all play natively
    on Android. Rarer formats such as WMA and APE won't; the library scan
    flags them so the phone can grey them out.
  - Data: 0.1 to 1.5 Mbps, which is fine on cellular. FLAC uses about
    300 to 700 MB per hour.
  - Background: playback continues with the screen off, with lock-screen
    and notification controls (Media3's media session service).
- **Movies depend on the files.**
  - **Video:** H.264 plays on every phone; H.265/HEVC on almost all recent
    phones; AV1 only on newer ones. MP4 and MKV containers both work.
  - **Audio:** movie rips often use AC3, E-AC3, DTS or TrueHD audio, which
    many phones can't decode. Picture then plays without sound. The library
    scan records each file's codecs, so the phone can say up front "This
    file's audio (DTS) won't play on this phone".
  - **Subtitles:** SRT, ASS and PGS inside MKV files work. An `.srt` file with
    the same name next to the movie is offered too.
- **Bandwidth.**
  - At home on Wi-Fi this is rarely an issue.
  - Away from home, the limit is the home internet's *upload* speed. A
    typical 1080p file at 5 to 10 Mbps streams fine on most connections; a
    4K remux at 40 to 80 Mbps usually won't. One hour of 1080p is about 2 to
    4.5 GB of mobile data, so the phone warns before playing a movie on
    cellular (it can be turned off).
- **Tailscale route.** Tailscale normally connects the phone and PC directly.
  If it can't, it relays traffic through its own servers, which is much
  slower and makes video stutter. Settings shows whether the connection is
  direct or relayed.
- **Later:** on-the-fly conversion on the PC with FFmpeg, for files the phone
  can't decode and for a "data saver" quality on cellular. If movies become
  a big use, an established media server such as Jellyfin (free, open
  source) already does conversion, resume and subtitles, and Control Center
  could link to it instead of rebuilding that.

### 5.10 Files on the PC (File System app)

On the phone, the File System app is a **read-only** file browser for the
whole PC. It's built on a new `remoteFilesService.js` and doesn't touch
`fileSystemService.js`, which keeps running the hand-tracking explorer and
recorder on the PC as a desktop-only feature.

**What it can see.** The phone can see any file the PC's Windows account can
read, because the server runs as that account. That's the same set the user
sees in Windows Explorer. Hidden and system files are left out unless the
phone asks for them.

**Endpoints.** All are read-only. The server has **no** upload, create,
rename, move or delete endpoint for files, so a compromised or buggy phone
still can't change anything.

| Endpoint | Purpose |
|---|---|
| `GET /api/files/roots` | Quick locations (Desktop, Documents, Downloads, Pictures, Music, Videos, resolved for the PC's user) and fixed drives, with free space |
| `GET /api/files/list?path=&hidden=0\|1` | Folder entries: name, folder or file, size, modified, hidden. Folders the account can't open come back marked `noAccess` instead of failing the whole listing. |
| `GET /api/files/info?path=` | Details: full path, size, type, created and modified dates |
| `GET /api/files/content?path=` | The file itself, with HTTP Range support. Used for previews, streaming and downloads; `?download=1` adds a download header. |

**Path checks.** Paths are absolute here, since the whole PC is in scope, but
they're still validated:
- local drive paths only: no network (UNC) paths, no `\\?\` or `\\.\` device
  prefixes
- no alternate data streams (`name:stream`)
- no reserved device names (`CON`, `NUL`, …)
- normalized before use

**Kill switch.** A desktop setting, "Phone file access" (on by default),
makes every `/api/files` route return `403` for phone tokens when switched
off.

**Hidden files.** Node can't read Windows' hidden and system attributes, so a
listing gets them from Windows in one hidden-window query per folder. Combined
with dot-prefixed names, this is the same rule as the desktop explorer's
`is_hidden_entry`. The cost per listing is measured at implementation.

**Risk, and how it's contained.** A paired phone can read anything on the PC,
including sensitive files such as browser profiles and SSH keys under hidden
folders. That's what was asked for, so the protection goes around it:
- the device token is in Keystore-backed storage
- File System requires the fingerprint or screen lock to open (design 3.6)
- the PC can remove the phone, or switch off file access, instantly
- every file download is written to the auth audit log (4.7)

## 6. Phone app project

```
mobile-app/                         Android Studio project (Gradle, Kotlin)
  app/src/main/
    AndroidManifest.xml
    java/com/alexmglesser/controlcenter/mobile/
      MainActivity.kt               single activity, hosts Compose navigation
      ui/theme/                     colors (design 1.1), chamfer shape (1.2), type
      ui/navigation/                tabs, app routes, back handling, transitions
      ui/screens/                   connect, home, chat, settings, one package per app
      data/api/                     HTTP client (OkHttp + Retrofit), DTOs, auth header, 401 handling
      data/events/                  SSE client, connection state machine (7.2)
      data/auth/                    Keystore-encrypted token storage
      service/ConnectionService.kt  foreground service: persistent stream + alerts (7)
      service/MediaService.kt       Media3 session service: background music
      notify/                       notification channels, reminder scheduling (7.3)
    res/drawable/                   Lucide icons as vector drawables
```

- **Language and UI:** Kotlin and Jetpack Compose with a Material 3 base and
  the custom theme from design section 1. State lives in ViewModels with
  `StateFlow`, and the structure stays deliberately small: no heavy
  frameworks beyond the standard Android ones.
- **Libraries**, all pinned at implementation:
  - OkHttp, with its SSE add-on, plus Retrofit and kotlinx.serialization, for
    the API and event stream
  - AndroidX Media3 (ExoPlayer, media session, OkHttp data source) for music
    and movies
  - CameraX with ML Kit barcode scanning (the bundled model, which works
    without Google Play services or internet) for the pairing QR code
  - DataStore, for settings and the encrypted token
  - AndroidX Biometric, for the File System lock (fingerprint or screen lock)
- **Theme and motion** (design sections 1.1 to 1.3):
  - **Colors** are a Compose color scheme using the desktop's token names and
    the phone's neon values.
  - **The chamfered tile** is a custom `Shape`. The glow is a colored shadow
    drawn behind it while pressed or active.
  - **The tile expanding into an app** is a Compose shared-element transition.
    Tabs use `AnimatedContent`, and pushes and sheets use the standard
    enter and exit transitions.
  - **Haptics:** a light tick on primary actions.
  - **Remove animations:** Compose follows Android's animation scale, so
    turning off animations removes the motion automatically.
- **Rotation:** the activity declares no fixed orientation. Screen state lives
  in ViewModels and `rememberSaveable`, so rotating keeps scroll position,
  typed text and playback (design section 4.3). Layouts switch on Android's
  window size classes: compact under 600 dp, medium 600 to 840 dp, and
  expanded from 840 dp. Full-screen movie playback requests landscape and
  restores the previous orientation on exit.
- **Android versions:** minimum Android 10 (API 29), targeting the current
  Android release. Final values are set at implementation.
- **Build and install:** build in Android Studio, then sideload the APK, over
  USB with `adb install` or by downloading it on the phone. Debug builds come
  first, then a signed release APK with the signing key kept outside the
  repo. The app checks the server's version (`GET /api/system`) and shows a
  clear message if they're incompatible.

## 7. Background connection and notifications

Android stops background apps from holding network connections unless they
run a **foreground service**. A foreground service must show a permanent
notification, which is also where the connection status appears.

### 7.1 Connection service
- `ConnectionService` is a foreground service that owns the one event stream
  connection for the whole app. The UI reads its state and events instead of
  opening its own stream, so screens stay live and nothing is duplicated.
- **It starts:**
  - when the app opens
  - after the phone reboots, if "Stay connected" is on
  - after an app update
- **It stops** when "Stay connected" is off and the app is closed, or when the
  user signs out.
- **Foreground service type.** Android 14 and later require a declared type.
  The plan is `specialUse`, described as "persistent connection to the
  user's own home server". That's acceptable for a sideloaded app; the
  alternative is `remoteMessaging`. This gets confirmed against the current
  Android release at implementation, including the rules for starting at
  boot.
- **Battery optimization.** On first run, the app asks to be excluded from it,
  so the connection survives Doze (the system idle mode). This is what keeps
  the stream alive with the phone asleep.
- **Battery cost:** the stream is idle except for a 25-second heartbeat and
  real events. Tailscale keeps its own tunnel up regardless.

### 7.2 Connection states and the "connection lost" alert
```
 Connected ──(no data for 45 s, or socket error)──► Reconnecting
    ▲                                                  │
    │                       retry with backoff:        │
    │                       1, 2, 5, 10, 30 s, then    │
    │                       every 60 s                 │
    └─────────────(stream re-opens)────────────────────┤
                                                       │
                     still failing after 60 s ─────────► Disconnected
                                                           • send one alert
                                                           • keep retrying
                                                             every 60 s
 Disconnected ──(stream re-opens)──► Connected
                                     • replace the alert with "Reconnected",
                                       which clears itself after 10 s
```
**Cause detection**, checked in order when entering Disconnected:
1. The phone has no internet: "Your phone is offline." This uses lower
   priority, because it's not a PC problem.
2. No VPN is active, so Tailscale is off: "Tailscale is off on your phone."
3. A `server-stopping` event arrived just before the drop: "Control Center
   was shut down on the PC."
4. The PC's Tailscale address can't be reached: "Can't reach alex-desktop. It
   may be asleep or off."
5. The PC is reachable but `/api/health` fails: "Control Center isn't running
   on the PC."

Only one alert is sent per outage. A brief blip that recovers within the
60-second grace period sends nothing.

### 7.3 Calendar reminders
- The phone schedules reminders **locally** with Android's exact alarms
  (`setExactAndAllowWhileIdle`), so they fire on time in Doze and when the PC
  can't be reached.
- **Rescheduling:** the phone reschedules all reminders for the next 14 days:
  - on every calendar `data-changed` event
  - when the service starts or reconnects
  - every 6 hours
  - after a reboot or a time-zone change
- **Duplicates and removals:** each reminder's ID comes from the event ID and
  the reminder type. Rescheduling replaces existing reminders and cancels
  those for deleted events.
- **Permission:** a calendar app may use `USE_EXACT_ALARM`, which Android
  grants automatically. If that ever changes, the fallback is asking for
  `SCHEDULE_EXACT_ALARM`.
- The PC doesn't send reminders itself, which avoids duplicate notifications.
- **Known limit:** an event changed on the PC while the phone is offline
  keeps its old reminder until the phone reconnects.

### 7.4 Jarvis reply notifications
When a `chat` event arrives for a turn this phone started, and the app isn't
on screen, the service fetches the reply and posts it as a notification.
Tapping it opens the chat.

### 7.5 Notification channels
| Channel | Importance | Content |
|---|---|---|
| Connection status | Low: silent, no pop-up | The permanent service notification: "Connected to alex-desktop", "Reconnecting…", "Disconnected" |
| Connection alerts | High | "Connection lost" plus cause, and "Reconnected" |
| Calendar | High: pops up | Event title, time, and "starts now" or "in 10 min" |
| Jarvis | Default | Reply text, shortened only by Android's own notification limits |

Android 13 and later need the notifications permission. The app asks right
after pairing, explaining why.

## 8. Implementation phases

Each phase ends in something testable, and phase 1 ships before anything is
reachable from outside the PC.

1. **Lock down the server.** Auth middleware, the desktop local-session
   cookie, `HOST=127.0.0.1`, the remote allowlist, desktop-only agent tools,
   the music file restriction, and auth on the `/voice` WebSocket.
   *Exit:* the full auth test matrix passes, and the desktop app works
   unchanged.
2. **Pairing and remote access.** Device store, pairing endpoints, the desktop
   Settings > Devices UI with QR code, Tailscale setup steps, `tailscale
   serve`, SSE heartbeat and `server-stopping`. *Exit:* a test script on
   another tailnet device pairs over cellular and reads `/api/apps`.
3. **Phone shell.** Android project, theme, Connect screen, app grid, Jarvis
   chat, Settings, the connection service, connection alerts, and reply
   notifications. *Exit:* the phone pairs, shows the grid, and chats with
   Jarvis, with history shared with the desktop. Turning the PC off gives
   exactly one alert, and turning it on gives "Reconnected".
4. **App views, part A.** Calendar with reminders, News, Wikipedia (proxy),
   Projects/Work (reader), File System (browse, preview, download, lock),
   the generic card, and `data-changed` events.
5. **App views, part B.** Music (Media3 background playback, both targets),
   Server Manager (storage migration), Drawing viewer, Movie (server library
   and streaming).

## 9. Testing

- **Auth matrix (automated, phase 1).** For every route: no credentials gets
  401, a remote token on a desktop-only route gets 403, a local session gets
  the normal result, and a revoked token gets 401. Also path-escape tests for
  `local-file`, the project file reader, movie streaming and the File System
  endpoints (`..`, symlinks and junctions, alternate data streams, device
  names, UNC and device-prefixed paths). Every write method on `/api/files`
  returns 404 or 405, and file access returns 403 while the kill switch is off.
- **Existing smoke test** extended to run with a local session, so it catches
  desktop regressions.
- **Agent:** turns from the phone can't run desktop-only tools, and
  `open_app` from the phone doesn't open PC windows.
- **Phone unit tests:** the connection state machine (blips under 60 s send
  nothing, one alert per outage, cause ordering) and reminder scheduling
  (IDs, cancellation, time zones).
- **Manual on the phone:**
  - pairing
  - Wi-Fi to cellular handoff
  - the PC asleep; Control Center stopped
  - removing the device while the app is open
  - each app screen; TalkBack labels on the grid
  - rotating each screen with something typed, scrolled or playing, and
    checking nothing resets; rotation lock on
  - forcing Doze (`adb shell dumpsys deviceidle force-idle`) and checking that
    the connection alert and a calendar reminder still arrive
  - rebooting the phone and checking reminders are still scheduled
  - music with the screen off; a movie over cellular

## 10. Risks and open points

- **Background limits on some phones.** Some manufacturers, notably Samsung
  and Xiaomi, kill background services more aggressively than Pixel phones.
  The battery-optimization exemption usually fixes it; the settings screen
  links to the right page if it doesn't.
- **Tailscale HTTPS** requires HTTPS certificates to be enabled for the tailnet.
  If the user prefers not to, the fallback is plain HTTP inside the tailnet
  (still encrypted by WireGuard) with an Android cleartext exception for that
  one host.
- **Desktop app regressions** from adding auth everywhere. This is mitigated by
  the cookie approach (no page changes) and the extended smoke test.
- **Long-running agent turns** hold the queue (sequential worker), and a slow
  Wikipedia search or long Jarvis turn makes phone chats wait. The UI shows
  the queue position. Changing the queue itself is out of scope.
- **Mobile Mode toggle.** The existing desktop/mobile mode switch was meant for
  a future audio-only phone client. It stays as is for now, and is revisited
  when voice comes to the phone.
