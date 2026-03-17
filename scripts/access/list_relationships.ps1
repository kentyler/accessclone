# List all relationships in an Access database
# Usage: .\list_relationships.ps1 -DatabasePath "path\to\db.accdb"
# Output: JSON array of relationship objects
# Uses DAO.DBEngine.120 directly to avoid VBA compilation issues

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

$dbe = $null
$db = $null
try {
    $dbe = New-Object -ComObject DAO.DBEngine.120
    $db = $dbe.OpenDatabase($DatabasePath)

    $relationships = @()
    foreach ($rel in $db.Relations) {
        # Skip system relationships
        if ($rel.Name.StartsWith("MSys")) { continue }

        $fields = @()
        foreach ($f in $rel.Fields) {
            $fields += @{
                primary = $f.ForeignName
                foreign = $f.Name
            }
        }

        $relationships += @{
            name         = $rel.Name
            primaryTable = $rel.Table
            foreignTable = $rel.ForeignTable
            fields       = $fields
        }
    }

    # Output as JSON
    $relationships | ConvertTo-Json -Compress -Depth 3
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
