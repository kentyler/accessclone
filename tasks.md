# Project Tasks

## Pending

- **Wire VBA code to form controls** — Imported cranbrook forms have buttons/events that show generic messages instead of executing actual logic. Infrastructure exists (intent interpreter, `/api/modules/Form_{name}/handlers`), just needs wiring for each form's controls.
- **SQL Server data layer support** — Many Access deployments use SQL Server as the back-end (linked tables). Support connecting to an existing SQL Server for user data while keeping platform metadata in PostgreSQL. Requires: dual connection manager, T-SQL query adapter on CRUD routes, T-SQL output mode for query converter, SQL Server metadata queries. Form state sync cross-joins need special attention. See MEMORY.md for full assessment.
- **Image import test** — Run `POST /api/database-import/import-images` against northwinddev.accdb and verify images render in forms.
- **Runtime form state sync test** — Open a form, navigate records, verify `form_control_state` populates and dependent views filter.

## In Progress

## Completed

- **SaveAsText rewrite of all export scripts** (March 18) — Rewrote export_form.ps1, export_forms_batch.ps1, export_report.ps1, export_reports_batch.ps1 from COM design-view to Application.SaveAsText parsing. Form parser uses context stack for nested labels/tab controls. Report parser simpler (flat control depth).
- **Macro export reliability** (March 18) — Added `$accessApp.Visible = $false` to export_macro.ps1 and export_macros_batch.ps1. Changed batch timeout formula in export.js.
- **cranbrook14 full pipeline import** (March 18) — All 33 forms with controls, all 7 reports with controls, 38 modules translated, queries imported with dependency retry. First fully successful complex .mdb import.
- **Business intent extraction** (March 17) — LLM extracts purpose/category/data-flows from forms, reports, queries. Stored in JSONB, integrated into chat context.
