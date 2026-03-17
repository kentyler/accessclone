# Export a macro from an Access database using SaveAsText
# Usage: .\export_macro.ps1 -DatabasePath "path\to\db.accdb" -MacroName "AutoExec"
# Output: JSON object with name and definition (raw XML text)

param(
    [Parameter(Mandatory=$true)]
    [string]$DatabasePath,

    [Parameter(Mandatory=$true)]
    [string]$MacroName
)

. "$PSScriptRoot\com_helpers.ps1"

# Kill any existing Access processes
Get-Process MSACCESS -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 500

# Remove lock file if exists
if ($DatabasePath -match '\.accdb$') {
    Remove-Item ($DatabasePath -replace '\.accdb$', '.laccdb') -Force -ErrorAction SilentlyContinue
} elseif ($DatabasePath -match '\.mdb$') {
    Remove-Item ($DatabasePath -replace '\.mdb$', '.ldb') -Force -ErrorAction SilentlyContinue
}

$accessApp = $null
try {
    $accessApp = New-Object -ComObject Access.Application
    $accessApp.AutomationSecurity = 3  # msoAutomationSecurityForceDisable
    Open-AccessDatabase -AccessApp $accessApp -DatabasePath $DatabasePath

    # Export macro to a temp file using SaveAsText (acMacro = 4)
    $tempFile = [System.IO.Path]::GetTempFileName()
    $accessApp.SaveAsText(4, $MacroName, $tempFile)

    # Read the exported text (Access 2010+ macros export as XML)
    $definition = Get-Content -Path $tempFile -Raw -Encoding UTF8

    # Clean up temp file
    Remove-Item $tempFile -Force -ErrorAction SilentlyContinue

    # Build result object
    $result = [ordered]@{
        name = $MacroName
        definition = $definition
    }

    # Output as JSON
    $result | ConvertTo-Json -Compress

    $accessApp.CloseCurrentDatabase()
}
catch {
    Write-Error $_.Exception.Message
    exit 1
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
