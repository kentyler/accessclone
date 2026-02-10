# AccessClone Server Startup Script

param(
    [string]$Password = "<password>",
    [int]$Port = 3001
)

Write-Host "AccessClone Server" -ForegroundColor Cyan
Write-Host "=================" -ForegroundColor Cyan

# Kill existing server on this port
Write-Host "Checking for existing server on port $Port..." -ForegroundColor Yellow
Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique |
    ForEach-Object {
        Write-Host "Stopping process PID: $_" -ForegroundColor Yellow
        Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue
    }
Start-Sleep -Milliseconds 500

# Set environment and start server
Write-Host "Starting server..." -ForegroundColor Yellow
$env:PGPASSWORD = $Password

Set-Location $PSScriptRoot\server
npm start
