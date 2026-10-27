#!/usr/bin/env bash
# Installs Control Center Remote on this Linux computer.
#
# Checks for Node.js and Tailscale (offers to install them), installs the
# app's packages, sets up Electron's sandbox if the system needs it, and adds
# an app-menu entry. Run it again any time to update after pulling new code.
#
#   ./install.sh                  install
#   ./install.sh --start-at-login also start in the tray when you sign in
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
START_AT_LOGIN=0
for arg in "$@"; do
  [[ "$arg" == "--start-at-login" ]] && START_AT_LOGIN=1
done

step() { printf '\n\033[36m==> %s\033[0m\n' "$1"; }
warn() { printf '\033[33m%s\033[0m\n' "$1"; }
ask() {
  local answer
  read -r -p "$1 [Y/n] " answer
  [[ -z "$answer" || "$answer" =~ ^[Yy] ]]
}
have() { command -v "$1" >/dev/null 2>&1; }

install_packages() {
  if have apt-get; then sudo apt-get update && sudo apt-get install -y "$@"
  elif have dnf; then sudo dnf install -y "$@"
  elif have pacman; then sudo pacman -S --needed --noconfirm "$@"
  elif have zypper; then sudo zypper install -y "$@"
  else return 1
  fi
}

printf '\033[35mControl Center Remote setup\033[0m\n'

# --- Node.js (npm installs the app's packages, including Electron) ---
step "Checking Node.js"
node_ok=0
if have node; then
  major="$(node --version | sed 's/^v//; s/\..*//')"
  if (( major >= 18 )); then node_ok=1; echo "Node.js $(node --version) found."
  else warn "Node.js $(node --version) is too old (need 18 or newer)."
  fi
fi
if (( ! node_ok )); then
  if ask "Install Node.js and npm with your package manager (uses sudo)?"; then
    install_packages nodejs npm || warn "Couldn't install automatically."
  fi
  if ! have npm || (( "$(node --version | sed 's/^v//; s/\..*//')" < 18 )); then
    echo "Node.js 18 or newer is required: https://nodejs.org (or your distribution's nodejs package, or nvm). Then run this again." >&2
    exit 1
  fi
fi

# --- Tailscale (the private network to the home PC) ---
step "Checking Tailscale"
if ! have tailscale; then
  if ask "Tailscale connects this computer to your home PC. Install it with Tailscale's official script (uses sudo)?"; then
    curl -fsSL https://tailscale.com/install.sh | sh
  fi
fi
if have tailscale; then
  echo "Tailscale is installed. If you haven't yet: sudo tailscale up  (same account as your home PC)."
else
  warn "Tailscale not found. Get it from https://tailscale.com/download before pairing."
fi

# --- The app's packages ---
step "Installing packages (this downloads Electron the first time)"
cd "$APP_DIR"
unset ELECTRON_RUN_AS_NODE
if [[ -f package-lock.json ]]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi
ELECTRON="$APP_DIR/node_modules/electron/dist/electron"
[[ -x "$ELECTRON" ]] || { echo "Electron didn't install: $ELECTRON is missing." >&2; exit 1; }
chmod +x "$APP_DIR/start.sh" "$APP_DIR/uninstall.sh"

# --- Electron's sandbox ---
# Some distributions (Ubuntu 24.04+) block the user namespaces Chromium's
# sandbox normally uses; then it needs its setuid helper, owned by root.
SANDBOX="$APP_DIR/node_modules/electron/dist/chrome-sandbox"
blocked=0
[[ -r /proc/sys/kernel/apparmor_restrict_unprivileged_userns && "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns)" == "1" ]] && blocked=1
[[ -r /proc/sys/kernel/unprivileged_userns_clone && "$(cat /proc/sys/kernel/unprivileged_userns_clone)" == "0" ]] && blocked=1
if (( blocked )); then
  step "Setting up Electron's sandbox"
  if ask "This system needs Electron's sandbox helper to be owned by root (chown root + chmod 4755 on chrome-sandbox, uses sudo). Do it?"; then
    sudo chown root:root "$SANDBOX" && sudo chmod 4755 "$SANDBOX" && echo "Sandbox ready."
  else
    warn "Skipped: the app will run without Chromium's sandbox."
  fi
fi

# --- App menu entry ---
step "Adding Control Center Remote to the app menu"
APPLICATIONS="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
mkdir -p "$APPLICATIONS"
cat > "$APPLICATIONS/control-center-remote.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Control Center Remote
Comment=Your home PC's Control Center, on this computer
Exec="$APP_DIR/start.sh"
Icon=$APP_DIR/assets/icon.png
Terminal=false
Categories=Utility;Network;
StartupWMClass=Control Center Remote
EOF
have update-desktop-database && update-desktop-database "$APPLICATIONS" >/dev/null 2>&1 || true
echo "Added. Look for \"Control Center Remote\" in your app menu."

if (( START_AT_LOGIN )); then
  "$ELECTRON" "$APP_DIR" --start-at-login $( (( blocked )) && [[ ! -u "$SANDBOX" ]] && echo --no-sandbox ) >/dev/null 2>&1 || true
  echo "It will start in the tray when you sign in (change this in its Settings)."
fi

printf '\n\033[32mDone. Start it from the app menu, or run ./start.sh.\033[0m\n'
echo "Then pair it: on the PC, Control Center > Settings > Devices > Pair a device."
