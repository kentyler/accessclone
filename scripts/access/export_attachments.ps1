# Export attachment files from Access attachment columns (DAO type 101)
# Usage: .\export_attachments.ps1 -DatabasePath "path\to\db.accdb" -TableName "Employees" -OutputDir "C:\staging\attachments"
# Output: JSON manifest to stdout with file metadata; files saved to OutputDir/{pkValue}/{fileName}
#
# Attachment columns in Access are multi-valued fields. Each record can have
# multiple attached files stored in a hidden child recordset. This script
# iterates records, opens each attachment child recordset, and saves files.

param(
    [Parameter(Mandatory=$true)]
    [string]$DatabasePath,

    [Parameter(Mandatory=$true)]
    [string]$TableName,

    [Parameter(Mandatory=$true)]
    [string]$OutputDir
)

# Force UTF-8 output so Node.js (which reads stdout as utf8) gets correct bytes
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

# Diagnostic output goes to stderr so it doesn't pollute JSON on stdout
function Log-Info([string]$msg) { [Console]::Error.WriteLine($msg) }
function Log-Warn([string]$msg) { [Console]::Error.WriteLine("WARNING: $msg") }

# Use .NET's built-in JSON string escaper
$script:useNetEscape = $false
try {
    Add-Type -AssemblyName System.Web
    $script:useNetEscape = $true
} catch {}

function Escape-JsonStr([string]$s) {
    if ($script:useNetEscape) {
        return [System.Web.HttpUtility]::JavaScriptStringEncode($s)
    }
    $s = $s.Replace('\', '\\')
    $s = $s.Replace('"', '\"')
    $s = $s.Replace("`b", '\b')
    $s = $s.Replace("`f", '\f')
    $s = $s.Replace("`t", '\t')
    $s = $s.Replace("`n", '\n')
    $s = $s.Replace("`r", '\r')
    return $s
}

# Ensure output directory exists
if (-not (Test-Path $OutputDir)) {
    New-Item -Path $OutputDir -ItemType Directory -Force | Out-Null
}

$dbe = $null
$db = $null
$rs = $null

try {
    $dbe = New-Object -ComObject DAO.DBEngine.120
    $db = $dbe.OpenDatabase($DatabasePath)

    $tableDef = $db.TableDefs.Item($TableName)

    # Find attachment columns (DAO type 101 = dbAttachment)
    $attachmentColumns = @()
    foreach ($field in $tableDef.Fields) {
        if ([int]$field.Type -eq 101) {
            $attachmentColumns += $field.Name
        }
    }

    if ($attachmentColumns.Count -eq 0) {
        Log-Info "No attachment columns found in table '$TableName'"
        Write-Output ('{"tableName":"' + (Escape-JsonStr $TableName) + '","pkColumn":null,"attachmentColumns":[],"files":[]}')
        exit 0
    }

    Log-Info "Found $($attachmentColumns.Count) attachment column(s): $($attachmentColumns -join ', ')"

    # Find primary key column from indexes
    $pkColumn = $null
    foreach ($idx in $tableDef.Indexes) {
        if ($idx.Primary) {
            # Use the first field of the PK index
            $pkColumn = $idx.Fields.Item(0).Name
            break
        }
    }

    if (-not $pkColumn) {
        Log-Warn "No primary key found for table '$TableName'. Using first column as identifier."
        $pkColumn = $tableDef.Fields.Item(0).Name
    }

    Log-Info "Primary key column: $pkColumn"

    # Open snapshot recordset for the table
    $rs = $db.OpenRecordset("SELECT * FROM [$TableName]", 4)  # 4 = dbOpenSnapshot

    $files = @()
    $recordCount = 0

    while (-not $rs.EOF) {
        $recordCount++
        $pkValue = $rs.Fields.Item($pkColumn).Value
        if ($null -eq $pkValue) {
            $rs.MoveNext()
            continue
        }
        $pkStr = [string]$pkValue

        foreach ($colName in $attachmentColumns) {
            $field = $rs.Fields.Item($colName)

            # Attachment fields expose a child Recordset2 via .Value
            $childRs = $null
            try {
                $childRs = $field.Value
            } catch {
                Log-Warn "Could not access child recordset for $colName on PK=$pkStr : $_"
                continue
            }

            if ($null -eq $childRs) { continue }

            $sortOrder = 0
            while (-not $childRs.EOF) {
                try {
                    $fileName = $childRs.Fields.Item("FileName").Value
                    if (-not $fileName) {
                        $childRs.MoveNext()
                        continue
                    }

                    # Create output directory: OutputDir/{pkValue}/
                    $safeKey = $pkStr -replace '[\\/:*?"<>|]', '_'
                    $destDir = Join-Path $OutputDir $safeKey
                    if (-not (Test-Path $destDir)) {
                        New-Item -Path $destDir -ItemType Directory -Force | Out-Null
                    }

                    $destPath = Join-Path $destDir $fileName

                    # SaveToFile saves the current attachment to a file path
                    # The FileData field contains the raw binary data
                    $childRs.Fields.Item("FileData").SaveToFile($destPath)

                    $fileSize = 0
                    if (Test-Path $destPath) {
                        $fileSize = (Get-Item $destPath).Length
                    }

                    $files += @{
                        pkValue = $pkStr
                        columnName = $colName
                        fileName = $fileName
                        sizeBytes = $fileSize
                        sortOrder = $sortOrder
                    }

                    Log-Info "  Saved: PK=$pkStr, Col=$colName, File=$fileName ($fileSize bytes)"
                    $sortOrder++
                } catch {
                    Log-Warn "Error saving attachment for PK=$pkStr, Col=$colName : $_"
                }

                $childRs.MoveNext()
            }

            try { $childRs.Close() } catch {}
        }

        $rs.MoveNext()
    }

    Log-Info "Processed $recordCount records, extracted $($files.Count) files"

    # Build JSON output manually (safe for embedded quotes)
    $colsJson = ($attachmentColumns | ForEach-Object { '"' + (Escape-JsonStr $_) + '"' }) -join ','
    $fileParts = @()
    foreach ($f in $files) {
        $part = '{"pkValue":"' + (Escape-JsonStr $f.pkValue) + '",' +
                '"columnName":"' + (Escape-JsonStr $f.columnName) + '",' +
                '"fileName":"' + (Escape-JsonStr $f.fileName) + '",' +
                '"sizeBytes":' + $f.sizeBytes + ',' +
                '"sortOrder":' + $f.sortOrder + '}'
        $fileParts += $part
    }

    $json = '{"tableName":"' + (Escape-JsonStr $TableName) + '",' +
            '"pkColumn":"' + (Escape-JsonStr $pkColumn) + '",' +
            '"attachmentColumns":[' + $colsJson + '],' +
            '"files":[' + ($fileParts -join ',') + ']}'

    Write-Output $json

} catch {
    Log-Warn "Fatal error: $($_.Exception.Message)"
    Write-Output '{"error":"' + (Escape-JsonStr $_.Exception.Message) + '"}'
    exit 1
}
finally {
    if ($rs) { try { $rs.Close() } catch {} }
    if ($db) { try { $db.Close() } catch {} }
    if ($dbe) {
        try { [System.Runtime.Interopservices.Marshal]::ReleaseComObject($dbe) | Out-Null } catch {}
    }
}
