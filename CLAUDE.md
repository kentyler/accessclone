# Project Instructions for Claude

## SQL Formatting

When providing SQL commands, write them as plain text WITHOUT code block formatting (no triple backticks). This avoids invisible character issues when copying from the terminal.

Example - do this:
ALTER TABLE users ADD COLUMN email VARCHAR(255)

Not this:
```sql
ALTER TABLE users ADD COLUMN email VARCHAR(255)
```

## Project Overview

This is PolyAccess (formerly CloneTemplate), a platform for converting MS Access databases to web applications with multi-database support using PostgreSQL.

## Architecture

- **Frontend**: ClojureScript/Reagent (ui/src/app/)
- **Backend**: Node.js/Express (server/)
- **Database**: PostgreSQL with schema-per-database isolation
- **Desktop**: Electron wrapper (electron/)

## Key Implementation Details

### Form Editor (ui/src/app/views/form_editor.cljs)
- Design View: Visual drag-drop editor
- Form View: Live data entry with record navigation
- Property Sheet: Access-style tabbed interface (Format/Data/Event/Other/All)
- Controls bind to database fields via `:field` (drag-drop) or `:control-source` (Property Sheet)

### State Management (ui/src/app/state.cljs)
- `set-view-mode!` - Switches between :design and :view modes, loads data
- `save-current-record!` - Handles both INSERT (new) and UPDATE (existing)
- `navigate-to-record!` - Auto-saves before navigation
- Records use keyword keys internally, converted to strings for API

### API Routes (server/routes/)
- `/api/data/:table` - CRUD operations for table records
- `/api/databases` - Multi-database management
- `/api/graph/*` - Dependency/intent graph queries
- Schema routing via X-Database-ID header

### Dependency/Intent Graph (server/graph/)
A unified graph in `shared._nodes` and `shared._edges` that tracks:
- **Structural nodes**: tables, columns, forms, controls (with database_id)
- **Intent nodes**: business purposes like "Track Inventory Costs" (global, no database_id)
- **Edges**: contains, references, bound_to, serves (structure→intent)

Populated once on first startup from schemas. Forms auto-update when saved.
After schema changes (new tables/columns), call `POST /api/graph/populate` to sync.

LLM tools in chat: `query_dependencies`, `query_intent`, `propose_intent`

## Skills Files

See `/skills/` directory for conversion and design guidance:
- `form-design.md` - Form structure and patterns
- `conversion.md` - Access database conversion workflow
- `database-patterns.md` - PostgreSQL function patterns
