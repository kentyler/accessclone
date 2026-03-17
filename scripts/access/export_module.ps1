# Export VBA module source from an Access database
# Usage: .\export_module.ps1 -DatabasePath "path\to\db.accdb" -ModuleName "basFormChange"
# Output: JSON object with name, lineCount, and code

param(
    [Parameter(Mandatory=$true)]
    [string]$DatabasePath,

    [Parameter(Mandatory=$true)]
    [string]$ModuleName
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

    # Access VBA source via the VBE object model
    $component = $null
    $lineCount = 0
    $code = ""
    $openedObject = $null

    try {
        $component = $accessApp.VBE.ActiveVBProject.VBComponents.Item($ModuleName)
    } catch {
        # Component not found — for Form_/Report_ modules, try opening in design view
        if ($ModuleName -like "Form_*") {
            $openedObject = $ModuleName.Substring(5)
            try {
                $accessApp.DoCmd.OpenForm($openedObject, 1)  # 1 = acDesign
                $component = $accessApp.VBE.ActiveVBProject.VBComponents.Item($ModuleName)
            } catch {
                # Form exists but has no code module — return empty
            }
        } elseif ($ModuleName -like "Report_*") {
            $openedObject = $ModuleName.Substring(7)
            try {
                $accessApp.DoCmd.OpenReport($openedObject, 4)  # 4 = acViewDesign
                $component = $accessApp.VBE.ActiveVBProject.VBComponents.Item($ModuleName)
            } catch {
                # Report exists but has no code module — return empty
            }
        }
    }

    if ($component) {
        try {
            $lineCount = $component.CodeModule.CountOfLines
        } catch {
            # CodeModule inaccessible — try design view fallback
            if (-not $openedObject -and $ModuleName -like "Form_*") {
                $openedObject = $ModuleName.Substring(5)
                $accessApp.DoCmd.OpenForm($openedObject, 1)
                $component = $accessApp.VBE.ActiveVBProject.VBComponents.Item($ModuleName)
                $lineCount = $component.CodeModule.CountOfLines
            } elseif (-not $openedObject -and $ModuleName -like "Report_*") {
                $openedObject = $ModuleName.Substring(7)
                $accessApp.DoCmd.OpenReport($openedObject, 4)
                $component = $accessApp.VBE.ActiveVBProject.VBComponents.Item($ModuleName)
                $lineCount = $component.CodeModule.CountOfLines
            }
        }
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
