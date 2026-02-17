# Disable or restore AutoExec macro in an Access database
# Uses DAO.DBEngine directly — does NOT open Access UI, does NOT trigger AutoExec
#
# Usage:
#   Disable:  .\disable_autoexec.ps1 -DatabasePath "path\to\db.accdb"
#   Restore:  .\disable_autoexec.ps1 -DatabasePath "path\to\db.accdb" -Restore
#
# Output: JSON with { "action", "found", "name", "error" }

param(
    [Parameter(Mandatory=$true)]
    [string]$DatabasePath,
    [switch]$Restore
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$db = $null
$engine = $null

try {
    if (-not (Test-Path $DatabasePath)) {
        Write-Output "{`"action`":`"error`",`"error`":`"File not found: $DatabasePath`"}"
        exit 1
    }

    $engine = New-Object -ComObject DAO.DBEngine.120

    # Open exclusively (True) so we can modify system tables
    $db = $engine.OpenDatabase($DatabasePath, $true)

    if ($Restore) {
        # Rename xAutoExec back to AutoExec
        $rs = $db.OpenRecordset("SELECT Name FROM MSysObjects WHERE Name = 'xAutoExec' AND Type = -32766", 2)
        if ($rs.EOF) {
            $rs.Close()
            Write-Output "{`"action`":`"restore`",`"found`":false}"
            exit 0
        }
        $rs.Close()

        $db.Execute("UPDATE MSysObjects SET Name = 'AutoExec' WHERE Name = 'xAutoExec' AND Type = -32766")
        Write-Output "{`"action`":`"restore`",`"found`":true,`"name`":`"AutoExec`"}"
    }
    else {
        # Rename AutoExec to xAutoExec
        $rs = $db.OpenRecordset("SELECT Name FROM MSysObjects WHERE Name = 'AutoExec' AND Type = -32766", 2)
        if ($rs.EOF) {
            $rs.Close()
            Write-Output "{`"action`":`"disable`",`"found`":false}"
            exit 0
        }
        $rs.Close()

        $db.Execute("UPDATE MSysObjects SET Name = 'xAutoExec' WHERE Name = 'AutoExec' AND Type = -32766")
        Write-Output "{`"action`":`"disable`",`"found`":true,`"name`":`"xAutoExec`"}"
    }
}
catch {
    $msg = $_.Exception.Message -replace '"', '\"'
    Write-Output "{`"action`":`"error`",`"error`":`"$msg`"}"
    exit 1
}
finally {
    if ($db) {
        try { $db.Close() } catch {}
    }
    if ($engine) {
        try { [System.Runtime.InteropServices.Marshal]::ReleaseComObject($engine) | Out-Null } catch {}
    }
}
