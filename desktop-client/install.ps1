<#
.SYNOPSIS
  Installs Control Center Remote on this Windows computer.

.DESCRIPTION
  Checks for Node.js and Tailscale (offers to install them with winget),
  installs the app's packages, and adds Start Menu and desktop shortcuts.
  Run it again any time to update after pulling new code.

.PARAMETER StartAtLogin
  Also start Control Center Remote (in the tray) when you sign in.
#>
param(
  [switch]$StartAtLogin
)

$ErrorActionPreference = 'Stop'
$AppDir = $PSScriptRoot

function Write-Step($text) { Write-Host "`n==> $text" -ForegroundColor Cyan }
function Ask($question) {
  $answer = Read-Host "$question [Y/n]"
  return ($answer -eq '' -or $answer -match '^[Yy]')
}
function Test-Command($name) { return [bool](Get-Command $name -ErrorAction SilentlyContinue) }
function Update-PathFromRegistry {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}

Write-Host 'Control Center Remote setup' -ForegroundColor Magenta

# --- Node.js (npm installs the app's packages, including Electron) ---
Write-Step 'Checking Node.js'
$nodeOk = $false
if (Test-Command 'node') {
  $major = [int]((node --version).TrimStart('v').Split('.')[0])
  $nodeOk = $major -ge 18
  if ($nodeOk) { Write-Host "Node.js $(node --version) found." }
  else { Write-Host "Node.js $(node --version) is too old (need 18 or newer)." -ForegroundColor Yellow }
}
if (-not $nodeOk) {
  if ((Test-Command 'winget') -and (Ask 'Install Node.js LTS with winget?')) {
    winget install --id OpenJS.NodeJS.LTS --exact --accept-source-agreements --accept-package-agreements
    Update-PathFromRegistry
  }
  if (-not (Test-Command 'npm')) {
    Write-Host 'Node.js is required. Install it from https://nodejs.org, then run this script again.' -ForegroundColor Red
    exit 1
  }
}

# --- Tailscale (the private network to the home PC) ---
Write-Step 'Checking Tailscale'
if (-not (Test-Command 'tailscale')) {
  $installed = Test-Path "$env:ProgramFiles\Tailscale\tailscale.exe"
  if (-not $installed -and (Test-Command 'winget') -and (Ask 'Tailscale connects this computer to your home PC. Install it with winget?')) {
    winget install --id Tailscale.Tailscale --exact --accept-source-agreements --accept-package-agreements
    Update-PathFromRegistry
  }
}
if ((Test-Command 'tailscale') -or (Test-Path "$env:ProgramFiles\Tailscale\tailscale.exe")) {
  Write-Host 'Tailscale is installed. Sign in to the same account as your home PC.'
} else {
  Write-Host 'Tailscale not found. Get it from https://tailscale.com/download before pairing.' -ForegroundColor Yellow
}

# --- The app's packages ---
Write-Step 'Installing packages (this downloads Electron the first time)'
Push-Location $AppDir
try {
  # ELECTRON_RUN_AS_NODE would make Electron act as plain Node.
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  if (Test-Path (Join-Path $AppDir 'package-lock.json')) { npm ci --no-audit --no-fund } else { npm install --no-audit --no-fund }
  if ($LASTEXITCODE -ne 0) { throw 'npm failed.' }
} finally {
  Pop-Location
}

$electron = Join-Path $AppDir 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path $electron)) { throw "Electron didn't install: $electron is missing." }

# --- Shortcuts (they carry the app ID Windows needs for notifications) ---
Write-Step 'Adding Start Menu and desktop shortcuts'
$setupArgs = @($AppDir, '--install-shortcuts')
if ($StartAtLogin) { $setupArgs += '--start-at-login' }
& $electron @setupArgs | Out-Null
Write-Host 'Added "Control Center Remote" to the Start Menu and the desktop.'
if ($StartAtLogin) { Write-Host 'It will start in the tray when you sign in (change this in its Settings).' }

Write-Host "`nDone. Start it from the Start Menu, or run start.ps1." -ForegroundColor Green
Write-Host 'Then pair it: on the PC, Control Center > Settings > Devices > Pair a device.'
