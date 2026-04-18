param(
  [switch]$InstallDependencies,
  [switch]$WebOnly,
  [switch]$ForceRestart
)

$ErrorActionPreference = "Stop"

function Assert-CommandExists {
  param([string]$CommandName)

  if (-not (Get-Command $CommandName -ErrorAction SilentlyContinue)) {
    throw "Required command '$CommandName' is not available in PATH."
  }
}

function Stop-ExistingControlCenterProcesses {
  Write-Host "Stopping existing Control Center processes..." -ForegroundColor Yellow

  $electronProcesses = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {
      $_.Name -in @("electron.exe", "Control Center.exe") -or
      ($_.Name -eq "node.exe" -and $_.CommandLine -like "*control-app*")
    }

  foreach ($process in $electronProcesses) {
    try {
      Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop
    } catch {
      Write-Host "Could not stop process $($process.ProcessId): $($_.Exception.Message)" -ForegroundColor DarkYellow
    }
  }

  $listeners = Get-NetTCPConnection -LocalPort 3100 -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique

  foreach ($ownerPid in $listeners) {
    if ($ownerPid) {
      try {
        Stop-Process -Id $ownerPid -Force -ErrorAction Stop
      } catch {
        Write-Host ("Could not stop port owner {0}: {1}" -f $ownerPid, $_.Exception.Message) -ForegroundColor DarkYellow
      }
    }
  }
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

Assert-CommandExists -CommandName "npm"

if ($ForceRestart) {
  Stop-ExistingControlCenterProcesses
}

if ($InstallDependencies) {
  Write-Host "Installing dependencies..." -ForegroundColor Cyan
  npm install
}

if ($WebOnly) {
  Write-Host "Starting Control Center in web-only mode..." -ForegroundColor Yellow
  npm run start:web
  exit $LASTEXITCODE
}

Write-Host "Starting Control Center desktop app..." -ForegroundColor Green
npm start
exit $LASTEXITCODE
