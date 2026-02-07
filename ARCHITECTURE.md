# Architecture

PolyAccess converts Microsoft Access databases into multi-tenant web applications backed by PostgreSQL.

## High-Level Overview

```
Browser (ClojureScript/Reagent)
  |
  | HTTP + X-Database-ID header
  v
Express Server (Node.js)
  |
  | search_path middleware (schema-per-database isolation)
  v
PostgreSQL
  ├── shared schema     (forms, reports, events, databases, graph)
  └── db_* schemas      (one per converted Access database — tables, views, functions)
```

## Multi-Database Isolation

Each converted Access database gets its own PostgreSQL schema (e.g., `db_calculator`, `db_inventory`). Middleware reads the `X-Database-ID` header and sets `search_path` so route handlers can query without schema-qualifying table names.

Shared metadata lives in the `shared` schema:
- `shared.databases` — registry of all converted databases
- `shared.forms` / `shared.reports` — append-only versioned JSON definitions
- `shared.events` — persistent error and event log
- `shared._nodes` / `shared._edges` — dependency graph

## Frontend Architecture

### State Management

The frontend uses a **single Reagent atom** (`app-state`) rather than re-frame. All mutations go through explicitly-named functions with `!` suffixes in the state modules:

```
state.cljs          Core state: shared helpers, loading, tabs, UI persistence, chat, config
state_form.cljs     Form editor: records, navigation, sessions, row-source/subform cache
state_report.cljs   Report editor: definition, preview, normalization
state_table.cljs    Table viewer: cell editing, clipboard, design mode
state_query.cljs    Query viewer: SQL editing, result display
```

Components in `views/` read from the atom and call state functions to trigger changes. HTTP calls use `cljs-http` with `core.async` (`go`/`<!` blocks).

### View Modules

Each object type has a set of view modules following the same pattern:

**Forms** (3 fixed sections: header, detail, footer):
```
form_editor.cljs       Orchestrator — mode switching, toolbar
form_design.cljs       Design surface — drag-drop canvas
form_properties.cljs   Property sheet — Format/Data/Event/Other/All tabs
form_view.cljs         Live view — data entry with record navigation
form_utils.cljs        Shared utilities — grid snapping, field resolution
```

**Reports** (banded: 5 standard + dynamic group bands):
```
report_editor.cljs     Orchestrator
report_design.cljs     Design surface with resizable bands
report_properties.cljs Property sheet (report, section, group, control levels)
report_view.cljs       Preview with live data and group break detection
report_utils.cljs      Shared utilities
```

**Tables:**
```
table_viewer.cljs      Datasheet view + Access-style Design View (split pane)
```

**Queries / Modules:**
```
query_viewer.cljs      Results grid + SQL editor
module_viewer.cljs     Read-only function source display
```

### Data Flow

1. User opens a form/report/table from the sidebar
2. State function loads the definition (from `shared.forms`/`shared.reports` or schema metadata)
3. If in View mode, data is fetched from `/api/data/:source`
4. User edits a record and navigates away or clicks Save
5. `save-current-record!` sends INSERT or UPDATE to `/api/data/:table`
6. Form/report definition changes go to `/api/forms/:name` or `/api/reports/:name`

## Backend Architecture

### Route Organization

Each route file exports a factory function that receives `pool` (and optionally other dependencies) and returns an Express router:

```
server/routes/
  metadata.js       GET /api/tables, /api/queries, /api/functions
  data.js           CRUD on /api/data/:source
  forms.js          CRUD on /api/forms/:name (append-only versioning)
  reports.js        CRUD on /api/reports/:name (append-only versioning)
  sessions.js       Execution sessions for PostgreSQL functions
  databases.js      Multi-database management and switching
  graph.js          Dependency/intent graph queries
  chat.js           AI chat with tool use
  lint.js           Form/report validation
  config.js         Application settings
  events.js         Event logging
  access-import.js  Access database scanning and export
```

### Error Logging

All errors are logged to `shared.events` via helpers in `server/lib/events.js`:

- `logError(pool, source, message, err, { databaseId })` — for actual errors (includes stack trace)
- `logEvent(pool, 'warning', source, message, { databaseId, details })` — for non-fatal issues

Frontend equivalents in `state.cljs` (core):
- `log-error!` — shows UI error banner + logs to server
- `log-event!` — logs to server without UI disruption

### Dependency Graph

The `shared._nodes` and `shared._edges` tables track structural relationships (tables contain columns, forms bind to fields) and intent relationships (structures serve business purposes). Populated on first startup from database schemas. Updated when forms/reports are saved.

## Form/Report Storage

Definitions are stored as JSON in `shared.forms` and `shared.reports` with append-only versioning. Each save creates a new row with an incremented version number. The `is_current` flag marks the active version; previous versions are retained for history.

On load, definitions pass through `normalize-form-definition` (in `state_form.cljs`) / `normalize-report-definition` (in `state_report.cljs`) which coerce types (keywords, yes/no values, numbers) to handle JSON round-trip losiness.

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| Single atom vs re-frame | IDE-style app needs unified state across editors, tabs, and property sheets |
| Schema-per-database | Strong isolation between converted databases; simple `search_path` routing |
| Append-only versioning | Free audit trail and rollback without separate history tables |
| PowerShell for Access export | COM automation requires Windows; scripts output JSON for cross-platform consumption |
| Lint before save | Catches field binding errors and invalid SQL before persisting bad definitions |
