# Fix PtrSafe declarations in an Access database
# Opens the database, scans all VBA modules for Declare statements missing PtrSafe,
# and adds the PtrSafe keyword. Run once before import to prevent compile error dialogs.
#
# Usage:  .\fix_ptrsafe.ps1 -DatabasePath "path\to\database.mdb"
#         .\fix_ptrsafe.ps1 -DatabasePath "path\to\database.accdb" -DryRun
#
# Output: JSON with { "success", "modulesScanned", "modulesFixed", "declarationsFixed", "details", "error" }
# -DryRun: report what would be fixed without modifying anything

param(
    [Parameter(Mandatory=$true)]
    [string]$DatabasePath,
    [switch]$DryRun
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

. "$PSScriptRoot\com_helpers.ps1"

function Escape-JsonStr([string]$s) {
    return $s.Replace('\', '\\').Replace('"', '\"').Replace("`r", '\r').Replace("`n", '\n')
}

# Remove lock file if exists
if ($DatabasePath -match '\.accdb$') {
    Remove-Item ($DatabasePath -replace '\.accdb$', '.laccdb') -Force -ErrorAction SilentlyContinue
} elseif ($DatabasePath -match '\.mdb$') {
    Remove-Item ($DatabasePath -replace '\.mdb$', '.ldb') -Force -ErrorAction SilentlyContinue
}

# Kill any existing Access processes
Get-Process MSACCESS -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

$accessApp = $null
$modulesScanned = 0
$modulesFixed = 0
$declarationsFixed = 0
$details = @()

try {
    if (-not (Test-Path $DatabasePath)) {
        Write-Output "{`"success`":false,`"error`":`"File not found: $(Escape-JsonStr $DatabasePath)`"}"
        exit 1
    }

    # Create a backup before modifying VBA (skip if backup already exists)
    $backupPath = $DatabasePath -replace '\.(mdb|accdb)$', '_bak.$1'
    if (-not $DryRun -and -not (Test-Path $backupPath)) {
        Copy-Item $DatabasePath $backupPath -Force
        [Console]::Error.WriteLine("Created backup: $backupPath")
    }

    $accessApp = New-Object -ComObject Access.Application
    $accessApp.AutomationSecurity = 3  # msoAutomationSecurityForceDisable
    $accessApp.Visible = $true

    # OpenCurrentDatabase may trigger a PtrSafe compile error dialog that blocks COM.
    # The shared helper auto-dismisses it with background SendKeys.
    Open-AccessDatabase -AccessApp $accessApp -DatabasePath $DatabasePath

    $accessApp.DoCmd.SetWarnings($false)

    # Give Access a moment to settle
    Start-Sleep -Seconds 1

    $vbProject = $accessApp.VBE.ActiveVBProject

    foreach ($component in $vbProject.VBComponents) {
        $compName = $component.Name
        $compType = [int]$component.Type
        $modulesScanned++

        try {
            $codeModule = $component.CodeModule
            $lineCount = $codeModule.CountOfLines

            if ($lineCount -eq 0) { continue }

            # Scan all lines, replace Declare with Declare PtrSafe in-place.
            # Backup copy preserves originals — no need for comment lines.
            $fixedLines = @()
            $moduleFixCount = 0

            for ($ln = 1; $ln -le $lineCount; $ln++) {
                $line = $codeModule.Lines($ln, 1)
                if ($line -match '^\s*(Private\s+|Public\s+)?Declare\s+(Function|Sub)\s' -and
                    $line -notmatch 'Declare\s+PtrSafe\s') {
                    $fixedLine = $line -replace '(Declare)\s+(Function|Sub)', 'Declare PtrSafe $2'
                    if (-not $DryRun) {
                        $codeModule.ReplaceLine($ln, $fixedLine)
                    }
                    $fixedLines += @{
                        original = $line.Trim()
                        fixed = $fixedLine.Trim()
                    }
                    $moduleFixCount++
                }
            }

            if ($moduleFixCount -gt 0) {

                $modulesFixed++
                $declarationsFixed += $moduleFixCount

                $details += [ordered]@{
                    module = $compName
                    componentType = $compType
                    fixCount = $moduleFixCount
                    declarations = @($fixedLines | ForEach-Object {
                        [ordered]@{
                            original = $_.original
                            fixed = $_.fixed
                        }
                    })
                }

                [Console]::Error.WriteLine("$(if ($DryRun) {'[DRY RUN] Would fix'} else {'Fixed'}) $moduleFixCount declaration(s) in $compName")
            }
        }
        catch {
            [Console]::Error.WriteLine("Warning: Could not read module ${compName}: $_")
        }
    }

    $accessApp.DoCmd.SetWarnings($true)  # Restore warnings
    # CloseCurrentDatabase saves all VBA changes automatically
    $accessApp.CloseCurrentDatabase()

    # Build result JSON manually for reliability
    $detailsJson = @()
    foreach ($d in $details) {
        $declJson = @()
        foreach ($decl in $d.declarations) {
            $declJson += "{`"original`":`"$(Escape-JsonStr $decl.original)`",`"fixed`":`"$(Escape-JsonStr $decl.fixed)`"}"
        }
        $detailsJson += "{`"module`":`"$(Escape-JsonStr $d.module)`",`"componentType`":$($d.componentType),`"fixCount`":$($d.fixCount),`"declarations`":[$($declJson -join ',')]}"
    }

    $modeStr = if ($DryRun) { ",`"dryRun`":true" } else { "" }
    $backupStr = if ($backupPath -and -not $DryRun -and (Test-Path $backupPath)) { ",`"backupPath`":`"$(Escape-JsonStr $backupPath)`"" } else { "" }

    Write-Output "{`"success`":true,`"modulesScanned`":$modulesScanned,`"modulesFixed`":$modulesFixed,`"declarationsFixed`":$declarationsFixed$modeStr$backupStr,`"details`":[$($detailsJson -join ',')]}"
}
catch {
    $msg = $_.Exception.Message -replace '"', '\"'
    Write-Output "{`"success`":false,`"error`":`"$msg`",`"modulesScanned`":$modulesScanned,`"modulesFixed`":$modulesFixed,`"declarationsFixed`":$declarationsFixed}"
    exit 1
}
finally {
    if ($accessApp) {
        try {
            $accessApp.Quit()
            [System.Runtime.Interopservices.Marshal]::ReleaseComObject($accessApp) | Out-Null
        } catch {}
    }
    Get-Process MSACCESS -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
}
