# Convert an .mdb file to .accdb format
# Uses Access.Application.SaveAsNewDatabase after disabling AutoExec via DAO
#
# Usage:  .\convert_mdb.ps1 -DatabasePath "path\to\file.mdb"
#         .\convert_mdb.ps1 -DatabasePath "path\to\file.mdb" -OutputPath "path\to\output.accdb"
#
# If -OutputPath is not specified, the .accdb is created next to the .mdb with the same name.
# Output: JSON with { "success", "inputPath", "outputPath", "autoExecDisabled", "autoExecRestored", "error" }

param(
    [Parameter(Mandatory=$true)]
    [string]$DatabasePath,
    [string]$OutputPath
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

function Escape-JsonStr([string]$s) {
    return $s.Replace('\', '\\').Replace('"', '\"')
}

$app = $null
$autoExecDisabled = $false
$autoExecRestored = $false

try {
    if (-not (Test-Path $DatabasePath)) {
        Write-Output "{`"success`":false,`"error`":`"File not found: $(Escape-JsonStr $DatabasePath)`"}"
        exit 1
    }

    $fullInput = (Resolve-Path $DatabasePath).Path

    # Verify it's an .mdb file
    if (-not $fullInput.ToLower().EndsWith('.mdb')) {
        Write-Output "{`"success`":false,`"error`":`"Input file is not an .mdb file: $(Escape-JsonStr $fullInput)`"}"
        exit 1
    }

    # Default output path: same directory and name, .accdb extension
    if (-not $OutputPath) {
        $OutputPath = [System.IO.Path]::ChangeExtension($fullInput, '.accdb')
    }
    else {
        # Resolve relative paths
        $OutputPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutputPath)
    }

    # Don't overwrite an existing .accdb
    if (Test-Path $OutputPath) {
        Write-Output "{`"success`":false,`"error`":`"Output file already exists: $(Escape-JsonStr $OutputPath)`"}"
        exit 1
    }

    # --- Step 1: Disable AutoExec via DAO (engine-level, no macro trigger) ---
    $engine = $null
    $db = $null
    try {
        $engine = New-Object -ComObject DAO.DBEngine.120
        $db = $engine.OpenDatabase($fullInput, $true)  # exclusive

        $rs = $db.OpenRecordset("SELECT Name FROM MSysObjects WHERE Name = 'AutoExec' AND Type = -32766", 2)
        if (-not $rs.EOF) {
            $rs.Close()
            $db.Execute("UPDATE MSysObjects SET Name = 'xAutoExec' WHERE Name = 'AutoExec' AND Type = -32766")
            $autoExecDisabled = $true
        }
        else {
            $rs.Close()
        }
    }
    finally {
        if ($db) { try { $db.Close() } catch {} }
        if ($engine) { try { [System.Runtime.InteropServices.Marshal]::ReleaseComObject($engine) | Out-Null } catch {} }
    }

    # --- Step 2: Convert via Access.Application ---
    try {
        $app = New-Object -ComObject Access.Application
        $app.AutomationSecurity = 3  # msoAutomationSecurityForceDisable
        $app.OpenCurrentDatabase($fullInput, $false)  # not exclusive (DAO released it)

        # acFileFormatAccess2007 = 12
        $app.SaveAsNewDatabase($OutputPath, 12)

        $app.CloseCurrentDatabase()
    }
    finally {
        if ($app) {
            try { $app.Quit() } catch {}
            try { [System.Runtime.InteropServices.Marshal]::ReleaseComObject($app) | Out-Null } catch {}
            $app = $null
        }
    }

    # --- Step 3: Restore AutoExec in the original .mdb ---
    if ($autoExecDisabled) {
        $engine2 = $null
        $db2 = $null
        try {
            $engine2 = New-Object -ComObject DAO.DBEngine.120
            $db2 = $engine2.OpenDatabase($fullInput, $true)
            $db2.Execute("UPDATE MSysObjects SET Name = 'AutoExec' WHERE Name = 'xAutoExec' AND Type = -32766")
            $autoExecRestored = $true
        }
        finally {
            if ($db2) { try { $db2.Close() } catch {} }
            if ($engine2) { try { [System.Runtime.InteropServices.Marshal]::ReleaseComObject($engine2) | Out-Null } catch {} }
        }
    }

    $result = @{
        success = $true
        inputPath = Escape-JsonStr $fullInput
        outputPath = Escape-JsonStr $OutputPath
        autoExecDisabled = $autoExecDisabled
        autoExecRestored = $autoExecRestored
    }

    Write-Output "{`"success`":true,`"inputPath`":`"$(Escape-JsonStr $fullInput)`",`"outputPath`":`"$(Escape-JsonStr $OutputPath)`",`"autoExecDisabled`":$($autoExecDisabled.ToString().ToLower()),`"autoExecRestored`":$($autoExecRestored.ToString().ToLower())}"
}
catch {
    $msg = $_.Exception.Message -replace '"', '\"'

    # If we disabled AutoExec but failed before restoring, try to restore now
    if ($autoExecDisabled -and -not $autoExecRestored) {
        try {
            $engine3 = New-Object -ComObject DAO.DBEngine.120
            $db3 = $engine3.OpenDatabase($fullInput, $true)
            $db3.Execute("UPDATE MSysObjects SET Name = 'AutoExec' WHERE Name = 'xAutoExec' AND Type = -32766")
            $db3.Close()
            [System.Runtime.InteropServices.Marshal]::ReleaseComObject($engine3) | Out-Null
            $autoExecRestored = $true
        }
        catch {}
    }

    Write-Output "{`"success`":false,`"error`":`"$msg`",`"autoExecDisabled`":$($autoExecDisabled.ToString().ToLower()),`"autoExecRestored`":$($autoExecRestored.ToString().ToLower())}"
    exit 1
}
