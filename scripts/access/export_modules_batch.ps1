# Export multiple VBA modules from an Access database in a single COM session
# Usage: .\export_modules_batch.ps1 -DatabasePath "path\to\db.accdb" -ModuleNames "Module1,Module2"
# Outputs JSON: {"objects":{"Module1":{...},"Module2":{...}},"errors":[...]}

param(
    [Parameter(Mandatory=$true)]
    [string]$DatabasePath,

    [Parameter(Mandatory=$true)]
    [string]$ModuleNames
)

# Parse comma-separated module names
$names = $ModuleNames -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' }

if ($names.Count -eq 0) {
    Write-Error "No module names provided"
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

    foreach ($moduleName in $names) {
        try {
            Write-Host "Exporting module: $moduleName" -ForegroundColor Cyan
            $component = $accessApp.VBE.ActiveVBProject.VBComponents.Item($moduleName)
            $lineCount = 0
            $code = ""
            $openedObject = $null

            try {
                $lineCount = $component.CodeModule.CountOfLines
            } catch {
                # CodeModule inaccessible — for Form_/Report_ modules, open in design view
                if ($moduleName -like "Form_*") {
                    $openedObject = $moduleName.Substring(5)
                    $accessApp.DoCmd.OpenForm($openedObject, 1)  # 1 = acDesign
                } elseif ($moduleName -like "Report_*") {
                    $openedObject = $moduleName.Substring(7)
                    $accessApp.DoCmd.OpenReport($openedObject, 4)  # 4 = acViewDesign
                }
                # Re-fetch after opening
                $component = $accessApp.VBE.ActiveVBProject.VBComponents.Item($moduleName)
                $lineCount = $component.CodeModule.CountOfLines
            }

            if ($lineCount -gt 0) {
                $code = $component.CodeModule.Lines(1, $lineCount)
            }

            # Close the object if we opened it
            if ($openedObject) {
                try {
                    if ($moduleName -like "Form_*") {
                        $accessApp.DoCmd.Close(2, $openedObject, 1)  # 2=acForm, 1=acSaveNo
                    } else {
                        $accessApp.DoCmd.Close(3, $openedObject, 1)  # 3=acReport, 1=acSaveNo
                    }
                } catch {}
            }

            $result = [ordered]@{
                name = $moduleName
                lineCount = $lineCount
                code = $code
            }

            $results[$moduleName] = $result
            Write-Host "Exported $lineCount lines ($moduleName)" -ForegroundColor Cyan
        } catch {
            Write-Host "Error exporting module $moduleName : $_" -ForegroundColor Red
            $errors += [ordered]@{ name = $moduleName; error = $_.Exception.Message }
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
