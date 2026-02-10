# PolyAccess

A template for converting Microsoft Access databases to web applications using PostgreSQL and ClojureScript.

## Quick Start

### 1. Install Dependencies

Run PowerShell as Administrator:

```powershell
.\install.ps1
```

This installs:
- Node.js (backend runtime)
- PostgreSQL (database)
- Java (for UI development)

### 2. Setup Project

After restarting your terminal:

```powershell
.\setup.ps1 -DatabaseName calculator -Password <your_pg_password>
```

This:
- Creates the PostgreSQL database
- Installs infrastructure (tables, functions)
- Installs npm dependencies

### 3. Start Application

```powershell
.\start.ps1 -Password <your_pg_password>
```

Opens the application at http://localhost:3001

For UI development with hot reload:

```powershell
.\start.ps1 -Password <your_pg_password> -Dev
```

## Project Structure

```
polyaccess/
├── server/              # Node.js backend
│   ├── index.js         # Express server
│   ├── config.js        # Database configuration
│   └── infrastructure.sql  # Setup script for new databases
├── ui/                  # ClojureScript frontend
│   ├── src/app/         # Application source
│   └── resources/public/  # Static files and compiled JS
├── skills/              # LLM guidance for conversions
├── install.ps1          # Install dependencies
├── setup.ps1            # Setup project
└── start.ps1            # Start application
```

## Converting an Access Database

See `skills/conversion.md` for the complete conversion workflow:

1. **Setup** - Create database and project folder
2. **Tables** - Migrate table structures and data
3. **Queries** - Convert queries to views/functions
4. **Forms** - Import forms via the UI (stored as JSON in PostgreSQL)
5. **VBA** - Translate VBA to PostgreSQL functions

## Requirements

### Runtime (to run a converted app)
- Node.js 18+
- PostgreSQL 14+
- Modern web browser

### Development (to modify UI)
- Java 11+ (for ClojureScript compiler)

### Conversion (to convert Access databases)
- Windows with MS Access installed
- PowerShell 5.1+

## Configuration

Database connection is configured in `server/config.js`. Override with environment variables:

```powershell
$env:PGHOST = "localhost"
$env:PGPORT = "5432"
$env:PGUSER = "postgres"
$env:PGPASSWORD = "your_password"
$env:PGDATABASE = "your_database"
```

Or set `DATABASE_URL` for a full connection string.

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/tables` | GET | List all tables with columns |
| `/api/queries` | GET | List all views with columns |
| `/api/queries/run` | POST | Execute a SELECT/WITH query |
| `/api/functions` | GET | List all stored functions |
| `/api/data/:source` | GET | Fetch records from table/view |
| `/api/data/:table` | POST | Insert new record |
| `/api/data/:table/:id` | PUT | Update record |
| `/api/data/:table/:id` | DELETE | Delete record |
| `/api/databases` | GET/POST | List or register databases |
| `/api/forms` | GET | List forms |
| `/api/forms/:name` | GET/PUT/DELETE | Form CRUD |
| `/api/reports` | GET | List reports |
| `/api/reports/:name` | GET/PUT/DELETE | Report CRUD |
| `/api/modules/:name` | GET | Read module source |
| `/api/lint/*` | POST | Validate forms/reports |
| `/api/chat` | POST | LLM chat with context |
| `/api/session/ui-state` | GET/PUT | Save/load UI state |
| `/api/graph/*` | GET/POST | Dependency/intent graph |
| `/api/access-import/*` | GET/POST | Import from Access databases |

## License

MIT
