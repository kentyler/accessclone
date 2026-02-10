# List all queries in an Access database
# Usage: .\list_queries.ps1 -DatabasePath "path\to\db.accdb"
# Output: JSON array of query objects with name and type

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
    $accessApp.AutomationSecurity = 3  # msoAutomationSecurityForceDisable
    $accessApp.OpenCurrentDatabase($DatabasePath)
    $db = $accessApp.CurrentDb

    $queries = @()
    foreach ($query in $db.QueryDefs) {
        # Skip temp queries (start with ~)
        if (-not $query.Name.StartsWith("~")) {
            # Determine query type from Type property
            # 0=Select, 16=Crosstab, 32=Delete, 48=Update, 64=Append, 80=MakeTable
            $queryType = switch ($query.Type) {
                0 { "Select" }
                16 { "Crosstab" }
                32 { "Delete" }
                48 { "Update" }
                64 { "Append" }
                80 { "MakeTable" }
                96 { "DDL" }
                112 { "PassThrough" }
                128 { "Union" }
                default { "Other" }
            }

            $queryInfo = @{
                name = $query.Name
                type = $queryType
            }
            $queries += $queryInfo
        }
    }

    # Output as JSON
    $queries | ConvertTo-Json -Compress

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
