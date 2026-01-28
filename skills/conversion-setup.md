# Conversion Setup Skill

Phase 1 of the conversion process. Creates the PostgreSQL database, installs infrastructure, and sets up the project folder.

## Quick Start (Automated)

CloneTemplate includes PowerShell scripts for automated setup:

```powershell
# 1. Install dependencies (run as Administrator)
.\install.ps1

# 2. Restart terminal, then setup project
.\setup.ps1 -DatabaseName calculator -Password <password>

# 3. Start the application
.\start.ps1 -Password <password>
```

## Prerequisites

- Windows 10/11 with PowerShell
- winget (App Installer) - included in Windows 11, available for Windows 10
- Target name decided (e.g., `calculator`)
- Source Access database path known

## Steps

### 1. Create PostgreSQL Database

```sql
CREATE DATABASE calculator;
```

From command line:
```bash
PGPASSWORD=<password> psql -h localhost -U postgres -c "CREATE DATABASE calculator;"
```

Or from WSL connecting to Windows PostgreSQL:
```bash
PGPASSWORD=<password> psql -h 10.255.255.254 -U postgres -c "CREATE DATABASE calculator;"
```

### 2. Install Infrastructure

Run the infrastructure script:

```bash
PGPASSWORD=<password> psql -h localhost -U postgres -d calculator -f /path/to/clonetemplate/server/infrastructure.sql
```

This creates:
- `execution_state` table - Session state storage
- `app_config` table - Application settings
- `migration_log` table - Migration tracking
- Session functions: `create_session()`, `clear_session()`, `cleanup_old_sessions()`
- State functions: `get_state()`, `set_state()`, and typed getters
- Config functions: `get_config()`, `set_config()`
- Utility functions: `normalize_text()`, `log_migration()`

### 3. Verify Infrastructure

```sql
-- Check tables exist
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public' AND table_type = 'BASE TABLE';

-- Check functions exist
SELECT routine_name FROM information_schema.routines
WHERE routine_schema = 'public' AND routine_type = 'FUNCTION';

-- Test session creation
SELECT create_session();
```

### 4. Create Project Folder

Copy the clonetemplate folder:

```bash
cp -r /path/to/clonetemplate/ /path/to/calculator/
```

On Windows:
```powershell
Copy-Item -Path "C:\path\to\clonetemplate" -Destination "C:\path\to\calculator" -Recurse
```

### 5. Initialize Git Repository

**First, ask the user:** "Which git hosting service do you use?"
- GitHub
- GitLab
- Bitbucket
- Azure DevOps
- None (local only)

#### Local Repository (All Options)

```bash
cd /path/to/calculator
git init
git add .
git commit -m "Initial commit from clonetemplate"
```

#### If GitHub

```bash
# Check CLI is available
gh auth status

# Create and push (private repo)
gh repo create calculator --private --source=. --push
```

If `gh` not installed: `winget install GitHub.cli` then `gh auth login`

#### If GitLab

```bash
# Check CLI is available
glab auth status

# Create and push (private repo)
glab repo create calculator --private
git push -u origin main
```

If `glab` not installed: `winget install GitLab.glab` then `glab auth login`

#### If Bitbucket

No official CLI. Use manual setup:
```bash
# Create repo at https://bitbucket.org/repo/create
# Then:
git remote add origin https://bitbucket.org/USERNAME/calculator.git
git push -u origin main
```

#### If Azure DevOps

```bash
# Check CLI is available
az repos list

# Create repo
az repos create --name calculator --project YOUR_PROJECT
git remote add origin https://dev.azure.com/ORG/PROJECT/_git/calculator
git push -u origin main
```

If `az` not installed: `winget install Microsoft.AzureCLI` then `az login`

#### If None (Local Only)

Just the local git init is sufficient. User can add a remote later if needed.

### 6. Update Configuration

Edit `calculator/server/config.js`:

Change the default database name:
```javascript
${process.env.PGDATABASE || 'calculator'}
```

### 7. Verify Setup

Start the server and test:

```bash
cd /path/to/calculator/server
npm install
npm start
```

Test the connection:
```bash
curl http://localhost:3001/api/tables
```

Should return empty array `[]` (no app tables yet, only infrastructure).

## Outputs

After this phase:
- PostgreSQL database `calculator` exists
- Infrastructure tables and functions installed
- Project folder `calculator/` created
- Git repository initialized with initial commit
- (If cloud hosting chosen) Remote repository created and pushed
- Server can connect to database

## Common Issues

### Database already exists

```sql
-- Drop and recreate (WARNING: destroys data)
DROP DATABASE IF EXISTS calculator;
CREATE DATABASE calculator;
```

### Permission denied

Ensure PostgreSQL user has CREATE DATABASE permission, or use a superuser.

### Connection refused

- Check PostgreSQL service is running
- Check host/port in config
- Check firewall allows connection
- For WSL→Windows: use Windows host IP (check `/etc/resolv.conf`)

## Next Phase

Proceed to `conversion-tables.md` for Phase 2: Table Migration.
