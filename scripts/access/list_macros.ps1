# List all macros in an Access database
# Usage: .\list_macros.ps1 -DatabasePath "path\to\db.accdb"
# Output: JSON array of macro objects with name
# .mdb files use DAO directly to avoid PtrSafe compile error dialogs

param(
    [Parameter(Mandatory=$true)]
    [string]$DatabasePath
)

# Remove lock file if exists
if ($DatabasePath -match '\.accdb$') {
    Remove-Item ($DatabasePath -replace '\.accdb$', '.laccdb') -Force -ErrorAction SilentlyContinue
} elseif ($DatabasePath -match '\.mdb$') {
    Remove-Item ($DatabasePath -replace '\.mdb$', '.ldb') -Force -ErrorAction SilentlyContinue
}

$isMdb = $DatabasePath.ToLower().EndsWith('.mdb')

if (-not $isMdb) {
    # .accdb: use Access.Application for full fidelity
    Get-Process MSACCESS -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500

    $accessApp = $null
    try {
        $accessApp = New-Object -ComObject Access.Application
        $accessApp.AutomationSecurity = 3  # msoAutomationSecurityForceDisable
        $accessApp.OpenCurrentDatabase($DatabasePath)

        $macros = @()
        foreach ($macro in $accessApp.CurrentProject.AllMacros) {
            $macros += @{ name = $macro.Name }
        }

        $macros | ConvertTo-Json -Compress

        $accessApp.CloseCurrentDatabase()
        exit 0
    }
    catch {
        # Fall through to DAO fallback
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
}

# DAO fallback (always used for .mdb, fallback for .accdb)
$dbe = $null
$db = $null
try {
    $dbe = New-Object -ComObject DAO.DBEngine.120
    $db = $dbe.OpenDatabase($DatabasePath)

    $macros = @()
    foreach ($doc in $db.Containers("Scripts").Documents) {
        if (-not $doc.Name.StartsWith("~")) {
            $macros += @{ name = $doc.Name }
        }
    }

    $macros | ConvertTo-Json -Compress
}
catch {
    Write-Error $_.Exception.Message
    exit 1
}
finally {
    if ($db) { try { $db.Close() } catch {} }
    if ($dbe) { try { [System.Runtime.Interopservices.Marshal]::ReleaseComObject($dbe) | Out-Null } catch {} }
}
