<#
.SYNOPSIS
  Removes Control Center Remote's shortcuts and start-at-login entry.

.PARAMETER RemoveData
  Also delete its saved pairing and settings. It will need to pair again.
  (Remove this computer under Settings > Devices on the PC too.)
#>
param(
  [switch]$RemoveData
)

$ErrorActionPreference = 'Stop'
$AppDir = $PSScriptRoot
$electron = Join-Path $AppDir 'node_modules\electron\dist\electron.exe'

Get-Process -Name electron -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -eq $electron } |
  Stop-Process -Force -ErrorAction SilentlyContinue

if (Test-Path $electron) {
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  & $electron $AppDir --remove-shortcuts | Out-Null
} else {
  Remove-Item "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Control Center Remote.lnk" -ErrorAction SilentlyContinue
  Remove-Item "$([Environment]::GetFolderPath('Desktop'))\Control Center Remote.lnk" -ErrorAction SilentlyContinue
}
Write-Host 'Removed the shortcuts and the start-at-login entry.'

if ($RemoveData) {
  Remove-Item (Join-Path $env:APPDATA 'control-center-remote') -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host 'Removed saved pairing and settings. Also remove this computer on the PC: Settings > Devices.'
}

Write-Host "The app's files are still in $AppDir; delete the folder to remove them."
