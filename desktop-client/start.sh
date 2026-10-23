#!/usr/bin/env bash
# Starts Control Center Remote.
#   ./start.sh            open the window
#   ./start.sh --hidden   start in the tray
#   ./start.sh --foreground   stay attached to this terminal (logs)
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ELECTRON="$APP_DIR/node_modules/electron/dist/electron"

if [[ ! -x "$ELECTRON" ]]; then
  echo "Control Center Remote is not installed yet. Run ./install.sh first." >&2
  exit 1
fi

# Inherited from some shells (VS Code's terminal): it makes Electron act as plain Node.
unset ELECTRON_RUN_AS_NODE

args=("$APP_DIR")
foreground=0
for arg in "$@"; do
  case "$arg" in
    --hidden) args+=("--hidden") ;;
    --foreground) foreground=1 ;;
  esac
done

# Electron's sandbox needs either unprivileged user namespaces or a setuid
# chrome-sandbox helper. install.sh sets up the helper when the system blocks
# user namespaces (Ubuntu 24.04 and later). Without either, run unsandboxed:
# the window only ever shows this app's own pages.
SANDBOX="$APP_DIR/node_modules/electron/dist/chrome-sandbox"
userns_blocked=0
if [[ -r /proc/sys/kernel/apparmor_restrict_unprivileged_userns ]] && [[ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns)" == "1" ]]; then
  userns_blocked=1
fi
if [[ -r /proc/sys/kernel/unprivileged_userns_clone ]] && [[ "$(cat /proc/sys/kernel/unprivileged_userns_clone)" == "0" ]]; then
  userns_blocked=1
fi
if [[ $userns_blocked == 1 ]] && ! { [[ -u "$SANDBOX" ]] && [[ "$(stat -c %U "$SANDBOX")" == "root" ]]; }; then
  echo "Note: running without Chromium's sandbox (run ./install.sh to set it up)." >&2
  args+=("--no-sandbox")
fi

if [[ $foreground == 1 ]]; then
  exec "$ELECTRON" "${args[@]}"
fi
nohup "$ELECTRON" "${args[@]}" >/dev/null 2>&1 &
disown
