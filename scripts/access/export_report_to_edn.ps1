# Export Access Report to EDN
# Usage: .\export_report_to_edn.ps1 -DatabasePath "path\to\db.accdb" -ReportName "ReportName"

param(
    [Parameter(Mandatory=$true)]
    [string]$DatabasePath,

    [Parameter(Mandatory=$true)]
    [string]$ReportName,

    [string]$OutputPath
)

# Control type mapping (same as forms)
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

# Section type mapping for reports
# Access section indices: 0=Detail, 1=ReportHeader, 2=ReportFooter, 3=PageHeader, 4=PageFooter
# Group headers start at 5, group footers at 6, alternating for each group level
$sectionTypes = @{
    0 = "detail"
    1 = "report-header"
    2 = "report-footer"
    3 = "page-header"
    4 = "page-footer"
}

# Convert Access color (long integer) to hex string
function ConvertTo-HexColor {
    param([long]$color)
    if ($color -lt 0) { return "nil" }
    # Access stores colors as BGR, convert to RGB hex
    $b = ($color -band 0xFF0000) -shr 16
    $g = ($color -band 0x00FF00) -shr 8
    $r = ($color -band 0x0000FF)
    return ('"#' + $r.ToString('X2') + $g.ToString('X2') + $b.ToString('X2') + '"')
}

function ConvertTo-EdnString {
    param([string]$value)
    if ([string]::IsNullOrEmpty($value)) { return "nil" }
    # Escape backslashes first, then quotes
    $escaped = $value -replace '\\', '\\' -replace '"', '\"'
    # Handle newlines
    $escaped = $escaped -replace "`r`n", '\n' -replace "`n", '\n' -replace "`r", '\n'
    return ('"' + $escaped + '"')
}

# Helper to add an EDN property line
function Add-EdnProp {
    param([string]$indent, [string]$key, $value)
    return ($indent + ":" + $key + " " + $value)
}

# Export a single control to EDN lines
function Export-Control {
    param($ctl, [int]$indent = 3)

    $spaces = " " * $indent
    $inner = " " * ($indent + 1)

    $typeName = $ctlTypes[[int]$ctl.ControlType]
    if (-not $typeName) { $typeName = "unknown-$($ctl.ControlType)" }

    $lines = @()
    $lines += ($spaces + "{" + ":type :" + $typeName)
    $lines += (Add-EdnProp $inner "name" (ConvertTo-EdnString $ctl.Name))

    # Position and size
    $lines += (Add-EdnProp $inner "x" $ctl.Left)
    $lines += (Add-EdnProp $inner "y" $ctl.Top)
    $lines += (Add-EdnProp $inner "width" $ctl.Width)
    $lines += (Add-EdnProp $inner "height" $ctl.Height)

    # Font properties
    try {
        $fontName = $ctl.FontName
        if ($fontName) {
            $lines += (Add-EdnProp $inner "font-name" (ConvertTo-EdnString $fontName))
        }
    } catch {}

    try {
        $fontSize = $ctl.FontSize
        if ($fontSize -and $fontSize -gt 0) {
            $lines += (Add-EdnProp $inner "font-size" $fontSize)
        }
    } catch {}

    try {
        if ($ctl.FontBold) {
            $lines += (Add-EdnProp $inner "font-bold" "true")
        }
    } catch {}

    try {
        if ($ctl.FontItalic) {
            $lines += (Add-EdnProp $inner "font-italic" "true")
        }
    } catch {}

    try {
        if ($ctl.FontUnderline) {
            $lines += (Add-EdnProp $inner "font-underline" "true")
        }
    } catch {}

    # Colors
    try {
        $foreColor = $ctl.ForeColor
        if ($foreColor -ne $null -and $foreColor -ge 0) {
            $lines += (Add-EdnProp $inner "fore-color" (ConvertTo-HexColor $foreColor))
        }
    } catch {}

    try {
        $backColor = $ctl.BackColor
        if ($backColor -ne $null -and $backColor -ge 0) {
            $lines += (Add-EdnProp $inner "back-color" (ConvertTo-HexColor $backColor))
        }
    } catch {}

    try {
        $borderColor = $ctl.BorderColor
        if ($borderColor -ne $null -and $borderColor -ge 0) {
            $lines += (Add-EdnProp $inner "border-color" (ConvertTo-HexColor $borderColor))
        }
    } catch {}

    # Control source / field binding
    try {
        $ctlSource = $ctl.ControlSource
        if ($ctlSource) {
            $lines += (Add-EdnProp $inner "field" (ConvertTo-EdnString $ctlSource))
        }
    } catch {}

    # Caption
    try {
        $caption = $ctl.Caption
        if ($caption) {
            $lines += (Add-EdnProp $inner "caption" (ConvertTo-EdnString $caption))
        }
    } catch {}

    # Format
    try {
        $format = $ctl.Format
        if ($format) {
            $lines += (Add-EdnProp $inner "format" (ConvertTo-EdnString $format))
        }
    } catch {}

    # Running sum (for totals)
    try {
        $runningSum = $ctl.RunningSum
        if ($runningSum -gt 0) {
            $runningSumMap = @{ 1 = "over-group"; 2 = "over-all" }
            $runningSumName = $runningSumMap[[int]$runningSum]
            if ($runningSumName) {
                $lines += ($inner + ":running-sum :" + $runningSumName)
            }
        }
    } catch {}

    # Can grow / can shrink (text boxes)
    try {
        if ($ctl.CanGrow) {
            $lines += (Add-EdnProp $inner "can-grow" "true")
        }
    } catch {}

    try {
        if ($ctl.CanShrink) {
            $lines += (Add-EdnProp $inner "can-shrink" "true")
        }
    } catch {}

    # Hide duplicates
    try {
        if ($ctl.HideDuplicates) {
            $lines += (Add-EdnProp $inner "hide-duplicates" "true")
        }
    } catch {}

    # Visible
    try {
        if (-not $ctl.Visible) {
            $lines += (Add-EdnProp $inner "visible" "false")
        }
    } catch {}

    # Subreport specific
    try {
        $sourceObject = $ctl.SourceObject
        if ($sourceObject) {
            $lines += (Add-EdnProp $inner "source-report" (ConvertTo-EdnString $sourceObject))

            $linkChild = $ctl.LinkChildFields
            $linkMaster = $ctl.LinkMasterFields
            if ($linkChild) {
                $lines += ($inner + ":link-child-fields [" + (ConvertTo-EdnString $linkChild) + "]")
            }
            if ($linkMaster) {
                $lines += ($inner + ":link-master-fields [" + (ConvertTo-EdnString $linkMaster) + "]")
            }
        }
    } catch {}

    # Report-specific events
    $events = @(
        @("OnFormat", "has-format-event"),
        @("OnPrint", "has-print-event"),
        @("OnClick", "has-click-event")
    )

    foreach ($evt in $events) {
        try {
            $evtValue = $ctl.$($evt[0])
            if ($evtValue -eq "[Event Procedure]") {
                $lines += (Add-EdnProp $inner $evt[1] "true")
            }
        } catch {}
    }

    $lines += ($spaces + "}")
    return $lines
}

# Export a section to EDN
function Export-Section {
    param($section, [string]$sectionName, [int]$indent = 2)

    $spaces = " " * $indent
    $inner = " " * ($indent + 1)

    $lines = @()
    $lines += ($spaces + "{:name " + (ConvertTo-EdnString $sectionName))

    # Section height
    try {
        $lines += (Add-EdnProp $inner "height" $section.Height)
    } catch {}

    # Section visibility
    try {
        if (-not $section.Visible) {
            $lines += (Add-EdnProp $inner "visible" "false")
        }
    } catch {}

    # Can grow / can shrink
    try {
        if ($section.CanGrow) {
            $lines += (Add-EdnProp $inner "can-grow" "true")
        }
    } catch {}

    try {
        if ($section.CanShrink) {
            $lines += (Add-EdnProp $inner "can-shrink" "true")
        }
    } catch {}

    # Force new page
    try {
        $forceNewPage = $section.ForceNewPage
        if ($forceNewPage -gt 0) {
            $forceMap = @{ 1 = "before"; 2 = "after"; 3 = "before-and-after" }
            $forceName = $forceMap[[int]$forceNewPage]
            if ($forceName) {
                $lines += ($inner + ":force-new-page :" + $forceName)
            }
        }
    } catch {}

    # Keep together
    try {
        if ($section.KeepTogether) {
            $lines += (Add-EdnProp $inner "keep-together" "true")
        }
    } catch {}

    # Back color
    try {
        $backColor = $section.BackColor
        if ($backColor -ne $null -and $backColor -ge 0) {
            $lines += (Add-EdnProp $inner "back-color" (ConvertTo-HexColor $backColor))
        }
    } catch {}

    # Section events
    $events = @(
        @("OnFormat", "has-format-event"),
        @("OnPrint", "has-print-event"),
        @("OnRetreat", "has-retreat-event")
    )

    foreach ($evt in $events) {
        try {
            $evtValue = $section.$($evt[0])
            if ($evtValue -eq "[Event Procedure]") {
                $lines += (Add-EdnProp $inner $evt[1] "true")
            }
        } catch {}
    }

    # Controls in this section
    $lines += ($inner + ":controls")
    $lines += ($inner + "[")

    foreach ($ctl in $section.Controls) {
        $ctlLines = Export-Control -ctl $ctl -indent ($indent + 2)
        $lines += ($ctlLines -join "`n")
    }

    $lines += ($inner + "]")
    $lines += ($spaces + "}")

    return $lines
}

# Cleanup function for reuse
function Cleanup-Access {
    param([object]$app, [string]$dbPath)

    # Try to close gracefully first
    if ($app) {
        try {
            $app.Quit()
            [System.Runtime.Interopservices.Marshal]::ReleaseComObject($app) | Out-Null
        } catch {}
    }

    # Kill any remaining Access processes
    Get-Process MSACCESS -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2

    # Remove lock file if exists
    if ($dbPath) {
        $lockFile = $dbPath -replace '\.accdb$', '.laccdb'
        Remove-Item $lockFile -Force -ErrorAction SilentlyContinue
    }

    # Force garbage collection to release COM objects
    [System.GC]::Collect()
    [System.GC]::WaitForPendingFinalizers()
}

# Initial cleanup - kill any existing Access processes from previous runs
Write-Host "Cleaning up any previous Access instances..."
Cleanup-Access -app $null -dbPath $DatabasePath
Start-Sleep -Seconds 1

$accessApp = $null
try {
    $accessApp = New-Object -ComObject Access.Application
    $accessApp.Visible = $true
    $accessApp.OpenCurrentDatabase($DatabasePath)

    # Open report in Design view (acViewDesign = 1)
    $accessApp.DoCmd.OpenReport($ReportName, 1)
    Start-Sleep -Seconds 2

    $report = $accessApp.Screen.ActiveReport

    # Build EDN output
    $edn = @()
    $edn += "{:id nil"
    $edn += (Add-EdnProp " " "name" (ConvertTo-EdnString $report.Name))
    $edn += " :type :report"

    # Report caption/title
    try {
        $reportCaption = $report.Caption
        if ($reportCaption) {
            $edn += (Add-EdnProp " " "caption" (ConvertTo-EdnString $reportCaption))
        }
    } catch {}

    # Record source
    $recordSource = $report.RecordSource
    if ($recordSource -match '^SELECT .+ FROM (\w+)') {
        $edn += (Add-EdnProp " " "record-source" (ConvertTo-EdnString $Matches[1]))
    } elseif ($recordSource) {
        $edn += (Add-EdnProp " " "record-source" (ConvertTo-EdnString $recordSource))
    } else {
        $edn += " :record-source nil"
    }

    # Report dimensions
    try {
        $edn += (Add-EdnProp " " "report-width" $report.Width)
    } catch {}

    # Page settings
    try {
        $edn += (Add-EdnProp " " "page-header" $report.PageHeader)  # 0=all, 1=not with report header, 2=not with report footer, 3=not with either
        $edn += (Add-EdnProp " " "page-footer" $report.PageFooter)
    } catch {}

    # Grouping and sorting
    $edn += " :grouping ["
    try {
        $groupLevel = 0
        while ($true) {
            try {
                $grpField = $report.GroupLevel($groupLevel).ControlSource
                if (-not $grpField) { break }

                $grpHeader = $report.GroupLevel($groupLevel).GroupHeader
                $grpFooter = $report.GroupLevel($groupLevel).GroupFooter
                $grpOn = $report.GroupLevel($groupLevel).GroupOn
                $grpInterval = $report.GroupLevel($groupLevel).GroupInterval
                $keepTogether = $report.GroupLevel($groupLevel).KeepTogether
                $sortOrder = $report.GroupLevel($groupLevel).SortOrder

                $edn += ("  {:field " + (ConvertTo-EdnString $grpField))
                $edn += ("   :group-header " + $(if ($grpHeader) { "true" } else { "false" }))
                $edn += ("   :group-footer " + $(if ($grpFooter) { "true" } else { "false" }))

                if ($sortOrder -eq 1) {
                    $edn += "   :sort-order :descending"
                } else {
                    $edn += "   :sort-order :ascending"
                }

                if ($grpOn -gt 0) {
                    $grpOnMap = @{ 1 = "prefix"; 2 = "year"; 3 = "quarter"; 4 = "month"; 5 = "week"; 6 = "day"; 7 = "hour"; 8 = "minute"; 9 = "interval" }
                    $grpOnName = $grpOnMap[[int]$grpOn]
                    if ($grpOnName) {
                        $edn += ("   :group-on :" + $grpOnName)
                        if ($grpInterval -gt 1) {
                            $edn += ("   :group-interval " + $grpInterval)
                        }
                    }
                }

                if ($keepTogether -gt 0) {
                    $keepMap = @{ 1 = "whole-group"; 2 = "with-first-detail" }
                    $keepName = $keepMap[[int]$keepTogether]
                    if ($keepName) {
                        $edn += ("   :keep-together :" + $keepName)
                    }
                }

                $edn += "  }"
                $groupLevel++
            } catch {
                break
            }
        }
    } catch {}
    $edn += " ]"

    # Report-level events
    $reportEvents = @(
        @("OnOpen", "has-open-event"),
        @("OnClose", "has-close-event"),
        @("OnActivate", "has-activate-event"),
        @("OnDeactivate", "has-deactivate-event"),
        @("OnNoData", "has-no-data-event"),
        @("OnPage", "has-page-event"),
        @("OnError", "has-error-event")
    )

    foreach ($evt in $reportEvents) {
        try {
            $evtValue = $report.$($evt[0])
            if ($evtValue -eq "[Event Procedure]") {
                $edn += (Add-EdnProp " " $evt[1] "true")
            }
        } catch {}
    }

    # Sections
    $edn += " :sections"
    $edn += " ["

    # Standard sections
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
                $secLines = Export-Section -section $section -sectionName $secName -indent 2
                $edn += ($secLines -join "`n")
            }
        } catch {
            # Section doesn't exist or is hidden
        }
    }

    # Group headers and footers (indices 5, 6, 7, 8, etc.)
    $groupLevel = 0
    while ($true) {
        try {
            $grpField = $report.GroupLevel($groupLevel).ControlSource
            if (-not $grpField) { break }

            # Group header is at index 5 + (groupLevel * 2)
            # Group footer is at index 6 + (groupLevel * 2)
            $headerIndex = 5 + ($groupLevel * 2)
            $footerIndex = 6 + ($groupLevel * 2)

            if ($report.GroupLevel($groupLevel).GroupHeader) {
                try {
                    $section = $report.Section($headerIndex)
                    $secLines = Export-Section -section $section -sectionName "group-header-$groupLevel" -indent 2
                    $edn += ($secLines -join "`n")
                } catch {}
            }

            if ($report.GroupLevel($groupLevel).GroupFooter) {
                try {
                    $section = $report.Section($footerIndex)
                    $secLines = Export-Section -section $section -sectionName "group-footer-$groupLevel" -indent 2
                    $edn += ($secLines -join "`n")
                } catch {}
            }

            $groupLevel++
        } catch {
            break
        }
    }

    $edn += " ]"
    $edn += "}"

    $output = $edn -join "`n"

    if ($OutputPath) {
        $output | Out-File -FilePath $OutputPath -Encoding UTF8
        Write-Host "Exported to: $OutputPath"
    } else {
        Write-Output $output
    }

    $accessApp.DoCmd.Close(3, $ReportName, 0)  # 3 = acReport
    $accessApp.CloseCurrentDatabase()
}
catch {
    Write-Host "Error: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "Stack: $($_.ScriptStackTrace)" -ForegroundColor Yellow
}
finally {
    Write-Host "Cleaning up..."
    Cleanup-Access -app $accessApp -dbPath $DatabasePath
    Write-Host "Done."
}
