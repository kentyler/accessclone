Write-Host "=== Checking your system ===" -ForegroundColor Cyan

# Check Node.js
Write-Host "`nNode.js:" -ForegroundColor Yellow
$nodeVersion = node --version 2>$null
if ($nodeVersion) { Write-Host "  Installed: $nodeVersion" -ForegroundColor Green }
else { Write-Host "  Not found" -ForegroundColor Red }

# Check PostgreSQL services
Write-Host "`nPostgreSQL Services:" -ForegroundColor Yellow
$pgServices = Get-Service postgresql* -ErrorAction SilentlyContinue
if ($pgServices) {
    $pgServices | ForEach-Object {
        Write-Host "  $($_.DisplayName): $($_.Status)" -ForegroundColor $(if ($_.Status -eq 'Running') { 'Green' } else { 'Yellow' })
    }
} else {
    Write-Host "  No PostgreSQL services found" -ForegroundColor Red
}

# Check PostgreSQL installations
Write-Host "`nPostgreSQL Installations:" -ForegroundColor Yellow
$found = $false
@(18,17,16,15,14) | ForEach-Object {
    $path = "C:\Program Files\PostgreSQL\$_"
    if (Test-Path $path) {
        Write-Host "  PostgreSQL $_ at $path" -ForegroundColor Green
        $found = $true
    }
}
if (-not $found) { Write-Host "  No installations found in standard locations" -ForegroundColor Red }

Write-Host "`n=== Scan complete ===" -ForegroundColor Cyan
Write-Host "`nCopy and paste the output above into the LLM chat." -ForegroundColor White
Write-Host ""
pause
