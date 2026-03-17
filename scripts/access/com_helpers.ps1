# Shared COM automation helpers for Access database scripts.
# Dot-source from other scripts:  . "$PSScriptRoot\com_helpers.ps1"

# P/Invoke for targeted dialog detection — only dismiss actual dialogs,
# not the VBA editor window (which has the same title prefix).
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class DialogFinder {
    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern int SendMessage(IntPtr hWnd, int Msg, IntPtr wParam, IntPtr lParam);
}
"@ -ErrorAction SilentlyContinue

function Open-AccessDatabase {
    <#
    .SYNOPSIS
    Opens an Access database via COM, auto-dismissing any VBA compile error dialogs.
    .DESCRIPTION
    Wraps AccessApp.OpenCurrentDatabase with a background timer that looks for
    standard Windows dialog windows (#32770 class) with VBA titles and dismisses
    them. Does NOT target the VBA editor window, preventing accidental keystrokes.
    #>
    param(
        [Parameter(Mandatory)]$AccessApp,
        [Parameter(Mandatory)][string]$DatabasePath
    )

    $dismissTimer = New-Object System.Timers.Timer
    $dismissTimer.Interval = 1500
    $dismissTimer.AutoReset = $true
    $dismissEvent = Register-ObjectEvent -InputObject $dismissTimer -EventName Elapsed -Action {
        try {
            # Look for a standard Windows dialog (#32770) with the VBA error title.
            # This does NOT match the VBA editor window (which is a different class).
            $dlg = [DialogFinder]::FindWindow('#32770', 'Microsoft Visual Basic for Applications')
            if ($dlg -ne [IntPtr]::Zero) {
                # BM_CLICK the dialog's default button by sending Enter via WM_KEYDOWN
                [DialogFinder]::SetForegroundWindow($dlg) | Out-Null
                $wsh = New-Object -ComObject WScript.Shell
                $wsh.SendKeys("{ENTER}")
                try { [System.Runtime.InteropServices.Marshal]::ReleaseComObject($wsh) | Out-Null } catch {}
            }
        } catch {}
    }
    $dismissTimer.Start()

    try {
        $AccessApp.OpenCurrentDatabase($DatabasePath)
    } finally {
        $dismissTimer.Stop()
        Unregister-Event -SubscriptionId $dismissEvent.Id -ErrorAction SilentlyContinue
        Remove-Job $dismissEvent -Force -ErrorAction SilentlyContinue
    }
}
