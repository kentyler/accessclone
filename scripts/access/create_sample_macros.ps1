# Create sample macros in an Access database for testing the import pipeline
# Usage: .\create_sample_macros.ps1 -DatabasePath "path\to\northwinddev.accdb"
# Creates 10 macros covering key Access macro action types
#
# LoadFromText requires the legacy Access macro text format with UTF-16 LE encoding.
# Each macro needs: Version/PublishOption/ColumnsShown header, Begin/End action blocks,
# and _AXL comment blocks containing the XML representation with escaped quotes and
# continuation lines (8-space indent).

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

$header = "Version =196611`r`nPublishOption =1`r`nColumnsShown =0"

# Define macros: name -> LoadFromText content
$macros = [ordered]@{}

# 1. Simple OpenForm action
$macros["Macro_OpenForm"] = @"
$header
Begin
    Action ="OpenForm"
    Argument ="Order List"
    Argument ="0"
    Argument =""
    Argument =""
    Argument ="-1"
    Argument ="0"
End
Begin
    Comment ="_AXL:<?xml version=\"1.0\" encoding=\"UTF-16\" standalone=\"no\"?>\015\012<UserI"
        "nterfaceMacro MinimumClientDesignVersion=\"14.0.0000.0000\" xmlns=\"http://schem"
        "as.microsoft.com/office/accessservices/2009/11/application\"><Statements><Action"
        " Name=\"OpenForm\"><Argument Name=\"FormName\">Order List</Argument></Action></S"
        "tatements></UserInterfaceMacro>"
End
"@

# 2. OpenForm with WhereCondition filter
$macros["Macro_OpenFormFiltered"] = @"
$header
Begin
    Action ="OpenForm"
    Argument ="Order Details"
    Argument ="0"
    Argument ="[OrderID]=Forms![Order List]![ID]"
    Argument =""
    Argument ="-1"
    Argument ="0"
End
Begin
    Comment ="_AXL:<?xml version=\"1.0\" encoding=\"UTF-16\" standalone=\"no\"?>\015\012<UserI"
        "nterfaceMacro MinimumClientDesignVersion=\"14.0.0000.0000\" xmlns=\"http://schem"
        "as.microsoft.com/office/accessservices/2009/11/application\"><Statements><Action"
        " Name=\"OpenForm\"><Argument Name=\"FormName\">Order Details</Argument><Argument"
        " Name=\"WhereCondition\">[OrderID]=Forms![Order List]![ID]</Argument></Action></"
        "Statements></UserInterfaceMacro>"
End
"@

# 3. OpenReport in preview mode
$macros["Macro_OpenReport"] = @"
$header
Begin
    Action ="OpenReport"
    Argument ="Sales Report"
    Argument ="2"
    Argument =""
    Argument ="0"
End
Begin
    Comment ="_AXL:<?xml version=\"1.0\" encoding=\"UTF-16\" standalone=\"no\"?>\015\012<UserI"
        "nterfaceMacro MinimumClientDesignVersion=\"14.0.0000.0000\" xmlns=\"http://schem"
        "as.microsoft.com/office/accessservices/2009/11/application\"><Statements><Action"
        " Name=\"OpenReport\"><Argument Name=\"ReportName\">Sales Report</Argument><Argum"
        "ent Name=\"View\">PrintPreview</Argument></Action></Statements></UserInterfaceMa"
        "cro>"
End
"@

# 4. MessageBox action
$macros["Macro_MessageBox"] = @"
$header
Begin
    Action ="MsgBox"
    Argument ="Welcome to the Northwind database application."
    Argument ="-1"
    Argument ="1"
    Argument ="Northwind Traders"
End
Begin
    Comment ="_AXL:<?xml version=\"1.0\" encoding=\"UTF-16\" standalone=\"no\"?>\015\012<UserI"
        "nterfaceMacro MinimumClientDesignVersion=\"14.0.0000.0000\" xmlns=\"http://schem"
        "as.microsoft.com/office/accessservices/2009/11/application\"><Statements><Action"
        " Name=\"MessageBox\"><Argument Name=\"Message\">Welcome to the Northwind databas"
        "e application.</Argument><Argument Name=\"Type\">Information</Argument><Argument"
        " Name=\"Title\">Northwind Traders</Argument></Action></Statements></UserInterfac"
        "eMacro>"
End
"@

# 5. Multiple actions in sequence: SetTempVar + OpenForm + MsgBox
$macros["Macro_MultipleActions"] = @"
$header
Begin
    Action ="SetTempVar"
    Argument ="CurrentFilter"
    Argument ="=""Active"""
End
Begin
    Action ="OpenForm"
    Argument ="Order List"
    Argument ="0"
    Argument =""
    Argument =""
    Argument ="-1"
    Argument ="0"
End
Begin
    Action ="MsgBox"
    Argument ="Filter applied: showing active orders only."
    Argument ="-1"
    Argument ="1"
    Argument ="Filter Applied"
End
Begin
    Comment ="_AXL:<?xml version=\"1.0\" encoding=\"UTF-16\" standalone=\"no\"?>\015\012<UserI"
        "nterfaceMacro MinimumClientDesignVersion=\"14.0.0000.0000\" xmlns=\"http://schem"
        "as.microsoft.com/office/accessservices/2009/11/application\"><Statements><Action"
        " Name=\"SetTempVar\"><Argument Name=\"Name\">CurrentFilter</Argument><Argument N"
        "ame=\"Expression\">=\"Active\"</Argument></Action><Action Name=\"OpenForm\"><Argu"
        "ment Name=\"FormName\">Order List</Argument></Action><Action Name=\"MessageBox\""
        "><Argument Name=\"Message\">Filter applied: showing active orders only.</Argument"
        "><Argument Name=\"Type\">Information</Argument><Argument Name=\"Title\">Filter A"
        "pplied</Argument></Action></Statements></UserInterfaceMacro>"
End
"@

# 6. Conditional logic (If/ElseIf/Else)
$macros["Macro_ConditionalLogic"] = @"
$header
Begin
    Condition ="[TempVars]![UserRole]=""Admin"""
    Action ="OpenForm"
    Argument ="Order List"
    Argument ="0"
    Argument =""
    Argument =""
    Argument ="-1"
    Argument ="0"
End
Begin
    Condition ="[TempVars]![UserRole]=""Manager"""
    Action ="MsgBox"
    Argument ="Welcome, Manager!"
    Argument ="-1"
    Argument ="1"
    Argument ="Northwind"
End
Begin
    Condition ="..."
    Action ="MsgBox"
    Argument ="Welcome, User!"
    Argument ="-1"
    Argument ="1"
    Argument ="Northwind"
End
Begin
    Comment ="_AXL:<?xml version=\"1.0\" encoding=\"UTF-16\" standalone=\"no\"?>\015\012<UserI"
        "nterfaceMacro MinimumClientDesignVersion=\"14.0.0000.0000\" xmlns=\"http://schem"
        "as.microsoft.com/office/accessservices/2009/11/application\"><Statements><Condit"
        "ionalBlock><If><Condition>[TempVars]![UserRole]=\"Admin\"</Condition><Statements>"
        "<Action Name=\"OpenForm\"><Argument Name=\"FormName\">Order List</Argument></Act"
        "ion></Statements></If><ElseIf><Condition>[TempVars]![UserRole]=\"Manager\"</Cond"
        "ition><Statements><Action Name=\"MessageBox\"><Argument Name=\"Message\">Welcome"
        ", Manager!</Argument><Argument Name=\"Type\">Information</Argument><Argument Nam"
        "e=\"Title\">Northwind</Argument></Action></Statements></ElseIf><Else><Statements"
        "><Action Name=\"MessageBox\"><Argument Name=\"Message\">Welcome, User!</Argument>"
        "<Argument Name=\"Type\">Information</Argument><Argument Name=\"Title\">Northwind"
        "</Argument></Action></Statements></Else></ConditionalBlock></Statements></UserIn"
        "terfaceMacro>"
End
"@

# 7. Submacros (named sections)
$macros["Macro_Submacros"] = @"
$header
Begin
    Action ="MsgBox"
    Argument ="Main macro body"
    Argument ="-1"
    Argument ="1"
    Argument ="Info"
End
Begin
    Comment ="_AXL:<?xml version=\"1.0\" encoding=\"UTF-16\" standalone=\"no\"?>\015\012<UserI"
        "nterfaceMacro MinimumClientDesignVersion=\"14.0.0000.0000\" xmlns=\"http://schem"
        "as.microsoft.com/office/accessservices/2009/11/application\"><Statements><Action"
        " Name=\"MessageBox\"><Argument Name=\"Message\">Main macro body</Argument><Argum"
        "ent Name=\"Type\">Information</Argument><Argument Name=\"Title\">Info</Argument>"
        "</Action><SubMacro Name=\"OpenCustomers\"><Statements><Action Name=\"OpenForm\">"
        "<Argument Name=\"FormName\">Customer List</Argument></Action></Statements></SubM"
        "acro><SubMacro Name=\"OpenOrders\"><Statements><Action Name=\"OpenForm\"><Argumen"
        "t Name=\"FormName\">Order List</Argument></Action></Statements></SubMacro></Stat"
        "ements></UserInterfaceMacro>"
End
"@

# 8. Error handling (OnError + handler submacro)
$macros["Macro_ErrorHandling"] = @"
$header
Begin
    Action ="OnError"
    Argument ="1"
    Argument ="ErrorHandler"
End
Begin
    Action ="OpenForm"
    Argument ="Order List"
    Argument ="0"
    Argument =""
    Argument =""
    Argument ="-1"
    Argument ="0"
End
Begin
    Comment ="_AXL:<?xml version=\"1.0\" encoding=\"UTF-16\" standalone=\"no\"?>\015\012<UserI"
        "nterfaceMacro MinimumClientDesignVersion=\"14.0.0000.0000\" xmlns=\"http://schem"
        "as.microsoft.com/office/accessservices/2009/11/application\"><Statements><Action"
        " Name=\"OnError\"><Argument Name=\"Goto\">Macro Name</Argument><Argument Name=\""
        "MacroName\">ErrorHandler</Argument></Action><Action Name=\"OpenForm\"><Argument "
        "Name=\"FormName\">Order List</Argument></Action><SubMacro Name=\"ErrorHandler\">"
        "<Statements><Action Name=\"MessageBox\"><Argument Name=\"Message\">=[MacroError]"
        ".[Description]</Argument><Argument Name=\"Type\">Critical</Argument><Argument Na"
        "me=\"Title\">Error</Argument></Action></Statements></SubMacro></Statements></Use"
        "rInterfaceMacro>"
End
"@

# 9. RunSQL actions
$macros["Macro_RunSQL"] = @"
$header
Begin
    Action ="SetWarnings"
    Argument ="0"
End
Begin
    Action ="RunSQL"
    Argument ="UPDATE Orders SET [Status Field]='Archived' WHERE [Ship Date] < DateAdd('m',-6,Date())"
End
Begin
    Action ="SetWarnings"
    Argument ="-1"
End
Begin
    Action ="MsgBox"
    Argument ="Old orders have been archived."
    Argument ="-1"
    Argument ="1"
    Argument ="Archive Complete"
End
Begin
    Comment ="_AXL:<?xml version=\"1.0\" encoding=\"UTF-16\" standalone=\"no\"?>\015\012<UserI"
        "nterfaceMacro MinimumClientDesignVersion=\"14.0.0000.0000\" xmlns=\"http://schem"
        "as.microsoft.com/office/accessservices/2009/11/application\"><Statements><Action"
        " Name=\"SetWarnings\"><Argument Name=\"WarningsOn\">No</Argument></Action><Actio"
        "n Name=\"RunSQL\"><Argument Name=\"SQLStatement\">UPDATE Orders SET [Status Field"
        "]=&apos;Archived&apos; WHERE [Ship Date] &lt; DateAdd(&apos;m&apos;,-6,Date())</"
        "Argument></Action><Action Name=\"SetWarnings\"><Argument Name=\"WarningsOn\">Yes"
        "</Argument></Action><Action Name=\"MessageBox\"><Argument Name=\"Message\">Old or"
        "ders have been archived.</Argument><Argument Name=\"Type\">Information</Argument>"
        "<Argument Name=\"Title\">Archive Complete</Argument></Action></Statements></User"
        "InterfaceMacro>"
End
"@

# 10. SetProperty actions (using SetValue in legacy format)
$macros["Macro_SetProperties"] = @"
$header
Begin
    Action ="SetValue"
    Argument ="[Forms]![Order List]![btnSubmit].[Enabled]"
    Argument ="True"
End
Begin
    Action ="SetValue"
    Argument ="[Forms]![Order List]![txtNotes].[Visible]"
    Argument ="True"
End
Begin
    Comment ="_AXL:<?xml version=\"1.0\" encoding=\"UTF-16\" standalone=\"no\"?>\015\012<UserI"
        "nterfaceMacro MinimumClientDesignVersion=\"14.0.0000.0000\" xmlns=\"http://schem"
        "as.microsoft.com/office/accessservices/2009/11/application\"><Statements><Action"
        " Name=\"SetProperty\"><Argument Name=\"ControlName\">btnSubmit</Argument><Argume"
        "nt Name=\"Property\">Enabled</Argument><Argument Name=\"Value\">True</Argument>"
        "</Action><Action Name=\"SetProperty\"><Argument Name=\"ControlName\">txtNotes</A"
        "rgument><Argument Name=\"Property\">Visible</Argument><Argument Name=\"Value\">T"
        "rue</Argument></Action></Statements></UserInterfaceMacro>"
End
"@

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

        # Write text to temp file with UTF-16 LE encoding and load
        $tempFile = [System.IO.Path]::GetTempFileName()
        [System.IO.File]::WriteAllText($tempFile, $macros[$macroName], [System.Text.Encoding]::Unicode)
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
