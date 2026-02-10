# List all tables in an Access database
# Usage: .\list_tables.ps1 -DatabasePath "path\to\db.accdb"
# Output: JSON array of table objects with name, field count, and row count

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
    $db = $accessApp.CurrentDb

    $tables = @()
    foreach ($table in $db.TableDefs) {
        # Skip system tables
        if (-not $table.Name.StartsWith("MSys") -and -not $table.Name.StartsWith("~")) {
            $tableInfo = @{
                name = $table.Name
                fieldCount = $table.Fields.Count
            }

            # Try to get row count
            try {
                $rs = $db.OpenRecordset("SELECT COUNT(*) FROM [$($table.Name)]")
                $tableInfo.rowCount = $rs.Fields(0).Value
                $rs.Close()
            } catch {
                $tableInfo.rowCount = -1
            }

            $tables += $tableInfo
        }
    }

    # Output as JSON
    $tables | ConvertTo-Json -Compress

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
