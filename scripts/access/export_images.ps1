# Export image data from Access form/report image controls
# Usage: .\export_images.ps1 -DatabasePath "path\to\db.accdb"
# Optional: -FormNames "Form1,Form2" -ReportNames "Report1,Report2"
# Output: JSON with images array [{objectType, objectName, controlName, base64, mimeType}]
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

function Extract-ImageFromControl {
    param($ctl, [string]$objectType, [string]$objectName)

    $controlName = $ctl.Name
    try {
        # PictureData is a byte array property on image controls
        $pictureData = $ctl.PictureData
        if ($null -eq $pictureData -or $pictureData.Length -eq 0) {
            return $null
        }

        [byte[]]$bytes = $pictureData

        # Skip images larger than 500KB (too large for data URIs in JSON definitions)
        if ($bytes.Length -gt 512000) {
            Log-Warn "Skipping $controlName (${objectName}): too large ($($bytes.Length) bytes)"
            return $null
        }

        # Find the actual image data start (skip OLE header)
        $result = Find-ImageStart -bytes $bytes
        if ($null -eq $result) {
            Log-Warn "Skipping $controlName (${objectName}): no recognized image signature"
            return $null
        }

        $offset = $result.offset
        $mimeType = $result.mimeType

        # Extract just the image bytes
        $imageLength = $bytes.Length - $offset
        $imageBytes = New-Object byte[] $imageLength
        [Array]::Copy($bytes, $offset, $imageBytes, 0, $imageLength)

        $base64 = [Convert]::ToBase64String($imageBytes)

        Log-Info "  Extracted $controlName (${objectName}): $mimeType, $imageLength bytes"

        return @{
            objectType = $objectType
            objectName = $objectName
            controlName = $controlName
            base64 = $base64
            mimeType = $mimeType
        }
    } catch {
        Log-Warn "Error reading $controlName (${objectName}): $_"
        return $null
    }
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

try {
    $accessApp = Open-AccessSession
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
            # Don't increment itemIndex — retry the same item
            continue
        }

        try {
            if ($objType -eq "form") {
                Log-Info "Scanning form: $objName"
                $accessApp.DoCmd.OpenForm($objName, 1)  # 1 = acDesign
                Start-Sleep -Milliseconds 500

                $form = $accessApp.Screen.ActiveForm
                foreach ($ctl in $form.Controls) {
                    $ct = [int]$ctl.ControlType
                    if ($ct -eq 103 -or $ct -eq 114) {  # 103=image, 114=object-frame
                        $img = Extract-ImageFromControl -ctl $ctl -objectType "form" -objectName $objName
                        if ($img) { $images += $img }
                    }
                }

                $accessApp.DoCmd.Close(2, $objName, 0)  # 2 = acForm, 0 = acSaveNo
            }
            elseif ($objType -eq "report") {
                Log-Info "Scanning report: $objName"
                $accessApp.DoCmd.OpenReport($objName, 1)  # 1 = acDesign
                Start-Sleep -Milliseconds 500

                $report = $accessApp.Screen.ActiveReport
                for ($secIdx = 0; $secIdx -lt 20; $secIdx++) {
                    try {
                        $section = $report.Section($secIdx)
                        foreach ($ctl in $section.Controls) {
                            $ct = [int]$ctl.ControlType
                            if ($ct -eq 103 -or $ct -eq 114) {  # 103=image, 114=object-frame
                                $img = Extract-ImageFromControl -ctl $ctl -objectType "report" -objectName $objName
                                if ($img) { $images += $img }
                            }
                        }
                    } catch {
                        # Section doesn't exist, continue
                    }
                }

                $accessApp.DoCmd.Close(3, $objName, 0)  # 3 = acReport, 0 = acSaveNo
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
                # Don't increment — retry the same item
            } else {
                # Non-COM error (e.g., form doesn't exist) — skip this item
                Log-Warn "Error scanning $objType '${objName}': $errMsg"
                try {
                    if ($objType -eq "form") { $accessApp.DoCmd.Close(2, $objName, 0) }
                    else { $accessApp.DoCmd.Close(3, $objName, 0) }
                } catch {}
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
    # Final cleanup — make sure no orphan Access process lingers
    Get-Process MSACCESS -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
}

# Build JSON output manually to handle large base64 strings safely
$jsonParts = @()
foreach ($img in $images) {
    $part = '{"objectType":"' + (Escape-JsonStr $img.objectType) + '",' +
            '"objectName":"' + (Escape-JsonStr $img.objectName) + '",' +
            '"controlName":"' + (Escape-JsonStr $img.controlName) + '",' +
            '"mimeType":"' + (Escape-JsonStr $img.mimeType) + '",' +
            '"base64":"' + $img.base64 + '"}'
    $jsonParts += $part
}

$json = '{"images":[' + ($jsonParts -join ',') + ']}'
Write-Output $json

Log-Info "Exported $($images.Count) images from $($workQueue.Count) objects"
