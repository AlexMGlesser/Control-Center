# Control Center Mobile: Product Requirements

**Status:** Draft for review, 2026-10-21
**Companion docs:** `mobile-app-design.md` (screens and UX), `mobile-app-architecture.md` (server, networking, security, build)

## 1. What it is

A native Android app, installed on the phone and meant to be kept open, that
connects to Control Center running on the home PC. It lets the user use their
Control Center apps and Jarvis (text only) from anywhere.
The home PC stays the single source of truth: the phone shows and edits the
same calendar, projects, music library, chat history and so on, and keeps no
separate copy of that data.

Laptop access comes later, as a separate step (architecture section 3).

## 2. Decisions already made

| Decision | Choice | Why |
|---|---|---|
| Platform | Android | User's phone. iPhone is out of scope. |
| App type | Fully native Android app (Kotlin + Jetpack Compose), not a web app | An app that lives on the phone and stays open. Native code gives a reliable background connection and notifications, background music with lock-screen controls, and a real video player that handles far more movie formats. |
| Remote access | Private VPN (Tailscale) | Works on Wi-Fi and cellular, away from home, without opening any port on the router. |
| Agent interface | Text chat only (v1) | Voice comes later. |
| Laptops | Later, not in v1 | Proposed route: a "connect to my home PC" mode in the existing desktop app (architecture section 3). |
| Look | The desktop's style with a cyberpunk color scheme, chamfered app icons, and quick clean transitions | Keeps the product consistent while giving the phone its own identity (design section 1). |

## 3. Goals for v1

1. Open the phone app and see an icon for every Control Center app, matching
   the desktop app list. New apps added to Control Center appear on the phone
   automatically.
2. Tap an icon to open that app's phone view, working on the home PC's data.
3. Chat with Jarvis by text, in the same conversation history as the desktop.
4. Connect securely from anywhere: only devices the user has paired can use
   Control Center, and pairing is a deliberate step on the PC.
5. Make sure nothing about remote access makes the home PC easier to attack.
   The security work in the architecture doc (section 4) ships before any
   phone feature.

## 4. Non-goals for v1

- Voice (wake word, speech-to-text, spoken replies). Text only.
- iPhone or a Play Store listing. The app is sideloaded as an APK.
- Offline editing. Without a connection the app shows a clear disconnected
  state and, where cached, read-only last-known data.
- Hand tracking and the gesture recorder on the phone. They stay on the PC;
  the phone's File System app works with files only.
- A full drawing editor on the phone.
- Notifications beyond calendar reminders, connection alerts and Jarvis
  replies (for example PC alarms) come later.

## 5. Users and situations

There's one user: the owner, on their own devices.
- **On the couch, same house:** check the calendar, start music on the PC,
  ask Jarvis something.
- **Away from home on cellular:** add a calendar event, look something up in
  the offline Wikipedia, browse a project's files, check the news briefing.
- **Lying in bed or out with the screen off:** music keeps playing from the
  PC's library, and a notification says when a calendar event starts.

## 6. App-by-app scope

"Phone view" means a screen built for the phone. "On the PC" means the action
happens on the home PC, with the phone acting as a remote.

| App | v1 on the phone | Later |
|---|---|---|
| Calendar | Phone view: agenda and month, add and delete events; reminder notifications | Edit events |
| News | Phone view: the briefing (weather, headlines, tech, daily STEM) | Background refresh |
| Wikipedia | Phone view: search and read articles from the offline archive | The archive's own Agent chat page |
| Projects (personal and work in one app) | Phone view: browse project folders, edit and save text files, create files and folders | Add or remove projects; rename, move and delete files; "open on PC" |
| Music | Phone view: browse library and playlists; play on the PC (remote control) or on the phone (stream from the PC) | Downloads for offline listening |
| Server Manager | Phone view: server list, open an SSH session in an Android SSH app | Status checks, power actions |
| File System | Phone view: browse every file on the PC that you'd see in Windows Explorer. View and download only; no changes or deletes. No hand tracking. | Search across the PC |
| Drawing | List of saved drawings with previews (view only) | Simple 2D editing |
| Movie | Needs a server-side movie library first (see architecture 5.6); then browse and stream to the phone. Whether a given file plays depends on its formats (architecture 5.9). | Converting files on the PC for formats the phone can't play; resume position across devices |
| Jarvis (chat) | A dedicated tab, shared history with the desktop | Voice |

## 7. Requirements

### 7.1 Connection and pairing
- R1. First launch shows a "Connect to Control Center" screen with a **Scan
  QR code** button. The QR code is shown on the PC under Settings > Devices >
  Pair a device.
- R2. A pairing code works once and expires after 5 minutes.
- R3. After pairing, the app stays signed in until the device is removed on
  the PC, or the user signs out on the phone.
- R4. The PC lists paired devices (name, last seen) and can remove any of them
  instantly.
- R5. The app shows connection state at all times: connected, reconnecting, or
  offline. The reason is shown when known: Tailscale off, PC asleep, or
  Control Center not running.

### 7.2 Home screen
- R6. A grid of app icons generated from the PC's app registry, in the same
  order as the desktop.
- R7. Each icon shows the app name and, where it applies, a small status dot
  (for example music playing on the PC).
- R8. Apps without a phone view yet still appear, and open a card explaining
  what the app does, with any available "on the PC" actions.

### 7.3 Jarvis chat
- R9. Send text and see the reply in the shared conversation. Messages sent from
  the desktop appear on the phone and vice versa.
- R10. While Jarvis works, the chat shows a "thinking" state and the tools it
  calls (for example "Calling list_calendar_events").
- R11. Commands act on the device you sent them from where that makes sense.
  "Open the calendar" sent from the phone opens Calendar on the phone, not on
  the PC. Commands that only make sense on the PC (play music on the PC
  speakers) act on the PC, and the reply says so.

### 7.4 Data and sync
- R12. All reads and writes go to the PC. A change made on one device shows up
  on any other open device within a couple of seconds, without a manual
  refresh.
- R13. Data that currently lives only inside the desktop app's browser
  storage moves to the PC's data folder so the phone can see it: Server
  Manager servers and Music saved playlists.

### 7.5 Security
- R14. No Control Center API is reachable without a valid device token, from
  any network, including the home Wi-Fi. This includes the desktop's own UI.
- R15. Desktop-only actions cannot be triggered remotely. That covers opening
  file pickers on the PC, launching PowerShell or an IDE on the PC, and
  shutting Control Center down.
- R16. Music, Projects and Movie read files only inside their own
  configured folders. The File System app can read any file the PC's Windows
  account can read, but can never change or delete anything (section 7.8).

### 7.6 Layout
- R17. Every screen works in portrait and landscape, following the phone's
  auto-rotate setting and rotation lock. Rotating never loses what's on
  screen (design section 4).

### 7.7 Notifications and background connection
- R18. **Calendar reminders.** The phone notifies the user when a calendar
  event starts, plus an optional earlier reminder (off, 5, 10, 15 or 30
  minutes before). Reminders fire even if the phone can't reach the PC at
  that moment, as long as the event was synced before.
- R19. **Persistent connection.** While the user has "Stay connected" on, the
  phone keeps its connection to the PC open in the background, including with
  the app closed and the screen off. Android requires a permanent status
  notification for this, and it shows the connection state.
- R20. **Connection lost alert.** If the connection to the PC breaks and doesn't
  recover within 1 minute, the phone sends an alert saying what's wrong where
  it can tell: the phone has no internet, Tailscale is off, the PC can't be
  reached, or Control Center was shut down on the PC. It sends one alert per
  outage, not one per retry, and a "Reconnected" notice when it comes back.
- R21. **Jarvis replies.** If the user sends Jarvis a message from the phone and
  leaves the app before the reply arrives, the reply arrives as a
  notification. This can be turned off.
- R22. **Control.** Each kind of notification can be switched on or off in the
  phone app's Settings, and each has its own Android notification category,
  so the user can also tune sound and vibration in Android's settings.

### 7.8 File System (files on the PC)
- R23. The phone can browse everything the user would see on the PC: the
  quick locations (Desktop, Documents, Downloads, Pictures, Music, Videos) and
  every drive.
- R24. The phone can preview common file types (text and code, images, PDF,
  audio, video), download any file to the phone, and share it to other apps.
- R25. **View and download only.** The phone can't upload, create, rename,
  move or delete anything on the PC. The server has no endpoints that could,
  so this doesn't depend on the app behaving.
- R26. Hidden and system files are hidden by default, with the same rule as
  the desktop File System app, and can be shown with a toggle.
- R27. Because File System exposes the whole PC, opening it on the phone
  requires the fingerprint or screen lock (on by default, can be turned off).
  The PC has a "Phone file access" switch that blocks all file browsing from
  the phone at once.

## 8. Success criteria

- From cellular with Tailscale on, the phone opens Calendar and shows today's
  events in under 3 seconds on a normal connection.
- An event added on the phone appears on the open desktop Calendar within 2 seconds.
- A device that hasn't been paired, or has been removed, gets "unauthorized"
  from every endpoint, including from the home Wi-Fi.
- The desktop app works exactly as before for the user sitting at the PC.
- A calendar reminder appears within 1 minute of its scheduled time, with the
  app closed and the phone locked, including when the phone has no signal.
- Turning the PC off produces exactly one "connection lost" alert within
  about 1.5 minutes, and turning it back on produces "Reconnected" within
  about 1 minute.

## 9. Open questions for review

1. **Who else is on your Tailscale network?** If only your own devices, the
   tailnet plus pairing tokens is plenty. If you share it with anyone, pairing
   tokens matter even more and we should note that.
2. **"Open X" from the phone:** should it open the app on the phone
   (proposed), or on the PC?
3. **Music from the phone:** should it default to playing on the PC speakers
   (remote control) or on the phone?
4. **What should the phone be allowed to change?** Proposed for v1: calendar
   add and delete, music playlists, and Jarvis commands (which already only
   go through Jarvis's tools). Decided: the phone can also edit and create
   project files; rename, move and delete stay on the PC, and so does
   shutting down the PC.
5. **One shared Jarvis conversation for all devices** (proposed), or a
   separate thread per device?
6. **App name and icon on the phone:** "Control Center" with the same icon
   as the desktop build (proposed)?
7. **Calendar reminder default:** notify at the event's start only (proposed),
   or also some minutes before? It can be changed in Settings either way.
8. **Stay connected default:** on (proposed). It costs a little battery and
   shows a permanent, silent status notification.
9. **File System lock:** require fingerprint or screen lock to open File
   System (proposed), given it can read every file on the PC? And is there
   anywhere it should never show, even with "Show hidden" on?
