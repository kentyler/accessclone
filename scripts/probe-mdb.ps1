param([string]$DbPath)

$dbe = New-Object -ComObject DAO.DBEngine.120
$db = $dbe.OpenDatabase($DbPath, $false, $true)

# Check database properties for startup settings
Write-Host "=== Database Properties ==="
try {
    foreach ($p in $db.Properties) {
        try {
            $name = $p.Name
            $val = $p.Value
            if ($name -match "Start|Form|Display|AllowFull|AppTitle") {
                Write-Host "  $name = $val"
            }
        } catch {}
    }
} catch { Write-Host "  Properties error: $_" }

# Check for AutoExec or auto-named macros
Write-Host "`n=== Macros in MSysObjects ==="
try {
    $rs = $db.OpenRecordset("SELECT Name, Type FROM MSysObjects WHERE Type = -32766", 4)
    while (-not $rs.EOF) {
        Write-Host "  $($rs.Fields('Name').Value) (Type: $($rs.Fields('Type').Value))"
        $rs.MoveNext()
    }
    $rs.Close()
} catch { Write-Host "  MSysObjects query failed: $_" }

# Check table count
Write-Host "`n=== Tables ==="
$count = 0
foreach ($td in $db.TableDefs) {
    if (-not $td.Name.StartsWith("MSys") -and -not $td.Name.StartsWith("~")) {
        $count++
    }
}
Write-Host "  $count user tables"

$db.Close()
[System.Runtime.Interopservices.Marshal]::ReleaseComObject($dbe) | Out-Null
Write-Host "`nDone."
