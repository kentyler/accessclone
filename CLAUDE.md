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

This is AccessClone, a platform for converting MS Access databases to web applications with multi-database support using PostgreSQL.

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
- `normalize-form-definition` in state_form.cljs normalizes form data on load: coerces control `:type` to keyword, yes/no props to 0/1 integers (with defaults), and numeric props to numbers — across form-level and all sections

### Report Editor (ui/src/app/views/report_editor.cljs)
- Reports are **banded** (unlike forms which have 3 fixed sections: header/detail/footer). A banded report has 5 standard bands plus dynamic group bands that repeat based on data grouping:
  - report-header (once), page-header (each page), group-header-0..N (on group break), detail (each record), group-footer-N..0 (on group break), page-footer (each page), report-footer (once)
- Design View: Visual drag-drop editor with all bands rendered as resizable sections
- Preview: Read-only page layout with live data, group break detection, banded section rendering
- Property Sheet: Access-style tabbed interface (Format/Data/Event/Other/All) for report-level, section (band), group-level, and control properties
- Group-level properties (field, sort-order, group-on, group-interval, keep-together) stored in `:grouping` array, edited via Data tab when a group band is selected
- `normalize-report-definition` in state_report.cljs normalizes report data on load (same pattern as forms)
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
- Split view: VBA source (left) + ClojureScript translation (right)
- Two-phase intent-based translation (recommended):
  1. **Extract Intents** — LLM extracts structured JSON intents from VBA (POST /api/chat/extract-intents)
  2. **Generate Code** — Mechanical templates + LLM fallback produce ClojureScript (POST /api/chat/generate-wiring)
- Legacy **Direct Translate** button preserved for one-shot LLM translation
- Intent summary panel: collapsible, shows procedures with color-coded stats (green=mechanical, yellow=LLM-assisted, red=gap)
- Info panel: Name, version, imported date, status dropdown
- `shared.modules` has `intents` JSONB column to persist extracted intent structure
- Server libs: `vba-intent-mapper.js` (30 intent types, deterministic mapping), `vba-intent-extractor.js` (LLM extraction), `vba-wiring-generator.js` (22 mechanical CLJS templates)
- Transforms: `set-module-intents`, `set-extracting-intents`; Flows: `extract-intents-flow`, `generate-wiring-flow`

### Macro Viewer (ui/src/app/views/macro_viewer.cljs)
- Left panel: Raw macro definition (SaveAsText format, read-only)
- Right panel: ClojureScript translation (initially empty, populated via chat)
- Info panel: Name, version, imported date, status dropdown
- Auto-analyze fires on first open, LLM describes structure/purpose
- Macros stored in `shared.macros` table with append-only versioning

### Access Import — AutoExec Warning
**IMPORTANT**: Before opening any Access database via COM automation (import scripts, export scripts, diagnose script), check if it has an AutoExec macro. If so, the user must rename it to "xAutoExec" first — otherwise it will fire on open, potentially showing a login dialog or running startup code that hangs the PowerShell process indefinitely.

### Access Import — PowerShell Script Notes
- `export_table.ps1` uses a custom `ConvertTo-SafeJson` serializer instead of `ConvertTo-Json` — PowerShell's built-in cmdlet has known bugs with embedded double quotes in large strings (e.g. HTML in memo fields). The custom serializer handles escaping of `"`, `\`, `\r`, `\n`, `\t` correctly.
- `list_modules.ps1`, `export_module.ps1`, `export_modules_batch.ps1` handle Form_/Report_ class modules (VBE type 100) with a design-view fallback: if `CodeModule.CountOfLines` is inaccessible (common with `AutomationSecurity=3`), the script opens the form/report in design view via `DoCmd.OpenForm`/`DoCmd.OpenReport` to force the code module to load, then closes it after reading. The listing script only skips type 100 modules with *confirmed* zero lines (not inaccessible ones).

### State Management
State is split across three modules that share a single Reagent atom (`app-state`):

**Core state** (`ui/src/app/state.cljs`):
- Shared helpers, loading/error, database selection, tabs, UI persistence, chat, config
- `load-databases!` / `switch-database!` reload all 7 object types: tables, queries, functions, forms, reports, modules, macros
- Records use keyword keys internally, converted to strings for API

**Form state** (`ui/src/app/state_form.cljs`):
- `set-view-mode!` - Switches between :design and :view modes, loads data
- `save-current-record!` - Handles both INSERT (new) and UPDATE (existing)
- `navigate-to-record!` - Auto-saves before navigation
- Row-source cache, subform cache, clipboard, form normalization
- `create-new-form!`, `load-form-for-editing!`, `save-form!`, `select-control!`, `update-control!`, `delete-control!`

**Report state** (`ui/src/app/state_report.cljs`):
- `set-report-definition!`, `load-report-for-editing!`, `save-report!`, `set-report-view-mode!`, `select-report-control!`, `update-report-control!`, `delete-report-control!`

### Error Logging (shared.events)
All errors are logged to the `shared.events` table for persistent diagnostics.

**Server-side** (`server/lib/events.js`):
- `logError(pool, source, message, err, { databaseId })` — logs with stack trace, event_type='error'
- `logEvent(pool, eventType, source, message, { databaseId, details })` — general events
- Source naming convention: `"METHOD /api/path"` e.g. `"GET /api/tables"`, `"POST /api/data/:table"`
- Use `logError` for actual errors; use `logEvent(pool, 'warning', ...)` for:
  - Graceful degradation (sessions GET returning empty `{}`)
  - Non-fatal side effects (graph population after form/report save)
  - Chat tool errors (with tool name in details)

**Frontend** (`state.cljs`):
- `log-error!` (message, source, details) — calls `set-error!` (UI banner) + `log-event!` (POST to server)
- `log-event!` (event-type, message, source, details) — POST to `/api/events`, no UI banner
- Use `log-error!` for user-facing errors (form load, save, delete failures)
- Use `log-event!` for background errors where a banner would be disruptive (subform loading, query execution when error state is already shown in UI)

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

### LLM Chat Context (server/routes/chat.js)
The chat system prompt includes context based on the active tab:
- **Forms**: `form_context` with `record_source` + full definition → `summarizeDefinition()` renders compact text (sections, controls with type/field/position)
- **Reports**: `report_context` with `report_name`, `record_source` + full definition → same `summarizeDefinition()` helper
- **Modules**: `module_context` with VBA source, CLJS translation, app object inventory. Also: `POST /api/chat/extract-intents` for structured intent extraction, `POST /api/chat/generate-wiring` for CLJS generation from intents
- **Graph tools**: Always available for dependency/intent queries

Auto-analyze: When a report or form is opened with no existing chat transcript, `maybe-auto-analyze!` in state.cljs automatically sends a prompt asking the LLM to describe the object's structure/purpose and flag potential issues. Uses a pending-flag pattern to handle the race between transcript loading and definition loading — whichever async operation completes second triggers the analysis. The generated analysis is saved as the transcript so it won't re-fire on subsequent opens.

### Query Converter (server/lib/query-converter/)
Converts Access SQL to PostgreSQL views/functions. Two-stage pipeline:

1. **Regex converter** (fast, deterministic, free): `index.js` orchestrates; `syntax.js` handles brackets/operators/schema-prefixing; `functions.js` maps Access→PG functions; `ddl.js` generates CREATE VIEW/FUNCTION DDL; `form-state.js` resolves form/TempVar references via cross-joins against `shared.session_state`.
2. **LLM fallback** (`llm-fallback.js`): When regex output fails PG execution, sends original Access SQL + error + full schema context (tables, views, columns, available functions) + control mapping to Claude Sonnet. LLM-assisted conversions flagged in `shared.import_issues` with category `llm-assisted`. **Dependency errors (42P01/42883) skip the LLM fallback** — the frontend retry loop handles these across passes. Error responses include `category: 'missing-dependency' | 'conversion-error'`.

VBA stub functions (`server/lib/vba-stub-generator.js`) are created before query execution so views referencing user-defined functions don't fail.

**Re-import behavior**: Queries use `CREATE OR REPLACE VIEW/FUNCTION`, so re-importing replaces existing objects in-place without affecting dependent views. If a view's column list changed, `executeStatements` catches the error, does a targeted `DROP CASCADE` + `CREATE` for just that view.

95 tests in `server/__tests__/query-converter.test.js`. Run after any converter changes.

### Form State Sync
See `skills/form-state-sync.md` for full architecture. Key points:
- `shared.session_state`: a view on `form_control_state` pre-filtered by `current_setting('app.session_id', true)` — used as cross-joins in converted queries
- `shared.control_column_map`: maps `(database_id, form_name, control_name)` → `(table_name, column_name)`, populated at form/report save
- `shared.form_control_state`: runtime state `(session_id, table_name, column_name, value)`, populated when users navigate records in forms with tagged controls
- Query converter resolves `[Forms]![frmX]![ctrl]` and `[TempVars]![var]` to cross-join aliases (`ss1.value`, `ss2.value`) against `shared.session_state`, with filtering in WHERE
- Import order matters: tables → forms/reports → queries (forms must exist before queries to populate the mapping)

### Query Import Retry Loop
Both `import-selected!` and `import-all!` use a multi-pass retry loop for queries to handle dependency ordering (query A depends on query B which depends on query C). Each pass imports what it can; failed queries are retried in the next pass. The loop continues while progress is made (at least one query succeeded), up to 20 passes max. Dependency errors (PG 42P01/42883) are identified server-side and returned with `category: 'missing-dependency'`.

## Skills Files

See `/skills/` directory for conversion and design guidance:
- `form-design.md` - Form structure and patterns
- `form-state-sync.md` - Form state sync architecture (control_column_map, form_control_state, import/runtime flow)
- `conversion.md` - Access database conversion workflow
- `conversion-setup.md` - Database setup and initial configuration
- `conversion-tables.md` - Table export from Access
- `conversion-queries.md` - Query/view export from Access (includes LLM fallback docs)
- `conversion-forms.md` - Form export from Access (critical transformations documented)
- `conversion-vba.md` - VBA to PostgreSQL function conversion
- `conversion-macros.md` - Macro import, format details, and translation strategy
- `database-patterns.md` - PostgreSQL function patterns
- `install.md` - Installation and setup guide
- `codebase-guide.md` - Guided tour of the codebase for LLMs or humans trying to understand the project
- `writing-skills.md` - Meta-guide for writing skill files (cross-platform patterns, checklist)
- `testing.md` - Full testing guide for LLMs — what tests exist, when to run them, how to add new ones

## Testing

**Always run after making changes:** `npm test` (from project root — runs server + electron tests)

| What you changed | What to run | Test file |
|-----------------|-------------|-----------|
| Query converter (`server/lib/query-converter/`) | `npm test` | `server/__tests__/query-converter.test.js` (95 tests) |
| Lint / validation (`server/routes/lint/`) | `npm test` | `server/__tests__/lint.test.js` |
| VBA stubs (`server/lib/vba-stub-generator.js`) | `npm test` | `server/__tests__/vba-stub-generator.test.js` |
| VBA intent mapper (`server/lib/vba-intent-mapper.js`) | `npm test` | `server/__tests__/vba-intent-mapper.test.js` (~24 tests) |
| VBA intent extractor (`server/lib/vba-intent-extractor.js`) | `npm test` | `server/__tests__/vba-intent-extractor.test.js` (~12 tests) |
| VBA wiring generator (`server/lib/vba-wiring-generator.js`) | `npm test` | `server/__tests__/vba-wiring-generator.test.js` (~35 tests) |
| Schema routing / multi-DB middleware | `npm run test:db` | `server/__tests__/db.schema-routing.test.js` (needs PostgreSQL) |
| Electron utilities (`electron/lib/`) | `npm test` | `electron/__tests__/*.test.js` |

DB tests require a running PostgreSQL instance and are gated behind `ACCESSCLONE_DB_TESTS=1`. They do NOT run with `npm test` — use `npm run test:db` explicitly.

See `skills/testing.md` for the full guide including how to write new tests.

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
   Fix: `normalize-form-definition` in state_form.cljs now coerces all control `:type` values to keywords,
   plus yes/no and number properties, on load. Code can safely match keywords directly.
