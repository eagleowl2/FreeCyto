param(
  [switch]$NoBackend,
  [switch]$NoFrontend
)

$ErrorActionPreference = "Stop"

# Root of the repo (directory containing this script)
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

if (-not $NoBackend) {
  Write-Host "Starting backend (new PowerShell window)..." -ForegroundColor Cyan
  $backendScript = Join-Path $root "backend\run.ps1"
  if (-not (Test-Path $backendScript)) {
    Write-Error "Backend runner not found at $backendScript"
    exit 1
  }

  # Launch backend run.ps1 in a separate PowerShell window so it keeps running
  Start-Process powershell -ArgumentList @(
    "-NoExit",
    "-ExecutionPolicy", "Bypass",
    "-File", "`"$backendScript`""
  )
}

if (-not $NoFrontend) {
  Write-Host "Starting frontend (Vite + Electron) in this window..." -ForegroundColor Cyan
  Set-Location (Join-Path $root "frontend")
  npm run dev
}

