# Export query SQL, type, and parameters from an Access database
# Usage: .\export_query.ps1 -DatabasePath "path\to\db.accdb" -QueryName "MyQuery"
# Output: JSON with queryName, queryType, queryTypeCode, sql, parameters
# Uses DAO.DBEngine.120 directly to avoid VBA compilation issues

param(
    [Parameter(Mandatory=$true)]
    [string]$DatabasePath,
    [Parameter(Mandatory=$true)]
    [string]$QueryName
)

# Remove lock file if exists
$lockFile = $DatabasePath -replace '\.accdb$', '.laccdb'
Remove-Item $lockFile -Force -ErrorAction SilentlyContinue

$dbe = $null
$db = $null
try {
    $dbe = New-Object -ComObject DAO.DBEngine.120
    $db = $dbe.OpenDatabase($DatabasePath)

    $queryDef = $db.QueryDefs.Item($QueryName)

    # Determine query type
    $typeCode = [int]$queryDef.Type
    $queryType = switch ($typeCode) {
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

    # Extract SQL
    $sql = $queryDef.SQL

    # Extract parameters — may fail if SQL uses VBA functions like Nz()
    $parameters = @()
    $paramWarning = $null
    try {
        foreach ($param in $queryDef.Parameters) {
            # DAO parameter Type codes:
            # 1=Boolean, 2=Byte, 3=Integer, 4=Long, 5=Currency,
            # 6=Single, 7=Double, 8=Date, 10=Text, 12=Memo
            $paramType = switch ([int]$param.Type) {
                1 { "Boolean" }
                2 { "Byte" }
                3 { "Integer" }
                4 { "Long" }
                5 { "Currency" }
                6 { "Single" }
                7 { "Double" }
                8 { "Date" }
                10 { "Text" }
                12 { "Memo" }
                default { "Text" }
            }
            $parameters += @{
                name = $param.Name
                type = $paramType
            }
        }
    }
    catch {
        $paramWarning = "Could not extract parameters: $($_.Exception.Message)"
    }

    $result = @{
        queryName = $QueryName
        queryType = $queryType
        queryTypeCode = $typeCode
        sql = $sql
        parameters = $parameters
    }
    if ($paramWarning) {
        $result.paramWarning = $paramWarning
    }

    $result | ConvertTo-Json -Depth 10 -Compress
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
