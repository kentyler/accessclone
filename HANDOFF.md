# Handoff Notes

Shared scratchpad for AI assistants working on this codebase. Read this at session start. Update it after significant changes.

---

## Current State

### Just Shipped (2026-02-17)
- **Automatic .mdb → .accdb conversion**: `convert_mdb.ps1` converts Access 97-2003 .mdb files to .accdb via `Access.Application.SaveAsNewDatabase`. Wired into `GET /api/access-import/database` — user selects an .mdb, pipeline silently converts and runs unchanged. Response includes `convertedFrom` field.
- **Automatic AutoExec disabling**: `disable_autoexec.ps1` renames AutoExec → xAutoExec via `DAO.DBEngine.120` (engine-level, no macro trigger). Called before/after listing scripts in the `/database` endpoint. No more manual renaming needed.
- **README rewrite**: "Copy the intent, not the code" philosophy — explains intent extraction pipeline as the core differentiator. Added AI-Assisted Setup section (shell-access vs chat-only tools). Added appendix positioning AccessClone as an AI agent substrate for OpenClaw integration.
- **INSTRUCTIONS.md rewrite**: Distinguishes shell-access tools (Claude Code, Codex, Cursor) from chat-only tools (ChatGPT, Claude web) with mode-specific guidance throughout all setup steps.

### Previously Shipped (2026-02-16)
- **Access &-hotkey rendering**: Captions with `&` markers now render the hotkey letter underlined (e.g. `"&Save"` → "**S**ave"). Alt+letter activates the matching control. Implementation: `render-hotkey-text` and `extract-hotkey` in `editor_utils.cljs`, hotkey handler in `form_view.cljs`, `.hotkey` CSS class. Applies to all control types via `display-text` (forms and reports). `strip-access-hotkey` made public for plain-text matching in `resolve-button-action`.

### Previously Shipped (2026-02-12)
- **LLM fallback for query conversion** (PR #23): When the regex-based Access→PG converter produces SQL that fails execution, automatically falls back to Claude Sonnet with schema context (tables, views, columns, functions), control mappings, and the PG error message. LLM-assisted conversions flagged in `shared.import_issues` with category `llm-assisted`. Graceful degradation when no API key configured.
- **VBA stub function generator**: `createStubFunctions()` parses VBA modules for function declarations and creates placeholder PG functions so views can reference user-defined functions. Endpoint: `POST /api/access-import/create-function-stubs`.
- **Query converter fixes**: EXTRACT(YEAR FROM ...) no longer schema-prefixes the FROM keyword. DAO parameters that are actually form/parent refs (`[Parent].[EmployeeID]`, `[Table].[Column]`) filtered out — queries stay as views instead of becoming functions.
- **Table-level form state sync**: `shared.form_control_state` keyed by `(session_id, table_name, column_name)`. `shared.control_column_map` maps form controls → table.column at save time. Query converter resolves `[Forms]![frmX]![ctrl]` via this mapping. See `skills/form-state-sync.md` for full architecture.
- **Import order**: tables → forms/reports → queries → macros → modules. Forms must be imported before queries so control_column_map exists.
- **Tested against two databases**: Northwind and a second Access database both import fully (tables, forms, reports, queries, modules, macros) without errors.

### In Progress / Uncommitted
- `ui/src/app/views/access_database_viewer.cljs` — modified (import order change)
- 4 batch PowerShell scripts in `scripts/access/` (untracked): `export_forms_batch.ps1`, `export_reports_batch.ps1`, `export_modules_batch.ps1`, `export_macros_batch.ps1`

### Next Up
- Test .mdb → .accdb conversion end-to-end with a real .mdb file
- Test runtime form state sync end-to-end: open a form, navigate records, verify `form_control_state` populated and dependent views filter correctly
- OpenClaw skill prototype: export intent graph + form definitions in a format an OpenClaw agent can consume

---

## Known Landmines

### API Contract Changes
- `PUT /api/form-state` now expects `{sessionId, entries: [{tableName, columnName, value}]}`. The old format `{sessionId, formName, controls: {...}}` no longer works. Both server and frontend are updated.
- `GET /api/data/:table` no longer reads `X-Form-Name` header or sets `app.active_form`. Only `X-Session-ID` and `X-Database-ID` headers matter now.

### Schema Migration
- `server/graph/schema.js` has a `DO $$ ... END $$` block that renames `form_name` → `table_name` and `control_name` → `column_name` in `form_control_state` on first run. It truncates the table during migration. This runs automatically on server start.

### Name Sanitization
- `sanitizeName()` in `query-converter.js` lowercases and replaces spaces with underscores, strips non-alphanumeric chars. All table names, column names, form names, and control names go through this. If you're comparing names across systems, always sanitize both sides.

### ClojureScript State Atom
- All state lives in a single Reagent atom `app-state` shared across `state.cljs`, `state_form.cljs`, and `state_report.cljs`. Mutations use `swap! app-state assoc-in [path...]`. Be careful with concurrent updates to nested paths.

### Form Definitions
- Controls have `:type` as keyword after normalization (`:text-box`, `:combo-box`), but arrive as strings from JSON round-trips. `normalize-form-definition` in `state_form.cljs` handles coercion. If you add new control properties, add normalization there too.

### Query Converter Pipeline
- **Regex converter** (`server/lib/query-converter/`): deterministic, fast, free — handles ~90% of queries. Split into modules: `index.js` (entry), `syntax.js` (brackets, operators, schema prefixing), `functions.js` (Access→PG function map), `ddl.js` (view/function DDL generation), `form-state.js` (form/TempVar ref resolution), `utils.js` (sanitizeName).
- **LLM fallback** (`server/lib/query-converter/llm-fallback.js`): called when regex output fails PG execution. Sends original Access SQL + failed PG SQL + error + full schema context (tables, views, columns, functions) to Claude Sonnet. Response parsed, executed in transaction.
- **VBA stubs** (`server/lib/vba-stub-generator.js`): creates placeholder PG functions from VBA module declarations so views referencing UDFs can be created before full VBA translation.

### Test Coverage
- `server/__tests__/query-converter.test.js` — 95 tests, comprehensive. Touch the converter? Run these.
- `server/__tests__/vba-stub-generator.test.js` — stub generator tests.
- No tests for route handlers. These are tested manually via the import pipeline.
- Frontend has no automated tests. Verify with `cd ui && npx shadow-cljs compile app` (should show only 2 harmless `no.en.core` redef warnings).

---

## Conventions

### Server-Side
- **Error logging**: `logError(pool, source, message, err, {databaseId})` for real errors. `logEvent(pool, 'warning', source, message, {databaseId, details})` for graceful degradation. Source format: `"METHOD /api/path"`.
- **Route structure**: Each route file exports `function(pool)` (or `function(pool, secrets)` for routes needing API keys) that returns an Express router.
- **Non-critical side effects** (graph population, control-column mapping) run outside the main transaction, wrapped in try/catch that logs warnings but doesn't fail the request.
- **Schema per database**: Each imported Access database gets its own PostgreSQL schema. The schema name comes from `shared.databases.schema_name`, selected by the `X-Database-ID` header.

### Frontend (ClojureScript)
- **Error reporting**: `log-error!` for user-visible errors (shows banner + logs to server). `log-event!` for background errors (server log only, no banner).
- **API calls**: Always use `db-headers` for the headers map. It includes `X-Session-ID` and `X-Database-ID`.
- **Naming**: ClojureScript uses kebab-case (`record-source`). JSON keys preserve Access-style kebab-case (`record-source`, `control-source`). PostgreSQL uses snake_case.

### Git
- Commit messages: imperative mood, 1-2 sentence summary, then details if needed.
- Co-author line: `Co-Authored-By: <Model> <noreply@anthropic.com>` (or appropriate email).
- Don't push to main without running tests (`npx jest`) and compiling frontend (`npx shadow-cljs compile app`).
