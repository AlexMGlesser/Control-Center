param(
  [switch]$InstallDependencies,
  [switch]$WebOnly
)

$ErrorActionPreference = "Stop"

function Assert-CommandExists {
  param([string]$CommandName)

  if (-not (Get-Command $CommandName -ErrorAction SilentlyContinue)) {
    throw "Required command '$CommandName' is not available in PATH."
  }
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

Assert-CommandExists -CommandName "npm"

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
