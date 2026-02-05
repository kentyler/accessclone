# Export Access Form to EDN
# Usage: .\export_form_to_edn.ps1 -DatabasePath "path\to\db.accdb" -FormName "FormName"

param(
    [Parameter(Mandatory=$true)]
    [string]$DatabasePath,

    [Parameter(Mandatory=$true)]
    [string]$FormName,

    [string]$OutputPath
)

# Control type mapping
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
    112 = "subform"
    114 = "object-frame"
    118 = "page-break"
    122 = "toggle-button"
    123 = "tab-control"
    124 = "page"
}

# Default view mapping
$viewTypes = @{
    0 = "single"
    1 = "continuous"
    2 = "datasheet"
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
    param($ctl, [int]$indent = 2, [string]$parentPage = $null)

    $spaces = " " * $indent
    $inner = " " * ($indent + 1)

    $typeName = $ctlTypes[[int]$ctl.ControlType]
    if (-not $typeName) { $typeName = "unknown-$($ctl.ControlType)" }

    $lines = @()
    $lines += ($spaces + "{" + ":type :" + $typeName)
    $lines += (Add-EdnProp $inner "name" (ConvertTo-EdnString $ctl.Name))

    # Parent page for controls inside tab pages
    if ($parentPage) {
        $lines += (Add-EdnProp $inner "parent-page" (ConvertTo-EdnString $parentPage))
    }

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

    # Default value
    try {
        $defaultValue = $ctl.DefaultValue
        if ($defaultValue) {
            $lines += (Add-EdnProp $inner "default-value" (ConvertTo-EdnString $defaultValue))
        }
    } catch {}

    # Format
    try {
        $format = $ctl.Format
        if ($format) {
            $lines += (Add-EdnProp $inner "format" (ConvertTo-EdnString $format))
        }
    } catch {}

    # Input mask
    try {
        $inputMask = $ctl.InputMask
        if ($inputMask) {
            $lines += (Add-EdnProp $inner "input-mask" (ConvertTo-EdnString $inputMask))
        }
    } catch {}

    # Validation
    try {
        $validationRule = $ctl.ValidationRule
        if ($validationRule) {
            $lines += (Add-EdnProp $inner "validation-rule" (ConvertTo-EdnString $validationRule))
        }
    } catch {}

    try {
        $validationText = $ctl.ValidationText
        if ($validationText) {
            $lines += (Add-EdnProp $inner "validation-text" (ConvertTo-EdnString $validationText))
        }
    } catch {}

    # Tooltip
    try {
        $controlTip = $ctl.ControlTipText
        if ($controlTip) {
            $lines += (Add-EdnProp $inner "tooltip" (ConvertTo-EdnString $controlTip))
        }
    } catch {}

    # Tag (often used for custom metadata)
    try {
        $tag = $ctl.Tag
        if ($tag) {
            $lines += (Add-EdnProp $inner "tag" (ConvertTo-EdnString $tag))
        }
    } catch {}

    # Tab index
    try {
        $tabIndex = $ctl.TabIndex
        if ($tabIndex -ne $null) {
            $lines += (Add-EdnProp $inner "tab-index" $tabIndex)
        }
    } catch {}

    # Enabled / Locked / Visible states
    try {
        if (-not $ctl.Enabled) {
            $lines += (Add-EdnProp $inner "enabled" "false")
        }
    } catch {}

    try {
        if ($ctl.Locked) {
            $lines += (Add-EdnProp $inner "locked" "true")
        }
    } catch {}

    try {
        if (-not $ctl.Visible) {
            $lines += (Add-EdnProp $inner "visible" "false")
        }
    } catch {}

    # ComboBox / ListBox specific
    try {
        $rowSource = $ctl.RowSource
        if ($rowSource) {
            $lines += (Add-EdnProp $inner "row-source" (ConvertTo-EdnString $rowSource))
            $lines += (Add-EdnProp $inner "bound-column" $ctl.BoundColumn)
            $lines += (Add-EdnProp $inner "column-count" $ctl.ColumnCount)

            # Column widths
            try {
                $colWidths = $ctl.ColumnWidths
                if ($colWidths) {
                    $lines += (Add-EdnProp $inner "column-widths" (ConvertTo-EdnString $colWidths))
                }
            } catch {}

            # Limit to list
            try {
                if ($ctl.LimitToList) {
                    $lines += (Add-EdnProp $inner "limit-to-list" "true")
                }
            } catch {}
        }
    } catch {}

    # Subform specific
    try {
        $sourceObject = $ctl.SourceObject
        if ($sourceObject) {
            $lines += (Add-EdnProp $inner "source-form" (ConvertTo-EdnString $sourceObject))

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

    # Tab control specific - export pages
    if ($typeName -eq "tab-control") {
        try {
            $pageNames = @()
            foreach ($page in $ctl.Pages) {
                $pageNames += (ConvertTo-EdnString $page.Name)
            }
            if ($pageNames.Count -gt 0) {
                $lines += ($inner + ":pages [" + ($pageNames -join " ") + "]")
            }
        } catch {}
    }

    # Page specific (tab page)
    if ($typeName -eq "page") {
        try {
            $pageIndex = $ctl.PageIndex
            $lines += (Add-EdnProp $inner "page-index" $pageIndex)
        } catch {}
    }

    # Option group specific
    if ($typeName -eq "option-group") {
        try {
            $optionValue = $ctl.DefaultValue
            if ($optionValue) {
                $lines += (Add-EdnProp $inner "default-option" $optionValue)
            }
        } catch {}
    }

    # Image specific
    if ($typeName -eq "image") {
        try {
            $picture = $ctl.Picture
            if ($picture) {
                $lines += (Add-EdnProp $inner "picture" (ConvertTo-EdnString $picture))
            }
        } catch {}
        try {
            $sizeMode = $ctl.SizeMode
            $sizeModeMap = @{ 0 = "clip"; 1 = "stretch"; 3 = "zoom" }
            $sizeModeName = $sizeModeMap[[int]$sizeMode]
            if ($sizeModeName) {
                $lines += ($inner + ":size-mode :" + $sizeModeName)
            }
        } catch {}
    }

    # Event procedures (flag them)
    $events = @(
        @("OnClick", "has-click-event"),
        @("OnDblClick", "has-dblclick-event"),
        @("OnChange", "has-change-event"),
        @("OnEnter", "has-enter-event"),
        @("OnExit", "has-exit-event"),
        @("BeforeUpdate", "has-before-update-event"),
        @("AfterUpdate", "has-after-update-event"),
        @("OnGotFocus", "has-gotfocus-event"),
        @("OnLostFocus", "has-lostfocus-event")
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

# Kill any existing Access processes
Get-Process MSACCESS -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2

# Remove lock file if exists
$lockFile = $DatabasePath -replace '\.accdb$', '.laccdb'
Remove-Item $lockFile -ErrorAction SilentlyContinue

try {
    $accessApp = New-Object -ComObject Access.Application
    $accessApp.Visible = $true
    $accessApp.OpenCurrentDatabase($DatabasePath)

    $accessApp.DoCmd.OpenForm($FormName, 1)  # 1 = acDesign
    Start-Sleep -Seconds 2

    $form = $accessApp.Screen.ActiveForm

    # Build EDN output
    $edn = @()
    $edn += "{:id nil"
    $edn += (Add-EdnProp " " "name" (ConvertTo-EdnString $form.Name))
    $edn += " :type :form"

    # Form caption/title
    try {
        $formCaption = $form.Caption
        if ($formCaption) {
            $edn += (Add-EdnProp " " "caption" (ConvertTo-EdnString $formCaption))
        }
    } catch {}

    # Record source
    $recordSource = $form.RecordSource
    if ($recordSource -match '^SELECT .+ FROM (\w+)') {
        $edn += (Add-EdnProp " " "record-source" (ConvertTo-EdnString $Matches[1]))
    } elseif ($recordSource) {
        $edn += (Add-EdnProp " " "record-source" (ConvertTo-EdnString $recordSource))
    } else {
        $edn += " :record-source nil"
    }

    # Default view
    $viewType = $viewTypes[[int]$form.DefaultView]
    if (-not $viewType) { $viewType = "single" }
    $edn += (' :default-view "' + $viewType + '"')

    # Form dimensions
    try {
        $edn += (Add-EdnProp " " "form-width" $form.Width)
        $edn += (Add-EdnProp " " "form-height" $form.Section(0).Height)  # Detail section height
    } catch {}

    # Form navigation/editing options
    try {
        if (-not $form.NavigationButtons) {
            $edn += (Add-EdnProp " " "navigation-buttons" "false")
        }
    } catch {}

    try {
        if (-not $form.RecordSelectors) {
            $edn += (Add-EdnProp " " "record-selectors" "false")
        }
    } catch {}

    try {
        if (-not $form.AllowAdditions) {
            $edn += (Add-EdnProp " " "allow-additions" "false")
        }
    } catch {}

    try {
        if (-not $form.AllowDeletions) {
            $edn += (Add-EdnProp " " "allow-deletions" "false")
        }
    } catch {}

    try {
        if (-not $form.AllowEdits) {
            $edn += (Add-EdnProp " " "allow-edits" "false")
        }
    } catch {}

    # Scroll bars
    try {
        $scrollBars = $form.ScrollBars
        $scrollMap = @{ 0 = "neither"; 1 = "horizontal"; 2 = "vertical"; 3 = "both" }
        $scrollName = $scrollMap[[int]$scrollBars]
        if ($scrollName -and $scrollName -ne "both") {
            $edn += (" :scroll-bars :" + $scrollName)
        }
    } catch {}

    # Form-level events
    $formEvents = @(
        @("OnLoad", "has-load-event"),
        @("OnOpen", "has-open-event"),
        @("OnClose", "has-close-event"),
        @("OnCurrent", "has-current-event"),
        @("BeforeInsert", "has-before-insert-event"),
        @("AfterInsert", "has-after-insert-event"),
        @("BeforeUpdate", "has-before-update-event"),
        @("AfterUpdate", "has-after-update-event"),
        @("OnDelete", "has-delete-event")
    )

    foreach ($evt in $formEvents) {
        try {
            $evtValue = $form.$($evt[0])
            if ($evtValue -eq "[Event Procedure]") {
                $edn += (Add-EdnProp " " $evt[1] "true")
            }
        } catch {}
    }

    # Controls
    $edn += " :controls"
    $edn += " ["

    # Track which controls are inside tab pages
    $tabPageControls = @{}

    # First pass: identify tab controls and their pages
    foreach ($ctl in $form.Controls) {
        if ([int]$ctl.ControlType -eq 123) {  # Tab control
            try {
                foreach ($page in $ctl.Pages) {
                    foreach ($pageCtl in $page.Controls) {
                        $tabPageControls[$pageCtl.Name] = $page.Name
                    }
                }
            } catch {}
        }
    }

    # Export all controls
    foreach ($ctl in $form.Controls) {
        $parentPage = $tabPageControls[$ctl.Name]
        $ctlLines = Export-Control -ctl $ctl -indent 2 -parentPage $parentPage
        $edn += ($ctlLines -join "`n")
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

    $accessApp.DoCmd.Close(2, $FormName, 0)
    $accessApp.CloseCurrentDatabase()
}
finally {
    if ($accessApp) {
        $accessApp.Quit()
        [System.Runtime.Interopservices.Marshal]::ReleaseComObject($accessApp) | Out-Null
    }
}
