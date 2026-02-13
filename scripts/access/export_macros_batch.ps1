# Export multiple macros from an Access database in a single COM session
# Usage: .\export_macros_batch.ps1 -DatabasePath "path\to\db.accdb" -MacroNames "Macro1,Macro2"
# Outputs JSON: {"objects":{"Macro1":{...},"Macro2":{...}},"errors":[...]}

param(
    [Parameter(Mandatory=$true)]
    [string]$DatabasePath,

    [Parameter(Mandatory=$true)]
    [string]$MacroNames
)

# Parse comma-separated macro names
$names = $MacroNames -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' }

if ($names.Count -eq 0) {
    Write-Error "No macro names provided"
    exit 1
}

# Kill any existing Access processes
Get-Process MSACCESS -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 500

# Remove lock file if exists
$lockFile = $DatabasePath -replace '\.accdb$', '.laccdb'
Remove-Item $lockFile -Force -ErrorAction SilentlyContinue

$results = [ordered]@{}
$errors = @()

$accessApp = $null
try {
    $accessApp = New-Object -ComObject Access.Application
    $accessApp.AutomationSecurity = 3  # msoAutomationSecurityForceDisable
    $accessApp.OpenCurrentDatabase($DatabasePath)

    foreach ($macroName in $names) {
        try {
            Write-Host "Exporting macro: $macroName" -ForegroundColor Cyan

            # Export macro to a temp file using SaveAsText (acMacro = 4)
            $tempFile = [System.IO.Path]::GetTempFileName()
            $accessApp.SaveAsText(4, $macroName, $tempFile)

            # Read the exported text
            $definition = Get-Content -Path $tempFile -Raw -Encoding UTF8

            # Clean up temp file
            Remove-Item $tempFile -Force -ErrorAction SilentlyContinue

            $result = [ordered]@{
                name = $macroName
                definition = $definition
            }

            $results[$macroName] = $result
            Write-Host "Exported macro: $macroName" -ForegroundColor Cyan
        } catch {
            Write-Host "Error exporting macro $macroName : $_" -ForegroundColor Red
            $errors += [ordered]@{ name = $macroName; error = $_.Exception.Message }
        }
    }

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

# Build final output
$output = [ordered]@{
    objects = $results
    errors = $errors
}

$json = $output | ConvertTo-Json -Depth 10 -Compress
Write-Output $json
