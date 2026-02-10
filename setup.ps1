# AccessClone - Project Setup
# Creates database, installs infrastructure, and prepares the project
#
# Usage: .\setup.ps1 -DatabaseName calculator -Password <your_pg_password>

param(
    [Parameter(Mandatory=$true)]
    [string]$DatabaseName,

    [Parameter(Mandatory=$true)]
    [string]$Password,

    [string]$Host = "localhost",
    [int]$Port = 5432,
    [string]$User = "postgres"
)

$ErrorActionPreference = "Stop"

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "AccessClone - Project Setup" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Database: $DatabaseName" -ForegroundColor White
Write-Host "Host:     $Host`:$Port" -ForegroundColor White
Write-Host "User:     $User" -ForegroundColor White
Write-Host ""

# Find psql
$psqlPaths = @(
    "C:\Program Files\PostgreSQL\18\bin\psql.exe",
    "C:\Program Files\PostgreSQL\17\bin\psql.exe",
    "C:\Program Files\PostgreSQL\16\bin\psql.exe",
    "C:\Program Files\PostgreSQL\15\bin\psql.exe",
    "C:\Program Files\PostgreSQL\14\bin\psql.exe"
)

$psql = $null
foreach ($path in $psqlPaths) {
    if (Test-Path $path) {
        $psql = $path
        break
    }
}

if (-not $psql) {
    $psql = Get-Command psql -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source
}

if (-not $psql) {
    Write-Host "ERROR: psql not found. Is PostgreSQL installed?" -ForegroundColor Red
    exit 1
}

Write-Host "Using: $psql" -ForegroundColor Gray
Write-Host ""

# Set password environment variable for psql
$env:PGPASSWORD = $Password

# Step 1: Create secrets.json and configure API key
Write-Host "[1/6] Configuring secrets.json..." -ForegroundColor Yellow
$secretsPath = Join-Path $PSScriptRoot "secrets.json"
$examplePath = Join-Path $PSScriptRoot "secrets.json.example"
if (-not (Test-Path $secretsPath)) {
    if (Test-Path $examplePath) {
        Copy-Item $examplePath $secretsPath
        Write-Host "      Created secrets.json from example." -ForegroundColor Green
    } else {
        # Create a minimal secrets.json
        '{"anthropic":{"api_key":""},"openai":{"api_key":"","embedding_model":"text-embedding-3-small"}}' | Set-Content $secretsPath
        Write-Host "      Created secrets.json." -ForegroundColor Green
    }
}
# Check if the API key is still a placeholder
$secretsContent = Get-Content $secretsPath -Raw | ConvertFrom-Json
$currentKey = $secretsContent.anthropic.api_key
if (-not $currentKey -or $currentKey -eq "sk-ant-api03-your-key-here") {
    Write-Host ""
    Write-Host "      AccessClone uses an AI assistant for chat features." -ForegroundColor White
    Write-Host "      To enable it, you need an Anthropic API key from https://console.anthropic.com" -ForegroundColor White
    Write-Host ""
    $apiKey = Read-Host "      Enter your Anthropic API key (or press Enter to skip)"
    if ($apiKey) {
        $secretsContent.anthropic.api_key = $apiKey
        $secretsContent | ConvertTo-Json -Depth 3 | Set-Content $secretsPath
        Write-Host "      API key saved." -ForegroundColor Green
    } else {
        Write-Host "      Skipped. You can add it later by editing secrets.json." -ForegroundColor Gray
    }
} else {
    Write-Host "      secrets.json already configured." -ForegroundColor Green
}

# Step 2: Create database
Write-Host "[2/6] Creating database '$DatabaseName'..." -ForegroundColor Yellow
try {
    & $psql -h $Host -p $Port -U $User -c "CREATE DATABASE $DatabaseName;" 2>&1 | Out-Null
    Write-Host "      Database created." -ForegroundColor Green
} catch {
    # Check if database already exists
    $exists = & $psql -h $Host -p $Port -U $User -c "SELECT 1 FROM pg_database WHERE datname='$DatabaseName';" 2>&1
    if ($exists -match "1 row") {
        Write-Host "      Database already exists." -ForegroundColor Green
    } else {
        Write-Host "      Error: $_" -ForegroundColor Red
        exit 1
    }
}

# Step 3: Install infrastructure
Write-Host "[3/6] Installing infrastructure tables and functions..." -ForegroundColor Yellow
$infraPath = Join-Path $PSScriptRoot "server\infrastructure.sql"
if (Test-Path $infraPath) {
    & $psql -h $Host -p $Port -U $User -d $DatabaseName -f $infraPath 2>&1 | Out-Null
    Write-Host "      Infrastructure installed." -ForegroundColor Green
} else {
    Write-Host "      WARNING: infrastructure.sql not found at $infraPath" -ForegroundColor Yellow
}

# Step 4: Install server dependencies
Write-Host "[4/6] Installing server dependencies (npm)..." -ForegroundColor Yellow
$serverPath = Join-Path $PSScriptRoot "server"
Push-Location $serverPath
try {
    npm install 2>&1 | Out-Null
    Write-Host "      Server dependencies installed." -ForegroundColor Green
} finally {
    Pop-Location
}

# Step 5: Install UI dependencies
Write-Host "[5/6] Installing UI dependencies (npm)..." -ForegroundColor Yellow
$uiPath = Join-Path $PSScriptRoot "ui"
Push-Location $uiPath
try {
    npm install 2>&1 | Out-Null
    Write-Host "      UI dependencies installed." -ForegroundColor Green
} finally {
    Pop-Location
}

# Step 6: Update config
Write-Host "[6/6] Updating configuration..." -ForegroundColor Yellow
$configPath = Join-Path $PSScriptRoot "server\config.js"
$configContent = Get-Content $configPath -Raw

# Update default database name
$configContent = $configContent -replace "PGDATABASE \|\| '[^']*'", "PGDATABASE || '$DatabaseName'"

# Ensure localhost for Windows
$configContent = $configContent -replace "const defaultHost = isWSL \? '[^']*' : '[^']*';", "const defaultHost = isWSL ? '10.255.255.254' : 'localhost';"

Set-Content $configPath $configContent -NoNewline
Write-Host "      Configuration updated." -ForegroundColor Green

# Clear password from environment
$env:PGPASSWORD = $null

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Setup complete!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "To start the application:" -ForegroundColor White
Write-Host "  .\start.ps1 -Password $Password" -ForegroundColor Gray
Write-Host ""
Write-Host "Or manually:" -ForegroundColor White
Write-Host "  cd server" -ForegroundColor Gray
Write-Host "  set PGPASSWORD=$Password" -ForegroundColor Gray
Write-Host "  npm start" -ForegroundColor Gray
Write-Host ""
