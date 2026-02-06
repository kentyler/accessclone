# Diagnose Access Database for Conversion Readiness
# Usage: .\diagnose_database.ps1 -DatabasePath "path\to\db.accdb"
# Optional: -OutputPath "path\to\report.json" (default: stdout)
# Output: JSON diagnostic report for LLM consumption

param(
    [Parameter(Mandatory=$true)]
    [string]$DatabasePath,

    [string]$OutputPath
)

# ============================================================
# PostgreSQL reserved words (subset most likely to collide)
# ============================================================
$pgReservedWords = @(
    'all','analyse','analyze','and','any','array','as','asc','asymmetric',
    'authorization','between','bigint','binary','bit','boolean','both','case',
    'cast','char','character','check','coalesce','collate','column','concurrently',
    'constraint','create','cross','current_date','current_role','current_time',
    'current_timestamp','current_user','default','deferrable','desc','distinct',
    'do','else','end','except','exists','extract','false','fetch','float','for',
    'foreign','freeze','from','full','grant','group','having','ilike','in',
    'index','initially','inner','inout','int','integer','intersect','interval',
    'into','is','isnull','join','lateral','leading','left','like','limit',
    'localtime','localtimestamp','natural','new','not','notnull','null','numeric',
    'off','offset','old','on','only','or','order','out','outer','overlaps',
    'placing','position','primary','real','references','returning','right',
    'row','select','session_user','setof','similar','smallint','some','substring',
    'symmetric','table','then','to','trailing','trim','true','union','unique',
    'user','using','values','varchar','verbose','when','where','window','with'
)

# Access field type codes
$accessTypeNames = @{
    1  = "Yes/No"
    2  = "Byte"
    3  = "Integer"
    4  = "Long"
    5  = "Currency"
    6  = "Single"
    7  = "Double"
    8  = "Date/Time"
    10 = "Text"
    11 = "OLE Object"
    12 = "Memo"
    15 = "GUID"
    16 = "BigInt"
    17 = "Binary"
    18 = "Calculated"
    19 = "Attachment"
}

# Types that are problematic for PostgreSQL conversion
$problematicTypes = @(11, 17, 18)    # OLE Object, Binary, Attachment
$calculatedType   = 18               # Calculated fields

function Safe-Get {
    param($obj, [string]$prop, $default = $null)
    try {
        $val = $obj.$prop
        if ($null -ne $val) { return $val }
        return $default
    } catch { return $default }
}

# ============================================================
# Cleanup / setup
# ============================================================
Get-Process MSACCESS -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 500

$lockFile = $DatabasePath -replace '\.accdb$', '.laccdb'
Remove-Item $lockFile -Force -ErrorAction SilentlyContinue

# ============================================================
# Main diagnostic
# ============================================================
$accessApp = $null
$startTime = Get-Date

try {
    $accessApp = New-Object -ComObject Access.Application
    $accessApp.Visible = $false
    $accessApp.OpenCurrentDatabase($DatabasePath)
    $db = $accessApp.CurrentDb

    # Result containers
    $findings = @()
    $checks   = @()
    $summary  = @{ errors = 0; warnings = 0; info = 0 }

    function Add-Finding {
        param(
            [string]$Check,
            [string]$Severity,
            [string]$ObjectType,
            [string]$ObjectName,
            [string]$Message,
            [string]$Suggestion
        )
        $script:findings += @{
            check       = $Check
            severity    = $Severity
            object_type = $ObjectType
            object_name = $ObjectName
            message     = $Message
            suggestion  = $Suggestion
        }
        $script:summary[$Severity]++
    }

    function Run-Check {
        param([string]$Name, [scriptblock]$Block)
        $t0 = Get-Date
        $countBefore = $script:findings.Count
        try {
            & $Block
            $ran = $true
        } catch {
            $ran = $false
            Write-Host "  Check '$Name' failed: $($_.Exception.Message)" -ForegroundColor Yellow
        }
        $t1 = Get-Date
        $script:checks += @{
            check       = $Name
            ran         = $ran
            count       = $script:findings.Count - $countBefore
            duration_ms = [int]($t1 - $t0).TotalMilliseconds
        }
    }

    # ----------------------------------------------------------
    # Collect inventory (shared across checks)
    # ----------------------------------------------------------
    Write-Host "Collecting inventory..." -ForegroundColor Cyan

    $tables = @()
    foreach ($td in $db.TableDefs) {
        if ($td.Name.StartsWith("MSys") -or $td.Name.StartsWith("~")) { continue }

        $fields = @()
        $hasAutoNumber = $false
        foreach ($f in $td.Fields) {
            $isAutoNum = ($f.Attributes -band 16) -ne 0
            if ($isAutoNum) { $hasAutoNumber = $true }
            $fields += @{
                name       = $f.Name
                type       = [int]$f.Type
                typeName   = $accessTypeNames[[int]$f.Type]
                size       = [int]$f.Size
                required   = ($f.Required -eq $true)
                allowZero  = ($f.AllowZeroLength -eq $true)
                isAutoNum  = $isAutoNum
            }
        }

        # Row count
        $rowCount = 0
        try {
            $rs = $db.OpenRecordset("SELECT COUNT(*) FROM [$($td.Name)]")
            $rowCount = $rs.Fields(0).Value
            $rs.Close()
        } catch { $rowCount = -1 }

        $tables += @{
            name          = $td.Name
            fields        = $fields
            fieldCount    = $fields.Count
            rowCount      = $rowCount
            hasAutoNumber = $hasAutoNumber
        }
    }

    # Queries
    $queries = @()
    foreach ($qd in $db.QueryDefs) {
        if ($qd.Name.StartsWith("~")) { continue }
        $queries += @{
            name = $qd.Name
            type = [int]$qd.Type
            sql  = $qd.SQL
        }
    }

    # Relationships
    $relationships = @()
    foreach ($rel in $db.Relations) {
        if ($rel.Name.StartsWith("MSys")) { continue }
        $relFields = @()
        foreach ($f in $rel.Fields) {
            $relFields += @{ foreign = $f.Name; primary = $f.ForeignName }
        }
        $relationships += @{
            name         = $rel.Name
            foreignTable = $rel.ForeignTable
            primaryTable = $rel.Table
            fields       = $relFields
        }
    }

    # Forms
    $formNames = @()
    foreach ($f in $accessApp.CurrentProject.AllForms) { $formNames += $f.Name }

    # Reports
    $reportNames = @()
    foreach ($r in $accessApp.CurrentProject.AllReports) { $reportNames += $r.Name }

    # Modules
    $moduleNames = @()
    foreach ($m in $accessApp.CurrentProject.AllModules) { $moduleNames += $m.Name }

    Write-Host "  Tables: $($tables.Count), Queries: $($queries.Count), Forms: $($formNames.Count), Reports: $($reportNames.Count), Modules: $($moduleNames.Count)" -ForegroundColor Cyan

    # ==========================================================
    # CHECK 1: tables-without-pk
    # ==========================================================
    Run-Check "tables-without-pk" {
        Write-Host "  [1/12] Tables without primary key..." -ForegroundColor Gray
        foreach ($t in $tables) {
            if (-not $t.hasAutoNumber) {
                # Also check for explicit PK index
                $hasPK = $false
                try {
                    foreach ($idx in $db.TableDefs($t.name).Indexes) {
                        if ($idx.Primary) { $hasPK = $true; break }
                    }
                } catch {}

                if (-not $hasPK) {
                    Add-Finding -Check "tables-without-pk" -Severity "error" `
                        -ObjectType "table" -ObjectName $t.name `
                        -Message "Table has no primary key (no AutoNumber and no PK index). The form editor cannot distinguish inserts from updates." `
                        -Suggestion "Identify a natural key column, or plan to add 'id serial PRIMARY KEY' after migration."
                }
            }
        }
    }

    # ==========================================================
    # CHECK 2: duplicate-candidate-keys
    # ==========================================================
    Run-Check "duplicate-candidate-keys" {
        Write-Host "  [2/12] Checking candidate keys for no-PK tables..." -ForegroundColor Gray
        $noPkTables = $tables | Where-Object {
            -not $_.hasAutoNumber -and $_.rowCount -gt 0
        }
        foreach ($t in $noPkTables) {
            # Check if this table has an explicit PK index
            $hasPK = $false
            try {
                foreach ($idx in $db.TableDefs($t.name).Indexes) {
                    if ($idx.Primary) { $hasPK = $true; break }
                }
            } catch {}
            if ($hasPK) { continue }

            foreach ($f in $t.fields) {
                # Only check text/number fields as candidate keys
                if ($f.type -in @(10, 3, 4, 5, 7, 8, 15, 16)) {
                    try {
                        $rs = $db.OpenRecordset("SELECT COUNT(*) AS c, COUNT(DISTINCT [$($f.name)]) AS d FROM [$($t.name)] WHERE [$($f.name)] IS NOT NULL")
                        $total = $rs.Fields("c").Value
                        $distinct = $rs.Fields("d").Value
                        $rs.Close()
                        if ($total -gt 0 -and $total -ne $distinct) {
                            Add-Finding -Check "duplicate-candidate-keys" -Severity "warning" `
                                -ObjectType "column" -ObjectName "$($t.name).$($f.name)" `
                                -Message "Column has $total non-null values but only $distinct distinct. Cannot serve as natural PK." `
                                -Suggestion "This column has duplicates so it cannot be a natural key. Consider a different column or a surrogate key."
                        }
                    } catch {}
                }
            }
        }
    }

    # ==========================================================
    # CHECK 3: empty-tables
    # ==========================================================
    Run-Check "empty-tables" {
        Write-Host "  [3/12] Empty tables..." -ForegroundColor Gray
        foreach ($t in $tables) {
            if ($t.rowCount -eq 0) {
                Add-Finding -Check "empty-tables" -Severity "warning" `
                    -ObjectType "table" -ObjectName $t.name `
                    -Message "Table has 0 rows. May be intentional (lookup not yet populated) or a sign of a problem." `
                    -Suggestion "Verify this table should be empty. If it's a lookup table, it will need data before forms that reference it can work."
            }
        }
    }

    # ==========================================================
    # CHECK 4: problematic-data-types
    # ==========================================================
    Run-Check "problematic-data-types" {
        Write-Host "  [4/12] Problematic data types..." -ForegroundColor Gray
        foreach ($t in $tables) {
            foreach ($f in $t.fields) {
                if ($f.type -in $problematicTypes) {
                    $sev = if ($f.type -eq 19) { "error" } else { "warning" }
                    Add-Finding -Check "problematic-data-types" -Severity $sev `
                        -ObjectType "column" -ObjectName "$($t.name).$($f.name)" `
                        -Message "Column uses $($f.typeName) (type code $($f.type)) which has no clean PostgreSQL equivalent." `
                        -Suggestion $(switch ($f.type) {
                            11 { "OLE Object: migrate to bytea, or extract files and store externally." }
                            17 { "Binary: migrate to bytea." }
                            18 { "Calculated field: skip during migration, recreate as a view or generated column." }
                            19 { "Attachment: Access Attachment type cannot be directly migrated. Extract files and store as bytea or external references." }
                            default { "Review and map to appropriate PostgreSQL type." }
                        })
                }
                if ($f.type -eq $calculatedType) {
                    Add-Finding -Check "problematic-data-types" -Severity "info" `
                        -ObjectType "column" -ObjectName "$($t.name).$($f.name)" `
                        -Message "Calculated field will be skipped during table creation." `
                        -Suggestion "Recreate the calculation as a PostgreSQL generated column or view."
                }
            }
        }
    }

    # ==========================================================
    # CHECK 5: reserved-word-conflicts
    # ==========================================================
    Run-Check "reserved-word-conflicts" {
        Write-Host "  [5/12] PostgreSQL reserved word conflicts..." -ForegroundColor Gray
        foreach ($t in $tables) {
            if ($t.name.ToLower() -in $pgReservedWords) {
                Add-Finding -Check "reserved-word-conflicts" -Severity "warning" `
                    -ObjectType "table" -ObjectName $t.name `
                    -Message "Table name '$($t.name)' is a PostgreSQL reserved word." `
                    -Suggestion "Rename the table or use quoted identifiers (`"$($t.name)`") in all SQL."
            }
            foreach ($f in $t.fields) {
                if ($f.name.ToLower() -in $pgReservedWords) {
                    Add-Finding -Check "reserved-word-conflicts" -Severity "warning" `
                        -ObjectType "column" -ObjectName "$($t.name).$($f.name)" `
                        -Message "Column name '$($f.name)' is a PostgreSQL reserved word." `
                        -Suggestion "Rename the column or use quoted identifiers in all SQL."
                }
            }
        }
    }

    # ==========================================================
    # CHECK 6: case-collision-columns
    # ==========================================================
    Run-Check "case-collision-columns" {
        Write-Host "  [6/12] Case-collision columns..." -ForegroundColor Gray
        foreach ($t in $tables) {
            $lowerNames = @{}
            foreach ($f in $t.fields) {
                $lower = $f.name.ToLower()
                if ($lowerNames.ContainsKey($lower)) {
                    Add-Finding -Check "case-collision-columns" -Severity "error" `
                        -ObjectType "column" -ObjectName "$($t.name).$($f.name)" `
                        -Message "Column '$($f.name)' collides with '$($lowerNames[$lower])' when lowercased. PostgreSQL folds unquoted identifiers to lowercase." `
                        -Suggestion "Rename one of the columns before migration to avoid ambiguity."
                } else {
                    $lowerNames[$lower] = $f.name
                }
            }
        }
    }

    # ==========================================================
    # CHECK 7: complex-queries
    # ==========================================================
    Run-Check "complex-queries" {
        Write-Host "  [7/12] Complex/action queries..." -ForegroundColor Gray
        # Type codes: 0=Select, 16=Crosstab, 32=Delete, 48=Update, 64=Append, 80=MakeTable, 96=DDL, 112=PassThrough
        $queryTypeNames = @{
            0 = "Select"; 16 = "Crosstab"; 32 = "Delete"; 48 = "Update"
            64 = "Append"; 80 = "MakeTable"; 96 = "DDL"; 112 = "PassThrough"; 128 = "Union"
        }
        foreach ($q in $queries) {
            $typeName = $queryTypeNames[[int]$q.type]
            if (-not $typeName) { $typeName = "Unknown" }

            if ($q.type -notin @(0, 128)) {
                # Non-select, non-union queries need special handling
                $sev = if ($q.type -in @(32, 48, 64, 80)) { "warning" } else { "info" }
                Add-Finding -Check "complex-queries" -Severity $sev `
                    -ObjectType "query" -ObjectName $q.name `
                    -Message "$typeName query — cannot be directly converted to a PostgreSQL view." `
                    -Suggestion "Convert to a PostgreSQL function instead of a view. Action queries (Delete/Update/Append/MakeTable) need procedural translation."
            }

            # Check for Access-specific SQL functions
            $accessFunctions = @('IIf\(', 'Nz\(', 'DLookup\(', 'DCount\(', 'DSum\(', 'DAvg\(', 'DMax\(', 'DMin\(', 'Format\$?\(', 'DateSerial\(', 'DatePart\(', 'DateAdd\(', 'DateDiff\(', 'IsNull\(', 'Mid\$?\(', 'Left\$?\(', 'Right\$?\(', 'Trim\$?\(', 'Val\(', 'CStr\(', 'CInt\(', 'CLng\(', 'CDbl\(', 'CCur\(')
            $foundFunctions = @()
            foreach ($fn in $accessFunctions) {
                if ($q.sql -match $fn) {
                    $foundFunctions += ($fn -replace '\\', '' -replace '\(', '')
                }
            }
            if ($foundFunctions.Count -gt 0) {
                Add-Finding -Check "complex-queries" -Severity "info" `
                    -ObjectType "query" -ObjectName $q.name `
                    -Message "Uses Access-specific functions: $($foundFunctions -join ', '). These need PostgreSQL equivalents." `
                    -Suggestion "IIf->CASE WHEN, Nz->COALESCE, DLookup->subquery, Format->to_char, Mid->SUBSTRING, etc."
            }

            # Check for PARAMETERS declaration
            if ($q.sql -match 'PARAMETERS\s') {
                Add-Finding -Check "complex-queries" -Severity "info" `
                    -ObjectType "query" -ObjectName $q.name `
                    -Message "Parameterized query — needs conversion to a PostgreSQL function with arguments." `
                    -Suggestion "Convert to CREATE FUNCTION with typed parameters matching the PARAMETERS declaration."
            }
        }
    }

    # ==========================================================
    # CHECK 8: form-complexity
    # ==========================================================
    Run-Check "form-complexity" {
        Write-Host "  [8/12] Form complexity analysis..." -ForegroundColor Gray
        foreach ($formName in $formNames) {
            try {
                $accessApp.DoCmd.OpenForm($formName, 1)  # acDesign
                Start-Sleep -Milliseconds 300
                $form = $accessApp.Screen.ActiveForm

                $controlCount = 0
                $eventCount = 0
                $subformCount = 0
                $comboCount = 0
                $tabCount = 0
                $hasRecordSource = $false

                # Record source check
                $rs = Safe-Get $form "RecordSource"
                if ($rs) { $hasRecordSource = $true }

                # Walk controls
                foreach ($ctl in $form.Controls) {
                    $controlCount++
                    $ctlType = [int]$ctl.ControlType

                    if ($ctlType -eq 112) { $subformCount++ }
                    if ($ctlType -in @(110, 111)) { $comboCount++ }
                    if ($ctlType -eq 123) { $tabCount++ }

                    # Count event procedures on controls
                    $ctlEvents = @('OnClick','OnDblClick','OnChange','OnEnter','OnExit','BeforeUpdate','AfterUpdate','OnGotFocus','OnLostFocus')
                    foreach ($evt in $ctlEvents) {
                        try {
                            if ($ctl.$evt -eq "[Event Procedure]") { $eventCount++ }
                        } catch {}
                    }
                }

                # Count form-level events
                $formEvents = @('OnLoad','OnOpen','OnClose','OnCurrent','BeforeInsert','AfterInsert','BeforeUpdate','AfterUpdate','OnDelete')
                foreach ($evt in $formEvents) {
                    try {
                        if ($form.$evt -eq "[Event Procedure]") { $eventCount++ }
                    } catch {}
                }

                # Report findings for complex forms
                if ($subformCount -gt 0) {
                    Add-Finding -Check "form-complexity" -Severity "warning" `
                        -ObjectType "form" -ObjectName $formName `
                        -Message "Contains $subformCount subform(s). Subforms require separate form definitions and linked record sources." `
                        -Suggestion "Export each subform separately. Subform rendering is supported but needs LinkChildFields/LinkMasterFields configuration."
                }

                if ($eventCount -gt 5) {
                    Add-Finding -Check "form-complexity" -Severity "warning" `
                        -ObjectType "form" -ObjectName $formName `
                        -Message "Has $eventCount VBA event procedures. These need manual translation to PostgreSQL functions or client-side logic." `
                        -Suggestion "Prioritize BeforeUpdate/AfterUpdate events (data validation). OnClick events for buttons may need PostgreSQL function equivalents."
                } elseif ($eventCount -gt 0) {
                    Add-Finding -Check "form-complexity" -Severity "info" `
                        -ObjectType "form" -ObjectName $formName `
                        -Message "Has $eventCount VBA event procedure(s)." `
                        -Suggestion "Review each event to determine if it needs a PostgreSQL function equivalent."
                }

                if (-not $hasRecordSource) {
                    Add-Finding -Check "form-complexity" -Severity "info" `
                        -ObjectType "form" -ObjectName $formName `
                        -Message "Form has no record source (unbound form). It won't display data unless wired up." `
                        -Suggestion "Unbound forms are often used as navigation menus or dialogs. May not need a record source."
                }

                if ($controlCount -gt 50) {
                    Add-Finding -Check "form-complexity" -Severity "info" `
                        -ObjectType "form" -ObjectName $formName `
                        -Message "Form has $controlCount controls ($comboCount combo/list boxes, $tabCount tab controls). Large forms may need layout review." `
                        -Suggestion "The web form editor handles large forms but consider splitting into tabs or subforms for usability."
                }

                $accessApp.DoCmd.Close(2, $formName, 0)  # acForm, acSaveNo
            } catch {
                Add-Finding -Check "form-complexity" -Severity "warning" `
                    -ObjectType "form" -ObjectName $formName `
                    -Message "Could not open form in Design view: $($_.Exception.Message)" `
                    -Suggestion "Form may be corrupted or require a missing reference. Try opening it manually in Access first."
            }
        }
    }

    # ==========================================================
    # CHECK 9: report-complexity
    # ==========================================================
    Run-Check "report-complexity" {
        Write-Host "  [9/12] Report complexity analysis..." -ForegroundColor Gray
        foreach ($rptName in $reportNames) {
            try {
                $accessApp.DoCmd.OpenReport($rptName, 1)  # acDesign
                Start-Sleep -Milliseconds 300
                $report = $accessApp.Screen.ActiveReport

                $controlCount = 0
                $subreportCount = 0
                $groupCount = 0
                $eventCount = 0

                # Count groups
                try {
                    $g = 0
                    while ($true) {
                        $grpField = $report.GroupLevel($g).ControlSource
                        if (-not $grpField) { break }
                        $groupCount++
                        $g++
                    }
                } catch {}

                # Walk controls
                foreach ($ctl in $report.Controls) {
                    $controlCount++
                    if ([int]$ctl.ControlType -eq 112) { $subreportCount++ }

                    $ctlEvents = @('OnFormat','OnPrint','OnClick')
                    foreach ($evt in $ctlEvents) {
                        try {
                            if ($ctl.$evt -eq "[Event Procedure]") { $eventCount++ }
                        } catch {}
                    }
                }

                # Report-level events
                $rptEvents = @('OnOpen','OnClose','OnActivate','OnDeactivate','OnNoData','OnPage','OnError')
                foreach ($evt in $rptEvents) {
                    try {
                        if ($report.$evt -eq "[Event Procedure]") { $eventCount++ }
                    } catch {}
                }

                if ($subreportCount -gt 0) {
                    Add-Finding -Check "report-complexity" -Severity "warning" `
                        -ObjectType "report" -ObjectName $rptName `
                        -Message "Contains $subreportCount subreport(s). Subreport rendering requires additional work." `
                        -Suggestion "Export each subreport separately. Linked subreport fields need configuration."
                }

                if ($eventCount -gt 0) {
                    Add-Finding -Check "report-complexity" -Severity "info" `
                        -ObjectType "report" -ObjectName $rptName `
                        -Message "Has $eventCount VBA event procedure(s). Report events (OnFormat, OnPrint) are not supported in the web viewer." `
                        -Suggestion "Review events. OnFormat logic (conditional formatting) may need CSS rules. OnNoData can be handled client-side."
                }

                if ($groupCount -gt 3) {
                    Add-Finding -Check "report-complexity" -Severity "info" `
                        -ObjectType "report" -ObjectName $rptName `
                        -Message "Report has $groupCount grouping levels. Deep nesting increases preview complexity." `
                        -Suggestion "The report viewer supports multiple group levels but rendering performance may degrade beyond 3-4 levels."
                }

                $accessApp.DoCmd.Close(3, $rptName, 0)  # acReport, acSaveNo
            } catch {
                Add-Finding -Check "report-complexity" -Severity "warning" `
                    -ObjectType "report" -ObjectName $rptName `
                    -Message "Could not open report in Design view: $($_.Exception.Message)" `
                    -Suggestion "Report may be corrupted or require a missing reference."
            }
        }
    }

    # ==========================================================
    # CHECK 10: vba-modules
    # ==========================================================
    Run-Check "vba-modules" {
        Write-Host "  [10/12] VBA module analysis..." -ForegroundColor Gray
        foreach ($modName in $moduleNames) {
            try {
                $accessApp.DoCmd.OpenModule($modName)
                $mod = $accessApp.Modules($modName)
                $lineCount = $mod.CountOfLines

                if ($lineCount -gt 200) {
                    Add-Finding -Check "vba-modules" -Severity "warning" `
                        -ObjectType "module" -ObjectName $modName `
                        -Message "Module has $lineCount lines of VBA code. Large modules require significant translation effort." `
                        -Suggestion "Break down the translation by function. Prioritize functions called by form events."
                } elseif ($lineCount -gt 0) {
                    Add-Finding -Check "vba-modules" -Severity "info" `
                        -ObjectType "module" -ObjectName $modName `
                        -Message "Module has $lineCount lines of VBA code." `
                        -Suggestion "Translate to PostgreSQL functions following the session-state pattern."
                }

                # Try to read the code and look for external dependencies
                try {
                    $code = $mod.Lines(1, [Math]::Min($lineCount, 500))
                    $externalRefs = @()
                    if ($code -match 'CreateObject\(') { $externalRefs += "CreateObject (COM automation)" }
                    if ($code -match 'Shell\(') { $externalRefs += "Shell (external process)" }
                    if ($code -match 'DoCmd\.SendObject') { $externalRefs += "SendObject (email)" }
                    if ($code -match 'DoCmd\.OutputTo') { $externalRefs += "OutputTo (file export)" }
                    if ($code -match 'DoCmd\.TransferSpreadsheet') { $externalRefs += "TransferSpreadsheet (Excel)" }
                    if ($code -match 'FileSystemObject') { $externalRefs += "FileSystemObject (file I/O)" }
                    if ($code -match 'ADODB\.|DAO\.') { $externalRefs += "Direct DB connection objects" }

                    if ($externalRefs.Count -gt 0) {
                        Add-Finding -Check "vba-modules" -Severity "warning" `
                            -ObjectType "module" -ObjectName $modName `
                            -Message "Uses external dependencies: $($externalRefs -join '; '). These cannot run in PostgreSQL." `
                            -Suggestion "External operations (email, file I/O, COM) need server-side Node.js endpoints or must be removed."
                    }
                } catch {}

                $accessApp.DoCmd.Close(5, $modName)  # acModule
            } catch {
                Add-Finding -Check "vba-modules" -Severity "info" `
                    -ObjectType "module" -ObjectName $modName `
                    -Message "Could not read module content." `
                    -Suggestion "Open manually in Access to inspect."
            }
        }
    }

    # ==========================================================
    # CHECK 11: relationship-issues
    # ==========================================================
    Run-Check "relationship-issues" {
        Write-Host "  [11/12] Relationship analysis..." -ForegroundColor Gray
        $tableNameSet = @{}
        foreach ($t in $tables) { $tableNameSet[$t.name] = $true }

        foreach ($rel in $relationships) {
            # Check that referenced tables exist (should always be true, but just in case)
            if (-not $tableNameSet.ContainsKey($rel.foreignTable)) {
                Add-Finding -Check "relationship-issues" -Severity "error" `
                    -ObjectType "relationship" -ObjectName $rel.name `
                    -Message "Foreign table '$($rel.foreignTable)' not found in table list." `
                    -Suggestion "The relationship references a missing table. It may be a linked table or system table."
            }
            if (-not $tableNameSet.ContainsKey($rel.primaryTable)) {
                Add-Finding -Check "relationship-issues" -Severity "error" `
                    -ObjectType "relationship" -ObjectName $rel.name `
                    -Message "Primary table '$($rel.primaryTable)' not found in table list." `
                    -Suggestion "The relationship references a missing table."
            }
        }

        # Report total relationship count as context
        if ($relationships.Count -gt 0) {
            Add-Finding -Check "relationship-issues" -Severity "info" `
                -ObjectType "database" -ObjectName "relationships" `
                -Message "Database has $($relationships.Count) defined relationship(s). These will be converted to FOREIGN KEY constraints." `
                -Suggestion "Foreign keys will be added after all tables are created to avoid ordering issues."
        }
    }

    # ==========================================================
    # CHECK 12: size-and-scale
    # ==========================================================
    Run-Check "size-and-scale" {
        Write-Host "  [12/12] Size and scale assessment..." -ForegroundColor Gray

        $totalRows = 0
        $largeTableThreshold = 100000
        $veryLargeThreshold  = 1000000

        foreach ($t in $tables) {
            if ($t.rowCount -gt 0) { $totalRows += $t.rowCount }

            if ($t.rowCount -ge $veryLargeThreshold) {
                Add-Finding -Check "size-and-scale" -Severity "warning" `
                    -ObjectType "table" -ObjectName $t.name `
                    -Message "Very large table: $($t.rowCount.ToString('N0')) rows. Migration will take significant time." `
                    -Suggestion "Use batch import (COPY command) and consider adding indexes after data load for speed."
            } elseif ($t.rowCount -ge $largeTableThreshold) {
                Add-Finding -Check "size-and-scale" -Severity "info" `
                    -ObjectType "table" -ObjectName $t.name `
                    -Message "Large table: $($t.rowCount.ToString('N0')) rows." `
                    -Suggestion "Use COPY command for bulk import instead of row-by-row INSERT."
            }
        }

        # File size
        $fileInfo = Get-Item $DatabasePath
        $fileSizeMB = [math]::Round($fileInfo.Length / 1MB, 1)
        if ($fileSizeMB -gt 100) {
            Add-Finding -Check "size-and-scale" -Severity "warning" `
                -ObjectType "database" -ObjectName (Split-Path $DatabasePath -Leaf) `
                -Message "Database file is ${fileSizeMB}MB. Large files may contain embedded objects or bloat." `
                -Suggestion "Consider compacting the Access database before migration (Compact & Repair)."
        }

        # Summary info finding
        Add-Finding -Check "size-and-scale" -Severity "info" `
            -ObjectType "database" -ObjectName (Split-Path $DatabasePath -Leaf) `
            -Message "Totals: $($tables.Count) tables, $($totalRows.ToString('N0')) rows, $($queries.Count) queries, $($formNames.Count) forms, $($reportNames.Count) reports, $($moduleNames.Count) modules, ${fileSizeMB}MB file size." `
            -Suggestion "Use this inventory to estimate conversion effort."
    }

    # ==========================================================
    # Assemble final report
    # ==========================================================
    $endTime = Get-Date
    $durationMs = [int]($endTime - $startTime).TotalMilliseconds

    $report = [ordered]@{
        source_file = $DatabasePath
        source_name = [System.IO.Path]::GetFileNameWithoutExtension($DatabasePath)
        ran_at      = (Get-Date -Format "yyyy-MM-ddTHH:mm:ss")
        duration_ms = $durationMs
        summary     = [ordered]@{
            errors   = $summary.errors
            warnings = $summary.warnings
            info     = $summary.info
            total    = $findings.Count
        }
        inventory   = [ordered]@{
            tables        = $tables.Count
            queries       = $queries.Count
            forms         = $formNames.Count
            reports       = $reportNames.Count
            modules       = $moduleNames.Count
            relationships = $relationships.Count
        }
        checks   = $checks
        findings = $findings
    }

    $json = $report | ConvertTo-Json -Depth 10

    if ($OutputPath) {
        $json | Out-File -FilePath $OutputPath -Encoding UTF8
        Write-Host "`nDiagnostic report written to: $OutputPath" -ForegroundColor Green
    } else {
        Write-Output $json
    }

    Write-Host "`nDiagnostic complete: $($summary.errors) errors, $($summary.warnings) warnings, $($summary.info) info ($durationMs ms)" -ForegroundColor $(if ($summary.errors -gt 0) { "Red" } elseif ($summary.warnings -gt 0) { "Yellow" } else { "Green" })

    $accessApp.CloseCurrentDatabase()
}
catch {
    Write-Error $_.Exception.Message
    Write-Host "Stack: $($_.ScriptStackTrace)" -ForegroundColor Yellow
    exit 1
}
finally {
    if ($accessApp) {
        try {
            $accessApp.Quit()
            [System.Runtime.Interopservices.Marshal]::ReleaseComObject($accessApp) | Out-Null
        } catch {}
    }
    Get-Process MSACCESS -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
}
