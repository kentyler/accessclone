# CloneTemplate - Install Dependencies
# Run this script as Administrator to install required software
#
# Usage: Right-click > Run with PowerShell (as Administrator)
#    or: powershell -ExecutionPolicy Bypass -File install.ps1

param(
    [switch]$SkipNode,
    [switch]$SkipPostgres,
    [switch]$SkipJava
)

$ErrorActionPreference = "Stop"

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "CloneTemplate - Dependency Installation" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Check if running as Administrator
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "WARNING: Not running as Administrator. Some installations may fail." -ForegroundColor Yellow
    Write-Host "Consider re-running this script as Administrator." -ForegroundColor Yellow
    Write-Host ""
}

# Check if winget is available
$wingetAvailable = Get-Command winget -ErrorAction SilentlyContinue
if (-not $wingetAvailable) {
    Write-Host "ERROR: winget is not available." -ForegroundColor Red
    Write-Host "Please install App Installer from the Microsoft Store or update Windows." -ForegroundColor Red
    exit 1
}

Write-Host "Using winget for package installation..." -ForegroundColor Gray
Write-Host ""

# Install Node.js
if (-not $SkipNode) {
    Write-Host "[1/3] Checking Node.js..." -ForegroundColor Yellow
    $nodeVersion = node --version 2>$null
    if ($nodeVersion) {
        Write-Host "      Node.js already installed: $nodeVersion" -ForegroundColor Green
    } else {
        Write-Host "      Installing Node.js LTS..." -ForegroundColor White
        winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
        Write-Host "      Node.js installed. You may need to restart your terminal." -ForegroundColor Green
    }
} else {
    Write-Host "[1/3] Skipping Node.js (--SkipNode)" -ForegroundColor Gray
}

Write-Host ""

# Install PostgreSQL
if (-not $SkipPostgres) {
    Write-Host "[2/3] Checking PostgreSQL..." -ForegroundColor Yellow
    $pgService = Get-Service -Name "postgresql*" -ErrorAction SilentlyContinue
    if ($pgService) {
        Write-Host "      PostgreSQL already installed: $($pgService.DisplayName)" -ForegroundColor Green
    } else {
        Write-Host "      Installing PostgreSQL..." -ForegroundColor White
        Write-Host "      NOTE: Remember the password you set during installation!" -ForegroundColor Cyan
        winget install PostgreSQL.PostgreSQL --accept-package-agreements --accept-source-agreements
        Write-Host "      PostgreSQL installed." -ForegroundColor Green
    }
} else {
    Write-Host "[2/3] Skipping PostgreSQL (--SkipPostgres)" -ForegroundColor Gray
}

Write-Host ""

# Install Java (needed for ClojureScript development only)
if (-not $SkipJava) {
    Write-Host "[3/3] Checking Java (for UI development)..." -ForegroundColor Yellow
    $javaVersion = java --version 2>$null
    if ($javaVersion) {
        Write-Host "      Java already installed" -ForegroundColor Green
    } else {
        Write-Host "      Installing Eclipse Temurin JDK..." -ForegroundColor White
        winget install EclipseAdoptium.Temurin.21.JDK --accept-package-agreements --accept-source-agreements
        Write-Host "      Java installed." -ForegroundColor Green
    }
} else {
    Write-Host "[3/3] Skipping Java (--SkipJava)" -ForegroundColor Gray
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Installation complete!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Next steps:" -ForegroundColor White
Write-Host "  1. Restart your terminal to refresh PATH" -ForegroundColor Gray
Write-Host "  2. Run: .\setup.ps1 -DatabaseName <name> -Password <pg_password>" -ForegroundColor Gray
Write-Host ""
