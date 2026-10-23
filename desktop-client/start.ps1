<#
.SYNOPSIS
  Starts Control Center Remote.

.PARAMETER Hidden
  Start in the tray without showing the window.
#>
param(
  [switch]$Hidden
)

$ErrorActionPreference = 'Stop'
$AppDir = $PSScriptRoot
$electron = Join-Path $AppDir 'node_modules\electron\dist\electron.exe'

if (-not (Test-Path $electron)) {
  Write-Host 'Control Center Remote is not installed yet. Run install.ps1 first.' -ForegroundColor Red
  exit 1
}

# Inherited from some shells (VS Code's terminal): it makes Electron act as plain Node.
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

$arguments = @("`"$AppDir`"")
if ($Hidden) { $arguments += '--hidden' }
# A second launch just brings the running window forward.
Start-Process -FilePath $electron -ArgumentList $arguments -WorkingDirectory $AppDir
