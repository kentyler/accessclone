# AccessClone

**Convert Microsoft Access databases to modern web applications.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green.svg)](https://nodejs.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-14%2B-336791.svg)](https://www.postgresql.org/)

AccessClone imports your Access database — tables, queries, forms, reports, modules, and all — into a PostgreSQL-backed web application that looks and works like Access but runs in a browser.

<!-- Screenshot placeholder: replace with actual screenshot once available -->
<!-- ![AccessClone Screenshot](docs/screenshot.png) -->

## Why AccessClone?

Millions of business applications run on Microsoft Access. They work — but they're trapped on Windows desktops, limited to single users, and increasingly difficult to maintain. Rewriting from scratch means losing years of accumulated business logic.

AccessClone takes a different approach: **import everything, preserve everything, then modernize incrementally.**

- **Tables & data** import with full fidelity — types, constraints, indexes, and rows
- **Queries** import as PostgreSQL views and functions
- **Forms** render in the browser with the same layout, controls, and record navigation
- **Reports** render with banded sections, grouping, and live data preview
- **Modules** (VBA) are preserved alongside AI-assisted translation to PostgreSQL functions
- **AI chat** analyzes each object, answers questions, and helps with conversion

## Features

### Full Import Pipeline
Import directly from `.accdb` / `.mdb` files — no manual schema translation required.
Tables, queries, forms, reports, and modules all import through the UI with one-click workflows.

### Access-Style Form Editor
- Design View with drag-and-drop controls (text boxes, combo boxes, buttons, subforms, and more)
- Form View with live data entry, record navigation, insert, update, and delete
- Continuous Forms, popup/modal forms, and tabbed subforms
- Property Sheet with Format / Data / Event / Other / All tabs — just like Access

### Banded Report Editor
- Five standard bands: Report Header/Footer, Page Header/Footer, Detail
- Dynamic group bands with configurable grouping, sorting, and intervals
- Live data preview with group-break detection
- Design View with resizable band sections

### AI-Powered Chat Assistant
Every object has a built-in chat panel. The AI sees the full definition and data context:
- Auto-analyzes forms, reports, and modules on first open
- Search, analyze, and navigate records through natural language
- Query the dependency graph — "What tables does this form use?"
- Translate VBA to PostgreSQL functions interactively

### Multi-Database Support
Register and switch between multiple PostgreSQL databases from a single instance.
Each database is isolated in its own schema with independent tables, queries, forms, and reports.

### Dependency & Intent Graph
A unified graph tracks structural relationships (table → column → form → control) and business intent.
Understand how objects connect before making changes.

## Quick Start

### Prerequisites
- Windows with MS Access installed (for import — runtime is cross-platform)
- PowerShell 5.1+
- Node.js 18+
- PostgreSQL 14+
- Java 11+ (for ClojureScript UI compilation)

### 1. Install Dependencies

Run PowerShell as Administrator:

```powershell
.\install.ps1
```

### 2. Set Up a Database

```powershell
.\setup.ps1 -DatabaseName northwind -Password <your_pg_password>
```

### 3. Start the Application

```powershell
.\start.ps1 -Password <your_pg_password>
```

Open **http://localhost:3001** in your browser.

For UI development with hot reload:

```powershell
.\start.ps1 -Password <your_pg_password> -Dev
```

### 4. Import an Access Database

1. Click **Import** in the sidebar
2. Browse to your `.accdb` or `.mdb` file
3. Select objects to import (tables, queries, forms, reports, modules)
4. Click Import — AccessClone handles the rest

## Architecture

```
accessclone/
├── server/                 # Node.js/Express backend
│   ├── routes/             #   REST API endpoints
│   ├── graph/              #   Dependency/intent graph engine
│   ├── lib/                #   Shared utilities (events, schema cache)
│   └── infrastructure.sql  #   Database bootstrap script
├── ui/                     # ClojureScript/Reagent frontend
│   └── src/app/
│       ├── state.cljs      #   Core state management
│       ├── state_form.cljs #   Form editor state
│       ├── state_report.cljs # Report editor state
│       └── views/          #   UI components
├── skills/                 # Conversion guides and patterns
├── install.ps1             # Dependency installer
├── setup.ps1               # Database setup
└── start.ps1               # Application launcher
```

**Frontend**: ClojureScript with Reagent (React wrapper). Single-page app with tabbed interface, drag-and-drop editors, and real-time chat.

**Backend**: Node.js/Express serving a REST API. Schema-per-database isolation. LLM integration for chat and code analysis.

**Database**: PostgreSQL with `shared` schema for metadata (forms, reports, modules, events, graph) and per-database schemas for imported data.

## API Overview

| Area | Endpoints | Description |
|------|-----------|-------------|
| Data | `/api/data/:table` | CRUD operations on table records |
| Tables | `/api/tables` | Table metadata with column details |
| Queries | `/api/queries`, `/api/queries/run` | View listing and SQL execution |
| Functions | `/api/functions` | PostgreSQL function catalog |
| Forms | `/api/forms/:name` | Form definition CRUD |
| Reports | `/api/reports/:name` | Report definition CRUD |
| Modules | `/api/modules/:name` | Module source code |
| Import | `/api/access-import/*` | Access database import pipeline |
| Chat | `/api/chat` | LLM chat with object context |
| Graph | `/api/graph/*` | Dependency and intent queries |
| Lint | `/api/lint/*` | Cross-object validation |

## Converting an Access Database

See the [conversion guide](skills/conversion.md) for the complete workflow:

1. **Setup** — Create database and configure connection
2. **Tables** — Import table structures, data, and indexes
3. **Queries** — Import as PostgreSQL views and functions
4. **Forms** — Import form definitions with layout and data bindings
5. **Reports** — Import banded report definitions
6. **Modules** — Preserve VBA source, translate to PostgreSQL with AI assistance

## Configuration

Database connection via environment variables:

```powershell
$env:PGHOST = "localhost"
$env:PGPORT = "5432"
$env:PGUSER = "postgres"
$env:PGPASSWORD = "your_password"
$env:PGDATABASE = "your_database"
```

Or use `DATABASE_URL` for a full connection string.

LLM chat requires an `ANTHROPIC_API_KEY` environment variable.

## Contributing

Contributions are welcome! Please see the [issue templates](.github/ISSUE_TEMPLATE/) for bug reports and feature requests.

## License

[MIT](LICENSE) — Kenneth Tyler, 2026
