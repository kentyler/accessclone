# List all tables in an Access database
# Usage: .\list_tables.ps1 -DatabasePath "path\to\db.accdb"
# Output: JSON array of table objects with name, field count, and row count
# Uses DAO.DBEngine.120 directly to avoid VBA compilation issues

param(
    [Parameter(Mandatory=$true)]
    [string]$DatabasePath
)

# Remove lock file if exists
$lockFile = $DatabasePath -replace '\.accdb$', '.laccdb'
Remove-Item $lockFile -Force -ErrorAction SilentlyContinue

$dbe = $null
$db = $null
try {
    $dbe = New-Object -ComObject DAO.DBEngine.120
    $db = $dbe.OpenDatabase($DatabasePath)

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
}
catch {
    Write-Error $_.Exception.Message
    exit 1
}
finally {
    if ($db) {
        try { $db.Close() } catch {}
    }
    if ($dbe) {
        try { [System.Runtime.Interopservices.Marshal]::ReleaseComObject($dbe) | Out-Null } catch {}
    }
}
