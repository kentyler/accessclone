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
- Popup Forms: `:popup 1` renders as floating window; `:modal 1` adds full-screen backdrop (z-index 900)
- `normalize-form-definition` in state.cljs normalizes form data on load: coerces control `:type` to keyword, yes/no props to 0/1 integers (with defaults), and numeric props to numbers — across form-level and all sections

### Report Editor (ui/src/app/views/report_editor.cljs)
- Reports are **banded** (unlike forms which have 3 fixed sections: header/detail/footer). A banded report has 5 standard bands plus dynamic group bands that repeat based on data grouping:
  - report-header (once), page-header (each page), group-header-0..N (on group break), detail (each record), group-footer-N..0 (on group break), page-footer (each page), report-footer (once)
- Design View: Visual drag-drop editor with all bands rendered as resizable sections
- Preview: Read-only page layout with live data, group break detection, banded section rendering
- Property Sheet: Access-style tabbed interface (Format/Data/Event/Other/All) for report-level, section (band), group-level, and control properties
- Group-level properties (field, sort-order, group-on, group-interval, keep-together) stored in `:grouping` array, edited via Data tab when a group band is selected
- `normalize-report-definition` in state.cljs normalizes report data on load (same pattern as forms)
- EDN-format legacy reports (from PowerShell export) display as read-only preformatted text
- Files: report_editor.cljs (orchestrator), report_design.cljs (design surface), report_properties.cljs (property sheet), report_view.cljs (preview), report_utils.cljs (utilities)

### Table Viewer (ui/src/app/views/table_viewer.cljs)
- Datasheet View: Editable grid with inline cell editing
- Design View: Access-style split pane layout
  - Upper pane: Field Name | Data Type | Description grid with clickable row selection
  - Lower pane: Property sheet showing column properties (when a field is selected) or table properties (when none selected)
  - Column properties include: Field Size, Caption (pg_description), Default Value, Validation Rule (check constraints), Required (inverted nullable), Indexed (from pg_indexes)
  - Access-familiar N/A properties shown grayed out: New Values, Format, Input Mask, Validation Text, Allow Zero Length, Unicode Compression, IME Mode, Text Align
  - Selection state stored in `:table-viewer :selected-field`
- Metadata API (`/api/tables`) returns extended column info: maxLength, precision, scale, description, indexed, checkConstraint; plus table-level description
- Right-click context menu: New Record, Delete Record, Cut, Copy, Paste
- Tab/Shift+Tab navigation between cells
- State: `state_table.cljs` — `select-table-field!`, `set-table-view-mode!`, `load-table-for-viewing!`, cell editing, clipboard ops

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
- `load-databases!` / `switch-database!` reload all 5 object types: tables, queries, functions, forms, reports
- Report state: `set-report-definition!`, `load-report-for-editing!`, `save-report!`, `set-report-view-mode!`, `select-report-control!`, `update-report-control!`, `delete-report-control!`

### API Routes (server/routes/)
- `/api/data/:table` - CRUD operations for table records
- `/api/databases` - Multi-database management
- `/api/forms/*` - Form CRUD with append-only versioning (shared.forms table)
- `/api/reports/*` - Report CRUD with append-only versioning (shared.reports table)
- `/api/graph/*` - Dependency/intent graph queries
- `/api/session/ui-state` - Save/load UI state (open tabs, active database)
- `/api/queries/run` - Execute SQL queries (SELECT only)
- Schema routing via X-Database-ID header

### Lint / Cross-Object Validation (server/routes/lint.js)
Three endpoints for validating form and report definitions:
- `POST /api/lint/form` — Structural validation (required fields, control types, dimensions) + cross-object validation (record-source exists, field bindings match real columns, combo-box SQL is valid via EXPLAIN)
- `POST /api/lint/report` — Same pattern for reports: structural validation of banded sections + cross-object field binding checks
- `POST /api/lint/validate` — Database-wide: loads all forms/reports from shared.forms/shared.reports, validates each, returns aggregated results with summary

Save flow in both editors: lint first → if valid, save; if invalid, show errors in `.lint-errors-panel`; if lint endpoint fails, save anyway (graceful degradation). Cross-object checks use `getSchemaInfo()` which queries `information_schema` for all tables/views and their columns.

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
- `conversion-setup.md` - Database setup and initial configuration
- `conversion-tables.md` - Table export from Access
- `conversion-queries.md` - Query/view export from Access
- `conversion-forms.md` - Form export from Access (critical transformations documented)
- `conversion-vba.md` - VBA to PostgreSQL function conversion
- `database-patterns.md` - PostgreSQL function patterns
- `install.md` - Installation and setup guide

## Known Issues / Debugging Notes

### Form not loading data (returns 0 records)
If a form's View mode shows no records but the table has data:
1. Check record-source in Design view Property Sheet matches table name exactly
2. Open the table directly from sidebar to verify data exists
3. Check Network tab - look at `/api/data/{table}` response
4. Check X-Database-ID header is correct
5. Try deleting and re-importing the form from Access

**Resolved (2026-02-04)**: List_of_Carriers form was not displaying data due to two issues:
1. The `:field` property had "Carrier" (capital C) but the database column was "carrier" (lowercase).
   Fix: field lookup is now case-insensitive (normalized to lowercase).
2. The `:type` property was a string `"text-box"` after save+reload (JSON round-trip converts
   keywords to strings), but the `case` statement matched only keywords `:text-box`.
   Fix: `normalize-form-definition` in state.cljs now coerces all control `:type` values to keywords,
   plus yes/no and number properties, on load. Code can safely match keywords directly.
