# Export multiple Access Reports as JSON in a single COM session
# Usage: .\export_reports_batch.ps1 -DatabasePath "path\to\db.accdb" -ReportNames "Report1,Report2"
# Outputs JSON: {"objects":{"Report1":{...},"Report2":{...}},"errors":[...]}

param(
    [Parameter(Mandatory=$true)]
    [string]$DatabasePath,

    [Parameter(Mandatory=$true)]
    [string]$ReportNames
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

    $obj.left   = [int](Safe-GetProperty $ctl "Left" 0)
    $obj.top    = [int](Safe-GetProperty $ctl "Top" 0)
    $obj.width  = [int](Safe-GetProperty $ctl "Width" 100)
    $obj.height = [int](Safe-GetProperty $ctl "Height" 20)

    $fontName = Safe-GetProperty $ctl "FontName"
    if ($fontName) { $obj.fontName = $fontName }

    $fontSize = Safe-GetProperty $ctl "FontSize"
    if ($fontSize -and $fontSize -gt 0) { $obj.fontSize = [int]$fontSize }

    if (Safe-GetProperty $ctl "FontBold" $false) { $obj.fontBold = $true }
    if (Safe-GetProperty $ctl "FontItalic" $false) { $obj.fontItalic = $true }
    if (Safe-GetProperty $ctl "FontUnderline" $false) { $obj.fontUnderline = $true }

    $foreColor = Safe-GetProperty $ctl "ForeColor"
    if ($null -ne $foreColor -and $foreColor -ge 0) { $obj.foreColor = [long]$foreColor }

    $backColor = Safe-GetProperty $ctl "BackColor"
    if ($null -ne $backColor -and $backColor -ge 0) { $obj.backColor = [long]$backColor }

    $borderColor = Safe-GetProperty $ctl "BorderColor"
    if ($null -ne $borderColor -and $borderColor -ge 0) { $obj.borderColor = [long]$borderColor }

    $ctlSource = Safe-GetProperty $ctl "ControlSource"
    if ($ctlSource) { $obj.controlSource = $ctlSource }

    $caption = Safe-GetProperty $ctl "Caption"
    if ($caption) { $obj.caption = $caption }

    $format = Safe-GetProperty $ctl "Format"
    if ($format) { $obj.format = $format }

    $controlTip = Safe-GetProperty $ctl "ControlTipText"
    if ($controlTip) { $obj.tooltip = $controlTip }

    $tag = Safe-GetProperty $ctl "Tag"
    if ($tag) { $obj.tag = $tag }

    $visible = Safe-GetProperty $ctl "Visible" $true
    if (-not $visible) { $obj.visible = $false }

    $runningSum = Safe-GetProperty $ctl "RunningSum"
    if ($null -ne $runningSum -and $runningSum -gt 0) { $obj.runningSum = [int]$runningSum }

    $canGrow = Safe-GetProperty $ctl "CanGrow" $false
    if ($canGrow) { $obj.canGrow = $true }

    $canShrink = Safe-GetProperty $ctl "CanShrink" $false
    if ($canShrink) { $obj.canShrink = $true }

    $hideDuplicates = Safe-GetProperty $ctl "HideDuplicates" $false
    if ($hideDuplicates) { $obj.hideDuplicates = $true }

    $sourceObject = Safe-GetProperty $ctl "SourceObject"
    if ($sourceObject) {
        $obj.sourceReport = $sourceObject
        $linkChild = Safe-GetProperty $ctl "LinkChildFields"
        $linkMaster = Safe-GetProperty $ctl "LinkMasterFields"
        if ($linkChild) { $obj.linkChildFields = $linkChild }
        if ($linkMaster) { $obj.linkMasterFields = $linkMaster }
    }

    $rowSource = Safe-GetProperty $ctl "RowSource"
    if ($rowSource) {
        $obj.rowSource = $rowSource
        $obj.boundColumn = [int](Safe-GetProperty $ctl "BoundColumn" 1)
        $obj.columnCount = [int](Safe-GetProperty $ctl "ColumnCount" 1)

        $colWidths = Safe-GetProperty $ctl "ColumnWidths"
        if ($colWidths) { $obj.columnWidths = $colWidths }
    }

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

    $obj.height = [int](Safe-GetProperty $section "Height" 0)

    $visible = Safe-GetProperty $section "Visible" $true
    $obj.visible = [bool]$visible

    $canGrow = Safe-GetProperty $section "CanGrow" $false
    $obj.canGrow = [bool]$canGrow

    $canShrink = Safe-GetProperty $section "CanShrink" $false
    $obj.canShrink = [bool]$canShrink

    $forceNewPage = Safe-GetProperty $section "ForceNewPage" 0
    $obj.forceNewPage = [int]$forceNewPage

    $keepTogether = Safe-GetProperty $section "KeepTogether" $true
    $obj.keepTogether = [bool]$keepTogether

    $backColor = Safe-GetProperty $section "BackColor"
    if ($null -ne $backColor -and $backColor -ge 0) { $obj.backColor = [long]$backColor }

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

function Export-SingleReport {
    param($accessApp, [string]$reportName)

    $accessApp.DoCmd.OpenReport($reportName, 1)  # 1 = acViewDesign
    Start-Sleep -Seconds 1

    $report = $accessApp.Screen.ActiveReport

    $reportObj = [ordered]@{
        name = $report.Name
    }

    $caption = Safe-GetProperty $report "Caption"
    if ($caption) { $reportObj.caption = $caption }

    $recordSource = $report.RecordSource
    if ($recordSource) { $reportObj.recordSource = $recordSource }

    $reportObj.reportWidth = [int](Safe-GetProperty $report "Width" 10000)

    $reportObj.pageHeader = [int](Safe-GetProperty $report "PageHeader" 0)
    $reportObj.pageFooter = [int](Safe-GetProperty $report "PageFooter" 0)

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

    $sections = @()

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
        } catch {}
    }

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

    $totalControls = 0
    foreach ($sec in $sections) {
        $totalControls += $sec.controls.Count
    }
    Write-Host "Exported $totalControls controls across $($sections.Count) sections ($reportName)" -ForegroundColor Cyan

    $accessApp.DoCmd.Close(3, $reportName, 0)  # 3 = acReport

    return $reportObj
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
$lockFile = $DatabasePath -replace '\.accdb$', '.laccdb'
Remove-Item $lockFile -ErrorAction SilentlyContinue

$results = [ordered]@{}
$errors = @()

try {
    $accessApp = New-Object -ComObject Access.Application
    $accessApp.AutomationSecurity = 3  # msoAutomationSecurityForceDisable
    $accessApp.Visible = $true
    $accessApp.OpenCurrentDatabase($DatabasePath)

    foreach ($reportName in $names) {
        try {
            Write-Host "Exporting report: $reportName" -ForegroundColor Cyan
            $reportObj = Export-SingleReport -accessApp $accessApp -reportName $reportName
            $results[$reportName] = $reportObj
        } catch {
            Write-Host "Error exporting report $reportName : $_" -ForegroundColor Red
            $errors += [ordered]@{ name = $reportName; error = $_.Exception.Message }
        }
    }

    $accessApp.CloseCurrentDatabase()
}
finally {
    if ($accessApp) {
        $accessApp.Quit()
        [System.Runtime.Interopservices.Marshal]::ReleaseComObject($accessApp) | Out-Null
    }
}

# Build final output
$output = [ordered]@{
    objects = $results
    errors = $errors
}

$json = $output | ConvertTo-Json -Depth 10 -Compress
Write-Output $json
