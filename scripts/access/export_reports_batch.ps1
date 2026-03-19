# Export multiple Access Reports as JSON in a single COM session
# Usage: .\export_reports_batch.ps1 -DatabasePath "path\to\db.accdb" -ReportNames "Report1,Report2"
# Outputs JSON: {"objects":{"Report1":{...},"Report2":{...}},"errors":[...]}

param(
    [Parameter(Mandatory=$true)]
    [string]$DatabasePath,

    [Parameter(Mandatory=$true)]
    [string]$ReportNames
)

. "$PSScriptRoot\com_helpers.ps1"

# --- SaveAsText parser (same as export_report.ps1) ---

function Parse-ReportSaveAsText {
    param([string]$textContent, [string]$reportName)

    $lines = $textContent -split "`r?`n"

    $reportObj = [ordered]@{ name = $reportName }
    $grouping = @()
    $sections = @()

    $sectionTypeMap = @{
        'FormHeader' = 'report-header'
        'PageHeader' = 'page-header'
        'Section'    = 'detail'
        'PageFooter' = 'page-footer'
        'FormFooter' = 'report-footer'
    }

    $ctlTypeMap = @{
        'Label' = 'label'; 'TextBox' = 'text-box'; 'ComboBox' = 'combo-box'
        'ListBox' = 'list-box'; 'CheckBox' = 'check-box'; 'OptionButton' = 'option-button'
        'ToggleButton' = 'toggle-button'; 'CommandButton' = 'command-button'
        'Image' = 'image'; 'Rectangle' = 'rectangle'; 'Line' = 'line'
        'SubForm' = 'subreport'; 'OptionGroup' = 'option-group'
        'BoundObjectFrame' = 'object-frame'; 'PageBreak' = 'page-break'
    }

    $depth = 0
    $inBinary = $false
    $binaryDepth = 0
    $context = 'none'
    $currentSection = $null
    $currentControl = $null

    foreach ($rawLine in $lines) {
        $line = $rawLine.Trim()
        if (-not $line) { continue }

        # Binary property blocks
        if ($line -match '^\w+\s*=\s*Begin\s*$') {
            $inBinary = $true
            $binaryDepth = 1
            continue
        }
        if ($inBinary) {
            if ($line -eq 'Begin') { $binaryDepth++ }
            elseif ($line -eq 'End') { $binaryDepth--; if ($binaryDepth -eq 0) { $inBinary = $false } }
            continue
        }

        # Structural Begin
        if ($line -match '^Begin\s*(.*)$') {
            $typeName = $Matches[1].Trim()
            $depth++

            if ($depth -eq 1 -and $typeName -eq 'Report') {
                $context = 'report'
            }
            elseif ($depth -eq 3) {
                if ($sectionTypeMap.ContainsKey($typeName)) {
                    $context = 'section'
                    $currentSection = [ordered]@{
                        name = $sectionTypeMap[$typeName]
                        height = 0; visible = $true; canGrow = $false; canShrink = $false
                        forceNewPage = 0; keepTogether = $false; controls = @()
                    }
                }
                elseif ($typeName -eq 'BreakLevel') {
                    $context = 'grouping'
                    $currentGroupObj = [ordered]@{
                        field = ''; groupHeader = $false; groupFooter = $false
                        sortOrder = 0; groupOn = 0; groupInterval = 1; keepTogether = 0
                    }
                }
                elseif ($typeName -match '^GroupLevel(\d+)Header$') {
                    $context = 'section'
                    $currentSection = [ordered]@{
                        name = "group-header-$($Matches[1])"
                        height = 0; visible = $true; canGrow = $false; canShrink = $false
                        forceNewPage = 0; keepTogether = $false; controls = @()
                    }
                }
                elseif ($typeName -match '^GroupLevel(\d+)Footer$') {
                    $context = 'section'
                    $currentSection = [ordered]@{
                        name = "group-footer-$($Matches[1])"
                        height = 0; visible = $true; canGrow = $false; canShrink = $false
                        forceNewPage = 0; keepTogether = $false; controls = @()
                    }
                }
                else { $context = 'defaults' }
            }
            elseif ($depth -eq 4 -and $context -eq 'section' -and -not $typeName) {
                $context = 'section-controls'
            }
            elseif ($depth -eq 5 -and $context -eq 'section-controls') {
                $ctlType = if ($ctlTypeMap.ContainsKey($typeName)) { $ctlTypeMap[$typeName] } else { $typeName.ToLower() }
                $context = 'control'
                $currentControl = [ordered]@{
                    type = $ctlType; name = ''; left = 0; top = 0; width = 0; height = 0
                }
            }
            continue
        }

        # Structural End
        if ($line -eq 'End') {
            if ($depth -eq 5 -and $context -eq 'control') {
                if ($currentControl -and $currentControl.name) {
                    $currentSection.controls += $currentControl
                }
                $currentControl = $null
                $context = 'section-controls'
            }
            elseif ($depth -eq 4 -and $context -eq 'section-controls') {
                $context = 'section'
            }
            elseif ($depth -eq 3) {
                if ($context -eq 'section' -and $currentSection) {
                    $sections += $currentSection
                    $currentSection = $null
                }
                elseif ($context -eq 'grouping' -and $currentGroupObj) {
                    $grouping += $currentGroupObj
                    $currentGroupObj = $null
                }
                $context = 'report'
            }
            $depth--
            continue
        }

        # Property parsing
        if ($line -match '^(\w+)\s*=\s*(.+)$') {
            $pName = $Matches[1]
            $pVal = $Matches[2].Trim()
            if ($pVal -match '^"(.*)"$') { $pVal = $Matches[1] }
            $isNotDefault = ($pVal -eq 'NotDefault')

            if ($context -eq 'report' -and $depth -eq 1) {
                switch ($pName) {
                    'RecordSource' { $reportObj.recordSource = $pVal }
                    'Width'        { $reportObj.reportWidth = [int]$pVal }
                    'Caption'      { $reportObj.caption = $pVal }
                    'PageHeader'   { $reportObj.pageHeader = [int]$pVal }
                    'PageFooter'   { $reportObj.pageFooter = [int]$pVal }
                }
            }
            elseif ($context -eq 'grouping') {
                switch ($pName) {
                    'ControlSource' { $currentGroupObj.field = $pVal }
                    'SortOrder'     { if ($isNotDefault) { $currentGroupObj.sortOrder = 1 } }
                    'GroupOn'       { $currentGroupObj.groupOn = [int]$pVal }
                    'GroupInterval' { $currentGroupObj.groupInterval = [int]$pVal }
                    'KeepTogether'  { $currentGroupObj.keepTogether = [int]$pVal }
                    'GroupHeader'   { if ($isNotDefault) { $currentGroupObj.groupHeader = $true } }
                    'GroupFooter'   { if ($isNotDefault) { $currentGroupObj.groupFooter = $true } }
                }
            }
            elseif ($context -eq 'section' -and $currentSection -and $depth -eq 3) {
                switch ($pName) {
                    'Height'       { $currentSection.height = [int]$pVal }
                    'Visible'      { if ($pVal -eq '0' -or $pVal -eq 'False') { $currentSection.visible = $false } }
                    'CanGrow'      { if ($isNotDefault) { $currentSection.canGrow = $true } }
                    'CanShrink'    { if ($isNotDefault) { $currentSection.canShrink = $true } }
                    'KeepTogether' { if ($isNotDefault) { $currentSection.keepTogether = $true } }
                    'ForceNewPage' { $currentSection.forceNewPage = [int]$pVal }
                    'BackColor'    { $currentSection.backColor = [int]$pVal }
                }
            }
            elseif ($context -eq 'control' -and $currentControl) {
                switch ($pName) {
                    'Name'            { $currentControl.name = $pVal }
                    'Left'            { $currentControl.left = [int]$pVal }
                    'Top'             { $currentControl.top = [int]$pVal }
                    'Width'           { $currentControl.width = [int]$pVal }
                    'Height'          { $currentControl.height = [int]$pVal }
                    'FontName'        { $currentControl.fontName = $pVal }
                    'FontSize'        { $currentControl.fontSize = [int]$pVal }
                    'FontWeight'      { if ([int]$pVal -ge 700) { $currentControl.fontBold = $true } }
                    'FontItalic'      { if ($isNotDefault) { $currentControl.fontItalic = $true } }
                    'FontUnderline'   { if ($isNotDefault) { $currentControl.fontUnderline = $true } }
                    'ForeColor'       { $currentControl.foreColor = [long]$pVal }
                    'BackColor'       { $currentControl.backColor = [long]$pVal }
                    'BorderColor'     { $currentControl.borderColor = [long]$pVal }
                    'ControlSource'   { $currentControl.controlSource = $pVal }
                    'Caption'         { $currentControl.caption = $pVal }
                    'Format'          { $currentControl.format = $pVal }
                    'DecimalPlaces'   { $currentControl.'decimal-places' = [int]$pVal }
                    'TextAlign'       { $currentControl.textAlign = [int]$pVal }
                    'Visible'         { if ($pVal -eq '0' -or $pVal -eq 'False') { $currentControl.visible = $false } }
                    'CanGrow'         { if ($isNotDefault) { $currentControl.canGrow = $true } }
                    'CanShrink'       { if ($isNotDefault) { $currentControl.canShrink = $true } }
                    'RunningSum'      { $currentControl.runningSum = [int]$pVal }
                    'RowSource'       { $currentControl.rowSource = $pVal }
                    'BoundColumn'     { $currentControl.boundColumn = [int]$pVal }
                    'ColumnCount'     { $currentControl.columnCount = [int]$pVal }
                    'ColumnWidths'    { $currentControl.columnWidths = $pVal }
                }
            }
        }
    }

    if (-not $reportObj.Contains('reportWidth')) { $reportObj.reportWidth = 10000 }
    if (-not $reportObj.Contains('pageHeader')) { $reportObj.pageHeader = 0 }
    if (-not $reportObj.Contains('pageFooter')) { $reportObj.pageFooter = 0 }
    $reportObj.grouping = $grouping
    $reportObj.sections = $sections

    return $reportObj
}

# --- Export a single report via SaveAsText ---

function Export-SingleReport {
    param($accessApp, [string]$reportName)

    $tempFile = [System.IO.Path]::GetTempFileName()
    try {
        $accessApp.SaveAsText(3, $reportName, $tempFile)  # 3 = acReport
        $textContent = Get-Content $tempFile -Raw -Encoding Default
        $reportObj = Parse-ReportSaveAsText -textContent $textContent -reportName $reportName

        $totalControls = 0
        foreach ($sec in $reportObj.sections) { $totalControls += $sec.controls.Count }
        Write-Host "Exported $totalControls controls across $($reportObj.sections.Count) sections ($reportName)" -ForegroundColor Cyan

        return $reportObj
    } finally {
        Remove-Item $tempFile -Force -ErrorAction SilentlyContinue
    }
}

# Parse comma-separated report names
$names = $ReportNames -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' }

if ($names.Count -eq 0) {
    Write-Error "No report names provided"
    exit 1
}

# Kill any existing Access processes
Get-Process MSACCESS -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2

# Remove lock file if exists
if ($DatabasePath -match '\.accdb$') {
    Remove-Item ($DatabasePath -replace '\.accdb$', '.laccdb') -Force -ErrorAction SilentlyContinue
} elseif ($DatabasePath -match '\.mdb$') {
    Remove-Item ($DatabasePath -replace '\.mdb$', '.ldb') -Force -ErrorAction SilentlyContinue
}

$results = [ordered]@{}
$errors = @()

try {
    $accessApp = New-Object -ComObject Access.Application
    $accessApp.AutomationSecurity = 3  # msoAutomationSecurityForceDisable
    $accessApp.Visible = $false
    Open-AccessDatabase -AccessApp $accessApp -DatabasePath $DatabasePath

    foreach ($reportName in $names) {
        try {
            # Check COM health before each export — reconnect if dead
            try { $null = $accessApp.Visible } catch {
                Write-Host "COM connection lost. Reconnecting..." -ForegroundColor Yellow
                try { [System.Runtime.Interopservices.Marshal]::ReleaseComObject($accessApp) | Out-Null } catch {}
                Get-Process MSACCESS -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
                Start-Sleep -Seconds 2
                if ($DatabasePath -match '\.accdb$') {
                    Remove-Item ($DatabasePath -replace '\.accdb$', '.laccdb') -Force -ErrorAction SilentlyContinue
                } elseif ($DatabasePath -match '\.mdb$') {
                    Remove-Item ($DatabasePath -replace '\.mdb$', '.ldb') -Force -ErrorAction SilentlyContinue
                }
                $accessApp = New-Object -ComObject Access.Application
                $accessApp.AutomationSecurity = 3
                $accessApp.Visible = $false
                Open-AccessDatabase -AccessApp $accessApp -DatabasePath $DatabasePath
            }

            Write-Host "Exporting report: $reportName" -ForegroundColor Cyan
            $reportObj = Export-SingleReport -accessApp $accessApp -reportName $reportName
            $results[$reportName] = $reportObj
        } catch {
            Write-Host "Error exporting report $reportName : $_" -ForegroundColor Red
            $errors += [ordered]@{ name = $reportName; error = $_.Exception.Message }
        }
    }

    try { $accessApp.CloseCurrentDatabase() } catch {}
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

# Build final output
$output = [ordered]@{
    objects = $results
    errors = $errors
}

$json = $output | ConvertTo-Json -Depth 10 -Compress
Write-Output $json
