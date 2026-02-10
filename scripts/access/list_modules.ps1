# List all VBA modules in an Access database
# Usage: .\list_modules.ps1 -DatabasePath "path\to\db.accdb"
# Output: JSON array of module objects with name and line count

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
    foreach ($module in $accessApp.CurrentProject.AllModules) {
        $moduleInfo = @{
            name = $module.Name
            lineCount = 0
        }

        # Try to get line count by opening the module
        try {
            $accessApp.DoCmd.OpenModule($module.Name)
            $moduleObj = $accessApp.Modules($module.Name)
            $moduleInfo.lineCount = $moduleObj.CountOfLines
            $accessApp.DoCmd.Close(5, $module.Name)  # acModule = 5
        } catch {
            # Could not get line count
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
