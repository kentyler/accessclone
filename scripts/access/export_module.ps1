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
    $accessApp.OpenCurrentDatabase($DatabasePath)

    # Access VBA source via the VBE object model
    $component = $accessApp.VBE.ActiveVBProject.VBComponents.Item($ModuleName)
    $codeModule = $component.CodeModule

    $lineCount = $codeModule.CountOfLines
    $code = ""
    if ($lineCount -gt 0) {
        $code = $codeModule.Lines(1, $lineCount)
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
