# AccessClone - Create Distribution Package
# Creates a AccessClone.zip ready to share with new users
#
# Usage: .\package.ps1
#        .\package.ps1 -OutputPath C:\Users\Ken\Desktop\AccessClone.zip

param(
    [string]$OutputPath
)

$ErrorActionPreference = "Stop"

# Read version from package.json
$packageJson = Get-Content (Join-Path $PSScriptRoot "package.json") -Raw | ConvertFrom-Json
$version = $packageJson.version

if (-not $OutputPath) {
    $OutputPath = Join-Path $PSScriptRoot "AccessClone-$version.zip"
}

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "AccessClone $version - Build Distribution Package" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

$sourceDir = $PSScriptRoot
$stagingDir = Join-Path ([System.IO.Path]::GetTempPath()) "AccessClone"

# Clean up any previous staging directory
if (Test-Path $stagingDir) {
    Write-Host "Cleaning previous staging directory..." -ForegroundColor Gray
    Remove-Item $stagingDir -Recurse -Force
}

# Clean up any previous zip
if (Test-Path $OutputPath) {
    Remove-Item $OutputPath -Force
}

Write-Host "[1/4] Copying project files..." -ForegroundColor Yellow

# Directories and files to exclude
$excludeDirs = @(
    '.git',
    'node_modules',
    '.shadow-cljs',
    'temp',
    'electron\dist'
)

$excludeFiles = @(
    'secrets.json',
    'package.ps1'
)

# Create staging directory
New-Item -ItemType Directory -Path $stagingDir | Out-Null

# Use robocopy for fast copying with exclusions
$excludeDirArgs = $excludeDirs | ForEach-Object { "/XD"; $_ }
$excludeFileArgs = $excludeFiles | ForEach-Object { "/XF"; $_ }

& robocopy $sourceDir $stagingDir /E /NFL /NDL /NJH /NJS /NC /NS /NP @excludeDirArgs @excludeFileArgs | Out-Null

Write-Host "      Files copied." -ForegroundColor Green

# Step 2: Verify compiled UI exists
Write-Host "[2/4] Checking compiled UI..." -ForegroundColor Yellow
$mainJs = Join-Path $stagingDir "ui\resources\public\js\main.js"
if (Test-Path $mainJs) {
    $size = [math]::Round((Get-Item $mainJs).Length / 1MB, 1)
    Write-Host "      main.js found (${size}MB)." -ForegroundColor Green
} else {
    Write-Host "      WARNING: Compiled UI not found at ui\resources\public\js\main.js" -ForegroundColor Red
    Write-Host "      Run 'cd ui && npx shadow-cljs compile app' first, then re-run this script." -ForegroundColor Red
    Remove-Item $stagingDir -Recurse -Force
    exit 1
}

# Step 3: Verify key files
Write-Host "[3/4] Verifying package contents..." -ForegroundColor Yellow
$requiredFiles = @(
    "install.ps1",
    "setup.ps1",
    "start.ps1",
    "secrets.json.example",
    "server\index.js",
    "server\config.js",
    "server\infrastructure.sql",
    "server\package.json",
    "ui\package.json",
    "ui\resources\public\index.html"
)

$missing = @()
foreach ($file in $requiredFiles) {
    $filePath = Join-Path $stagingDir $file
    if (-not (Test-Path $filePath)) {
        $missing += $file
    }
}

if ($missing.Count -gt 0) {
    Write-Host "      WARNING: Missing files:" -ForegroundColor Red
    $missing | ForEach-Object { Write-Host "        - $_" -ForegroundColor Red }
    Remove-Item $stagingDir -Recurse -Force
    exit 1
}
Write-Host "      All required files present." -ForegroundColor Green

# Step 4: Create zip
Write-Host "[4/4] Creating zip archive..." -ForegroundColor Yellow
Compress-Archive -Path $stagingDir -DestinationPath $OutputPath -CompressionLevel Optimal
$zipSize = [math]::Round((Get-Item $OutputPath).Length / 1MB, 1)
Write-Host "      Created: $OutputPath (${zipSize}MB)" -ForegroundColor Green

# Clean up staging directory
Remove-Item $stagingDir -Recurse -Force

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Package complete!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "The zip extracts to a 'AccessClone' folder." -ForegroundColor White
Write-Host "Share it with users and have them follow README.md to get started." -ForegroundColor Gray
Write-Host ""
