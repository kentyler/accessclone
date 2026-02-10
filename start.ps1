# AccessClone - Start Application
# Starts the backend server and optionally the UI dev server
#
# Usage: .\start.ps1 -Password <your_pg_password>
#        .\start.ps1 -Password <your_pg_password> -Dev    # Also starts UI dev server

param(
    [Parameter(Mandatory=$true)]
    [string]$Password,

    [switch]$Dev,
    [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "AccessClone - Starting Application" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Set environment variables
$env:PGPASSWORD = $Password

# Get paths
$serverPath = Join-Path $PSScriptRoot "server"
$uiPath = Join-Path $PSScriptRoot "ui"

# Start backend server
Write-Host "Starting backend server..." -ForegroundColor Yellow
$serverProcess = Start-Process -FilePath "node" -ArgumentList "index.js" -WorkingDirectory $serverPath -PassThru -NoNewWindow

Write-Host "Backend server started (PID: $($serverProcess.Id))" -ForegroundColor Green
Write-Host "API available at: http://localhost:3001" -ForegroundColor Gray

if ($Dev) {
    # Start UI development server
    Write-Host ""
    Write-Host "Starting UI development server..." -ForegroundColor Yellow

    $uiProcess = Start-Process -FilePath "npx" -ArgumentList "shadow-cljs", "watch", "app" -WorkingDirectory $uiPath -PassThru -NoNewWindow

    Write-Host "UI dev server started (PID: $($uiProcess.Id))" -ForegroundColor Green
    Write-Host "UI available at: http://localhost:8080" -ForegroundColor Gray

    $url = "http://localhost:8080"
} else {
    # Serve static files (production mode)
    $url = "http://localhost:3001"
    Write-Host ""
    Write-Host "Running in production mode (pre-built UI)" -ForegroundColor Gray
    Write-Host "Use -Dev flag to start UI development server" -ForegroundColor Gray
}

Write-Host ""

# Open browser
if (-not $NoBrowser) {
    Write-Host "Opening browser..." -ForegroundColor Yellow
    Start-Sleep -Seconds 2  # Give server time to start
    Start-Process $url
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Application running!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Press Ctrl+C to stop the server" -ForegroundColor Gray
Write-Host ""

# Wait for server process
try {
    $serverProcess.WaitForExit()
} finally {
    # Cleanup
    $env:PGPASSWORD = $null

    if ($Dev -and $uiProcess -and -not $uiProcess.HasExited) {
        Write-Host "Stopping UI server..." -ForegroundColor Yellow
        Stop-Process -Id $uiProcess.Id -Force -ErrorAction SilentlyContinue
    }
}
