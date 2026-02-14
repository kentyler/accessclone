# List all VBA modules in an Access database (standard, class, and form/report class modules)
# Usage: .\list_modules.ps1 -DatabasePath "path\to\db.accdb"
# Output: JSON array of module objects with name, lineCount, and componentType

param(
    [Parameter(Mandatory=$true)]
    [string]$DatabasePath
)

# Kill any existing Access processes
Get-Process MSACCESS -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 500

# Remove lock file if exists
$lockFile = $DatabasePath -replace '\.accdb$', '.laccdb'
Remove-Item $lockFile -Force -ErrorAction SilentlyContinue

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
            # Could not access code module — for document modules (type 100)
            # this may mean we need to open the form/report in design view first
        }

        # Skip document modules only if we CONFIRMED they have no code.
        # If CodeModule was inaccessible, include them — export will retry
        # with the form/report open in design view.
        if ($compType -eq 100 -and $codeReadOK -and $lineCount -eq 0) {
            continue
        }

        $moduleInfo = @{
            name = $component.Name
            lineCount = $lineCount
            componentType = $compType
        }

        $modules += $moduleInfo
    }

    # Output as JSON
    $modules | ConvertTo-Json -Compress

    $accessApp.CloseCurrentDatabase()
}
catch {
    Write-Error $_.Exception.Message
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
