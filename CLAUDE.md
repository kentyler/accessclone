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
- Continuous Forms: `:default-view "Continuous Forms"` renders header once, detail per record, footer once
- New records marked with `:__new__ true` to distinguish INSERT from UPDATE
- Close button in forms calls `close-tab!` to close current tab

### Table Viewer (ui/src/app/views/table_viewer.cljs)
- Datasheet View: Editable grid with inline cell editing
- Design View: Shows table structure (columns, types, keys)
- Right-click context menu: New Record, Delete Record, Cut, Copy, Paste
- Tab/Shift+Tab navigation between cells

### Query Viewer (ui/src/app/views/query_viewer.cljs)
- Results View: Runs SQL and displays data in read-only grid
- SQL View: Editable SQL with Run button
- Only SELECT queries allowed for safety

### Module Viewer (ui/src/app/views/module_viewer.cljs)
- Read-only display of PostgreSQL function source code
- Shows function signature (arguments, return type)
- All editing done via AI chat

### State Management (ui/src/app/state.cljs)
- `set-view-mode!` - Switches between :design and :view modes, loads data
- `save-current-record!` - Handles both INSERT (new) and UPDATE (existing)
- `navigate-to-record!` - Auto-saves before navigation
- Records use keyword keys internally, converted to strings for API
- UI state persistence: saves/restores open tabs across sessions

### API Routes (server/routes/)
- `/api/data/:table` - CRUD operations for table records
- `/api/databases` - Multi-database management
- `/api/graph/*` - Dependency/intent graph queries
- `/api/session/ui-state` - Save/load UI state (open tabs, active database)
- `/api/queries/run` - Execute SQL queries (SELECT only)
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
- `conversion-forms.md` - Form export from Access (critical transformations documented)
- `database-patterns.md` - PostgreSQL function patterns

## Known Issues / Debugging Notes

### Form not loading data (returns 0 records)
If a form's View mode shows no records but the table has data:
1. Check record-source in Design view Property Sheet matches table name exactly
2. Open the table directly from sidebar to verify data exists
3. Check Network tab - look at `/api/data/{table}` response
4. Check X-Database-ID header is correct
5. Try deleting and re-importing the form from Access

**Unresolved (2026-02-03)**: List_of_Carriers form returns 0 records even though:
- Table viewer shows 2 rows in carrier table
- Record-source is correctly set to "carrier"
- Other forms (List_of_Measurements, Ingredient_Entry) work fine
- May need to delete form from shared.forms and re-import
