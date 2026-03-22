# Export Access Form as JSON via SaveAsText
# Usage: .\export_form.ps1 -DatabasePath "path\to\db.accdb" -FormName "FormName"
# Outputs JSON to stdout (or file if -OutputPath given)

param(
    [Parameter(Mandatory=$true)]
    [string]$DatabasePath,

    [Parameter(Mandatory=$true)]
    [string]$FormName,

    [string]$OutputPath
)

. "$PSScriptRoot\com_helpers.ps1"

# --- SaveAsText parser for forms ---

function DimToTwips {
    # Access SaveAsText stores geometry as twips (integers) OR inches (decimals, e.g. "0.2083").
    # [int] cast truncates 0.2083 to 0, so detect the decimal case and convert.
    param([string]$val)
    if ($val -match '\.') { return [int]([double]$val * 1440) }
    return [int]$val
}

function Parse-FormSaveAsText {
    param([string]$textContent, [string]$formName)

    $lines = $textContent -split "`r?`n"

    $formObj = [ordered]@{ name = $formName }
    $controls = @()
    $sectionHeights = [ordered]@{ headerHeight = 0; detailHeight = 3000; footerHeight = 0 }
    $sectionProps = [ordered]@{}

    $sectionMap = @{
        'FormHeader' = 1
        'Section'    = 0
        'FormFooter' = 2
    }
    $sectionPrefix = @{ 0 = 'detail'; 1 = 'header'; 2 = 'footer' }

    $ctlTypeMap = @{
        'Label' = 'label'; 'TextBox' = 'text-box'; 'ComboBox' = 'combo-box'
        'ListBox' = 'list-box'; 'CheckBox' = 'check-box'; 'OptionButton' = 'option-button'
        'ToggleButton' = 'toggle-button'; 'CommandButton' = 'command-button'
        'Image' = 'image'; 'Rectangle' = 'rectangle'; 'Line' = 'line'
        'SubForm' = 'subform'; 'OptionGroup' = 'option-group'
        'BoundObjectFrame' = 'object-frame'; 'PageBreak' = 'page-break'
        'TabCtl' = 'tab-control'; 'Page' = 'page'; 'Attachment' = 'attachment'
    }

    $depth = 0
    $inBinary = $false
    $binaryDepth = 0

    # Default control heights from top-level template blocks
    $defaultHeights = @{}
    $defaultTypeName = ''

    # Context stack
    $ctxStack = [System.Collections.ArrayList]::new()
    $ctx = 'none'

    # Control stack — when entering a control's children, push current control
    $controlStack = [System.Collections.ArrayList]::new()
    $currentControl = $null
    $currentSection = 0
    $currentTabPage = $null

    # Form-level event tracking
    $formEvents = [ordered]@{}

    foreach ($rawLine in $lines) {
        $line = $rawLine.Trim()
        if (-not $line) { continue }

        # Binary property blocks
        if ($line -match '^\w+\s*=\s*Begin\s*$') {
            $inBinary = $true; $binaryDepth = 1; continue
        }
        if ($inBinary) {
            if ($line -eq 'Begin') { $binaryDepth++ }
            elseif ($line -eq 'End') { $binaryDepth--; if ($binaryDepth -eq 0) { $inBinary = $false } }
            continue
        }

        # --- Begin ---
        if ($line -match '^Begin\s*(.*)$') {
            $typeName = $Matches[1].Trim()
            $depth++

            # Push context
            $null = $ctxStack.Add($ctx)

            if ($ctx -eq 'none' -and $typeName -eq 'Form') {
                $ctx = 'form'
            }
            elseif ($ctx -eq 'form' -and -not $typeName) {
                $ctx = 'formContainer'
            }
            elseif ($ctx -eq 'formContainer') {
                if ($sectionMap.ContainsKey($typeName)) {
                    $currentSection = $sectionMap[$typeName]
                    $ctx = 'section'
                } else {
                    $ctx = 'defaults'
                    $defaultTypeName = $typeName
                }
            }
            elseif ($ctx -eq 'section' -and -not $typeName) {
                $ctx = 'sectionControls'
            }
            elseif ($ctx -eq 'sectionControls') {
                # Main control in a section
                $ctlType = if ($ctlTypeMap.ContainsKey($typeName)) { $ctlTypeMap[$typeName] } else { $typeName.ToLower() }
                $currentControl = [ordered]@{
                    type = $ctlType; name = ''; section = $currentSection
                    left = 0; top = 0; width = 0
                    height = if ($defaultHeights.ContainsKey($typeName)) { $defaultHeights[$typeName] } else { 0 }
                }
                if ($currentTabPage) { $currentControl.parentPage = $currentTabPage }
                $ctx = 'control'
            }
            elseif ($ctx -eq 'control' -and -not $typeName) {
                # Entering control's children container — save current control, push to stack
                if ($currentControl -and $currentControl.name) {
                    $controls += $currentControl
                }
                $null = $controlStack.Add($currentControl)
                $currentControl = $null
                $ctx = 'controlChildren'
            }
            elseif ($ctx -eq 'controlChildren') {
                if ($ctlTypeMap.ContainsKey($typeName)) {
                    $ctlType = $ctlTypeMap[$typeName]
                    if ($typeName -eq 'Page') {
                        # Tab page — create page control, will set tab page name from Name property
                        $currentControl = [ordered]@{
                            type = 'page'; name = ''; section = $currentSection
                            left = 0; top = 0; width = 0
                            height = if ($defaultHeights.ContainsKey($typeName)) { $defaultHeights[$typeName] } else { 0 }
                        }
                        $ctx = 'tabPage'
                    } else {
                        # Attached label or other child
                        $currentControl = [ordered]@{
                            type = $ctlType; name = ''; section = $currentSection
                            left = 0; top = 0; width = 0
                            height = if ($defaultHeights.ContainsKey($typeName)) { $defaultHeights[$typeName] } else { 0 }
                        }
                        if ($currentTabPage) { $currentControl.parentPage = $currentTabPage }
                        $ctx = 'control'
                    }
                } else {
                    $ctx = 'skip'
                }
            }
            elseif ($ctx -eq 'tabPage' -and -not $typeName) {
                # Tab page controls container — save page control first
                if ($currentControl -and $currentControl.name) {
                    $currentTabPage = $currentControl.name
                    $controls += $currentControl
                }
                $null = $controlStack.Add($currentControl)
                $currentControl = $null
                $ctx = 'sectionControls'  # reuse sectionControls for page children
            }
            else {
                $ctx = 'skip'
            }
            continue
        }

        # --- End ---
        if ($line -eq 'End') {
            $prevCtx = $ctx
            # Pop context
            if ($ctxStack.Count -gt 0) {
                $ctx = $ctxStack[$ctxStack.Count - 1]
                $ctxStack.RemoveAt($ctxStack.Count - 1)
            } else { $ctx = 'none' }
            $depth--

            # Save control when exiting control context (if not already saved)
            if ($prevCtx -eq 'control' -and $currentControl -and $currentControl.name) {
                $controls += $currentControl
                $currentControl = $null
            }
            # Restore from control stack when exiting children containers
            if ($prevCtx -eq 'controlChildren' -and $controlStack.Count -gt 0) {
                $currentControl = $controlStack[$controlStack.Count - 1]
                $controlStack.RemoveAt($controlStack.Count - 1)
                $currentControl = $null  # already saved
            }
            # Exiting tabPage's controls — pop controlStack and clear tab page
            if ($prevCtx -eq 'sectionControls' -and $ctx -eq 'tabPage') {
                # Nothing to do — will be handled by tabPage End
            }
            if ($prevCtx -eq 'tabPage') {
                if ($controlStack.Count -gt 0) {
                    $controlStack.RemoveAt($controlStack.Count - 1)
                }
                $currentTabPage = $null
                if ($currentControl -and $currentControl.name) {
                    $controls += $currentControl
                    $currentControl = $null
                }
            }
            continue
        }

        # --- Property parsing ---
        if ($line -match '^(\w+)\s*=\s*(.+)$') {
            $pName = $Matches[1]
            $pVal = $Matches[2].Trim()
            if ($pVal -match '^"(.*)"$') { $pVal = $Matches[1] }
            $isNotDefault = ($pVal -eq 'NotDefault')

            # Form-level
            if ($ctx -eq 'form') {
                switch ($pName) {
                    'RecordSource'      { $formObj.recordSource = $pVal }
                    'Width'             { $formObj.formWidth = DimToTwips $pVal }
                    'Caption'           { $formObj.caption = $pVal }
                    'DefaultView'       { $formObj.defaultView = [int]$pVal }
                    'ScrollBars'        { $formObj.scrollBars = [int]$pVal }
                    'NavigationButtons' { if ($isNotDefault) { $formObj.navigationButtons = $false } }
                    'RecordSelectors'   { if ($isNotDefault) { $formObj.recordSelectors = $false } }
                    'AllowAdditions'    { if ($isNotDefault) { $formObj.allowAdditions = $false } }
                    'AllowDeletions'    { if ($isNotDefault) { $formObj.allowDeletions = $false } }
                    'AllowEdits'        { if ($isNotDefault) { $formObj.allowEdits = $false } }
                    'PopUp'             { if ($isNotDefault) { $formObj.popup = $true } }
                    'Modal'             { if ($isNotDefault) { $formObj.modal = $true } }
                    'DividingLines'     { if ($isNotDefault) { $formObj.dividingLines = $false } }
                    'DataEntry'         { if ($isNotDefault) { $formObj.dataEntry = $true } }
                    'Filter'            { $formObj.filter = $pVal }
                    'FilterOn'          { if ($isNotDefault) { $formObj.filterOn = $true } }
                    'OrderBy'           { $formObj.orderBy = $pVal }
                    'OrderByOn'         { if ($isNotDefault) { $formObj.orderByOn = $true } }
                    # Form events
                    'OnLoad'        { if ($pVal -eq '[Event Procedure]') { $formObj.hasLoadEvent = $true }; $formEvents['on-load'] = $pVal }
                    'OnOpen'        { if ($pVal -eq '[Event Procedure]') { $formObj.hasOpenEvent = $true }; $formEvents['on-open'] = $pVal }
                    'OnClose'       { if ($pVal -eq '[Event Procedure]') { $formObj.hasCloseEvent = $true }; $formEvents['on-close'] = $pVal }
                    'OnCurrent'     { if ($pVal -eq '[Event Procedure]') { $formObj.hasCurrentEvent = $true }; $formEvents['on-current'] = $pVal }
                    'BeforeInsert'  { if ($pVal -eq '[Event Procedure]') { $formObj.hasBeforeInsertEvent = $true }; $formEvents['before-insert'] = $pVal }
                    'AfterInsert'   { if ($pVal -eq '[Event Procedure]') { $formObj.hasAfterInsertEvent = $true }; $formEvents['after-insert'] = $pVal }
                    'BeforeUpdate'  { if ($pVal -eq '[Event Procedure]') { $formObj.hasBeforeUpdateEvent = $true }; $formEvents['before-update'] = $pVal }
                    'AfterUpdate'   { if ($pVal -eq '[Event Procedure]') { $formObj.hasAfterUpdateEvent = $true }; $formEvents['after-update'] = $pVal }
                    'OnDelete'      { if ($pVal -eq '[Event Procedure]') { $formObj.hasDeleteEvent = $true }; $formEvents['on-delete'] = $pVal }
                }
            }
            # Section properties
            elseif ($ctx -eq 'section') {
                $secPfx = $sectionPrefix[$currentSection]
                switch ($pName) {
                    'Height' {
                        $heightKey = switch ($currentSection) { 0 {'detailHeight'} 1 {'headerHeight'} 2 {'footerHeight'} }
                        $sectionHeights[$heightKey] = DimToTwips $pVal
                    }
                    'BackColor' { $sectionProps["${secPfx}BackColor"] = [long]$pVal }
                    'Name' { }  # internal name, skip
                    default {
                        # Capture other section properties with prefix
                        if ($pVal -match '^\d+$') {
                            $sectionProps["${secPfx}${pName}"] = [int]$pVal
                        } elseif ($isNotDefault) {
                            $sectionProps["${secPfx}${pName}"] = 1
                        }
                    }
                }
            }
            # Tab page
            elseif ($ctx -eq 'tabPage') {
                if ($pName -eq 'Name' -and $currentControl) { $currentControl.name = $pVal }
                elseif ($pName -eq 'PageIndex' -and $currentControl) { $currentControl.pageIndex = [int]$pVal }
                elseif ($pName -eq 'Caption' -and $currentControl) { $currentControl.caption = $pVal }
            }
            # Default control template blocks
            elseif ($ctx -eq 'defaults') {
                if ($pName -eq 'Height') { $defaultHeights[$defaultTypeName] = DimToTwips $pVal }
            }
            # Control properties
            elseif ($ctx -eq 'control' -and $currentControl) {
                switch ($pName) {
                    'Name'              { $currentControl.name = $pVal }
                    'Left'              { $currentControl.left = DimToTwips $pVal }
                    'Top'               { $currentControl.top = DimToTwips $pVal }
                    'Width'             { $currentControl.width = DimToTwips $pVal }
                    'Height'            { $currentControl.height = DimToTwips $pVal }
                    'FontName'          { $currentControl.fontName = $pVal }
                    'FontSize'          { $currentControl.fontSize = [int]$pVal }
                    'FontWeight'        { if ([int]$pVal -ge 700) { $currentControl.fontBold = $true } }
                    'FontItalic'        { if ($isNotDefault) { $currentControl.fontItalic = $true } }
                    'FontUnderline'     { if ($isNotDefault) { $currentControl.fontUnderline = $true } }
                    'ForeColor'         { $currentControl.foreColor = [long]$pVal }
                    'BackColor'         { $currentControl.backColor = [long]$pVal }
                    'BorderColor'       { $currentControl.borderColor = [long]$pVal }
                    'BackStyle'         { $currentControl.backStyle = [int]$pVal }
                    'ControlSource'     { $currentControl.controlSource = $pVal }
                    'Caption'           { $currentControl.caption = $pVal }
                    'Format'            { $currentControl.format = $pVal }
                    'DefaultValue'      { $currentControl.defaultValue = $pVal }
                    'InputMask'         { $currentControl.inputMask = $pVal }
                    'ValidationRule'    { $currentControl.validationRule = $pVal }
                    'ValidationText'    { $currentControl.validationText = $pVal }
                    'TabIndex'          { $currentControl.tabIndex = [int]$pVal }
                    'Enabled'           { if ($pVal -eq '0') { $currentControl.enabled = $false } }
                    'Locked'            { if ($isNotDefault) { $currentControl.locked = $true } }
                    'Visible'           { if ($isNotDefault) { $currentControl.visible = $false } }
                    'ControlTipText'    { $currentControl.tooltip = $pVal }
                    'StatusBarText'     { $currentControl.tooltip = $pVal }
                    'Tag'               { $currentControl.tag = $pVal }
                    'TextAlign'         { $currentControl.textAlign = [int]$pVal }
                    'DecimalPlaces'     { $currentControl.'decimal-places' = [int]$pVal }
                    'RowSource'         { $currentControl.rowSource = $pVal }
                    'BoundColumn'       { $currentControl.boundColumn = [int]$pVal }
                    'ColumnCount'       { $currentControl.columnCount = [int]$pVal }
                    'ColumnWidths'      { $currentControl.columnWidths = $pVal }
                    'LimitToList'       { if ($isNotDefault) { $currentControl.limitToList = $true } }
                    'SourceObject'      { $currentControl.sourceForm = $pVal }
                    'LinkChildFields'   { $currentControl.linkChildFields = $pVal }
                    'LinkMasterFields'  { $currentControl.linkMasterFields = $pVal }
                    'SizeMode'          { $currentControl.sizeMode = [int]$pVal }
                    'Picture'           { $currentControl.picture = $pVal }
                    'ScrollBars'        { }  # control-level scrollbars, skip
                    'SpecialEffect'     { }  # skip
                    'OverlapFlags'      { }  # skip
                    'ColumnHidden'      { }  # skip
                    'ColumnWidth'       { }  # skip
                    'ColumnOrder'       { }  # skip
                    'TabStop'           { }  # skip
                    'EventProcPrefix'   { }  # skip
                    # Control events
                    'OnClick'       { if ($pVal -eq '[Event Procedure]') { $currentControl.hasClickEvent = $true } }
                    'OnDblClick'    { if ($pVal -eq '[Event Procedure]') { $currentControl.hasDblClickEvent = $true }
                                      elseif ($pVal) { $currentControl.hasDblClickEvent = $true } }
                    'OnChange'      { if ($pVal -eq '[Event Procedure]') { $currentControl.hasChangeEvent = $true } }
                    'OnEnter'       { if ($pVal -eq '[Event Procedure]') { $currentControl.hasEnterEvent = $true } }
                    'OnExit'        { if ($pVal -eq '[Event Procedure]') { $currentControl.hasExitEvent = $true } }
                    'BeforeUpdate'  { if ($pVal -eq '[Event Procedure]') { $currentControl.hasBeforeUpdateEvent = $true } }
                    'AfterUpdate'   { if ($pVal -eq '[Event Procedure]') { $currentControl.hasAfterUpdateEvent = $true } }
                    'OnGotFocus'    { if ($pVal -eq '[Event Procedure]') { $currentControl.hasGotFocusEvent = $true } }
                    'OnLostFocus'   { if ($pVal -eq '[Event Procedure]') { $currentControl.hasLostFocusEvent = $true } }
                }
            }
        }
    }

    # Apply Access internal defaults for controls whose height was never written to SaveAsText.
    # Access omits Height when it matches the built-in default, so 0 here means "use the default".
    # Lines legitimately have height=0 (horizontal strokes) and are excluded.
    $accessControlHeightDefaults = @{
        'text-box' = 252; 'combo-box' = 252; 'list-box' = 252
        'command-button' = 360; 'check-box' = 240; 'option-button' = 240; 'toggle-button' = 360
        'attachment' = 252
    }
    foreach ($ctl in $controls) {
        if ($ctl.height -eq 0 -and $accessControlHeightDefaults.ContainsKey($ctl.type)) {
            $ctl.height = $accessControlHeightDefaults[$ctl.type]
        }
    }

    # Assemble output
    if (-not $formObj.Contains('formWidth')) { $formObj.formWidth = 10000 }
    if (-not $formObj.Contains('defaultView')) { $formObj.defaultView = 0 }

    # Merge section heights and props
    $sectionsObj = [ordered]@{}
    foreach ($k in $sectionHeights.Keys) { $sectionsObj[$k] = $sectionHeights[$k] }
    foreach ($k in $sectionProps.Keys) { $sectionsObj[$k] = $sectionProps[$k] }
    $formObj.sections = $sectionsObj

    # Defaults for boolean form properties
    if (-not $formObj.Contains('navigationButtons')) { $formObj.navigationButtons = $true }
    if (-not $formObj.Contains('recordSelectors')) { $formObj.recordSelectors = $true }
    if (-not $formObj.Contains('allowAdditions')) { $formObj.allowAdditions = $true }
    if (-not $formObj.Contains('allowDeletions')) { $formObj.allowDeletions = $true }
    if (-not $formObj.Contains('allowEdits')) { $formObj.allowEdits = $true }
    if (-not $formObj.Contains('scrollBars')) { $formObj.scrollBars = 3 }
    if (-not $formObj.Contains('popup')) { $formObj.popup = $false }
    if (-not $formObj.Contains('modal')) { $formObj.modal = $false }
    if (-not $formObj.Contains('dividingLines')) { $formObj.dividingLines = $true }
    if (-not $formObj.Contains('dataEntry')) { $formObj.dataEntry = $false }

    if ($formEvents.Count -gt 0) { $formObj.events = $formEvents }
    $formObj.controls = $controls

    return $formObj
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

    # Use SaveAsText — works reliably for all forms including .mdb with VBA compile errors
    $tempFile = [System.IO.Path]::GetTempFileName()
    $accessApp.SaveAsText(2, $FormName, $tempFile)  # 2 = acForm
    $textContent = Get-Content $tempFile -Raw -Encoding Default
    Remove-Item $tempFile -Force -ErrorAction SilentlyContinue

    $formObj = Parse-FormSaveAsText -textContent $textContent -formName $FormName

    $ctlCount = $formObj.controls.Count
    Write-Host "Exported $ctlCount controls ($FormName)" -ForegroundColor Cyan

    $json = $formObj | ConvertTo-Json -Depth 10 -Compress

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
