Three Horse — Qualifying Analysis
==================================

What This Is
------------
A diagnostic tool that analyzes your Microsoft Access database and produces
a detailed report of everything in it — tables, queries, forms, reports,
VBA code, macros, and relationships. The report helps you understand what
you have and what a migration to a modern web application would involve.


Requirements
------------
- Windows 10 or later
- PowerShell 5 or later (included with Windows)
- Microsoft Access OR the free Access Database Engine
  (https://www.microsoft.com/en-us/download/details.aspx?id=54920)


How to Run
----------
1. Right-click qualifying-analysis.ps1 and select "Run with PowerShell"

   OR open PowerShell and run:

   .\qualifying-analysis.ps1 "C:\path\to\your\database.accdb"

2. If your Access app is split into multiple files (front-end + back-end),
   pass them all:

   .\qualifying-analysis.ps1 "C:\path\to\frontend.accdb" "C:\path\to\backend.accdb"

3. The report is saved as a .md file next to your database.
   To save it somewhere else:

   .\qualifying-analysis.ps1 "C:\path\to\database.accdb" -OutputDir "C:\Desktop"


If PowerShell Blocks the Script
-------------------------------
You may see "running scripts is disabled on this system." To fix this,
open PowerShell as Administrator and run:

   Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned

Then try again.


What to Do With the Report
--------------------------
The report is a text file you can open in any text editor or browser.

For a deeper understanding, paste the report AND the included
qualifying-guide.md into your preferred AI assistant (ChatGPT, Claude,
Gemini, etc.). The guide gives the AI context about what the report means
and what the target environment looks like, so it can help you explore
your database and discuss migration options.

Try asking:
- "What does this application do?"
- "What are the blocking issues?"
- "Which parts would migrate automatically?"
- "What would the user experience be like after migration?"


What's in This Package
----------------------
README.txt                  This file
qualifying-analysis.ps1     The diagnostic script
qualifying-guide.md         Context file for your AI assistant


Learn More
----------
https://three.horse
