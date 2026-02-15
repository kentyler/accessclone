# Export Access Form as JSON
# Usage: .\export_form.ps1 -DatabasePath "path\to\db.accdb" -FormName "FormName"
# Outputs JSON to stdout (or file if -OutputPath given)

param(
    [Parameter(Mandatory=$true)]
    [string]$DatabasePath,

    [Parameter(Mandatory=$true)]
    [string]$FormName,

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
    112 = "subform"
    114 = "object-frame"
    118 = "page-break"
    122 = "toggle-button"
    123 = "tab-control"
    124 = "page"
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

function Export-ControlToObject {
    param($ctl, [string]$parentPage = $null)

    $typeName = $ctlTypes[[int]$ctl.ControlType]
    if (-not $typeName) { $typeName = "unknown-$($ctl.ControlType)" }

    $obj = [ordered]@{
        type = $typeName
        name = $ctl.Name
    }

    # Section (0=Detail, 1=Header, 2=Footer)
    $obj.section = [int](Safe-GetProperty $ctl "Section" 0)

    # Parent page for tab page children
    if ($parentPage) {
        $obj.parentPage = $parentPage
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

    # Default value
    $defaultValue = Safe-GetProperty $ctl "DefaultValue"
    if ($defaultValue) { $obj.defaultValue = $defaultValue }

    # Format
    $format = Safe-GetProperty $ctl "Format"
    if ($format) { $obj.format = $format }

    # Input mask
    $inputMask = Safe-GetProperty $ctl "InputMask"
    if ($inputMask) { $obj.inputMask = $inputMask }

    # Validation
    $validationRule = Safe-GetProperty $ctl "ValidationRule"
    if ($validationRule) { $obj.validationRule = $validationRule }

    $validationText = Safe-GetProperty $ctl "ValidationText"
    if ($validationText) { $obj.validationText = $validationText }

    # Tooltip
    $controlTip = Safe-GetProperty $ctl "ControlTipText"
    if ($controlTip) { $obj.tooltip = $controlTip }

    # Tag
    $tag = Safe-GetProperty $ctl "Tag"
    if ($tag) { $obj.tag = $tag }

    # Tab index
    $tabIndex = Safe-GetProperty $ctl "TabIndex"
    if ($null -ne $tabIndex) { $obj.tabIndex = [int]$tabIndex }

    # Enabled / Locked / Visible
    $enabled = Safe-GetProperty $ctl "Enabled" $true
    if (-not $enabled) { $obj.enabled = $false }

    $locked = Safe-GetProperty $ctl "Locked" $false
    if ($locked) { $obj.locked = $true }

    $visible = Safe-GetProperty $ctl "Visible" $true
    if (-not $visible) { $obj.visible = $false }

    # ComboBox / ListBox specific
    $rowSource = Safe-GetProperty $ctl "RowSource"
    if ($rowSource) {
        $obj.rowSource = $rowSource
        $obj.boundColumn = [int](Safe-GetProperty $ctl "BoundColumn" 1)
        $obj.columnCount = [int](Safe-GetProperty $ctl "ColumnCount" 1)

        $colWidths = Safe-GetProperty $ctl "ColumnWidths"
        if ($colWidths) { $obj.columnWidths = $colWidths }

        $limitToList = Safe-GetProperty $ctl "LimitToList" $false
        if ($limitToList) { $obj.limitToList = $true }
    }

    # Subform specific
    $sourceObject = Safe-GetProperty $ctl "SourceObject"
    if ($sourceObject) {
        $obj.sourceForm = $sourceObject
        $linkChild = Safe-GetProperty $ctl "LinkChildFields"
        $linkMaster = Safe-GetProperty $ctl "LinkMasterFields"
        if ($linkChild) { $obj.linkChildFields = $linkChild }
        if ($linkMaster) { $obj.linkMasterFields = $linkMaster }
    }

    # Tab control pages
    if ($typeName -eq "tab-control") {
        try {
            $pageNames = @()
            foreach ($page in $ctl.Pages) {
                $pageNames += $page.Name
            }
            if ($pageNames.Count -gt 0) { $obj.pages = $pageNames }
        } catch {}
    }

    # Page specific
    if ($typeName -eq "page") {
        $pageIndex = Safe-GetProperty $ctl "PageIndex"
        if ($null -ne $pageIndex) { $obj.pageIndex = [int]$pageIndex }
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

    # Event procedures (flag them)
    $events = @(
        @("OnClick", "hasClickEvent"),
        @("OnDblClick", "hasDblClickEvent"),
        @("OnChange", "hasChangeEvent"),
        @("OnEnter", "hasEnterEvent"),
        @("OnExit", "hasExitEvent"),
        @("BeforeUpdate", "hasBeforeUpdateEvent"),
        @("AfterUpdate", "hasAfterUpdateEvent"),
        @("OnGotFocus", "hasGotFocusEvent"),
        @("OnLostFocus", "hasLostFocusEvent")
    )

    foreach ($evt in $events) {
        $evtValue = Safe-GetProperty $ctl $evt[0]
        if ($evtValue -eq "[Event Procedure]") {
            $obj[$evt[1]] = $true
        }
    }

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

    $accessApp.DoCmd.OpenForm($FormName, 1)  # 1 = acDesign
    Start-Sleep -Seconds 2

    $form = $accessApp.Screen.ActiveForm

    # Build form object
    $formObj = [ordered]@{
        name = $form.Name
    }

    # Caption
    $caption = Safe-GetProperty $form "Caption"
    if ($caption) { $formObj.caption = $caption }

    # Record source
    $recordSource = $form.RecordSource
    if ($recordSource) { $formObj.recordSource = $recordSource }

    # Default view (0=Single, 1=Continuous, 2=Datasheet)
    $formObj.defaultView = [int](Safe-GetProperty $form "DefaultView" 0)

    # Filter and OrderBy
    $filter = Safe-GetProperty $form "Filter"
    if ($filter) { $formObj.filter = $filter }

    $filterOn = Safe-GetProperty $form "FilterOn" $false
    if ($filterOn) { $formObj.filterOn = $true }

    $orderBy = Safe-GetProperty $form "OrderBy"
    if ($orderBy) { $formObj.orderBy = $orderBy }

    $orderByOn = Safe-GetProperty $form "OrderByOn" $false
    if ($orderByOn) { $formObj.orderByOn = $true }

    # Form width (twips)
    $formObj.formWidth = [int](Safe-GetProperty $form "Width" 10000)

    # Section heights (twips)
    $formObj.sections = [ordered]@{}
    try { $formObj.sections.headerHeight = [int]$form.Section(1).Height } catch { $formObj.sections.headerHeight = 0 }
    try { $formObj.sections.detailHeight = [int]$form.Section(0).Height } catch { $formObj.sections.detailHeight = 3000 }
    try { $formObj.sections.footerHeight = [int]$form.Section(2).Height } catch { $formObj.sections.footerHeight = 0 }

    # Navigation/editing options
    $formObj.navigationButtons = [bool](Safe-GetProperty $form "NavigationButtons" $true)
    $formObj.recordSelectors = [bool](Safe-GetProperty $form "RecordSelectors" $true)
    $formObj.allowAdditions = [bool](Safe-GetProperty $form "AllowAdditions" $true)
    $formObj.allowDeletions = [bool](Safe-GetProperty $form "AllowDeletions" $true)
    $formObj.allowEdits = [bool](Safe-GetProperty $form "AllowEdits" $true)

    # Scroll bars (0=neither, 1=horizontal, 2=vertical, 3=both)
    $formObj.scrollBars = [int](Safe-GetProperty $form "ScrollBars" 3)

    # Popup / Modal
    $formObj.popup = [bool](Safe-GetProperty $form "PopUp" $false)
    $formObj.modal = [bool](Safe-GetProperty $form "Modal" $false)

    # Dividing lines
    $formObj.dividingLines = [bool](Safe-GetProperty $form "DividingLines" $true)

    # Data entry mode
    $formObj.dataEntry = [bool](Safe-GetProperty $form "DataEntry" $false)

    # Colors
    $backColor = Safe-GetProperty $form "Section(0).BackColor"
    if ($null -eq $backColor) {
        try { $backColor = $form.Section(0).BackColor } catch {}
    }
    if ($null -ne $backColor -and $backColor -ge 0) { $formObj.backColor = [long]$backColor }

    # Form-level picture (background image)
    $picture = Safe-GetProperty $form "Picture"
    if ($picture) { $formObj.picture = $picture }
    $pictureSizeMode = Safe-GetProperty $form "PictureSizeMode"
    if ($null -ne $pictureSizeMode) { $formObj.pictureSizeMode = [int]$pictureSizeMode }

    # Section-level pictures
    foreach ($secDef in @(@(1, "header"), @(0, "detail"), @(2, "footer"))) {
        try {
            $sec = $form.Section($secDef[0])
            $secPic = Safe-GetProperty $sec "Picture"
            if ($secPic) {
                $formObj.sections["$($secDef[1])Picture"] = $secPic
                $secPicSM = Safe-GetProperty $sec "PictureSizeMode"
                if ($null -ne $secPicSM) { $formObj.sections["$($secDef[1])PictureSizeMode"] = [int]$secPicSM }
            }
        } catch {}
    }

    # Form-level events
    $formEvents = @(
        @("OnLoad", "hasLoadEvent"),
        @("OnOpen", "hasOpenEvent"),
        @("OnClose", "hasCloseEvent"),
        @("OnCurrent", "hasCurrentEvent"),
        @("BeforeInsert", "hasBeforeInsertEvent"),
        @("AfterInsert", "hasAfterInsertEvent"),
        @("BeforeUpdate", "hasBeforeUpdateEvent"),
        @("AfterUpdate", "hasAfterUpdateEvent"),
        @("OnDelete", "hasDeleteEvent")
    )

    foreach ($evt in $formEvents) {
        $evtValue = Safe-GetProperty $form $evt[0]
        if ($evtValue -eq "[Event Procedure]") {
            $formObj[$evt[1]] = $true
        }
    }

    # Track tab page children
    $tabPageControls = @{}
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
    $controls = @()
    foreach ($ctl in $form.Controls) {
        try {
            $parentPage = $tabPageControls[$ctl.Name]
            $ctlObj = Export-ControlToObject -ctl $ctl -parentPage $parentPage
            $controls += $ctlObj
        } catch {
            Write-Host "Warning: Could not export control $($ctl.Name): $_" -ForegroundColor Yellow
        }
    }
    $formObj.controls = $controls

    Write-Host "Exported $($controls.Count) controls ($FormName)" -ForegroundColor Cyan

    # Convert to JSON
    $json = $formObj | ConvertTo-Json -Depth 10 -Compress

    if ($OutputPath) {
        $json | Out-File -FilePath $OutputPath -Encoding UTF8 -NoNewline
        Write-Host "Exported to: $OutputPath"
    } else {
        Write-Output $json
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
