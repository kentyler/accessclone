# List all queries in an Access database
# Usage: .\list_queries.ps1 -DatabasePath "path\to\db.accdb"
# Output: JSON array of query objects with name and type
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

    $queries = @()
    foreach ($query in $db.QueryDefs) {
        # Skip temp queries (start with ~)
        if (-not $query.Name.StartsWith("~")) {
            # Determine query type from Type property
            # 0=Select, 16=Crosstab, 32=Delete, 48=Update, 64=Append, 80=MakeTable
            $queryType = switch ($query.Type) {
                0 { "Select" }
                16 { "Crosstab" }
                32 { "Delete" }
                48 { "Update" }
                64 { "Append" }
                80 { "MakeTable" }
                96 { "DDL" }
                112 { "PassThrough" }
                128 { "Union" }
                default { "Other" }
            }

            $queryInfo = @{
                name = $query.Name
                type = $queryType
            }
            $queries += $queryInfo
        }
    }

    # Output as JSON
    $queries | ConvertTo-Json -Compress
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
