#!/usr/bin/env bash
# Removes Control Center Remote's app-menu entry and start-at-login entry.
#   ./uninstall.sh                also keep the saved pairing and settings
#   ./uninstall.sh --remove-data  also delete them (it will need to pair again)
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

pkill -f "$APP_DIR/node_modules/electron/dist/electron" 2>/dev/null || true

rm -f "${XDG_DATA_HOME:-$HOME/.local/share}/applications/control-center-remote.desktop"
rm -f "${XDG_CONFIG_HOME:-$HOME/.config}/autostart/control-center-remote.desktop"
echo "Removed the app-menu entry and the start-at-login entry."

if [[ "${1:-}" == "--remove-data" ]]; then
  rm -rf "${XDG_CONFIG_HOME:-$HOME/.config}/control-center-remote"
  echo "Removed saved pairing and settings. Also remove this computer on the PC: Settings > Devices."
fi

echo "The app's files are still in $APP_DIR; delete the folder to remove them."
