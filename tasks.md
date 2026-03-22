# Project Tasks

## Pending

- **Expand VBA-to-JS parser coverage** — `server/lib/vba-to-js.js` handles common patterns (DoCmd, MsgBox, Me.control properties) but complex VBA (If/Else, loops, DLookup, variables) still needs implementation. Test against cranbrook and northwind modules to identify gaps.
- **SQL Server data layer support** — Many Access deployments use SQL Server as the back-end (linked tables). Support connecting to an existing SQL Server for user data while keeping platform metadata in PostgreSQL. Requires: dual connection manager, T-SQL query adapter on CRUD routes, T-SQL output mode for query converter, SQL Server metadata queries. Form state sync cross-joins need special attention. See MEMORY.md for full assessment.
- **Image import test** — Run `POST /api/database-import/import-images` against northwinddev.accdb and verify images render in forms.
- **Runtime form state sync test** — Open a form, navigate records, verify `form_control_state` populates and dependent views filter.

## In Progress

## Completed

- **Dead CLJS translation pipeline removed** (March 21) — Deleted `vba-wiring-generator.js` + tests, `intent_interpreter.cljs`. Removed `generate-wiring` endpoint, `update_translation` chat tool, CLJS panel in Module/Macro Viewer, "Generate All Code" step in App Viewer. Pipeline reduced from 5→4 steps. Module Viewer now shows VBA + JS handlers panel. All `cljs-source`/`cljs-dirty?` state paths cleaned. Forward declarations added for `load-chat-transcript!` and `fire-report-event!` — frontend compile warnings reduced from 9→3 (remaining are `:redef` from third-party lib + intentional `run!` shadow). ~27 files modified, 3 deleted. Updated CLAUDE.md, HANDOFF.md, 6 skills docs.
- **VBA-to-JS event handler architecture** (March 21) — Replaced intent-based runtime execution with JavaScript generated from VBA at import time. New files: `server/lib/vba-to-js.js` (parser), `ui/src/app/runtime.cljs` (window.AC API). JS handlers stored in `shared.modules.js_handlers` JSONB column, auto-generated on module save. All 511 existing modules backfilled. Intent interpreter removed from all event execution paths. Also fixed: command-button renderer, label pointer-events, SQL record-source routing.
- **Import UX flow fix** (March 20) — Moved "New Database" into database dropdown, disabled Import button when no source/target selected, added error messages to `trigger-import!`, suppressed table-load errors in import mode.
- **SaveAsText rewrite of all export scripts** (March 18) — Rewrote export_form.ps1, export_forms_batch.ps1, export_report.ps1, export_reports_batch.ps1 from COM design-view to Application.SaveAsText parsing. Form parser uses context stack for nested labels/tab controls. Report parser simpler (flat control depth).
- **Macro export reliability** (March 18) — Added `$accessApp.Visible = $false` to export_macro.ps1 and export_macros_batch.ps1. Changed batch timeout formula in export.js.
- **cranbrook14 full pipeline import** (March 18) — All 33 forms with controls, all 7 reports with controls, 38 modules translated, queries imported with dependency retry. First fully successful complex .mdb import.
- **Business intent extraction** (March 17) — LLM extracts purpose/category/data-flows from forms, reports, queries. Stored in JSONB, integrated into chat context.
