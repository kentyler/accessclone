# Export VBA module source from an Access database
# Usage: .\export_module.ps1 -DatabasePath "path\to\db.accdb" -ModuleName "basFormChange"
# Output: JSON object with name, lineCount, and code

param(
    [Parameter(Mandatory=$true)]
    [string]$DatabasePath,

    [Parameter(Mandatory=$true)]
    [string]$ModuleName
)

# Kill any existing Access processes
Get-Process MSACCESS -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 500

# Remove lock file if exists
$lockFile = $DatabasePath -replace '\.accdb$', '.laccdb'
Remove-Item $lockFile -Force -ErrorAction SilentlyContinue

$accessApp = $null
try {
    $accessApp = New-Object -ComObject Access.Application
    $accessApp.AutomationSecurity = 3  # msoAutomationSecurityForceDisable
    $accessApp.OpenCurrentDatabase($DatabasePath)

    # Access VBA source via the VBE object model
    $component = $accessApp.VBE.ActiveVBProject.VBComponents.Item($ModuleName)
    $lineCount = 0
    $code = ""
    $openedObject = $null

    try {
        $lineCount = $component.CodeModule.CountOfLines
    } catch {
        # CodeModule inaccessible — for Form_/Report_ modules, open in design view
        if ($ModuleName -like "Form_*") {
            $openedObject = $ModuleName.Substring(5)
            $accessApp.DoCmd.OpenForm($openedObject, 1)  # 1 = acDesign
        } elseif ($ModuleName -like "Report_*") {
            $openedObject = $ModuleName.Substring(7)
            $accessApp.DoCmd.OpenReport($openedObject, 4)  # 4 = acViewDesign
        }
        # Re-fetch after opening
        $component = $accessApp.VBE.ActiveVBProject.VBComponents.Item($ModuleName)
        $lineCount = $component.CodeModule.CountOfLines
    }

    if ($lineCount -gt 0) {
        $code = $component.CodeModule.Lines(1, $lineCount)
    }

    # Close the object if we opened it
    if ($openedObject) {
        try {
            if ($ModuleName -like "Form_*") {
                $accessApp.DoCmd.Close(2, $openedObject, 1)  # 2=acForm, 1=acSaveNo
            } else {
                $accessApp.DoCmd.Close(3, $openedObject, 1)  # 3=acReport, 1=acSaveNo
            }
        } catch {}
    }

    # Build result object
    $result = [ordered]@{
        name = $ModuleName
        lineCount = $lineCount
        code = $code
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
