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

# Types to skip: OLE (11), Binary (17), Attachment (19)
# Note: Calculated (18) is now handled — extracted as PG generated columns
$skipTypes = @(11, 17, 19)

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
