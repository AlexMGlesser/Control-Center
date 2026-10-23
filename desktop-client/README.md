# Control Center Remote

Control Center on a laptop or another desktop, for Windows and Linux. It
has the phone app's features (Jarvis and the same app views), connected
to Control Center on your home PC over Tailscale.

It keeps running in the tray, so the connection, notifications, alarms,
calendar reminders and music carry on with the window closed.

## Install

You need [Tailscale](https://tailscale.com) on this computer, signed in to
the same account as the home PC. The install scripts offer to install it,
and Node.js too.

**Windows** (PowerShell, from this folder):

```
.\install.ps1                 # add -StartAtLogin to start in the tray at sign-in
.\start.ps1                   # or use the Start Menu / desktop shortcut
```

If scripts are blocked, run `powershell -ExecutionPolicy Bypass -File .\install.ps1`.

**Linux** (from this folder):

```
./install.sh                  # add --start-at-login to start in the tray at sign-in
./start.sh                    # or use the app menu entry
```

On Ubuntu 24.04 and other systems that block unprivileged user namespaces,
`install.sh` offers to set up Chromium's sandbox helper (it needs `sudo`).
If you skip that, `start.sh` runs the app without the sandbox and says so.

Run the install script again after pulling new code. `uninstall.ps1` /
`uninstall.sh` remove the shortcuts and the start-at-login entry; add
`-RemoveData` / `--remove-data` to also forget the pairing.

## Pair it

1. On the home PC: Control Center > Settings > Devices > **Pair a device**.
2. In Control Center Remote, enter the address and the 8-character code the
   PC shows. It's paired as a laptop.

Remove it any time from the PC's Devices list, or with **Sign out** in its
Settings.

## What's in it

| | |
|---|---|
| Jarvis | The same chat as the PC and the phone. Replies arrive as notifications when the window isn't in front. Alarms set from here ring here. |
| Projects | Browse project folders and edit text files (Ctrl+S saves; warns if the file changed on the PC). New files and folders; rename, move and delete stay on the PC. |
| Calendar | Agenda and month view, add events, delete with Undo. Reminders are scheduled on this computer. |
| News, Wikipedia | As on the phone. |
| File System | Read-only browsing of the whole PC with previews and Download. Locked behind Windows Hello, or a PIN on Linux (or where Hello isn't set up). |
| Music | Streams your playlists here, with the keyboard's media keys and the OS media controls; or set it to play on the PC's speakers. |
| Movies | Streams the PC's movie library with subtitles; full screen from the player. Formats Chromium can't play (for example AC3, DTS audio) show an error. |
| Servers | Opens SSH in this computer's terminal (Windows Terminal, or the Linux desktop's terminal). |
| Drawing | View 2D drawings. |

"Hack the mainframe" is phone-only.

## How it works

- Electron, one codebase for both systems. The page has no build step:
  plain ES modules in `src/renderer/`.
- The window loads from a private `cc://app/` address. Its calls to
  `cc://app/api/...` go through the main process (`src/main/api.js`), which
  adds this device's token and forwards them to the PC. The page never sees
  the token, and media players and images work with plain URLs.
- The token is stored encrypted by the OS keychain (Windows DPAPI, or the
  Linux secret service) when there is one; otherwise in a file only you can
  read, and Settings says so.
- The live connection (`src/main/connection.js`) follows the phone's rules:
  a 45-second heartbeat watchdog, backoff, one "lost" alert per outage
  after a 60-second grace period, and a reason for it.
- Alarms and calendar reminders (`src/main/schedules.js`) are kept locally
  as well, so they fire on time when the PC can't be reached, and catch up
  after the laptop wakes from sleep.
