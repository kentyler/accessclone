# Handoff Notes

Shared scratchpad for AI assistants working on this codebase. Read this at session start. Update it after significant changes.

---

## Current State

### Just Shipped (2026-02-12)
- **Table-level form state sync** (commit 2be0c6f): `shared.form_control_state` now keyed by `(session_id, table_name, column_name)` instead of `(session_id, form_name, control_name)`. New `shared.control_column_map` table maps form controls to their underlying table.column at save time. Query converter resolves `[Forms]![frmX]![ctrl]` references via this mapping at conversion time.
- **Import order changed**: tables → forms/reports → queries → macros → modules. Forms must be imported before queries so the control_column_map exists when the converter needs it.
- Removed: `activeFormStateSubquery`, `parentFormStateSubquery`, `app.active_form` session var, `X-Form-Name` HTTP header.

### In Progress / Uncommitted
- 4 batch PowerShell scripts in `scripts/access/` are on disk but not committed: `export_forms_batch.ps1`, `export_reports_batch.ps1`, `export_modules_batch.ps1`, `export_macros_batch.ps1`. The server routes that call them already exist in `access-import.js`.

### Next Up
- Re-import Northwind queries to verify the `extractCalculatedColumns` disable fix resolves type errors.
- Test the retry loop for dependency ordering on cascading query views.
- Restart server to trigger schema migration (control_column_map creation, form_control_state column rename).
- GitHub repo presentation: README.md, LICENSE, repo metadata (see MEMORY.md for full list).

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

### Test Coverage
- `server/__tests__/query-converter.test.js` — 77 tests, comprehensive. Touch the converter? Run these.
- No tests for `expression-converter.js`, `control-mapping.js`, or any route handlers. These are tested manually via the import pipeline.
- Frontend has no automated tests. Verify with `cd ui && npx shadow-cljs compile app` (should show only 2 harmless `no.en.core` redef warnings).

---

## Conventions

### Server-Side
- **Error logging**: `logError(pool, source, message, err, {databaseId})` for real errors. `logEvent(pool, 'warning', source, message, {databaseId, details})` for graceful degradation. Source format: `"METHOD /api/path"`.
- **Route structure**: Each route file exports `function(pool)` that returns an Express router.
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
