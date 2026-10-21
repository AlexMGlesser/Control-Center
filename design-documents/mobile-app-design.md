# Control Center Mobile: Screens and UX

**Status:** Draft for review, 2026-10-21
**Companion docs:** `mobile-app-prd.md` (scope), `mobile-app-architecture.md` (how it works)

## 1. Look and feel

The phone keeps the desktop's style (`control-app/docs/style-guide.md`):
dark-first, calm, low-glare panels, the same typography, spacing and rounded
cards. Two things change to give it a cyberpunk look: **the color scheme** and
**the shape of the app icons**. Taps and screen changes get clean, quick
transitions (section 1.3).

### 1.1 Color scheme: cyberpunk

Same token names as the desktop, so the two themes stay easy to compare, with
neon values on a deeper, blue-violet black:

| Token | Desktop value | Phone value | Use on the phone |
|---|---|---|---|
| `--bg-primary` | `#081114` | `#07070d` | Screen background |
| `--bg-panel` | `#11242b` | `#10111f` | Cards, icon tiles |
| `--bg-panel-soft` | `#142f38` | `#181a30` | Pressed tiles, input fields |
| `--line` | cyan, 20% | `rgba(0, 240, 255, 0.22)` | Card and tile borders |
| `--text-primary` | `#e6f7fb` | `#e8f1ff` | Main text |
| `--text-secondary` | `#9eb7be` | `#8e96bd` | Secondary text |
| `--accent-cyan` | `#3ac2d4` | `#00f0ff` (neon cyan) | Primary: active tab, primary buttons, links, focus |
| `--accent-magenta` | (none) | `#ff2bd6` (neon magenta) | Second accent: Jarvis's chat bubbles, now playing, selection |
| `--ok` | `#38b58f` | `#39ff9c` (neon green) | Online, running |
| `--warn` | `#b69845` | `#f5e642` (acid yellow) | Reconnecting, caution |
| `--accent-red` | `#9f2d37` | `#ff3355` (neon red) | Offline, errors, destructive buttons |

Neon is used for accents only:
- **Glow** (a soft outer shadow in the element's accent color) appears only on
  active, focused or pressed controls, and on running-status dots. Text never
  glows, and nothing glows when idle.
- **Contrast:** all text meets 4.5:1 on its background. Neon colors are used
  for text only at 16 sp and up, or bold.
- **Backgrounds** stay flat and dark: no scanlines, grids or animated effects.

### 1.2 Icon shape

App tiles and icon buttons use a **chamfered** shape instead of plain rounded
squares: two opposite corners cut at 45° (top-left and bottom-right, 10 dp
cuts on tiles, 6 dp on buttons), with the other two corners slightly rounded.

```
   ╱‾‾‾‾‾‾‾‾‾╮        tile at rest:   --bg-panel fill, 1 dp --line border,
  │    ▦      │                       icon in --accent-cyan
  │ Calendar  │        tile pressed:  border full --accent-cyan, cyan glow
  ╰_________╱         app running:    small --ok dot with a soft green glow
```

- Icons are Lucide line icons (section 3.2) drawn in neon cyan at a 1.75 dp
  stroke, so they read as neon tubes on the dark tile.
- The same chamfer marks other interactive shapes: primary buttons, the
  connection pill and the active-tab indicator. Plain cards and panels keep
  the desktop's rounded corners, so the cut shape always means "tappable".

### 1.3 Transitions

Every tap gets immediate feedback, and every screen change moves in a clear
direction.
- **Fast:** 80 to 260 ms.
- **Interruptible:** tapping again mid-animation never waits for it to finish.
- **Smooth:** only position, scale and opacity are animated, so it stays at
  60 fps on a mid-range phone.

| Action | Transition |
|---|---|
| Press any button or tile | On touch: scale to 97%, the border brightens to full accent, and the glow fades in (80 ms). On release: back to rest (120 ms). Primary actions add a light haptic tick. |
| Open an app from the grid | The tile expands into the app screen: it grows from the tile's position to full screen (260 ms, fast start then a gentle settle), and the app's content fades in over the last 120 ms. |
| Back from an app | The reverse: the screen shrinks back into its tile (220 ms). |
| Switch bottom tab | Content cross-fades with a short slide toward the new tab (180 ms). The neon tab indicator slides across (200 ms). |
| Go deeper inside an app (folder to subfolder, list to detail) | The new view slides in from the right with a fade (220 ms). Back slides it out to the right. |
| Sheets and dialogs | Slide up and fade in (240 ms), with the background dimming to 60%. Close in 180 ms. |
| Send a chat message | The bubble rises from the input box (160 ms). Jarvis's reply fades and slides up (180 ms). |
| Loading | A thin neon cyan line sweeps along the bottom edge of the top bar instead of a spinner. Lists show placeholder blocks with a slow shimmer. |
| Connection state changes | The pill changes color and pulses once. It never blinks continuously. |
| Undo bar, toasts | Slide up from the bottom (200 ms). |
| Rotate the phone | No animation: the layout simply reflows (section 4.3). |

If Android's **Remove animations** setting is on, every movement becomes a
plain 100 ms fade, and the press feedback keeps only the color change.

Phone-specific rules:
- **Touch targets** are at least 48 × 48 dp, as Android recommends.
- **Type:** 16 sp body text and 13 sp secondary text. Nothing smaller than 12 sp.
- **Navigation:** one-handed in portrait. Primary navigation sits at the
  bottom in portrait and moves to a rail on the left edge in landscape
  (section 4). There are no important controls in the top corners.
- **Rotation:** every screen works in portrait and landscape (section 4).
- **Back:** the Android back gesture always goes back one level. From the
  Apps home screen it leaves the app.
- **Light mode:** none for v1, matching the desktop.

## 2. App structure

```
Launch
  ├─ Not paired ─────────────► Connect screen (scan QR) ──► Home
  └─ Paired ─────────────────► Home
                                 │
        Bottom tabs: [ Apps ]  [ Jarvis ]  [ Settings ]
                         │          │           │
                    App grid     Chat       Connection, device, about
                         │
                    App screen (one per app, opened from the grid)
```

The bottom tab bar is visible on the three main tabs. Inside an app it hides
to give the app full height, and a back arrow and the app name sit in the
top bar.

## 3. Screens

### 3.1 Connect (first launch)

```
┌──────────────────────────────┐
│                              │
│        [Control Center       │
│             logo]            │
│                              │
│   Connect to your home PC    │
│                              │
│  On the PC, open Control     │
│  Center > Settings > Devices │
│  > Pair a device, then scan  │
│  the code it shows.          │
│                              │
│  ┌────────────────────────┐  │
│  │     Scan QR code       │  │  primary button
│  └────────────────────────┘  │
│     Enter code manually      │  text link: server address + 8-char code
│                              │
│  Tailscale must be on.       │  shown only if the address can't be reached
└──────────────────────────────┘
```

After scanning, the screen shows "Connecting…", then "Paired as *Pixel 8*"
(the device name is editable), then goes to Home.

### 3.2 Home: app grid

```
┌──────────────────────────────┐
│ Control Center      ● Online │  status pill: green Online / amber
│                              │  Reconnecting / red Offline
│  ┌──────┐ ┌──────┐ ┌──────┐  │
│  │  ▦   │ │  ▤   │ │  ✉   │  │
│  │Calen-│ │ News │ │ Work │  │
│  │ dar  │ │      │ │      │  │
│  └──────┘ └──────┘ └──────┘  │
│  ┌──────┐ ┌──────┐ ┌──────┐  │
│  │  ⌂   │ │  ♪   │ │  ✎   │  │
│  │Proj- │ │Music │ │Draw- │  │
│  │ ects │ │      │ │ ing  │  │
│  └──────┘ └──────┘ └──────┘  │
│  ┌──────┐ ┌──────┐ ┌──────┐  │
│  │  ▶   │ │  ☰   │ │  W   │  │
│  │Movies│ │Serv- │ │Wiki- │  │
│  │      │ │ ers  │ │pedia │  │
│  └──────┘ └──────┘ └──────┘  │
│  ┌──────┐                    │
│  │  ⊞   │                    │
│  │ File │                    │
│  │System│                    │
│  └──────┘                    │
│                              │
├──────────────────────────────┤
│  [■ Apps]  [ Jarvis ] [ ⚙ ]  │
└──────────────────────────────┘
```

- The grid has 3 columns of square, chamfered tiles (section 1.2). The icon is 28 dp, with the name below it. Long names
  wrap to two lines rather than being cut off.
- Order and names come from the PC's app registry, the same list the desktop
  shows. If the PC isn't reachable, the last-known grid is shown dimmed
  with the Offline pill.
- Pull down to refresh.
- Apps with no phone view yet show a small "PC" badge. They still open (see 3.6).

**Icons.** The desktop app has no app icons today, so this design adds one per
app. They come from Lucide (an open-source line-icon set, ISC license),
bundled inside the app with no downloads, drawn in neon cyan on the
chamfered tiles described in section 1.2. The PC's app registry gets a new `icon` field holding
the icon name, so the desktop can show the same icons later and new apps
choose their own.

| App | Lucide icon | | App | Lucide icon |
|---|---|---|---|---|
| Calendar | `calendar-days` | | Drawing | `pen-tool` |
| News | `newspaper` | | Movies | `clapperboard` |
| Work | `briefcase` | | Server Manager | `server` |
| Projects | `folder-git-2` | | Wikipedia | `book-open-text` |
| Music | `music` | | File System | `folder-tree` |
| Jarvis tab | `message-circle` | | Unknown/new app | `app-window` |

### 3.3 Jarvis (chat)

```
┌──────────────────────────────┐
│ Jarvis              ● Online │
├──────────────────────────────┤
│        ┌───────────────────┐ │
│        │ What's on my      │ │  yours: right, cyan border
│        │ calendar today?   │ │
│        └───────────────────┘ │
│  ┌───────────────────────┐   │
│  │ You have CS class at  │   │  Jarvis: left, magenta border
│  │ 3:45 PM and Dentist   │   │
│  │ at 6 PM.              │   │
│  └───────────────────────┘   │
│  · used list_calendar_events │  tool line, small secondary text
│                              │
│  ┌───────────────────────┐   │
│  │ ● ● ●  thinking       │   │  while a turn is running
│  └───────────────────────┘   │
├──────────────────────────────┤
│ ┌──────────────────────┐ ┌─┐ │
│ │ Message Jarvis…      │ │➤│ │  send is disabled while the box is empty
│ └──────────────────────┘ └─┘ │
│  [ Apps ] [■ Jarvis] [ ⚙ ]   │
└──────────────────────────────┘
```

- **One shared conversation.** It's the same history the desktop chatbot
  tab shows. Messages typed on the desktop appear here live.
- **Device label.** Each user message carries a small "from Phone", "from PC"
  label in secondary text, so mixed history stays readable.
- **Tool lines.** Calls are collapsed into one line by default. Tapping the
  line expands the list. Jarvis's replies are never edited or shortened.
- **Waiting.** If the agent is busy with another request, the bubble reads
  "Queued (1 ahead)" until its turn starts.
- **Jumping to an app.** When Jarvis opens an app for this device ("open the
  calendar"), the phone switches to that app. A small "Opened Calendar"
  chip in the chat lets you come back.
- **Keyboard.** The input grows to 4 lines, then scrolls. Enter adds a new
  line; the send button sends.

### 3.4 Settings

```
┌──────────────────────────────┐
│ Settings                     │
├──────────────────────────────┤
│ CONNECTION                   │
│  Home PC     alex-desktop    │
│  Address     https://alex-…  │
│  Status      Online · 42 ms  │
│ THIS DEVICE                  │
│  Name        Pixel 8      ›  │
│  Paired      Oct 21, 2026    │
│  Route       Direct          │  "Relayed" in amber if Tailscale can't
│                              │  connect directly (slow for video)
│  Stay connected        [ON]  │  background connection (section 8)
│ NOTIFICATIONS                │
│  Calendar reminders    [ON]  │
│  Remind me   At start     ›  │  at start / 5 / 10 / 15 / 30 min before
│  Connection alerts     [ON]  │
│  Jarvis replies        [ON]  │
│  Battery optimization  Off ✓ │  amber "On, may drop connection ›" otherwise
│ SECURITY                     │
│  Lock File System      [ON]  │  fingerprint or screen lock to open it
│ MUSIC & MOVIES               │
│  Play music on ( PC | Phone )│  default play target (PRD open question 3)
│  Warn before movies on       │
│  mobile data           [ON]  │
│ ABOUT                        │
│  App 0.1.0 · Server 1.0.0    │
│                              │
│  [ Sign out of this device ] │  red outline; clears the token on the phone
└──────────────────────────────┘
```

### 3.5 PC side: Settings > Devices (desktop app)

A new section in the desktop Settings tab:

```
Devices
  Paired devices
    Pixel 8        last seen 2 min ago    [Remove]
    Old phone      last seen yesterday    [Remove]
  [ Pair a device ]  → shows a QR code + the 8-char code, counts down 5:00,
                       closes itself when a device pairs

  Phone file access                                         [ON]
    The phone's File System app can view and download any file
    on this PC. It can't change or delete anything.
```

Switching "Phone file access" off blocks all file browsing from the phone at
once, without unpairing it.

### 3.6 App screens

Every app screen has the same top bar: a back arrow, the app name, and a
"⋮" menu for that app's extra actions. The layouts below describe portrait;
section 4 covers what each screen does in landscape.

**Calendar**
- Defaults to an agenda list: Today, Tomorrow, then the next 14 days. Each
  event shows time, title and length.
- A Month toggle at the top switches to a month grid with event dots. Tapping
  a day filters the agenda to that day.
- A `+` floating button opens the "New event" sheet: title, date, start time,
  optional end time. Swipe an event left to delete it, with Undo for 5 seconds.

**News**
- Cards top to bottom: weather (current plus today's high and low),
  headlines, tech, and the daily STEM item.
- Tapping a headline opens it in the phone's browser.
- A "Refreshed 10:42" note and pull to refresh.

**Wikipedia**
- A search box at the top, with results as title plus a 2-line snippet.
- Tapping a result opens the article: readable text and a contents menu
  that jumps to a section. The archive's API returns plain text, so links
  inside articles aren't tappable in v1; a "Search related" button on the
  article searches its title instead.
- Searches can be slow while the PC's hard drive warms up, so a "Searching
  the archive… (this can take up to a minute)" note appears after 3 seconds.

**Projects / Work** (the same screen, two different project lists)
- A project list leads to a folder tree. Tap a folder to go into it; a path
  breadcrumb sits at the top.
- Tapping a text or code file opens a read-only viewer with monospace text,
  line numbers and horizontal scroll. Binary or very large files show
  "Can't preview on the phone" with size and type.

**Music**
- Tabs: Playlists, Tracks.
- A mini-player bar sits above the bottom tabs with track, play/pause, next
  and a target chip: "♪ on PC" or "♪ on Phone". Tap the chip to switch.
- "On PC" sends commands to the PC's player, the same path as Jarvis's
  `control_music`. "On Phone" streams the file from the PC and plays it on
  the phone. It keeps playing with the screen off, with controls on the lock
  screen and in the notification shade.
- Tracks in formats the phone can't play are greyed out, with a note why.

**Server Manager**
- A list of your servers: name, user@host, tags.
- Tapping a server shows details plus **Open SSH**, which hands
  `ssh://user@host:port` to an installed Android SSH app such as Termux or
  JuiceSSH. If none is installed, it shows a prompt to install one.

**File System** (files on the PC)

On the phone this is a **view-and-download** file browser for the whole PC:
any file you'd see in Windows Explorer on the PC. It can't change anything:
there's no upload, rename, move or delete. Hand tracking and the gesture
recorder stay on the PC.

```
┌──────────────────────────────┐
│ ←  File System          ⋮    │  ⋮ = show hidden, sort
│ D: › Documents › CS 301      │  breadcrumb; tap any part to jump back
├──────────────────────────────┤
│ Filter this folder…          │
│ ▸ Assignments         Oct 19 │  folders first
│ ▸ Lectures            Oct 14 │
│ ◇ syllabus.pdf  212 KB Sep 2 │  files: type icon, size, date
│ ◇ notes.md        4 KB Oct 20│
│ ◇ demo.mp4       84 MB Oct 8 │
└──────────────────────────────┘
```

- **Top level:** Quick locations (Desktop, Documents, Downloads, Pictures,
  Music, Videos) followed by the PC's drives (C:, D:, …), each with free
  space shown.
- **Locked first.** Opening File System asks for your fingerprint or screen
  lock, since it shows everything on the PC. This can be turned off in
  Settings.
- **Tap a folder** to go in. The breadcrumb shows the path, and back goes up
  one level.
- **Tap a file** to preview it:
  - Text and code: a read-only viewer, the same one Projects uses.
  - Images: pinch to zoom.
  - PDFs: Android's built-in PDF rendering.
  - Audio and video: stream and play with the player Music and Movies use.
  - Anything else: name, size, type and dates, with **Download**.
- **Long-press a file** (or use the buttons in a preview) for:
  - **Download** to the phone's Downloads folder, with a progress
    notification for big files
  - **Share** to another app (it downloads first)
  - **Details:** full path, size, type, created and modified dates
- **Folders the PC itself can't open**, like other users' folders, show a
  lock icon and "No access".
- **Hidden files** stay hidden, matching the desktop File System app's rule,
  until you turn on "Show hidden" in the ⋮ menu.

**Drawing**
- A grid of saved drawings with name, date and thumbnail. Tapping one opens
  a pinch-to-zoom view-only preview. 3D scenes show their thumbnail only.

**Movie**
- Until the PC has a saved movie library (architecture 5.6), it shows: "Pick
  a movie folder in the desktop Movie app to make it available here."
- After that: a poster grid. Tapping a poster opens full-screen playback
  streamed from the PC, with the usual seek and pause controls, plus audio
  and subtitle track choice.
- **Before playing:**
  - On mobile data, the app asks first: "Stream on mobile data? About 3 GB
    for this movie." It also offers "Don't ask again".
  - If the file's video or audio format won't play on this phone, its poster
    shows a small warning badge. Tapping it explains why, for example
    "Audio is DTS, which this phone can't play".
  - If Tailscale is relayed rather than direct, a note warns that playback
    may stutter.

**Generic "PC only" card** (any app without a phone view, including new ones)
- The icon, the name and the registry description.
- The app's available on-PC actions, if any.
- The note "Open this app on the PC to use it."

## 4. Rotation

The whole app rotates. It follows Android's auto-rotate setting and respects
the rotation lock in quick settings. The app never forces an orientation,
with one exception: full-screen movie playback switches to landscape for a
widescreen video and returns to the previous orientation when you exit.

### 4.1 Layouts by available width

Layouts depend on the width available, using Android's standard window size
classes. A phone in landscape, a foldable and a tablet all get a sensible
layout from the same rules:

| Width | Typically | Navigation | Layout |
|---|---|---|---|
| Compact, under 600 dp | Phone in portrait | Bottom tab bar | Single column, as in section 3 |
| Medium, 600 to 840 dp | Phone in landscape, unfolded foldable | Left navigation rail: icons with short labels | Two panes where an app has a list and a detail view |
| Expanded, 840 dp and up | Tablet | Left sidebar with full labels | Two panes, plus chat as an optional right-hand panel |

Landscape phones are short (about 360 to 420 dp tall), so medium layouts save
height. The top bar shrinks to 48 dp, and the rail replaces the bottom tabs.

```
Phone in landscape: app grid
┌────┬───────────────────────────────────────────────────┐
│ ▦  │ Control Center                          ● Online  │
│Apps│ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐   │
│    │ │  ▦  │ │  ▤  │ │  ✉  │ │  ⌂  │ │  ♪  │ │  ✎  │   │
│ ✉  │ │Cal. │ │News │ │Work │ │Proj.│ │Music│ │Draw.│   │
│Jar-│ └─────┘ └─────┘ └─────┘ └─────┘ └─────┘ └─────┘   │
│vis │ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐                   │
│    │ │  ▶  │ │  ☰  │ │  W  │ │  ⊞  │                   │
│ ⚙  │ │Movie│ │Serv.│ │Wiki │ │File │                   │
└────┴───────────────────────────────────────────────────┘
 rail                  grid: 6 columns, scrolls vertically
```

### 4.2 Each screen in landscape

| Screen | Landscape layout |
|---|---|
| Connect, Settings | A centered single column, at most 560 dp wide |
| Home grid | 5 or 6 columns |
| Jarvis chat | Messages in a centered column, at most 640 dp wide, so lines stay readable. The input stays at the bottom. With the keyboard open, the list shrinks and stays scrolled to the newest message. |
| Calendar | Month grid on the left, the selected day's agenda on the right |
| News | Cards in two columns |
| Wikipedia | Section list on the left, article on the right |
| Projects / Work | Folder tree on the left, file viewer on the right. Code is easier to read wide. |
| Music | Playlist or track list on the left, now-playing panel on the right |
| Server Manager | Server list on the left, details and Open SSH on the right |
| File System | Folder list on the left, file preview on the right |
| Drawing | Preview fills the screen |
| Movie | Poster grid with 4 or 5 columns. Playback full screen. |
| Generic card | Icon on the left, description and actions on the right |

### 4.3 Nothing is lost when you rotate

Rotating keeps everything as it was, without reloading or fetching data again:
- scroll position
- text typed in the chat box
- an open sheet or dialog
- the current folder or article
- a playing song or video

Turning the phone sideways to read a file and back again is instant.

## 5. Connection states

| State | What the user sees |
|---|---|
| Online | A green pill. Everything works. |
| Reconnecting | An amber pill and a thin amber bar under the top bar. Screens keep their last data. Buttons that need the PC are disabled with "Reconnecting…". |
| Offline | A red pill and a banner with the likely cause and a fix: "Can't reach alex-desktop. Is Tailscale on?" / "PC is unreachable (asleep or off)." / "Control Center isn't running on the PC." A Retry button. |
| Unauthorized | A full-screen "This device was removed from Control Center" and a button back to the Connect screen. |

The app retries automatically with backoff (1, 2, 5, 10, then 30 seconds) and
immediately when the phone regains network.

## 6. Laptops (later)

Laptops aren't part of v1. The proposed route is a "connect to my home PC"
mode in the existing desktop app, so a laptop gets the full desktop Control
Center experience running against the home PC's data (architecture section 3).

## 7. Accessibility

- Every icon tile and icon button has a text label for TalkBack.
- Contrast: `--text-secondary` on `--bg-panel` meets 4.5:1. Status is never
  shown by color alone; each pill has a word.
- Text scales with Android's font size setting up to 130% without clipping.

## 8. Notifications

The app keeps a connection to the PC open in the background (architecture
section 7), so it can notify you with the app closed and the phone locked.
All notifications use the app's icon, with neon cyan as the accent color.

### 8.1 What each one looks like

```
Permanent status (silent, stays in the shade while "Stay connected" is on)
┌─────────────────────────────────────────────┐
│ ◆ Control Center                            │
│ ● Connected to alex-desktop                 │  "Reconnecting…" / "Disconnected"
└─────────────────────────────────────────────┘

Connection lost (pops up once per outage)
┌─────────────────────────────────────────────┐
│ ◆ Control Center · now                      │
│ Lost connection to alex-desktop             │
│ Can't reach the PC. It may be asleep or off.│  cause line (architecture 7.2)
│                          [ Retry ] [ Open ] │
└─────────────────────────────────────────────┘
   … replaced by "Reconnected to alex-desktop" when it comes back,
     which clears itself after 10 seconds

Calendar (pops up, sound and vibration)
┌─────────────────────────────────────────────┐
│ ◆ Calendar · 3:45 PM                        │
│ CS class                     starts now     │  or "in 10 min" for an early reminder
│ 3:45 – 5:00 PM                              │
│                     [ Snooze 5 min ] [ Open]│
└─────────────────────────────────────────────┘

Jarvis reply (when you left the app before the answer came)
┌─────────────────────────────────────────────┐
│ ◆ Jarvis · now                              │
│ You have CS class at 3:45 PM and Dentist at │
│ 6 PM.                                       │
│                                  [ Reply ]  │  reply inline from the shade
└─────────────────────────────────────────────┘
```

- **Tapping a notification** opens the matching screen: Calendar on that
  event, the Jarvis chat, or Settings > Connection for connection alerts.
- **Reply inline:** a Jarvis reply notification has a text box in the
  notification shade, so you can answer without opening the app.
- **Grouping:** several calendar reminders at once are grouped into one
  stack.

### 8.2 First run after pairing

Two short, skippable explanation screens follow pairing, in the same
chamfered-card style. Each one leads to Android's own prompt:

1. **"Get notified"** explains that it's for calendar events, connection
   problems and Jarvis replies, then shows Android's notification permission
   prompt.
2. **"Stay connected in the background"** explains that the connection to
   your PC stays open, with a silent status notification, then opens
   Android's battery-optimization prompt.

Skipping either is fine. Settings > Notifications shows what's off and how
to turn it on later.
