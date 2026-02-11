# Create sample macros in an Access database for testing the import pipeline
# Usage: .\create_sample_macros.ps1 -DatabasePath "path\to\northwinddev.accdb"
# Creates 10 macros covering key Access macro action types

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

# Define macros as name -> XML content pairs
$macros = @{}

# 1. Simple OpenForm action
$macros["Macro_OpenForm"] = @'
<?xml version="1.0" encoding="UTF-16" standalone="no"?>
<UserInterfaceMacros xmlns="http://schemas.microsoft.com/office/accessservices/2009/11/application">
    <UserInterfaceMacro>
        <Statements>
            <Action Name="OpenForm">
                <Argument Name="FormName">Order List</Argument>
                <Argument Name="View">Form</Argument>
                <Argument Name="WindowMode">Normal</Argument>
            </Action>
        </Statements>
    </UserInterfaceMacro>
</UserInterfaceMacros>
'@

# 2. OpenForm with WhereCondition filter
$macros["Macro_OpenFormFiltered"] = @'
<?xml version="1.0" encoding="UTF-16" standalone="no"?>
<UserInterfaceMacros xmlns="http://schemas.microsoft.com/office/accessservices/2009/11/application">
    <UserInterfaceMacro>
        <Statements>
            <Action Name="OpenForm">
                <Argument Name="FormName">Order Details</Argument>
                <Argument Name="View">Form</Argument>
                <Argument Name="WhereCondition">=[OrderID]=Forms![Order List]![ID]</Argument>
                <Argument Name="WindowMode">Normal</Argument>
            </Action>
        </Statements>
    </UserInterfaceMacro>
</UserInterfaceMacros>
'@

# 3. OpenReport in preview mode
$macros["Macro_OpenReport"] = @'
<?xml version="1.0" encoding="UTF-16" standalone="no"?>
<UserInterfaceMacros xmlns="http://schemas.microsoft.com/office/accessservices/2009/11/application">
    <UserInterfaceMacro>
        <Statements>
            <Action Name="OpenReport">
                <Argument Name="ReportName">Sales Report</Argument>
                <Argument Name="View">Print Preview</Argument>
                <Argument Name="WindowMode">Normal</Argument>
            </Action>
        </Statements>
    </UserInterfaceMacro>
</UserInterfaceMacros>
'@

# 4. MessageBox action
$macros["Macro_MessageBox"] = @'
<?xml version="1.0" encoding="UTF-16" standalone="no"?>
<UserInterfaceMacros xmlns="http://schemas.microsoft.com/office/accessservices/2009/11/application">
    <UserInterfaceMacro>
        <Statements>
            <Action Name="MessageBox">
                <Argument Name="Message">Welcome to the Northwind database application.</Argument>
                <Argument Name="Beep">Yes</Argument>
                <Argument Name="Type">Information</Argument>
                <Argument Name="Title">Northwind Traders</Argument>
            </Action>
        </Statements>
    </UserInterfaceMacro>
</UserInterfaceMacros>
'@

# 5. Multiple actions in sequence
$macros["Macro_MultipleActions"] = @'
<?xml version="1.0" encoding="UTF-16" standalone="no"?>
<UserInterfaceMacros xmlns="http://schemas.microsoft.com/office/accessservices/2009/11/application">
    <UserInterfaceMacro>
        <Statements>
            <Action Name="SetTempVar">
                <Argument Name="Name">CurrentFilter</Argument>
                <Argument Name="Expression">="Active"</Argument>
            </Action>
            <Action Name="OpenForm">
                <Argument Name="FormName">Order List</Argument>
                <Argument Name="View">Form</Argument>
                <Argument Name="WindowMode">Normal</Argument>
            </Action>
            <Action Name="ApplyFilter">
                <Argument Name="WhereCondition">=[Status Field]=[TempVars]![CurrentFilter]</Argument>
            </Action>
            <Action Name="MessageBox">
                <Argument Name="Message">Filter applied: showing active orders only.</Argument>
                <Argument Name="Type">Information</Argument>
                <Argument Name="Title">Filter Applied</Argument>
            </Action>
        </Statements>
    </UserInterfaceMacro>
</UserInterfaceMacros>
'@

# 6. Conditional logic with If/ElseIf/Else
$macros["Macro_ConditionalLogic"] = @'
<?xml version="1.0" encoding="UTF-16" standalone="no"?>
<UserInterfaceMacros xmlns="http://schemas.microsoft.com/office/accessservices/2009/11/application">
    <UserInterfaceMacro>
        <Statements>
            <ConditionalBlock>
                <If>
                    <Condition>[TempVars]![UserRole]="Admin"</Condition>
                    <Statements>
                        <Action Name="OpenForm">
                            <Argument Name="FormName">Admin Panel</Argument>
                            <Argument Name="View">Form</Argument>
                        </Action>
                    </Statements>
                </If>
                <ElseIf>
                    <Condition>[TempVars]![UserRole]="Manager"</Condition>
                    <Statements>
                        <Action Name="OpenForm">
                            <Argument Name="FormName">Manager Dashboard</Argument>
                            <Argument Name="View">Form</Argument>
                        </Action>
                    </Statements>
                </ElseIf>
                <Else>
                    <Statements>
                        <Action Name="OpenForm">
                            <Argument Name="FormName">Order List</Argument>
                            <Argument Name="View">Form</Argument>
                        </Action>
                    </Statements>
                </Else>
            </ConditionalBlock>
        </Statements>
    </UserInterfaceMacro>
</UserInterfaceMacros>
'@

# 7. Named submacros
$macros["Macro_Submacros"] = @'
<?xml version="1.0" encoding="UTF-16" standalone="no"?>
<UserInterfaceMacros xmlns="http://schemas.microsoft.com/office/accessservices/2009/11/application">
    <UserInterfaceMacro>
        <Statements>
            <SubMacro Name="OpenCustomers">
                <Statements>
                    <Action Name="OpenForm">
                        <Argument Name="FormName">Customer List</Argument>
                        <Argument Name="View">Form</Argument>
                    </Action>
                </Statements>
            </SubMacro>
            <SubMacro Name="OpenOrders">
                <Statements>
                    <Action Name="OpenForm">
                        <Argument Name="FormName">Order List</Argument>
                        <Argument Name="View">Form</Argument>
                    </Action>
                </Statements>
            </SubMacro>
            <SubMacro Name="OpenProducts">
                <Statements>
                    <Action Name="OpenForm">
                        <Argument Name="FormName">Product List</Argument>
                        <Argument Name="View">Form</Argument>
                    </Action>
                </Statements>
            </SubMacro>
        </Statements>
    </UserInterfaceMacro>
</UserInterfaceMacros>
'@

# 8. Error handling pattern
$macros["Macro_ErrorHandling"] = @'
<?xml version="1.0" encoding="UTF-16" standalone="no"?>
<UserInterfaceMacros xmlns="http://schemas.microsoft.com/office/accessservices/2009/11/application">
    <UserInterfaceMacro>
        <Statements>
            <Action Name="OnError">
                <Argument Name="Goto">Macro Name</Argument>
                <Argument Name="MacroName">ErrorHandler</Argument>
            </Action>
            <Action Name="OpenForm">
                <Argument Name="FormName">Order List</Argument>
                <Argument Name="View">Form</Argument>
            </Action>
            <Action Name="SetTempVar">
                <Argument Name="Name">LastAction</Argument>
                <Argument Name="Expression">="OpenedOrders"</Argument>
            </Action>
            <SubMacro Name="ErrorHandler">
                <Statements>
                    <Action Name="MessageBox">
                        <Argument Name="Message">=[MacroError].[Description]</Argument>
                        <Argument Name="Type">Critical</Argument>
                        <Argument Name="Title">Error</Argument>
                    </Action>
                </Statements>
            </SubMacro>
        </Statements>
    </UserInterfaceMacro>
</UserInterfaceMacros>
'@

# 9. RunSQL actions
$macros["Macro_RunSQL"] = @'
<?xml version="1.0" encoding="UTF-16" standalone="no"?>
<UserInterfaceMacros xmlns="http://schemas.microsoft.com/office/accessservices/2009/11/application">
    <UserInterfaceMacro>
        <Statements>
            <Action Name="SetWarnings">
                <Argument Name="WarningsOn">No</Argument>
            </Action>
            <Action Name="RunSQL">
                <Argument Name="SQLStatement">UPDATE Orders SET [Status Field]='Archived' WHERE [Ship Date] &lt; DateAdd('m',-6,Date())</Argument>
            </Action>
            <Action Name="RunSQL">
                <Argument Name="SQLStatement">INSERT INTO AuditLog (Action, ActionDate, UserName) VALUES ('Archive', Date(), CurrentUser())</Argument>
            </Action>
            <Action Name="SetWarnings">
                <Argument Name="WarningsOn">Yes</Argument>
            </Action>
            <Action Name="MessageBox">
                <Argument Name="Message">Old orders have been archived.</Argument>
                <Argument Name="Type">Information</Argument>
                <Argument Name="Title">Archive Complete</Argument>
            </Action>
        </Statements>
    </UserInterfaceMacro>
</UserInterfaceMacros>
'@

# 10. SetProperty actions
$macros["Macro_SetProperties"] = @'
<?xml version="1.0" encoding="UTF-16" standalone="no"?>
<UserInterfaceMacros xmlns="http://schemas.microsoft.com/office/accessservices/2009/11/application">
    <UserInterfaceMacro>
        <Statements>
            <Action Name="SetProperty">
                <Argument Name="ControlName">btnSubmit</Argument>
                <Argument Name="Property">Enabled</Argument>
                <Argument Name="Value">True</Argument>
            </Action>
            <Action Name="SetProperty">
                <Argument Name="ControlName">txtNotes</Argument>
                <Argument Name="Property">Visible</Argument>
                <Argument Name="Value">True</Argument>
            </Action>
            <Action Name="SetProperty">
                <Argument Name="ControlName">lblStatus</Argument>
                <Argument Name="Property">Caption</Argument>
                <Argument Name="Value">="Ready to submit"</Argument>
            </Action>
            <Action Name="SetProperty">
                <Argument Name="ControlName">txtTotal</Argument>
                <Argument Name="Property">BackColor</Argument>
                <Argument Name="Value">=RGB(144,238,144)</Argument>
            </Action>
        </Statements>
    </UserInterfaceMacro>
</UserInterfaceMacros>
'@

$accessApp = $null
try {
    $accessApp = New-Object -ComObject Access.Application
    $accessApp.AutomationSecurity = 3  # msoAutomationSecurityForceDisable
    $accessApp.OpenCurrentDatabase($DatabasePath)

    $created = 0
    $skipped = 0

    foreach ($macroName in $macros.Keys) {
        # Check if macro already exists
        $exists = $false
        foreach ($m in $accessApp.CurrentProject.AllMacros) {
            if ($m.Name -eq $macroName) {
                $exists = $true
                break
            }
        }

        if ($exists) {
            Write-Host "Skipping $macroName (already exists)"
            $skipped++
            continue
        }

        # Write XML to temp file and load via LoadFromText (acMacro = 4)
        $tempFile = [System.IO.Path]::GetTempFileName()
        $macros[$macroName] | Out-File -FilePath $tempFile -Encoding Unicode
        try {
            $accessApp.LoadFromText(4, $macroName, $tempFile)
            Write-Host "Created $macroName"
            $created++
        }
        catch {
            Write-Host "Failed to create ${macroName}: $($_.Exception.Message)"
        }
        finally {
            Remove-Item $tempFile -Force -ErrorAction SilentlyContinue
        }
    }

    Write-Host ""
    Write-Host "Done: $created created, $skipped skipped"

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
