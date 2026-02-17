# Detect Access database version using DAO
# Uses DAO.DBEngine.120 directly — does NOT open Access UI, does NOT trigger AutoExec
#
# Usage:
#   .\detect_version.ps1 -DatabasePath "path\to\db.accdb"
#
# Output: JSON with { "fileFormat", "daoVersion", "accessVersion", "error" }
#
# Version mapping:
#   DAO Version 4.0 + .accdb = Access 2007+ (file format doesn't distinguish 2007/2010/2013/2016/365)
#   DAO Version 4.0 + .mdb   = Access 2000/2003
#   DAO Version 3.0 + .mdb   = Access 97 (reported as '1997' for correct lexicographic sorting)

param(
    [Parameter(Mandatory=$true)]
    [string]$DatabasePath
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$db = $null
$engine = $null

try {
    if (-not (Test-Path $DatabasePath)) {
        Write-Output "{`"error`":`"File not found: $DatabasePath`"}"
        exit 1
    }

    $engine = New-Object -ComObject DAO.DBEngine.120

    # Open read-only (False = not exclusive), read-only flag = True
    $db = $engine.OpenDatabase($DatabasePath, $false, $true)

    $daoVersion = $db.Version
    $ext = [System.IO.Path]::GetExtension($DatabasePath).ToLower()

    # Determine file format
    $fileFormat = "unknown"
    if ($ext -eq ".accdb") {
        $fileFormat = "accdb"
    } elseif ($ext -eq ".mdb") {
        $fileFormat = "mdb"
    }

    # Map DAO version + file format to Access version
    # DAO 4.0 = Access 2000+ engine
    # DAO 3.0 = Access 97 engine
    # .accdb format = Access 2007+ (the file format itself doesn't encode 2010/2013/2016/365)
    # .mdb with DAO 4.0 = Access 2000 or 2003
    # .mdb with DAO 3.0 = Access 97
    $accessVersion = "unknown"
    switch ($daoVersion) {
        "4.0" {
            if ($fileFormat -eq "accdb") {
                # Best we can determine from the file alone is "2007+"
                # The .accdb format was introduced in 2007 and hasn't changed structurally
                $accessVersion = "2007"
            } else {
                # .mdb with DAO 4.0 = Access 2000/2003
                $accessVersion = "2000"
            }
        }
        "3.0" {
            $accessVersion = "1997"
        }
        default {
            $accessVersion = "unknown"
        }
    }

    Write-Output "{`"fileFormat`":`"$fileFormat`",`"daoVersion`":`"$daoVersion`",`"accessVersion`":`"$accessVersion`"}"
}
catch {
    $msg = $_.Exception.Message -replace '"', '\"'
    Write-Output "{`"error`":`"$msg`"}"
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
