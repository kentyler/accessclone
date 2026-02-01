# List all reports in an Access database
# Usage: .\list_reports.ps1 -DatabasePath "path\to\db.accdb"
# Output: JSON array of report names

param(
    [Parameter(Mandatory=$true)]
    [string]$DatabasePath
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

    $reportNames = @()
    foreach ($report in $accessApp.CurrentProject.AllReports) {
        $reportNames += $report.Name
    }

    # Output as JSON
    $reportNames | ConvertTo-Json -Compress

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
