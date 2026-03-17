# Three Horse — Qualifying Analysis
# Analyzes one or more Microsoft Access database files and produces a readable diagnostic report.
# Access apps are often split into multiple files (front-end with forms/reports, back-end with tables).
#
# Usage:
#   .\qualifying-analysis.ps1 "C:\path\to\database.accdb"
#   .\qualifying-analysis.ps1 "C:\path\to\frontend.accdb" "C:\path\to\backend.accdb"
#   .\qualifying-analysis.ps1 "C:\path\to\*.accdb"
#   .\qualifying-analysis.ps1 "C:\path\to\database.mdb" -OutputDir "C:\reports"
#
# Output: A markdown file (diagnostic report) written next to the first database
#         or to the specified output directory.
#
# Requirements: Windows, PowerShell 5+, Microsoft Access or Access Database Engine

param(
    [Parameter(Mandatory=$true, Position=0, ValueFromRemainingArguments=$true)]
    [string[]]$DatabasePaths,

    [string]$OutputDir
)

# ============================================================
# Validate input — resolve all paths, expand wildcards
# ============================================================
$resolvedPaths = @()
foreach ($p in $DatabasePaths) {
    # Expand wildcards
    $expanded = Resolve-Path $p -ErrorAction SilentlyContinue
    if ($expanded) {
        foreach ($ep in $expanded) { $resolvedPaths += $ep.Path }
    } else {
        Write-Host "Error: File not found: $p" -ForegroundColor Red
        exit 1
    }
}

if ($resolvedPaths.Count -eq 0) {
    Write-Host "Error: No database files found." -ForegroundColor Red
    exit 1
}

$dbName = [System.IO.Path]::GetFileNameWithoutExtension($resolvedPaths[0])

if (-not $OutputDir) {
    $OutputDir = Split-Path $resolvedPaths[0] -Parent
}
if (-not (Test-Path $OutputDir)) {
    New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
}

$reportPath = Join-Path $OutputDir "$dbName-qualifying-analysis.md"

Write-Host ""
Write-Host "Three Horse Qualifying Analysis" -ForegroundColor Cyan
Write-Host "================================" -ForegroundColor Cyan
if ($resolvedPaths.Count -eq 1) {
    Write-Host "Database: $($resolvedPaths[0])"
} else {
    Write-Host "Files ($($resolvedPaths.Count)):"
    foreach ($rp in $resolvedPaths) {
        Write-Host "  - $rp"
    }
}
Write-Host ""

# ============================================================
# PostgreSQL reserved words
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

# Access field type names
$accessTypeNames = @{
    1="Yes/No"; 2="Byte"; 3="Integer"; 4="Long Integer"; 5="Currency";
    6="Single"; 7="Double"; 8="Date/Time"; 10="Text"; 11="OLE Object";
    12="Memo/Long Text"; 15="GUID"; 16="BigInt"; 17="Binary";
    18="Calculated"; 19="Attachment"
}

$problematicTypes = @(11, 17, 18, 19)

function Safe-Get {
    param($obj, [string]$prop, $default = $null)
    try {
        $val = $obj.$prop
        if ($null -ne $val) { return $val }
        return $default
    } catch { return $default }
}

# ============================================================
# Cleanup
# ============================================================
Get-Process MSACCESS -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 500

foreach ($rp in $resolvedPaths) {
    $lockFile = $rp -replace '\.(accdb|mdb)$', '.laccdb'
    Remove-Item $lockFile -Force -ErrorAction SilentlyContinue
}

# ============================================================
# Extract inventory (loop over all files)
# ============================================================
$dbe = $null
$db = $null
$accessApp = $null
$startTime = Get-Date

$findings = @()
$summary = @{ error = 0; warning = 0; info = 0 }

# Accumulated results across all files
$tables = @()
$queries = @()
$relationships = @()
$formNames = @()
$reportNames = @()
$modules = @()
$macroNames = @()
$formDetails = @()
$moduleDetails = @()
$fileInventory = @()

$queryTypeNames = @{
    0="Select"; 16="Crosstab"; 32="Delete"; 48="Update";
    64="Append"; 80="MakeTable"; 96="DDL"; 112="PassThrough"; 128="Union"
}

function Add-Finding {
    param(
        [string]$Category,
        [string]$Severity,
        [string]$ObjectType,
        [string]$ObjectName,
        [string]$Message,
        [string]$Suggestion
    )
    $script:findings += @{
        category    = $Category
        severity    = $Severity
        object_type = $ObjectType
        object_name = $ObjectName
        message     = $Message
        suggestion  = $Suggestion
    }
    $script:summary[$Severity]++
}

try {
    foreach ($currentPath in $resolvedPaths) {
        $currentFileName = [System.IO.Path]::GetFileName($currentPath)
        $fileStats = @{ file = $currentFileName; tables = 0; queries = 0; forms = 0; reports = 0; modules = 0; macros = 0 }

        Write-Host "Processing: $currentFileName" -ForegroundColor White

        # --- DAO phase (tables, queries, relationships) ---
        Write-Host "  Opening with DAO..." -ForegroundColor Gray
        $dbe = New-Object -ComObject DAO.DBEngine.120
        $db = $dbe.OpenDatabase($currentPath, $false, $true)

        # Tables
        Write-Host "  Reading tables..." -ForegroundColor Gray
        foreach ($td in $db.TableDefs) {
            if ($td.Name.StartsWith("MSys") -or $td.Name.StartsWith("~")) { continue }

            $fields = @()
            $hasAutoNumber = $false
            $hasPK = $false
            foreach ($f in $td.Fields) {
                $isAutoNum = ($f.Attributes -band 16) -ne 0
                if ($isAutoNum) { $hasAutoNumber = $true }
                $fields += @{
                    name     = $f.Name
                    type     = [int]$f.Type
                    typeName = $accessTypeNames[[int]$f.Type]
                    size     = [int]$f.Size
                    required = ($f.Required -eq $true)
                    isAutoNum = $isAutoNum
                }
            }

            # Check for PK index
            try {
                foreach ($idx in $db.TableDefs($td.Name).Indexes) {
                    if ($idx.Primary) { $hasPK = $true; break }
                }
            } catch {}
            if ($hasAutoNumber -and -not $hasPK) { $hasPK = $true }

            # Row count
            $rowCount = 0
            try {
                $rs = $db.OpenRecordset("SELECT COUNT(*) FROM [$($td.Name)]")
                $rowCount = $rs.Fields(0).Value
                $rs.Close()
            } catch { $rowCount = -1 }

            $tables += @{
                name       = $td.Name
                fields     = $fields
                fieldCount = $fields.Count
                rowCount   = $rowCount
                hasPK      = $hasPK
                sourceFile = $currentFileName
            }
            $fileStats.tables++
        }

        # Queries
        Write-Host "  Reading queries..." -ForegroundColor Gray
        foreach ($qd in $db.QueryDefs) {
            if ($qd.Name.StartsWith("~")) { continue }
            $queries += @{
                name = $qd.Name
                type = [int]$qd.Type
                typeName = $queryTypeNames[[int]$qd.Type]
                sql  = $qd.SQL
                sourceFile = $currentFileName
            }
            $fileStats.queries++
        }

        # Relationships
        Write-Host "  Reading relationships..." -ForegroundColor Gray
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
                sourceFile   = $currentFileName
            }
        }

        # Close DAO before disabling AutoExec (needs exclusive access)
        $db.Close()
        [System.Runtime.Interopservices.Marshal]::ReleaseComObject($dbe) | Out-Null
        $db = $null
        $dbe = $null

        # Disable AutoExec macro via the existing script (prevents it firing when Access.Application opens)
        $autoExecDisabled = $false
        $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
        $disableScript = Join-Path $scriptDir "access\disable_autoexec.ps1"
        if (Test-Path $disableScript) {
            try {
                $result = powershell -ExecutionPolicy Bypass -File $disableScript -DatabasePath $currentPath 2>&1
                if ($result -match '"found":true') {
                    $autoExecDisabled = $true
                    Write-Host "  Disabled AutoExec macro." -ForegroundColor Gray
                }
            } catch {}
        }

        # --- Access.Application phase (forms, reports, modules, macros) ---
        # Run in a background job with timeout — some .mdb files hang on OpenCurrentDatabase
        $accessPhaseTimeout = 120
        Write-Host "  Opening with Access.Application (${accessPhaseTimeout}s timeout)..." -ForegroundColor Gray

        $accessJob = Start-Job -ArgumentList $currentPath, $currentFileName -ScriptBlock {
            param($dbPath, $fileName)

            function Safe-Get {
                param($obj, [string]$prop, $default = $null)
                try { $val = $obj.$prop; if ($null -ne $val) { return $val }; return $default } catch { return $default }
            }

            $result = @{
                formNames = @(); reportNames = @(); modules = @(); macroNames = @()
                formDetails = @(); moduleDetails = @()
                stats = @{ forms = 0; reports = 0; modules = 0; macros = 0 }
            }

            $app = New-Object -ComObject Access.Application
            $app.AutomationSecurity = 3
            $app.Visible = $false
            $app.UserControl = $false
            $app.OpenCurrentDatabase($dbPath)

            # Forms
            foreach ($f in $app.CurrentProject.AllForms) {
                $result.formNames += $f.Name
                $result.stats.forms++
            }

            # Reports
            foreach ($r in $app.CurrentProject.AllReports) {
                $result.reportNames += $r.Name
                $result.stats.reports++
            }

            # Modules
            foreach ($component in $app.VBE.ActiveVBProject.VBComponents) {
                $compType = [int]$component.Type
                $lineCount = 0
                try { $lineCount = $component.CodeModule.CountOfLines } catch {}
                if ($compType -eq 100 -and $lineCount -eq 0) { continue }
                $result.modules += @{
                    name = $component.Name; lineCount = $lineCount
                    componentType = $compType; sourceFile = $fileName
                }
                $result.stats.modules++
            }

            # Macros
            foreach ($m in $app.CurrentProject.AllMacros) {
                $result.macroNames += $m.Name
                $result.stats.macros++
            }

            # Form detail scan
            $currentFormNames = @()
            foreach ($f in $app.CurrentProject.AllForms) { $currentFormNames += $f.Name }

            foreach ($formName in $currentFormNames) {
                try {
                    $app.DoCmd.OpenForm($formName, 1)
                    Start-Sleep -Milliseconds 200
                    $form = $app.Screen.ActiveForm

                    $controlCount = 0; $eventCount = 0; $subformCount = 0; $comboCount = 0; $tabCount = 0
                    $recordSource = Safe-Get $form "RecordSource"

                    foreach ($ctl in $form.Controls) {
                        $controlCount++
                        $ctlType = [int]$ctl.ControlType
                        if ($ctlType -eq 112) { $subformCount++ }
                        if ($ctlType -in @(110, 111)) { $comboCount++ }
                        if ($ctlType -eq 123) { $tabCount++ }
                        foreach ($evt in @('OnClick','OnChange','BeforeUpdate','AfterUpdate','OnEnter','OnExit')) {
                            try { if ($ctl.$evt -eq "[Event Procedure]") { $eventCount++ } } catch {}
                        }
                    }
                    foreach ($evt in @('OnLoad','OnOpen','OnClose','OnCurrent','BeforeUpdate','AfterUpdate')) {
                        try { if ($form.$evt -eq "[Event Procedure]") { $eventCount++ } } catch {}
                    }

                    $result.formDetails += @{
                        name = $formName; recordSource = $recordSource; controls = $controlCount
                        events = $eventCount; subforms = $subformCount; combos = $comboCount
                        tabs = $tabCount; sourceFile = $fileName
                    }
                    $app.DoCmd.Close(2, $formName, 0)
                } catch {
                    $result.formDetails += @{ name = $formName; error = $_.Exception.Message; sourceFile = $fileName }
                }
            }

            # VBA external dependency scan
            $currentModules = $result.modules | Where-Object { $_.sourceFile -eq $fileName }
            foreach ($mod in $currentModules) {
                $detail = @{
                    name = $mod.name; lineCount = $mod.lineCount
                    type = switch ($mod.componentType) { 1 { "Standard" }; 2 { "Class" }; 100 { "Form/Report" }; default { "Other" } }
                    externalDeps = @(); sourceFile = $fileName
                }
                if ($mod.lineCount -gt 0) {
                    try {
                        $app.DoCmd.OpenModule($mod.name)
                        $m = $app.Modules($mod.name)
                        $code = $m.Lines(1, [Math]::Min($mod.lineCount, 500))
                        if ($code -match 'CreateObject\(') { $detail.externalDeps += "COM automation" }
                        if ($code -match 'Shell\(') { $detail.externalDeps += "Shell commands" }
                        if ($code -match 'DoCmd\.SendObject') { $detail.externalDeps += "Email" }
                        if ($code -match 'DoCmd\.OutputTo') { $detail.externalDeps += "File export" }
                        if ($code -match 'DoCmd\.TransferSpreadsheet') { $detail.externalDeps += "Excel transfer" }
                        if ($code -match 'FileSystemObject') { $detail.externalDeps += "File I/O" }
                        if ($code -match 'ADODB\.|DAO\.') { $detail.externalDeps += "Direct DB connections" }
                        $app.DoCmd.Close(5, $mod.name)
                    } catch {}
                }
                $result.moduleDetails += $detail
            }

            try { $app.CloseCurrentDatabase() } catch {}
            try { $app.Quit() } catch {}
            try { [System.Runtime.Interopservices.Marshal]::ReleaseComObject($app) | Out-Null } catch {}

            return $result
        }

        $jobCompleted = $accessJob | Wait-Job -Timeout $accessPhaseTimeout
        $accessPhaseSkipped = $false

        if ($jobCompleted) {
            $jobResult = Receive-Job -Job $accessJob
            if ($jobResult) {
                $formNames += $jobResult.formNames
                $reportNames += $jobResult.reportNames
                $modules += $jobResult.modules
                $macroNames += $jobResult.macroNames
                $formDetails += $jobResult.formDetails
                $moduleDetails += $jobResult.moduleDetails
                $fileStats.forms = $jobResult.stats.forms
                $fileStats.reports = $jobResult.stats.reports
                $fileStats.modules = $jobResult.stats.modules
                $fileStats.macros = $jobResult.stats.macros
                Write-Host "  Access.Application phase complete." -ForegroundColor Gray
            }
        } else {
            $accessPhaseSkipped = $true
            Write-Host "  Access.Application timed out after ${accessPhaseTimeout}s -- skipping forms/reports/modules/macros for this file." -ForegroundColor Yellow
            Add-Finding "access" "warning" "file" $currentFileName `
                "Could not open with Access.Application within ${accessPhaseTimeout}s. Forms, reports, modules, and macros were not analyzed." `
                "The database may have a startup form or security setting blocking automation. Try opening it in Access manually first."
        }
        Remove-Job -Job $accessJob -Force -ErrorAction SilentlyContinue
        Get-Process MSACCESS -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 500

        # Restore AutoExec macro if we disabled it
        if ($autoExecDisabled) {
            try {
                $result = powershell -ExecutionPolicy Bypass -File $disableScript -DatabasePath $currentPath -Restore 2>&1
                Write-Host "  Restored AutoExec macro." -ForegroundColor Gray
            } catch {
                Write-Host "  Warning: could not restore AutoExec macro." -ForegroundColor Yellow
            }
        }

        $fileInventory += $fileStats
    }

    # ============================================================
    # Deduplicate objects across files (linked tables appear in both front-end and back-end)
    # ============================================================
    if ($resolvedPaths.Count -gt 1) {
        # Tables: keep first occurrence by name (prefer the one with more rows)
        $uniqueTables = @{}
        foreach ($t in $tables) {
            $key = $t.name.ToLower()
            if (-not $uniqueTables.ContainsKey($key)) {
                $uniqueTables[$key] = $t
            } elseif ($t.rowCount -gt $uniqueTables[$key].rowCount) {
                $uniqueTables[$key] = $t
            }
        }
        $tables = @($uniqueTables.Values)

        # Queries: keep first occurrence by name
        $uniqueQueries = @{}
        foreach ($q in $queries) {
            $key = $q.name.ToLower()
            if (-not $uniqueQueries.ContainsKey($key)) {
                $uniqueQueries[$key] = $q
            }
        }
        $queries = @($uniqueQueries.Values)

        # Relationships: keep first occurrence by name
        $uniqueRels = @{}
        foreach ($rel in $relationships) {
            $key = $rel.name.ToLower()
            if (-not $uniqueRels.ContainsKey($key)) {
                $uniqueRels[$key] = $rel
            }
        }
        $relationships = @($uniqueRels.Values)
    }

    # ============================================================
    # Run analysis checks
    # ============================================================
    Write-Host "  Running analysis checks..." -ForegroundColor Gray

    # Tables without PK
    foreach ($t in $tables) {
        if (-not $t.hasPK) {
            Add-Finding "schema" "error" "table" $t.name `
                "No primary key. Record editing and inserts will not work without one." `
                "Add an auto-increment ID column or identify a natural key."
        }
    }

    # Problematic data types
    foreach ($t in $tables) {
        foreach ($f in $t.fields) {
            if ($f.type -in $problematicTypes) {
                Add-Finding "schema" "warning" "column" "$($t.name).$($f.name)" `
                    "$($f.typeName) field requires special handling during migration." `
                    $(switch ($f.type) {
                        11 { "OLE Object: extract embedded files or migrate to bytea." }
                        17 { "Binary: migrate to bytea." }
                        18 { "Calculated field: recreate as a PostgreSQL generated column or view." }
                        19 { "Attachment: extract files and store as file references." }
                        default { "Map to appropriate PostgreSQL type." }
                    })
            }
        }
    }

    # Reserved word conflicts
    foreach ($t in $tables) {
        if ($t.name.ToLower() -in $pgReservedWords) {
            Add-Finding "schema" "warning" "table" $t.name `
                "Table name is a PostgreSQL reserved word." `
                "Will be quoted automatically during migration."
        }
        foreach ($f in $t.fields) {
            if ($f.name.ToLower() -in $pgReservedWords) {
                Add-Finding "schema" "warning" "column" "$($t.name).$($f.name)" `
                    "Column name is a PostgreSQL reserved word." `
                    "Will be quoted automatically during migration."
            }
        }
    }

    # Action queries
    foreach ($q in $queries) {
        if ($q.type -notin @(0, 128)) {
            Add-Finding "queries" "warning" "query" $q.name `
                "$($q.typeName) query cannot be a simple PostgreSQL view." `
                "Will be converted to a PostgreSQL function."
        }
    }

    # Access-specific SQL functions
    $accessFunctions = @('IIf\(', 'Nz\(', 'DLookup\(', 'DCount\(', 'DSum\(', 'Format\$?\(', 'DateSerial\(', 'Mid\$?\(', 'Left\$?\(', 'Val\(')
    foreach ($q in $queries) {
        $found = @()
        foreach ($fn in $accessFunctions) {
            if ($q.sql -match $fn) { $found += ($fn -replace '\\', '' -replace '\(', '') }
        }
        if ($found.Count -gt 0) {
            Add-Finding "queries" "info" "query" $q.name `
                "Uses Access-specific functions: $($found -join ', ')." `
                "These are automatically converted during migration (IIf->CASE, Nz->COALESCE, etc.)."
        }
    }

    # Complex forms
    foreach ($fd in $formDetails) {
        if ($fd.error) { continue }
        if ($fd.subforms -gt 0) {
            Add-Finding "forms" "warning" "form" $fd.name `
                "Contains $($fd.subforms) subform(s). Subforms are supported but add complexity." ""
        }
        if ($fd.events -gt 5) {
            Add-Finding "forms" "warning" "form" $fd.name `
                "Has $($fd.events) VBA event procedures requiring translation." ""
        }
    }

    # VBA external dependencies
    foreach ($md in $moduleDetails) {
        if ($md.externalDeps.Count -gt 0) {
            Add-Finding "vba" "warning" "module" $md.name `
                "Uses external dependencies: $($md.externalDeps -join ', ')." `
                "These need server-side equivalents or must be redesigned."
        }
        if ($md.lineCount -gt 200) {
            Add-Finding "vba" "info" "module" $md.name `
                "$($md.lineCount) lines of VBA code." ""
        }
    }

    # ============================================================
    # Generate markdown report
    # ============================================================
    $endTime = Get-Date
    $durationSec = [math]::Round(($endTime - $startTime).TotalSeconds, 1)
    $totalSizeMB = 0
    foreach ($rp in $resolvedPaths) {
        $fileInfo = Get-Item $rp
        $totalSizeMB += $fileInfo.Length / 1MB
    }
    $totalSizeMB = [math]::Round($totalSizeMB, 1)
    $totalRows = ($tables | ForEach-Object { if ($_.rowCount -gt 0) { $_.rowCount } else { 0 } } | Measure-Object -Sum).Sum

    $md = "# Qualifying Analysis: $dbName`n`n"

    if ($resolvedPaths.Count -eq 1) {
        $md += "**Source:** $($resolvedPaths[0])`n"
    } else {
        $md += "**Source files ($($resolvedPaths.Count)):**`n"
        foreach ($rp in $resolvedPaths) {
            $md += "- $rp`n"
        }
    }

    $md += @"
**Total file size:** ${totalSizeMB} MB
**Analyzed:** $(Get-Date -Format "yyyy-MM-dd HH:mm")
**Duration:** ${durationSec}s

---

"@

    # File inventory (only for multi-file)
    if ($resolvedPaths.Count -gt 1) {
        $md += "## File Inventory`n`n"
        $md += "| File | Tables | Queries | Forms | Reports | Modules | Macros |`n"
        $md += "|------|--------|---------|-------|---------|---------|--------|`n"
        foreach ($fi in $fileInventory) {
            $md += "| $($fi.file) | $($fi.tables) | $($fi.queries) | $($fi.forms) | $($fi.reports) | $($fi.modules) | $($fi.macros) |`n"
        }
        $md += "`n---`n`n"
    }

    $md += @"
## Summary

| Category | Count |
|----------|-------|
| Tables | $($tables.Count) |
| Queries | $($queries.Count) |
| Forms | $($formNames.Count) |
| Reports | $($reportNames.Count) |
| VBA Modules | $($modules.Count) |
| Macros | $($macroNames.Count) |
| Relationships | $($relationships.Count) |
| Total data rows | $($totalRows.ToString('N0')) |

### Findings

| Severity | Count |
|----------|-------|
| Errors (must fix before migration) | $($summary.error) |
| Warnings (review recommended) | $($summary.warning) |
| Info (noted, usually handled automatically) | $($summary.info) |

---

"@

    $multiFile = $resolvedPaths.Count -gt 1

    if ($multiFile) {
        $md += "## Tables`n`n"
        $md += "| Table | Fields | Rows | Primary Key | Source |`n"
        $md += "|-------|--------|------|-------------|--------|`n"
    } else {
        $md += "## Tables`n`n"
        $md += "| Table | Fields | Rows | Primary Key |`n"
        $md += "|-------|--------|------|-------------|`n"
    }

    foreach ($t in ($tables | Sort-Object { $_.name })) {
        $pkStatus = if ($t.hasPK) { "Yes" } else { "**MISSING**" }
        $rows = if ($t.rowCount -ge 0) { $t.rowCount.ToString('N0') } else { "?" }
        if ($multiFile) {
            $md += "| $($t.name) | $($t.fieldCount) | $rows | $pkStatus | $($t.sourceFile) |`n"
        } else {
            $md += "| $($t.name) | $($t.fieldCount) | $rows | $pkStatus |`n"
        }
    }

    if ($multiFile) {
        $md += "`n---`n`n## Queries`n`n"
        $md += "| Query | Type | Source |`n"
        $md += "|-------|------|--------|`n"
    } else {
        $md += "`n---`n`n## Queries`n`n"
        $md += "| Query | Type |`n"
        $md += "|-------|------|`n"
    }

    foreach ($q in ($queries | Sort-Object { $_.name })) {
        if ($multiFile) {
            $md += "| $($q.name) | $($q.typeName) | $($q.sourceFile) |`n"
        } else {
            $md += "| $($q.name) | $($q.typeName) |`n"
        }
    }

    if ($multiFile) {
        $md += "`n---`n`n## Forms`n`n"
        $md += "| Form | Record Source | Controls | Events | Subforms | Combos | Source |`n"
        $md += "|------|--------------|----------|--------|----------|--------|--------|`n"
    } else {
        $md += "`n---`n`n## Forms`n`n"
        $md += "| Form | Record Source | Controls | Events | Subforms | Combos |`n"
        $md += "|------|--------------|----------|--------|----------|--------|`n"
    }

    foreach ($fd in ($formDetails | Sort-Object { $_.name })) {
        if ($fd.error) {
            if ($multiFile) {
                $md += "| $($fd.name) | *could not open* | - | - | - | - | $($fd.sourceFile) |`n"
            } else {
                $md += "| $($fd.name) | *could not open* | - | - | - | - |`n"
            }
        } else {
            $rs = if ($fd.recordSource) { $fd.recordSource } else { "(unbound)" }
            if ($multiFile) {
                $md += "| $($fd.name) | $rs | $($fd.controls) | $($fd.events) | $($fd.subforms) | $($fd.combos) | $($fd.sourceFile) |`n"
            } else {
                $md += "| $($fd.name) | $rs | $($fd.controls) | $($fd.events) | $($fd.subforms) | $($fd.combos) |`n"
            }
        }
    }

    $md += "`n---`n`n## Reports`n`n"

    if ($reportNames.Count -eq 0) {
        $md += "No reports found.`n"
    } else {
        foreach ($rn in ($reportNames | Sort-Object)) {
            $md += "- $rn`n"
        }
    }

    if ($multiFile) {
        $md += "`n---`n`n## VBA Modules`n`n"
        $md += "| Module | Type | Lines | External Dependencies | Source |`n"
        $md += "|--------|------|-------|-----------------------|--------|`n"
    } else {
        $md += "`n---`n`n## VBA Modules`n`n"
        $md += "| Module | Type | Lines | External Dependencies |`n"
        $md += "|--------|------|-------|-----------------------|`n"
    }

    foreach ($md2 in ($moduleDetails | Sort-Object { $_.name })) {
        $deps = if ($md2.externalDeps.Count -gt 0) { $md2.externalDeps -join ", " } else { "None" }
        if ($multiFile) {
            $md += "| $($md2.name) | $($md2.type) | $($md2.lineCount) | $deps | $($md2.sourceFile) |`n"
        } else {
            $md += "| $($md2.name) | $($md2.type) | $($md2.lineCount) | $deps |`n"
        }
    }

    $md += "`n---`n`n## Macros`n`n"

    if ($macroNames.Count -eq 0) {
        $md += "No macros found.`n"
    } else {
        foreach ($mn in ($macroNames | Sort-Object)) {
            $md += "- $mn`n"
        }
    }

    $md += @"

---

## Relationships

"@

    if ($relationships.Count -eq 0) {
        $md += "No relationships defined.`n"
    } else {
        $md += "| Relationship | From | To | Fields |`n"
        $md += "|-------------|------|-----|--------|`n"
        foreach ($rel in ($relationships | Sort-Object { $_.name })) {
            $fieldPairs = ($rel.fields | ForEach-Object { "$($_.foreign) -> $($_.primary)" }) -join ", "
            $md += "| $($rel.name) | $($rel.foreignTable) | $($rel.primaryTable) | $fieldPairs |`n"
        }
    }

    $md += @"

---

## Findings Detail

"@

    # Group by severity
    foreach ($sev in @("error", "warning", "info")) {
        $sevFindings = $findings | Where-Object { $_.severity -eq $sev }
        if ($sevFindings.Count -eq 0) { continue }

        $sevLabel = switch ($sev) {
            "error"   { "Errors" }
            "warning" { "Warnings" }
            "info"    { "Information" }
        }

        $md += "`n### $sevLabel`n`n"

        foreach ($f in $sevFindings) {
            $line = "- **" + $f.object_type + ": " + $f.object_name + "** -- " + $f.message
            if ($f.suggestion) { $line += " *" + $f.suggestion + "*" }
            $md += $line + "`n"
        }
    }

    # ============================================================
    # Import difficulty assessment
    # ============================================================
    $totalVBALines = ($moduleDetails | ForEach-Object { $_.lineCount } | Measure-Object -Sum).Sum
    $formsWithEvents = ($formDetails | Where-Object { $_.events -gt 0 }).Count

    # Identify specific risk objects
    $tablesNoPK = @($tables | Where-Object { -not $_.hasPK })
    $actionQueries = @($queries | Where-Object { $_.type -notin @(0, 128) })
    $crosstabQueries = @($queries | Where-Object { $_.type -eq 16 })
    $passthroughQueries = @($queries | Where-Object { $_.type -eq 112 })
    $formRefQueries = @($queries | Where-Object { $_.sql -match '\[Forms\]!' })
    $heavyEventForms = @($formDetails | Where-Object { $_.events -gt 10 })
    $subformForms = @($formDetails | Where-Object { $_.subforms -gt 0 })
    $externalDepModules = @($moduleDetails | Where-Object { $_.externalDeps.Count -gt 0 })
    $largeModules = @($moduleDetails | Where-Object { $_.lineCount -gt 500 })

    # Problematic columns across all tables
    $problematicColumns = @()
    foreach ($t in $tables) {
        foreach ($f in $t.fields) {
            if ($f.type -in $problematicTypes) {
                $problematicColumns += @{ table = $t.name; field = $f.name; typeName = $f.typeName }
            }
        }
    }

    # Score: 0-2 = easy (auto-import), 3-5 = moderate (auto with attention), 6+ = hard (individual recommended)
    $difficultyScore = 0
    $riskFactors = @()

    if ($tablesNoPK.Count -gt 0) {
        $difficultyScore += [Math]::Min($tablesNoPK.Count, 3)
        $riskFactors += "$($tablesNoPK.Count) table`(s`) without primary keys -- record editing will fail until keys are added"
    }
    if ($actionQueries.Count -gt 0) {
        $difficultyScore += [Math]::Min($actionQueries.Count, 2)
        $riskFactors += "$($actionQueries.Count) action queries `(delete/update/append/make-table`) -- converted to functions, may need manual review"
    }
    if ($crosstabQueries.Count -gt 0) {
        $difficultyScore += $crosstabQueries.Count
        $riskFactors += "$($crosstabQueries.Count) crosstab queries -- requires tablefunc extension and may need manual SQL adjustment"
    }
    if ($passthroughQueries.Count -gt 0) {
        $difficultyScore += $passthroughQueries.Count
        $riskFactors += "$($passthroughQueries.Count) pass-through queries -- references external data sources not available in PostgreSQL"
    }
    if ($formRefQueries.Count -gt 0) {
        $difficultyScore += [Math]::Min($formRefQueries.Count, 3)
        $riskFactors += "$($formRefQueries.Count) queries reference form controls `([Forms]!`) -- requires form state sync; forms must import before these queries"
    }
    if ($heavyEventForms.Count -gt 0) {
        $difficultyScore += [Math]::Min($heavyEventForms.Count, 3)
        $riskFactors += "$($heavyEventForms.Count) form`(s`) with 10+ VBA events -- complex business logic requiring intent extraction"
    }
    if ($subformForms.Count -gt 3) {
        $difficultyScore += 1
        $riskFactors += "$($subformForms.Count) forms with subforms -- parent/child linking adds import complexity"
    }
    if ($externalDepModules.Count -gt 0) {
        $difficultyScore += [Math]::Min($externalDepModules.Count * 2, 4)
        $riskFactors += "$($externalDepModules.Count) VBA module`(s`) with external dependencies `(COM, file I/O, email`) -- need server-side replacements"
    }
    if ($largeModules.Count -gt 0) {
        $difficultyScore += [Math]::Min($largeModules.Count, 2)
        $riskFactors += "$($largeModules.Count) VBA module`(s`) over 500 lines -- may need to import and translate individually"
    }
    if ($problematicColumns.Count -gt 3) {
        $difficultyScore += 1
        $riskFactors += "$($problematicColumns.Count) columns with problematic types `(OLE, Binary, Calculated, Attachment`)"
    }

    $difficultyLevel = if ($difficultyScore -le 2) { "Low" } elseif ($difficultyScore -le 5) { "Moderate" } else { "High" }
    $recommendAutoImport = $difficultyScore -le 5

    # Build the individual-import watchlist
    $watchlistItems = @()
    foreach ($t in $tablesNoPK) {
        $watchlistItems += "- **Table: $($t.name)** -- no primary key. Add a key column before or during import."
    }
    foreach ($q in $actionQueries) {
        $watchlistItems += "- **Query: $($q.name)** -- $($q.typeName) query. Import individually and verify the generated function."
    }
    foreach ($q in $crosstabQueries) {
        $watchlistItems += "- **Query: $($q.name)** -- Crosstab. Import individually; may need manual SQL."
    }
    foreach ($q in $passthroughQueries) {
        $watchlistItems += "- **Query: $($q.name)** -- Pass-through. External data source; will need manual handling."
    }
    foreach ($q in $formRefQueries) {
        $watchlistItems += "- **Query: $($q.name)** -- References form controls. Import after the related forms are in place."
    }
    foreach ($fd in $heavyEventForms) {
        $watchlistItems += "- **Form: $($fd.name)** -- $($fd.events) events. Import individually and review translated intents."
    }
    foreach ($md2 in $externalDepModules) {
        $deps = $md2.externalDeps -join ", "
        $watchlistItems += "- **Module: $($md2.name)** -- Uses $deps. Translation will have gaps requiring manual work."
    }
    foreach ($md2 in $largeModules) {
        if ($md2.name -notin ($externalDepModules | ForEach-Object { $_.name })) {
            $watchlistItems += "- **Module: $($md2.name)** -- $($md2.lineCount) lines. Import individually to monitor translation quality."
        }
    }

    # ============================================================
    # Generate Migration Readiness + Import Difficulty section
    # ============================================================
    $md += @"

---

## Migration Readiness

"@

    if ($summary.error -eq 0) {
        $md += "This application has no blocking issues. It is ready for migration.`n"
    } else {
        $md += "This application has **" + $summary.error + " blocking issue(s)** that should be addressed before or during migration.`n"
    }

    $schemaRating = if ($tables.Count -le 10) { "straightforward" } elseif ($tables.Count -le 30) { "moderate" } else { "complex" }
    $queryRating = if ($queries.Count -le 10) { "straightforward" } elseif ($queries.Count -le 50) { "moderate" } else { "complex" }
    $formRating = if ($formsWithEvents -le 3) { "straightforward" } elseif ($formsWithEvents -le 10) { "moderate" } else { "complex" }
    $vbaRating = if ($totalVBALines -le 500) { "light" } elseif ($totalVBALines -le 2000) { "moderate" } else { "significant" }

    $md += "`n### Complexity Assessment`n`n"
    $md += "- Schema complexity: $($tables.Count) tables, $($relationships.Count) relationships -- $schemaRating`n"
    $md += "- Query complexity: $($queries.Count) queries -- $queryRating`n"
    $md += "- Form complexity: $($formNames.Count) forms, $formsWithEvents with VBA events -- $formRating`n"
    $md += "- VBA complexity: $totalVBALines total lines across $($modules.Count) modules -- $vbaRating`n"

    $md += @"

---

## Import Difficulty Assessment

**Overall difficulty: $difficultyLevel** (score: $difficultyScore)

"@

    if ($recommendAutoImport) {
        if ($difficultyScore -eq 0) {
            $md += @"
**Recommendation: Auto-import.** This database has no significant risk factors. The automatic import pipeline should handle everything without issues.

"@
        } else {
            $md += @"
**Recommendation: Auto-import** with attention to the items listed below. The automatic pipeline should handle the bulk of the work, but some objects may need a second look after import.

"@
        }
    } else {
        $md += @"
**Recommendation: Import objects individually.** This database has enough complexity that the automatic pipeline may struggle with some objects. Importing tables, forms, queries, and modules in controlled batches will give better results and make it easier to catch issues early.

Suggested import order:
1. **Tables** -- import all at once (safe, no dependencies)
2. **Forms and reports** -- import all at once (needed before form-referencing queries)
3. **Queries** -- import in batches, starting with simple Select queries. Review action queries and form-referencing queries individually.
4. **Modules** -- import one at a time for large or complex modules. Review translated intents before proceeding.
5. **Macros** -- import all at once (converted to event handlers)

"@
    }

    if ($riskFactors.Count -gt 0) {
        $md += "### Risk Factors`n`n"
        foreach ($rf in $riskFactors) {
            $md += "- $rf`n"
        }
        $md += "`n"
    }

    if ($watchlistItems.Count -gt 0) {
        $md += "### Objects to Watch`n`n"
        $md += "These specific objects are likely to need individual attention during import:`n`n"
        foreach ($wi in $watchlistItems) {
            $md += "$wi`n"
        }
        $md += "`n"
    }

    if ($recommendAutoImport -and $watchlistItems.Count -gt 0) {
        $md += "*Even with auto-import, you can re-import any of these objects individually afterward if the initial result needs adjustment.*`n`n"
    }

    $md += "---`n`n"
    $md += "*Generated by Three Horse Qualifying Analysis*`n"
    $md += "*Learn more: https://three.horse*`n"

    # Write the report
    $md | Out-File -FilePath $reportPath -Encoding UTF8

    Write-Host ""
    Write-Host "Report written to: $reportPath" -ForegroundColor Green
    Write-Host ""
    Write-Host "  $($summary.error) errors, $($summary.warning) warnings, $($summary.info) info" -ForegroundColor $(
        if ($summary.error -gt 0) { "Red" }
        elseif ($summary.warning -gt 0) { "Yellow" }
        else { "Green" }
    )
    Write-Host ""
    Write-Host "Next steps:" -ForegroundColor Cyan
    Write-Host "  1. Read the report: $reportPath"
    Write-Host "  2. Paste the report + the qualifying-guide.md into your preferred LLM"
    Write-Host "     (ChatGPT, Claude, etc.) to discuss your database and migration options."
    Write-Host ""
}
catch {
    Write-Host "Error: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "Stack: $($_.ScriptStackTrace)" -ForegroundColor Yellow
    exit 1
}
finally {
    if ($db) {
        try { $db.Close() } catch {}
    }
    if ($dbe) {
        try { [System.Runtime.Interopservices.Marshal]::ReleaseComObject($dbe) | Out-Null } catch {}
    }
    if ($accessApp) {
        try {
            $accessApp.Quit()
            [System.Runtime.Interopservices.Marshal]::ReleaseComObject($accessApp) | Out-Null
        } catch {}
    }
    # Final cleanup — ensure no orphaned Access processes
    Get-Process MSACCESS -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
}
