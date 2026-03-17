# List all VBA modules in an Access database (standard, class, and form/report class modules)
# Usage: .\list_modules.ps1 -DatabasePath "path\to\db.accdb"
# Output: JSON array of module objects with name, lineCount, and componentType
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
    # .accdb: use Access.Application for full VBE access
    Get-Process MSACCESS -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500

    $accessApp = $null
    try {
        $accessApp = New-Object -ComObject Access.Application
        $accessApp.AutomationSecurity = 3  # msoAutomationSecurityForceDisable
        $accessApp.OpenCurrentDatabase($DatabasePath)

        $modules = @()

        # Use VBE.VBComponents to get ALL module types:
        #   1 = vbext_ct_StdModule (standard modules like modGlobal)
        #   2 = vbext_ct_ClassModule (standalone class modules like clsErrorHandler)
        # 100 = vbext_ct_Document (form/report class modules like Form_frmAdmin)
        foreach ($component in $accessApp.VBE.ActiveVBProject.VBComponents) {
            $compType = [int]$component.Type
            $lineCount = 0
            $codeReadOK = $false

            try {
                $lineCount = $component.CodeModule.CountOfLines
                $codeReadOK = $true
            } catch {
                # Could not access code module -- for document modules (type 100)
                # this may mean we need to open the form/report in design view first
            }

            # Skip document modules only if we CONFIRMED they have no code.
            # If CodeModule was inaccessible, include them -- export will retry
            # with the form/report open in design view.
            if ($compType -eq 100 -and $codeReadOK -and $lineCount -eq 0) {
                continue
            }

            $modules += @{
                name = $component.Name
                lineCount = $lineCount
                componentType = $compType
            }
        }

        $modules | ConvertTo-Json -Compress

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
# Note: DAO can't access VBE, so lineCount and componentType are approximate
$dbe = $null
$db = $null
try {
    $dbe = New-Object -ComObject DAO.DBEngine.120
    $db = $dbe.OpenDatabase($DatabasePath)

    $modules = @()

    # Standard modules via Containers (no MSysObjects permission needed)
    foreach ($doc in $db.Containers("Modules").Documents) {
        if (-not $doc.Name.StartsWith("~")) {
            $modules += @{
                name = $doc.Name
                lineCount = 0
                componentType = 1
            }
        }
    }

    # Form class modules (Form_*)
    foreach ($doc in $db.Containers("Forms").Documents) {
        if (-not $doc.Name.StartsWith("~")) {
            $modules += @{
                name = "Form_" + $doc.Name
                lineCount = 0
                componentType = 100
            }
        }
    }

    # Report class modules (Report_*)
    foreach ($doc in $db.Containers("Reports").Documents) {
        if (-not $doc.Name.StartsWith("~")) {
            $modules += @{
                name = "Report_" + $doc.Name
                lineCount = 0
                componentType = 100
            }
        }
    }

    $modules | ConvertTo-Json -Compress
}
catch {
    Write-Error $_.Exception.Message
    exit 1
}
finally {
    if ($db) { try { $db.Close() } catch {} }
    if ($dbe) { try { [System.Runtime.Interopservices.Marshal]::ReleaseComObject($dbe) | Out-Null } catch {} }
}
