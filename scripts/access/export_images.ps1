# Export image data from Access form/report controls via SaveAsText
# Usage: .\export_images.ps1 -DatabasePath "path\to\db.accdb"
# Optional: -FormNames "Form1,Form2" -ReportNames "Report1,Report2"
# Output: JSON with images array [{objectType, objectName, controlName, level, sectionName, base64, mimeType}]
#
# Approach: Uses Application.SaveAsText to dump form/report definitions as text,
# then parses PictureData hex blocks from the output. This avoids reading
# PictureData byte arrays via COM (which has never worked reliably).
# Shared images from MSysResources are still loaded via COM/DAO.
#
# COM Recovery: If Access crashes mid-session, the script restarts it and
# continues with the remaining forms/reports.

param(
    [Parameter(Mandatory=$true)]
    [string]$DatabasePath,

    [string]$FormNames,
    [string]$ReportNames
)

# Force UTF-8 output so Node.js (which reads stdout as utf8) gets correct bytes
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

# Diagnostic output goes to stderr so it doesn't pollute JSON on stdout
function Log-Info([string]$msg) { [Console]::Error.WriteLine($msg) }
function Log-Warn([string]$msg) { [Console]::Error.WriteLine("WARNING: $msg") }

# Use .NET's built-in JSON string escaper
$script:useNetEscape = $false
try {
    Add-Type -AssemblyName System.Web
    $script:useNetEscape = $true
} catch {}

function Escape-JsonStr([string]$s) {
    if ($script:useNetEscape) {
        return [System.Web.HttpUtility]::JavaScriptStringEncode($s)
    }
    $s = $s.Replace('\', '\\')
    $s = $s.Replace('"', '\"')
    $s = $s.Replace("`b", '\b')
    $s = $s.Replace("`f", '\f')
    $s = $s.Replace("`t", '\t')
    $s = $s.Replace("`n", '\n')
    $s = $s.Replace("`r", '\r')
    return $s
}

function Find-ImageStart {
    param([byte[]]$bytes)
    # Scan for known image signatures to skip OLE header
    # JPEG: FF D8 FF
    # PNG:  89 50 4E 47
    # BMP:  42 4D
    # GIF:  47 49 46 38
    for ($i = 0; $i -lt [Math]::Min($bytes.Length, 8192); $i++) {
        # JPEG
        if ($i + 2 -lt $bytes.Length -and
            $bytes[$i] -eq 0xFF -and $bytes[$i+1] -eq 0xD8 -and $bytes[$i+2] -eq 0xFF) {
            return @{ offset = $i; mimeType = "image/jpeg" }
        }
        # PNG
        if ($i + 3 -lt $bytes.Length -and
            $bytes[$i] -eq 0x89 -and $bytes[$i+1] -eq 0x50 -and $bytes[$i+2] -eq 0x4E -and $bytes[$i+3] -eq 0x47) {
            return @{ offset = $i; mimeType = "image/png" }
        }
        # BMP
        if ($i + 1 -lt $bytes.Length -and
            $bytes[$i] -eq 0x42 -and $bytes[$i+1] -eq 0x4D) {
            # BMP header has file size at offset 2-5 from signature
            if ($i + 5 -lt $bytes.Length) {
                $bmpSize = [BitConverter]::ToUInt32($bytes, $i + 2)
                if ($bmpSize -gt 0 -and $bmpSize -le ($bytes.Length - $i)) {
                    return @{ offset = $i; mimeType = "image/bmp" }
                }
            }
        }
        # GIF
        if ($i + 3 -lt $bytes.Length -and
            $bytes[$i] -eq 0x47 -and $bytes[$i+1] -eq 0x49 -and $bytes[$i+2] -eq 0x46 -and $bytes[$i+3] -eq 0x38) {
            return @{ offset = $i; mimeType = "image/gif" }
        }
    }
    return $null
}

function Load-SharedImages {
    param($accessApp)
    $shared = @{}
    try {
        $db = $accessApp.CurrentDb
        # MSysResources stores shared image resources (PictureType = Shared)
        $rs = $db.OpenRecordset("SELECT Name, Extension, Data FROM MSysResources WHERE Type = 'img'", 4)  # 4 = dbOpenSnapshot
        while (-not $rs.EOF) {
            $name = $rs.Fields("Name").Value
            $ext = $rs.Fields("Extension").Value
            $field = $rs.Fields("Data")
            $size = $field.FieldSize
            if ($size -gt 0 -and $size -le 512000) {
                [byte[]]$bytes = $field.GetChunk(0, $size)
                $result = Find-ImageStart -bytes $bytes
                if ($result) {
                    $offset = $result.offset
                    $imageLength = $bytes.Length - $offset
                    $imageBytes = New-Object byte[] $imageLength
                    [Array]::Copy($bytes, $offset, $imageBytes, 0, $imageLength)
                    $shared[$name] = @{
                        base64 = [Convert]::ToBase64String($imageBytes)
                        mimeType = $result.mimeType
                    }
                    Log-Info "  Loaded shared image: $name ($ext, $imageLength bytes)"
                }
            } elseif ($size -gt 512000) {
                Log-Warn "Skipping shared image ${name}: too large ($size bytes)"
            }
            $rs.MoveNext()
        }
        $rs.Close()
    } catch {
        Log-Warn "Could not read MSysResources (shared images): $_"
    }
    return $shared
}

# --- Section name mapping ---

function Map-SectionName {
    param([string]$eventProcPrefix, [string]$objectType)

    if (-not $eventProcPrefix) { return $null }

    switch ($eventProcPrefix) {
        'Form_Header'    { return 'header' }
        'Detail'         { return 'detail' }
        'Form_Footer'    { return 'footer' }
        'Report_Header'  { return 'report-header' }
        'Report_Footer'  { return 'report-footer' }
        'Page_Header'    { return 'page-header' }
        'Page_Footer'    { return 'page-footer' }
        default {
            if ($eventProcPrefix -match '^GroupHeader(\d+)$') {
                return "group-header-$($Matches[1])"
            }
            if ($eventProcPrefix -match '^GroupFooter(\d+)$') {
                return "group-footer-$($Matches[1])"
            }
            return $eventProcPrefix
        }
    }
}

# --- Determine image context from parser stack ---

function Get-ImageContext {
    param($stack, [string]$objectType, [string]$objectName)

    $controlEntry = $null
    $sectionEntry = $null

    for ($i = $stack.Count - 1; $i -ge 0; $i--) {
        $entry = $stack[$i]
        $t = $entry.type
        if ($t -eq '_container') { continue }
        if ($t -eq 'Form' -or $t -eq 'Report') { break }
        if ($t -eq 'Section') {
            if (-not $sectionEntry) { $sectionEntry = $entry }
            continue
        }
        # Everything else is a control type
        if (-not $controlEntry) {
            $controlEntry = $entry
        }
    }

    if ($controlEntry) {
        return @{
            controlName = $controlEntry.name
            level = $null
            sectionName = $null
            label = "$($controlEntry.name) ($objectName)"
        }
    }
    elseif ($sectionEntry) {
        $secName = Map-SectionName $sectionEntry.eventProcPrefix $objectType
        return @{
            controlName = $null
            level = 'section'
            sectionName = $secName
            label = "section/$secName ($objectName)"
        }
    }
    else {
        return @{
            controlName = $null
            level = $objectType
            sectionName = $null
            label = "$objectType ($objectName)"
        }
    }
}

# --- Convert hex string to image ---

function Convert-HexToImage {
    param(
        [string]$hexStr,
        $stack,
        [string]$objectType,
        [string]$objectName
    )

    $byteCount = [Math]::Floor($hexStr.Length / 2)
    if ($byteCount -eq 0) { return $null }
    if ($byteCount -gt 512000) {
        Log-Warn "Skipping image in $objectType '$objectName': too large ($byteCount bytes)"
        return $null
    }

    [byte[]]$bytes = New-Object byte[] $byteCount
    for ($i = 0; $i -lt $byteCount; $i++) {
        $bytes[$i] = [Convert]::ToByte($hexStr.Substring($i * 2, 2), 16)
    }

    $result = Find-ImageStart -bytes $bytes
    if ($null -eq $result) {
        Log-Warn "Skipping image in $objectType '$objectName': no recognized image signature"
        return $null
    }

    $offset = $result.offset
    $mimeType = $result.mimeType
    $imageLength = $bytes.Length - $offset
    $imageBytes = New-Object byte[] $imageLength
    [Array]::Copy($bytes, $offset, $imageBytes, 0, $imageLength)
    $base64 = [Convert]::ToBase64String($imageBytes)

    $context = Get-ImageContext $stack $objectType $objectName

    Log-Info "  Extracted $($context.label): $mimeType, $imageLength bytes"

    return @{
        objectType = $objectType
        objectName = $objectName
        controlName = $context.controlName
        level = $context.level
        sectionName = $context.sectionName
        base64 = $base64
        mimeType = $mimeType
    }
}

# --- Resolve shared image reference ---

function Resolve-SharedImage {
    param($entry, $stack, [string]$objectType, [string]$objectName, $shared)

    $t = $entry.type

    if ($t -eq 'Form' -or $t -eq 'Report') {
        Log-Info "  Extracted $objectType ($objectName) from shared: $($entry.picture)"
        return @{
            objectType = $objectType
            objectName = $objectName
            controlName = $null
            level = $objectType
            sectionName = $null
            base64 = $shared.base64
            mimeType = $shared.mimeType
        }
    }
    elseif ($t -eq 'Section') {
        $secName = Map-SectionName $entry.eventProcPrefix $objectType
        Log-Info "  Extracted section/$secName ($objectName) from shared: $($entry.picture)"
        return @{
            objectType = $objectType
            objectName = $objectName
            controlName = $null
            level = 'section'
            sectionName = $secName
            base64 = $shared.base64
            mimeType = $shared.mimeType
        }
    }
    elseif ($t -ne '_container') {
        # Control level
        Log-Info "  Extracted $($entry.name) ($objectName) from shared: $($entry.picture)"
        return @{
            objectType = $objectType
            objectName = $objectName
            controlName = $entry.name
            level = $null
            sectionName = $null
            base64 = $shared.base64
            mimeType = $shared.mimeType
        }
    }

    return $null
}

# --- Parse SaveAsText output ---
# State-machine parser that tracks Begin/End nesting via a stack.
# Extracts PictureData hex blocks and resolves shared image references.
# Also handles non-PictureData property blocks (ObjectPalette, NameMap, etc.)
# that use the same Begin/End syntax so their End doesn't mis-pop the stack.

function Parse-SaveAsText {
    param(
        [string]$textContent,
        [string]$objectType,
        [string]$objectName,
        [hashtable]$sharedImages
    )

    $results = @()
    $stack = [System.Collections.ArrayList]::new()
    $collectingHex = $false
    $hexBuffer = [System.Text.StringBuilder]::new()
    # Depth counter for non-PictureData property blocks (ObjectPalette = Begin, etc.)
    $propertyBlockDepth = 0

    foreach ($line in $textContent -split "`r?`n") {
        $trimmed = $line.Trim()
        if ($trimmed -eq '') { continue }

        # --- Hex collection mode (inside PictureData = Begin ... End) ---
        if ($collectingHex) {
            if ($trimmed -match '^0x([0-9A-Fa-f]+)') {
                [void]$hexBuffer.Append($Matches[1])
            }
            elseif ($trimmed -eq 'End') {
                # End of PictureData block — convert hex to image
                $hexStr = $hexBuffer.ToString()
                if ($hexStr.Length -gt 0) {
                    $img = Convert-HexToImage $hexStr $stack $objectType $objectName
                    if ($img) { $results += $img }
                }
                # Mark enclosing stack entry as having embedded picture data
                if ($stack.Count -gt 0) {
                    $stack[$stack.Count - 1].hasPictureData = $true
                }
                $collectingHex = $false
                [void]$hexBuffer.Clear()
            }
            continue
        }

        # --- Inside a non-PictureData property block (ObjectPalette, NameMap, etc.) ---
        if ($propertyBlockDepth -gt 0) {
            if ($trimmed -eq 'End') {
                $propertyBlockDepth--
            }
            elseif ($trimmed -match '=\s*Begin\s*$') {
                # Nested property block (unlikely but handle safely)
                $propertyBlockDepth++
            }
            continue
        }

        # --- PictureData = Begin (start hex collection) ---
        if ($trimmed -match '^PictureData\s*=\s*Begin') {
            $collectingHex = $true
            [void]$hexBuffer.Clear()
            continue
        }

        # --- Other property blocks with Begin/End syntax ---
        # e.g. ObjectPalette = Begin, NameMap = Begin, PrtMip = Begin, LayoutData = Begin
        if ($trimmed -match '^\w+\s*=\s*Begin\s*$') {
            $propertyBlockDepth++
            continue
        }

        # --- Begin <Type> (structural nesting) ---
        if ($trimmed -match '^Begin\s+(\S+)') {
            [void]$stack.Add(@{
                type = $Matches[1]
                name = $null
                eventProcPrefix = $null
                picture = $null
                hasPictureData = $false
            })
            continue
        }

        # --- Begin (anonymous container) ---
        if ($trimmed -eq 'Begin') {
            [void]$stack.Add(@{
                type = '_container'
                name = $null
                eventProcPrefix = $null
                picture = $null
                hasPictureData = $false
            })
            continue
        }

        # --- End (pop stack, check for shared image reference) ---
        if ($trimmed -eq 'End') {
            if ($stack.Count -gt 0) {
                $popped = $stack[$stack.Count - 1]
                [void]$stack.RemoveAt($stack.Count - 1)

                # If this entry had a Picture property but no embedded PictureData,
                # it may reference a shared image from MSysResources
                if ($popped.picture -and
                    $popped.picture -ne '(bitmap)' -and
                    -not $popped.hasPictureData -and
                    $sharedImages -and
                    $sharedImages.ContainsKey($popped.picture))
                {
                    $shared = $sharedImages[$popped.picture]
                    $img = Resolve-SharedImage $popped $stack $objectType $objectName $shared
                    if ($img) { $results += $img }
                }
            }
            continue
        }

        # --- Property: Name ---
        if ($trimmed -match '^Name\s*=\s*"([^"]*)"') {
            if ($stack.Count -gt 0) {
                $stack[$stack.Count - 1].name = $Matches[1]
            }
            continue
        }

        # --- Property: EventProcPrefix (identifies section type) ---
        if ($trimmed -match '^EventProcPrefix\s*=\s*"([^"]*)"') {
            if ($stack.Count -gt 0) {
                $stack[$stack.Count - 1].eventProcPrefix = $Matches[1]
            }
            continue
        }

        # --- Property: Picture (image name, may be shared ref) ---
        if ($trimmed -match '^Picture\s*=\s*"([^"]*)"') {
            if ($stack.Count -gt 0) {
                $stack[$stack.Count - 1].picture = $Matches[1]
            }
            continue
        }
    }

    return $results
}

# --- COM session management ---

function Kill-Access {
    Get-Process MSACCESS -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Seconds 3
    $lf = $DatabasePath -replace '\.accdb$', '.laccdb'
    Remove-Item $lf -Force -ErrorAction SilentlyContinue
}

function Open-AccessSession {
    $app = New-Object -ComObject Access.Application
    $app.AutomationSecurity = 3  # msoAutomationSecurityForceDisable
    $app.Visible = $true
    $app.OpenCurrentDatabase($DatabasePath)
    return $app
}

function Close-AccessSession {
    param($app)
    if ($app) {
        try { $app.CloseCurrentDatabase() } catch {}
        try { $app.Quit() } catch {}
        try { [System.Runtime.Interopservices.Marshal]::ReleaseComObject($app) | Out-Null } catch {}
    }
}

function Test-ComAlive {
    param($app)
    try {
        # Quick probe — reading a property will throw if COM is dead
        $null = $app.Visible
        return $true
    } catch {
        return $false
    }
}

# --- Main ---

Kill-Access

$images = @()

# Determine which forms/reports to scan
$formList = @()
if ($FormNames) {
    $formList = @($FormNames -split ',')
}

$reportList = @()
if ($ReportNames) {
    $reportList = @($ReportNames -split ',')
}

# Build a work queue: @( @{type="form"; name="..."}, @{type="report"; name="..."} )
$workQueue = @()
foreach ($f in $formList)  { $workQueue += @{ type = "form";   name = $f } }
foreach ($r in $reportList) { $workQueue += @{ type = "report"; name = $r } }

if ($workQueue.Count -eq 0) {
    # Nothing to do
    Write-Output '{"images":[]}'
    exit 0
}

Log-Info "Image export: $($formList.Count) forms, $($reportList.Count) reports to scan"

$accessApp = $null
$maxRetries = 2  # how many times to restart Access after a crash
$tempFile = [System.IO.Path]::GetTempFileName()

try {
    $accessApp = Open-AccessSession

    # Load shared images from MSysResources (used by controls with PictureType = Shared)
    $sharedImages = Load-SharedImages $accessApp

    $itemIndex = 0

    while ($itemIndex -lt $workQueue.Count) {
        $item = $workQueue[$itemIndex]
        $objType = $item.type
        $objName = $item.name

        # Check if COM is still alive before each item
        if (-not (Test-ComAlive $accessApp)) {
            Log-Warn "COM session died before processing $objType '$objName' — restarting Access"
            Close-AccessSession $accessApp
            Kill-Access
            $maxRetries--
            if ($maxRetries -lt 0) {
                Log-Warn "Max retries exceeded, stopping with $($images.Count) images collected so far"
                break
            }
            $accessApp = Open-AccessSession
            $sharedImages = Load-SharedImages $accessApp
            # Don't increment itemIndex — retry the same item
            continue
        }

        try {
            # acForm=2, acReport=3
            $acType = if ($objType -eq "form") { 2 } else { 3 }
            Log-Info "Scanning $objType: $objName"

            # SaveAsText dumps the entire definition as text — no need to open in design view
            $accessApp.SaveAsText($acType, $objName, $tempFile)
            $textContent = [System.IO.File]::ReadAllText($tempFile)

            $parsed = @(Parse-SaveAsText -textContent $textContent -objectType $objType -objectName $objName -sharedImages $sharedImages)
            if ($parsed.Count -gt 0) {
                $images += $parsed
            }

            # Success — move to next item
            $itemIndex++

        } catch {
            $errMsg = $_.Exception.Message
            # Check if this is a COM/RPC failure (Access process died)
            if ($errMsg -match '800706BA|800706BE|800706BF|RPC|disconnected|server') {
                Log-Warn "COM failure on $objType '${objName}': $errMsg — restarting Access"
                Close-AccessSession $accessApp
                Kill-Access
                $maxRetries--
                if ($maxRetries -lt 0) {
                    Log-Warn "Max retries exceeded, stopping with $($images.Count) images collected so far"
                    break
                }
                $accessApp = Open-AccessSession
                $sharedImages = Load-SharedImages $accessApp
                # Don't increment — retry the same item
            } else {
                # Non-COM error (e.g., object doesn't exist) — skip this item
                Log-Warn "Error scanning $objType '${objName}': $errMsg"
                $itemIndex++
            }
        }
    }

    Close-AccessSession $accessApp
    $accessApp = $null

} catch {
    Log-Warn "Fatal error: $($_.Exception.Message)"
}
finally {
    if ($accessApp) {
        Close-AccessSession $accessApp
    }
    # Clean up temp file
    Remove-Item $tempFile -Force -ErrorAction SilentlyContinue
    # Final cleanup — make sure no orphan Access process lingers
    Get-Process MSACCESS -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
}

# Build JSON output manually to handle large base64 strings safely
$jsonParts = @()
foreach ($img in $images) {
    $cnVal = if ($null -eq $img.controlName) { 'null' } else { '"' + (Escape-JsonStr $img.controlName) + '"' }
    $lvVal = if ($img.level) { '"' + (Escape-JsonStr $img.level) + '"' } else { 'null' }
    $snVal = if ($img.sectionName) { '"' + (Escape-JsonStr $img.sectionName) + '"' } else { 'null' }
    $part = '{"objectType":"' + (Escape-JsonStr $img.objectType) + '",' +
            '"objectName":"' + (Escape-JsonStr $img.objectName) + '",' +
            '"controlName":' + $cnVal + ',' +
            '"level":' + $lvVal + ',' +
            '"sectionName":' + $snVal + ',' +
            '"mimeType":"' + (Escape-JsonStr $img.mimeType) + '",' +
            '"base64":"' + $img.base64 + '"}'
    $jsonParts += $part
}

$json = '{"images":[' + ($jsonParts -join ',') + ']}'
Write-Output $json

Log-Info "Exported $($images.Count) images from $($workQueue.Count) objects"
