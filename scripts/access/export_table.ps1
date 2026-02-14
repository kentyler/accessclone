# Export table structure + data from an Access database
# Usage: .\export_table.ps1 -DatabasePath "path\to\db.accdb" -TableName "MyTable"
# Output: JSON with fields[], indexes[], rows[], skippedColumns[], rowCount, fieldCount
# Uses DAO.DBEngine.120 directly to avoid VBA compilation issues

param(
    [Parameter(Mandatory=$true)]
    [string]$DatabasePath,
    [Parameter(Mandatory=$true)]
    [string]$TableName
)

# Force UTF-8 output so Node.js (which reads stdout as utf8) gets correct bytes
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

# Types to skip: OLE (11), Binary (17), Attachment (19)
# Note: Calculated (18) is now handled — extracted as PG generated columns
$skipTypes = @(11, 17, 19)

# Use .NET's built-in JSON string escaper — handles all edge cases
# (embedded quotes, backslashes, control chars, Unicode) correctly.
# Falls back to manual escaping if System.Web is unavailable.
$script:useNetEscape = $false
try {
    Add-Type -AssemblyName System.Web
    $script:useNetEscape = $true
} catch {}

function Escape-JsonStr([string]$s) {
    if ($script:useNetEscape) {
        return [System.Web.HttpUtility]::JavaScriptStringEncode($s)
    }
    # Manual fallback — covers all JSON-required escapes
    $s = $s.Replace('\', '\\')
    $s = $s.Replace('"', '\"')
    $s = $s.Replace("`b", '\b')
    $s = $s.Replace("`f", '\f')
    $s = $s.Replace("`t", '\t')
    $s = $s.Replace("`n", '\n')
    $s = $s.Replace("`r", '\r')
    return $s
}

function ConvertTo-SafeJson($obj) {
    if ($null -eq $obj -or $obj -is [System.DBNull]) { return 'null' }
    if ($obj -is [bool]) { if ($obj) { return 'true' } else { return 'false' } }
    if ($obj -is [int] -or $obj -is [long] -or $obj -is [double] -or $obj -is [decimal] -or $obj -is [single]) {
        return $obj.ToString([System.Globalization.CultureInfo]::InvariantCulture)
    }
    if ($obj -is [string]) { return '"' + (Escape-JsonStr $obj) + '"' }
    if ($obj -is [hashtable]) {
        if ($obj.Count -eq 0) { return '{}' }
        $pairs = [System.Collections.ArrayList]::new()
        foreach ($key in $obj.Keys) {
            [void]$pairs.Add(('"' + (Escape-JsonStr ([string]$key)) + '":' + (ConvertTo-SafeJson $obj[$key])))
        }
        return '{' + ($pairs -join ',') + '}'
    }
    if ($obj -is [array]) {
        if ($obj.Count -eq 0) { return '[]' }
        $items = [System.Collections.ArrayList]::new()
        foreach ($item in $obj) {
            [void]$items.Add((ConvertTo-SafeJson $item))
        }
        return '[' + ($items -join ',') + ']'
    }
    # Fallback: treat as string
    return '"' + (Escape-JsonStr ([string]$obj)) + '"'
}

# Remove lock file if exists
$lockFile = $DatabasePath -replace '\.accdb$', '.laccdb'
Remove-Item $lockFile -Force -ErrorAction SilentlyContinue

$dbe = $null
$db = $null
try {
    $dbe = New-Object -ComObject DAO.DBEngine.120
    $db = $dbe.OpenDatabase($DatabasePath)

    $tableDef = $db.TableDefs.Item($TableName)

    # Extract field definitions
    $fields = @()
    $skippedColumns = @()
    $includedFieldNames = @()

    foreach ($field in $tableDef.Fields) {
        $typeCode = [int]$field.Type

        if ($skipTypes -contains $typeCode) {
            $skippedColumns += @{
                name = $field.Name
                typeCode = $typeCode
            }
            continue
        }

        $fieldInfo = @{
            name = $field.Name
            type = $typeCode
            size = $field.Size
            required = [bool]$field.Required
            allowZeroLength = [bool]$field.AllowZeroLength
        }

        # Check if AutoNumber (attributes flag 0x10 = dbAutoIncrField)
        $fieldInfo.isAutoNumber = (($field.Attributes -band 0x10) -ne 0)

        # Default value
        try {
            if ($field.DefaultValue) {
                $fieldInfo.defaultValue = $field.DefaultValue
            }
        } catch {}

        # For calculated columns (type 18), extract expression and result type
        if ($typeCode -eq 18) {
            $fieldInfo.isCalculated = $true
            try {
                $fieldInfo.expression = $field.Expression
            } catch {
                $fieldInfo.expression = $null
            }
            # Get the result type from the calculated field's ResultType property
            try {
                $fieldInfo.resultType = [int]$field.Properties.Item("ResultType").Value
            } catch {
                $fieldInfo.resultType = 10  # Default to text if can't determine
            }
        }

        $fields += $fieldInfo
        # Don't add calculated fields to $includedFieldNames — their values are
        # computed by PG and can't be INSERT'd into a GENERATED column.
        if ($typeCode -ne 18) {
            $includedFieldNames += $field.Name
        }
    }

    # Extract indexes
    $indexes = @()
    foreach ($idx in $tableDef.Indexes) {
        $idxFields = @()
        foreach ($idxField in $idx.Fields) {
            $idxFields += $idxField.Name
        }
        $indexes += @{
            name = $idx.Name
            primary = [bool]$idx.Primary
            unique = [bool]$idx.Unique
            fields = $idxFields
        }
    }

    # Extract row data
    $rows = @()
    $rs = $db.OpenRecordset("SELECT * FROM [$TableName]", 4) # 4 = dbOpenSnapshot
    if (-not $rs.EOF) {
        $rs.MoveFirst()
        while (-not $rs.EOF) {
            $row = @{}
            foreach ($fname in $includedFieldNames) {
                $val = $rs.Fields.Item($fname).Value
                $fType = $rs.Fields.Item($fname).Type

                if ($null -eq $val -or $val -is [System.DBNull]) {
                    $row[$fname] = $null
                } elseif ($fType -eq 1) {
                    # Yes/No -> boolean
                    $row[$fname] = [bool]$val
                } elseif ($fType -eq 8) {
                    # Date/Time -> ISO 8601
                    try {
                        $row[$fname] = ([datetime]$val).ToString("yyyy-MM-ddTHH:mm:ss")
                    } catch {
                        $row[$fname] = $null
                    }
                } elseif ($fType -eq 15) {
                    # GUID -> string
                    $row[$fname] = $val.ToString()
                } elseif ($fType -eq 10 -or $fType -eq 12) {
                    # Text/Memo -> force string, sanitize control chars that break JSON
                    $str = [string]$val
                    # Remove NUL and other control chars (keep tab 0x09, newline 0x0A, CR 0x0D)
                    $str = $str -replace '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]', ''
                    $row[$fname] = $str
                } else {
                    $row[$fname] = $val
                }
            }
            $rows += $row
            $rs.MoveNext()
        }
    }
    $rs.Close()

    $result = @{
        tableName = $TableName
        fields = $fields
        indexes = $indexes
        rows = $rows
        skippedColumns = $skippedColumns
        rowCount = $rows.Count
        fieldCount = $fields.Count
    }

    ConvertTo-SafeJson $result
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
