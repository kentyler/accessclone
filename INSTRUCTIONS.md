# PolyAccess Setup Instructions

> **Note to the user:** If you get stuck on any step below, paste the step and any error messages into an AI assistant (ChatGPT, Claude, etc.) and it can walk you through it. When the AI gives you a command to run, always paste the full output back so it can see what happened and know whether to proceed or troubleshoot.

These instructions are designed for both human readers and AI assistants. If you are an AI agent helping a user install PolyAccess, follow the steps below. PolyAccess converts Microsoft Access databases (.accdb/.mdb) into web applications backed by PostgreSQL.

If you can execute commands directly (e.g. Claude Code, Codex, or another agent with shell access), run the commands yourself instead of asking the user to copy-paste them. The user-facing tips about pasting output back don't apply — you can see the results directly.

## Your Approach

- Be patient and clear. The user may not be technical.
- **Detect first, ask later.** Scan the system before asking questions the user might not know the answer to.
- Adapt to their situation (existing software, remote databases, etc.)
- If you can run commands directly, do so. Otherwise, ask the user to run them and remind them to paste the output back.
- Ask before running commands that modify the system.
- If something fails, help diagnose and fix it.

## What's Needed

1. **Node.js** (v18+) - runs the application server
2. **PostgreSQL** (v14+) - stores the data
3. **npm install** - installs JavaScript dependencies
4. **Database setup** - create a database and run infrastructure.sql

Optional:
- **Anthropic API key** - enables the built-in AI chat assistant (the app works fine without it)
- **Microsoft Access** - only needed if importing .accdb files (the PowerShell export scripts require Access to be installed)

## Step 1: Scan the System

Ask the user to run the included `check-system.ps1` script (right-click > "Run with PowerShell") and paste the output back to you. This checks for Node.js, PostgreSQL services, and PostgreSQL installations.

If the user can't run the script, have them run these individual commands in PowerShell and share the results:

```
node --version
Get-Service postgresql*
```

## Step 2: Install Missing Software

### If Node.js is missing:

```powershell
winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
```

Tell the user they'll need to close and reopen their terminal after Node.js installs.

If `winget` is not available, direct them to https://nodejs.org to download the installer.

### If PostgreSQL is missing:

Ask the user what they'd like to do:
1. **Install locally** (recommended for getting started)
2. **Use an existing PostgreSQL server** (local or remote) - just collect host, port, username, password

To install locally:
```powershell
winget install PostgreSQL.PostgreSQL --accept-package-agreements --accept-source-agreements
```

Important: The installer sets a password for the `postgres` user. Tell the user to remember it. If they didn't see a prompt, the password may need to be reset (see Troubleshooting below).

### If PostgreSQL is installed but not running:

```powershell
# Replace 18 with the actual version number found in Step 1
Start-Service postgresql-x64-18
```

## Step 3: Verify PostgreSQL Connection

Paste this single line into PowerShell (adjust the password and version number):

```powershell
$env:PGPASSWORD="<your password>"; & "C:\Program Files\PostgreSQL\<version>\bin\psql.exe" -U postgres -c "SELECT version();"
```

If this fails, see Troubleshooting below.

## Step 4: Locate the PolyAccess Folder

Ask the user where they unzipped PolyAccess. The folder should contain `server/`, `ui/`, and `scripts/` subdirectories. All subsequent commands should run from this folder.

```powershell
# Verify the folder structure
ls server\config.js, server\infrastructure.sql, ui\shadow-cljs.edn
```

## Step 5: Create Database and Run Infrastructure

```powershell
$env:PGPASSWORD = "<password>"
$psql = "C:\Program Files\PostgreSQL\<version>\bin\psql.exe"

# Create the database
& $psql -U postgres -c "CREATE DATABASE polyaccess;"

# Run infrastructure script (creates required tables and functions)
& $psql -U postgres -d polyaccess -f server\infrastructure.sql
```

The database name `polyaccess` matches the default in `server/config.js`. If the user wants a different name, also update the config file:

In `server/config.js`, find the line with `PGDATABASE || 'polyaccess'` and change `polyaccess` to their chosen name.

## Step 6: Install npm Dependencies

```powershell
cd server
npm install
cd ..\ui
npm install
cd ..
```

## Step 7: Configure AI Chat (Optional)

PolyAccess has a built-in AI assistant that can analyze forms, reports, and data. It needs an Anthropic API key.

If the user wants to set this up:
1. Copy the example file: `Copy-Item secrets.json.example secrets.json`
2. Edit `secrets.json` and replace `sk-ant-api03-your-key-here` with their actual API key

If not, skip it. The app works fine without it and they can add the key later.

## Step 8: Start and Test

```powershell
cd server
$env:PGPASSWORD = "<password>"
node index.js
```

The server starts on http://localhost:3001. Have the user open it in their browser.

To verify the API is working (in a separate terminal):
```powershell
Invoke-RestMethod http://localhost:3001/api/tables
```

## Step 9: Import an Access Database (Optional)

If the user has .accdb files to import:

1. In the browser, click the mode toggle in the top bar to switch to **Import** mode
2. In the sidebar, paste the folder path where their .accdb files are and click **Browse**
3. If they don't know where the files are, click **"Or scan all locations"** to search Desktop and Documents
4. Select a database from the list to see its tables, forms, reports, and modules
5. Import objects one at a time into PolyAccess

Note: Importing forms, reports, and modules from Access requires Microsoft Access to be installed on the same machine (the export scripts use Access COM automation via PowerShell). Tables and queries can be exported without Access.

## Everyday Startup

After installation, starting PolyAccess each time is just:

```powershell
cd <polyaccess-folder>\server
$env:PGPASSWORD = "<password>"
node index.js
```

Then open http://localhost:3001 in a browser.

## Troubleshooting

### "node is not recognized"
Node.js was just installed but the terminal needs to be restarted. Close and reopen PowerShell.

### "password authentication failed"
Wrong PostgreSQL password. To reset it:

```powershell
# Run PowerShell as Administrator for this
$pgVersion = "18"  # adjust to match installed version
$pgData = "C:\Program Files\PostgreSQL\$pgVersion\data"

# Backup auth config
Copy-Item "$pgData\pg_hba.conf" "$pgData\pg_hba.conf.bak"

# Temporarily allow passwordless access
(Get-Content "$pgData\pg_hba.conf") -replace 'scram-sha-256','trust' | Set-Content "$pgData\pg_hba.conf"

# Restart PostgreSQL
Restart-Service postgresql-x64-$pgVersion

# Set new password
& "C:\Program Files\PostgreSQL\$pgVersion\bin\psql.exe" -U postgres -c "ALTER USER postgres WITH PASSWORD 'newpassword';"

# Restore secure authentication
Copy-Item "$pgData\pg_hba.conf.bak" "$pgData\pg_hba.conf" -Force
Restart-Service postgresql-x64-$pgVersion
```

### "psql: connection refused"
PostgreSQL service isn't running:
```powershell
Start-Service postgresql-x64-18  # adjust version number
```

### "database already exists"
That's fine. Ask if they want to use the existing one or drop and recreate it.

### Port 5432 already in use
Another PostgreSQL instance may be running. Check with:
```powershell
netstat -ano | findstr :5432
```

### npm install fails
Try clearing the cache and retrying:
```powershell
npm cache clean --force
npm install
```
Or run the terminal as Administrator.

### "winget is not recognized"
Older Windows version. Direct the user to download installers manually:
- Node.js: https://nodejs.org
- PostgreSQL: https://www.postgresql.org/download/windows/

### Infrastructure script errors
If `infrastructure.sql` reports errors about objects already existing, that's usually fine - the script uses `CREATE IF NOT EXISTS`. If there are other errors, the user may need to drop and recreate the database.

## Project Structure (Reference)

```
server/           Node.js backend (Express)
  config.js       Database connection settings
  index.js        Entry point
  infrastructure.sql  Database schema setup
  routes/         API endpoints
ui/               ClojureScript frontend (Reagent)
  src/app/        Application source code
  resources/      Static assets (HTML, CSS)
scripts/access/   PowerShell scripts for Access import
skills/           LLM skill files for conversion guidance
secrets.json      API keys (create from secrets.json.example)
```
