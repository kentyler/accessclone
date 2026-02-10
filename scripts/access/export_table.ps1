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

# Types to skip: OLE (11), Binary (17), Calculated (18), Attachment (19)
$skipTypes = @(11, 17, 18, 19)

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

        $fields += $fieldInfo
        $includedFieldNames += $field.Name
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

                if ($null -eq $val) {
                    $row[$fname] = $null
                } elseif ($fType -eq 1) {
                    # Yes/No -> boolean
                    $row[$fname] = [bool]$val
                } elseif ($fType -eq 8) {
                    # Date/Time -> ISO 8601
                    $row[$fname] = ([datetime]$val).ToString("yyyy-MM-ddTHH:mm:ss")
                } elseif ($fType -eq 15) {
                    # GUID -> string
                    $row[$fname] = $val.ToString()
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
