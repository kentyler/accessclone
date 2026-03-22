# Export Access Report as JSON
# Usage: .\export_report.ps1 -DatabasePath "path\to\db.accdb" -ReportName "ReportName"
# Outputs JSON to stdout (or file if -OutputPath given)

param(
    [Parameter(Mandatory=$true)]
    [string]$DatabasePath,

    [Parameter(Mandatory=$true)]
    [string]$ReportName,

    [string]$OutputPath
)

. "$PSScriptRoot\com_helpers.ps1"

function DimToTwips {
    # Access SaveAsText stores geometry as twips (integers) OR inches (decimals, e.g. "0.2083").
    # [int] cast truncates 0.2083 to 0, so detect the decimal case and convert.
    param([string]$val)
    if ($val -match '\.') { return [int]([double]$val * 1440) }
    return [int]$val
}

function Parse-ReportSaveAsText {
    param([string]$textContent, [string]$reportName)

    $lines = $textContent -split "`r?`n"

    # Result structure matching COM export format
    $reportObj = [ordered]@{ name = $reportName }
    $grouping = @()
    $sections = @()

    # Section name mapping (SaveAsText uses Form-style names for report sections)
    $sectionTypeMap = @{
        'FormHeader' = 'report-header'
        'PageHeader' = 'page-header'
        'Section'    = 'detail'
        'PageFooter' = 'page-footer'
        'FormFooter' = 'report-footer'
    }

    # Control type mapping
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

    # Default control heights from top-level template blocks (e.g. Begin TextBox ... Height=300 ... End)
    $defaultHeights = @{}
    $defaultTypeName = ''

    # Context stack: what we're currently inside
    $context = 'none'          # 'report', 'defaults', 'grouping', 'section', 'section-controls', 'control'
    $currentSection = $null
    $currentControl = $null
    $groupHeaderIdx = 0
    $groupFooterIdx = 0

    foreach ($rawLine in $lines) {
        $line = $rawLine.Trim()
        if (-not $line) { continue }

        # --- Binary property blocks (e.g. "PrtMip = Begin" ... "End") ---
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

        # --- Structural Begin ---
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
                        height = 0
                        visible = $true
                        canGrow = $false
                        canShrink = $false
                        forceNewPage = 0
                        keepTogether = $false
                        controls = @()
                    }
                }
                elseif ($typeName -eq 'BreakLevel') {
                    $context = 'grouping'
                    $currentGroupObj = [ordered]@{
                        field = ''
                        groupHeader = $false
                        groupFooter = $false
                        sortOrder = 0
                        groupOn = 0
                        groupInterval = 1
                        keepTogether = 0
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
                else {
                    $context = 'defaults'
                    $defaultTypeName = $typeName
                }
            }
            elseif ($depth -eq 4 -and $context -eq 'section' -and -not $typeName) {
                $context = 'section-controls'
            }
            elseif ($depth -eq 5 -and $context -eq 'section-controls') {
                $ctlType = if ($ctlTypeMap.ContainsKey($typeName)) { $ctlTypeMap[$typeName] } else { $typeName.ToLower() }
                $context = 'control'
                $currentControl = [ordered]@{
                    type = $ctlType
                    name = ''
                    left = 0; top = 0; width = 0
                    height = if ($defaultHeights.ContainsKey($typeName)) { $defaultHeights[$typeName] } else { 0 }
                }
            }
            continue
        }

        # --- Structural End ---
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

        # --- Property parsing ---
        if ($line -match '^(\w+)\s*=\s*(.+)$') {
            $pName = $Matches[1]
            $pVal = $Matches[2].Trim()

            # Strip quotes
            if ($pVal -match '^"(.*)"$') { $pVal = $Matches[1] }

            $isNotDefault = ($pVal -eq 'NotDefault')

            # Report-level
            if ($context -eq 'report' -and $depth -eq 1) {
                switch ($pName) {
                    'RecordSource' { $reportObj.recordSource = $pVal }
                    'Width'        { $reportObj.reportWidth = DimToTwips $pVal }
                    'Caption'      { $reportObj.caption = $pVal }
                    'PageHeader'   { $reportObj.pageHeader = [int]$pVal }
                    'PageFooter'   { $reportObj.pageFooter = [int]$pVal }
                }
            }
            # Grouping
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
            # Section properties
            elseif ($context -eq 'section' -and $currentSection -and $depth -eq 3) {
                switch ($pName) {
                    'Height'       { $currentSection.height = DimToTwips $pVal }
                    'Visible'      { if ($pVal -eq '0' -or $pVal -eq 'False') { $currentSection.visible = $false } }
                    'CanGrow'      { if ($isNotDefault) { $currentSection.canGrow = $true } }
                    'CanShrink'    { if ($isNotDefault) { $currentSection.canShrink = $true } }
                    'KeepTogether' { if ($isNotDefault) { $currentSection.keepTogether = $true } }
                    'ForceNewPage' { $currentSection.forceNewPage = [int]$pVal }
                    'BackColor'    { $currentSection.backColor = [int]$pVal }
                }
            }
            # Default control template blocks
            elseif ($context -eq 'defaults') {
                if ($pName -eq 'Height') { $defaultHeights[$defaultTypeName] = DimToTwips $pVal }
            }
            # Control properties
            elseif ($context -eq 'control' -and $currentControl) {
                switch ($pName) {
                    'Name'            { $currentControl.name = $pVal }
                    'Left'            { $currentControl.left = DimToTwips $pVal }
                    'Top'             { $currentControl.top = DimToTwips $pVal }
                    'Width'           { $currentControl.width = DimToTwips $pVal }
                    'Height'          { $currentControl.height = DimToTwips $pVal }
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
                    'ColumnWidth'     { } # skip
                    'TabIndex'        { } # skip
                    'EventProcPrefix' { } # skip
                    'InputMask'       { } # skip
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

    # Apply Access internal defaults for report controls whose height was never written.
    $accessControlHeightDefaults = @{
        'text-box' = 300; 'combo-box' = 300; 'label' = 252
        'command-button' = 360; 'check-box' = 240; 'option-button' = 240
    }
    foreach ($sec in $sections) {
        foreach ($ctl in $sec.controls) {
            if ($ctl.height -eq 0 -and $accessControlHeightDefaults.ContainsKey($ctl.type)) {
                $ctl.height = $accessControlHeightDefaults[$ctl.type]
            }
        }
    }

    $reportObj.grouping = $grouping
    $reportObj.sections = $sections

    return $reportObj
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

try {
    $accessApp = New-Object -ComObject Access.Application
    $accessApp.AutomationSecurity = 3  # msoAutomationSecurityForceDisable
    $accessApp.Visible = $false
    Open-AccessDatabase -AccessApp $accessApp -DatabasePath $DatabasePath

    # Use SaveAsText — works reliably for all reports including .mdb with VBA compile errors
    $tempFile = [System.IO.Path]::GetTempFileName()
    $accessApp.SaveAsText(3, $ReportName, $tempFile)  # 3 = acReport
    $textContent = Get-Content $tempFile -Raw -Encoding Default
    Remove-Item $tempFile -Force -ErrorAction SilentlyContinue

    $reportObj = Parse-ReportSaveAsText -textContent $textContent -reportName $ReportName

    $totalControls = 0
    foreach ($sec in $reportObj.sections) { $totalControls += $sec.controls.Count }
    Write-Host "Exported $totalControls controls across $($reportObj.sections.Count) sections ($ReportName)" -ForegroundColor Cyan

    $json = $reportObj | ConvertTo-Json -Depth 10 -Compress

    if ($OutputPath) {
        $json | Out-File -FilePath $OutputPath -Encoding UTF8 -NoNewline
        Write-Host "Exported to: $OutputPath"
    } else {
        Write-Output $json
    }

    $accessApp.CloseCurrentDatabase()
}
finally {
    if ($accessApp) {
        $accessApp.Quit()
        [System.Runtime.Interopservices.Marshal]::ReleaseComObject($accessApp) | Out-Null
    }
}
