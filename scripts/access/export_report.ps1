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

# Control type mapping (Access ControlType enum -> string)
$ctlTypes = @{
    100 = "label"
    101 = "rectangle"
    102 = "line"
    103 = "image"
    104 = "button"
    105 = "option-button"
    106 = "check-box"
    107 = "option-group"
    109 = "text-box"
    110 = "list-box"
    111 = "combo-box"
    112 = "subreport"
    114 = "object-frame"
    118 = "page-break"
    122 = "toggle-button"
    123 = "tab-control"
    124 = "page"
}

# Section index mapping for reports
# Access section indices: 0=Detail, 1=ReportHeader, 2=ReportFooter, 3=PageHeader, 4=PageFooter
# Group headers/footers start at 5, alternating: 5=group-header-0, 6=group-footer-0, 7=group-header-1, etc.
$sectionNames = @{
    0 = "detail"
    1 = "report-header"
    2 = "report-footer"
    3 = "page-header"
    4 = "page-footer"
}

function Safe-GetProperty {
    param($obj, [string]$propName, $default = $null)
    try {
        $val = $obj.$propName
        if ($null -ne $val) { return $val }
        return $default
    } catch {
        return $default
    }
}

function Export-ReportControlToObject {
    param($ctl)

    $typeName = $ctlTypes[[int]$ctl.ControlType]
    if (-not $typeName) { $typeName = "unknown-$($ctl.ControlType)" }

    $obj = [ordered]@{
        type = $typeName
        name = $ctl.Name
    }

    # Position and size (in twips)
    $obj.left   = [int](Safe-GetProperty $ctl "Left" 0)
    $obj.top    = [int](Safe-GetProperty $ctl "Top" 0)
    $obj.width  = [int](Safe-GetProperty $ctl "Width" 100)
    $obj.height = [int](Safe-GetProperty $ctl "Height" 20)

    # Font properties
    $fontName = Safe-GetProperty $ctl "FontName"
    if ($fontName) { $obj.fontName = $fontName }

    $fontSize = Safe-GetProperty $ctl "FontSize"
    if ($fontSize -and $fontSize -gt 0) { $obj.fontSize = [int]$fontSize }

    if (Safe-GetProperty $ctl "FontBold" $false) { $obj.fontBold = $true }
    if (Safe-GetProperty $ctl "FontItalic" $false) { $obj.fontItalic = $true }
    if (Safe-GetProperty $ctl "FontUnderline" $false) { $obj.fontUnderline = $true }

    # Colors (as integers - conversion to hex done in ClojureScript)
    $foreColor = Safe-GetProperty $ctl "ForeColor"
    if ($null -ne $foreColor -and $foreColor -ge 0) { $obj.foreColor = [long]$foreColor }

    $backColor = Safe-GetProperty $ctl "BackColor"
    if ($null -ne $backColor -and $backColor -ge 0) { $obj.backColor = [long]$backColor }

    $borderColor = Safe-GetProperty $ctl "BorderColor"
    if ($null -ne $borderColor -and $borderColor -ge 0) { $obj.borderColor = [long]$borderColor }

    # Control source / field binding
    $ctlSource = Safe-GetProperty $ctl "ControlSource"
    if ($ctlSource) { $obj.controlSource = $ctlSource }

    # Caption
    $caption = Safe-GetProperty $ctl "Caption"
    if ($caption) { $obj.caption = $caption }

    # Format
    $format = Safe-GetProperty $ctl "Format"
    if ($format) { $obj.format = $format }

    # Tooltip
    $controlTip = Safe-GetProperty $ctl "ControlTipText"
    if ($controlTip) { $obj.tooltip = $controlTip }

    # Tag
    $tag = Safe-GetProperty $ctl "Tag"
    if ($tag) { $obj.tag = $tag }

    # Visible
    $visible = Safe-GetProperty $ctl "Visible" $true
    if (-not $visible) { $obj.visible = $false }

    # Report-specific control properties
    # Running sum (0=none, 1=over group, 2=over all)
    $runningSum = Safe-GetProperty $ctl "RunningSum"
    if ($null -ne $runningSum -and $runningSum -gt 0) { $obj.runningSum = [int]$runningSum }

    # Can grow / can shrink
    $canGrow = Safe-GetProperty $ctl "CanGrow" $false
    if ($canGrow) { $obj.canGrow = $true }

    $canShrink = Safe-GetProperty $ctl "CanShrink" $false
    if ($canShrink) { $obj.canShrink = $true }

    # Hide duplicates
    $hideDuplicates = Safe-GetProperty $ctl "HideDuplicates" $false
    if ($hideDuplicates) { $obj.hideDuplicates = $true }

    # Subreport specific
    $sourceObject = Safe-GetProperty $ctl "SourceObject"
    if ($sourceObject) {
        $obj.sourceReport = $sourceObject
        $linkChild = Safe-GetProperty $ctl "LinkChildFields"
        $linkMaster = Safe-GetProperty $ctl "LinkMasterFields"
        if ($linkChild) { $obj.linkChildFields = $linkChild }
        if ($linkMaster) { $obj.linkMasterFields = $linkMaster }
    }

    # Image specific
    if ($typeName -eq "image") {
        $picture = Safe-GetProperty $ctl "Picture"
        if ($picture) { $obj.picture = $picture }
        $sizeMode = Safe-GetProperty $ctl "SizeMode"
        if ($null -ne $sizeMode) {
            $sizeModeMap = @{ 0 = "clip"; 1 = "stretch"; 3 = "zoom" }
            $sizeModeName = $sizeModeMap[[int]$sizeMode]
            if ($sizeModeName) { $obj.sizeMode = $sizeModeName }
        }
    }

    # ComboBox / ListBox specific
    $rowSource = Safe-GetProperty $ctl "RowSource"
    if ($rowSource) {
        $obj.rowSource = $rowSource
        $obj.boundColumn = [int](Safe-GetProperty $ctl "BoundColumn" 1)
        $obj.columnCount = [int](Safe-GetProperty $ctl "ColumnCount" 1)

        $colWidths = Safe-GetProperty $ctl "ColumnWidths"
        if ($colWidths) { $obj.columnWidths = $colWidths }
    }

    # Event procedures
    $events = @(
        @("OnFormat", "hasFormatEvent"),
        @("OnPrint", "hasPrintEvent"),
        @("OnClick", "hasClickEvent")
    )

    foreach ($evt in $events) {
        $evtValue = Safe-GetProperty $ctl $evt[0]
        if ($evtValue -eq "[Event Procedure]") {
            $obj[$evt[1]] = $true
        }
    }

    return $obj
}

function Export-SectionToObject {
    param($section, [string]$sectionName, $report)

    $obj = [ordered]@{
        name = $sectionName
    }

    # Height
    $obj.height = [int](Safe-GetProperty $section "Height" 0)

    # Visibility
    $visible = Safe-GetProperty $section "Visible" $true
    $obj.visible = [bool]$visible

    # Can grow / can shrink
    $canGrow = Safe-GetProperty $section "CanGrow" $false
    $obj.canGrow = [bool]$canGrow

    $canShrink = Safe-GetProperty $section "CanShrink" $false
    $obj.canShrink = [bool]$canShrink

    # Force new page (0=none, 1=before, 2=after, 3=before and after)
    $forceNewPage = Safe-GetProperty $section "ForceNewPage" 0
    $obj.forceNewPage = [int]$forceNewPage

    # Keep together
    $keepTogether = Safe-GetProperty $section "KeepTogether" $true
    $obj.keepTogether = [bool]$keepTogether

    # Back color
    $backColor = Safe-GetProperty $section "BackColor"
    if ($null -ne $backColor -and $backColor -ge 0) { $obj.backColor = [long]$backColor }

    # Picture (section-level background image)
    $picture = Safe-GetProperty $section "Picture"
    if ($picture) { $obj.picture = $picture }
    $pictureSizeMode = Safe-GetProperty $section "PictureSizeMode"
    if ($null -ne $pictureSizeMode) { $obj.pictureSizeMode = [int]$pictureSizeMode }

    # Section events
    $events = @(
        @("OnFormat", "hasFormatEvent"),
        @("OnPrint", "hasPrintEvent"),
        @("OnRetreat", "hasRetreatEvent")
    )

    foreach ($evt in $events) {
        $evtValue = Safe-GetProperty $section $evt[0]
        if ($evtValue -eq "[Event Procedure]") {
            $obj[$evt[1]] = $true
        }
    }

    # Controls in this section
    $controls = @()
    foreach ($ctl in $section.Controls) {
        try {
            $ctlObj = Export-ReportControlToObject -ctl $ctl
            $controls += $ctlObj
        } catch {
            Write-Host "Warning: Could not export control $($ctl.Name): $_" -ForegroundColor Yellow
        }
    }
    $obj.controls = $controls

    return $obj
}

# Kill any existing Access processes
Get-Process MSACCESS -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2

# Remove lock file if exists
$lockFile = $DatabasePath -replace '\.accdb$', '.laccdb'
Remove-Item $lockFile -ErrorAction SilentlyContinue

try {
    $accessApp = New-Object -ComObject Access.Application
    $accessApp.AutomationSecurity = 3  # msoAutomationSecurityForceDisable
    $accessApp.Visible = $true
    $accessApp.OpenCurrentDatabase($DatabasePath)

    # Open report in Design view (acViewDesign = 1)
    $accessApp.DoCmd.OpenReport($ReportName, 1)
    Start-Sleep -Seconds 2

    $report = $accessApp.Screen.ActiveReport

    # Build report object
    $reportObj = [ordered]@{
        name = $report.Name
    }

    # Caption
    $caption = Safe-GetProperty $report "Caption"
    if ($caption) { $reportObj.caption = $caption }

    # Record source
    $recordSource = $report.RecordSource
    if ($recordSource) { $reportObj.recordSource = $recordSource }

    # Report width (twips)
    $reportObj.reportWidth = [int](Safe-GetProperty $report "Width" 10000)

    # Page header/footer options (0=all pages, 1=not with report header, 2=not with report footer, 3=not with either)
    $reportObj.pageHeader = [int](Safe-GetProperty $report "PageHeader" 0)
    $reportObj.pageFooter = [int](Safe-GetProperty $report "PageFooter" 0)

    # Report-level events
    $reportEvents = @(
        @("OnOpen", "hasOpenEvent"),
        @("OnClose", "hasCloseEvent"),
        @("OnActivate", "hasActivateEvent"),
        @("OnDeactivate", "hasDeactivateEvent"),
        @("OnNoData", "hasNoDataEvent"),
        @("OnPage", "hasPageEvent"),
        @("OnError", "hasErrorEvent")
    )

    foreach ($evt in $reportEvents) {
        $evtValue = Safe-GetProperty $report $evt[0]
        if ($evtValue -eq "[Event Procedure]") {
            $reportObj[$evt[1]] = $true
        }
    }

    # Report-level picture (background image)
    $picture = Safe-GetProperty $report "Picture"
    if ($picture) { $reportObj.picture = $picture }
    $pictureSizeMode = Safe-GetProperty $report "PictureSizeMode"
    if ($null -ne $pictureSizeMode) { $reportObj.pictureSizeMode = [int]$pictureSizeMode }

    # Grouping and sorting
    $grouping = @()
    $groupCount = 0
    try {
        $groupLevel = 0
        while ($true) {
            try {
                $grpField = $report.GroupLevel($groupLevel).ControlSource
                if (-not $grpField) { break }

                $grpObj = [ordered]@{
                    field = $grpField
                    groupHeader = [bool]$report.GroupLevel($groupLevel).GroupHeader
                    groupFooter = [bool]$report.GroupLevel($groupLevel).GroupFooter
                    sortOrder = [int]$report.GroupLevel($groupLevel).SortOrder
                    groupOn = [int]$report.GroupLevel($groupLevel).GroupOn
                    groupInterval = [int]$report.GroupLevel($groupLevel).GroupInterval
                    keepTogether = [int]$report.GroupLevel($groupLevel).KeepTogether
                }

                $grouping += $grpObj
                $groupCount++
                $groupLevel++
            } catch {
                break
            }
        }
    } catch {}
    $reportObj.grouping = $grouping

    # Sections
    $sections = @()

    # Standard sections (in logical order)
    $standardSections = @(
        @(1, "report-header"),
        @(3, "page-header"),
        @(0, "detail"),
        @(4, "page-footer"),
        @(2, "report-footer")
    )

    foreach ($secDef in $standardSections) {
        $secIndex = $secDef[0]
        $secName = $secDef[1]
        try {
            $section = $report.Section($secIndex)
            if ($section) {
                $secObj = Export-SectionToObject -section $section -sectionName $secName -report $report
                $sections += $secObj
            }
        } catch {
            # Section doesn't exist
        }
    }

    # Group headers and footers
    # Group header index = 5 + (groupLevel * 2)
    # Group footer index = 6 + (groupLevel * 2)
    for ($gl = 0; $gl -lt $groupCount; $gl++) {
        if ($report.GroupLevel($gl).GroupHeader) {
            try {
                $headerIndex = 5 + ($gl * 2)
                $section = $report.Section($headerIndex)
                $secObj = Export-SectionToObject -section $section -sectionName "group-header-$gl" -report $report
                $sections += $secObj
            } catch {}
        }

        if ($report.GroupLevel($gl).GroupFooter) {
            try {
                $footerIndex = 6 + ($gl * 2)
                $section = $report.Section($footerIndex)
                $secObj = Export-SectionToObject -section $section -sectionName "group-footer-$gl" -report $report
                $sections += $secObj
            } catch {}
        }
    }

    $reportObj.sections = $sections

    # Count total controls
    $totalControls = 0
    foreach ($sec in $sections) {
        $totalControls += $sec.controls.Count
    }
    Write-Host "Exported $totalControls controls across $($sections.Count) sections ($ReportName)" -ForegroundColor Cyan

    # Convert to JSON
    $json = $reportObj | ConvertTo-Json -Depth 10 -Compress

    if ($OutputPath) {
        $json | Out-File -FilePath $OutputPath -Encoding UTF8 -NoNewline
        Write-Host "Exported to: $OutputPath"
    } else {
        Write-Output $json
    }

    $accessApp.DoCmd.Close(3, $ReportName, 0)  # 3 = acReport
    $accessApp.CloseCurrentDatabase()
}
finally {
    if ($accessApp) {
        $accessApp.Quit()
        [System.Runtime.Interopservices.Marshal]::ReleaseComObject($accessApp) | Out-Null
    }
}
