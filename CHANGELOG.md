# Changelog

All notable changes to AccessClone will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added
- **Batch pipeline: Extract All → Resolve Gaps → Generate All Code** — App Viewer's Gap Decisions pane restructured as a 3-step pipeline. Step 1: batch extract intents from all modules. Step 2: auto-resolve gaps whose referenced objects exist in the database, present remaining gaps to user. Step 3: batch code generation with multi-pass dependency retry (same pattern as query imports — modules whose intent dependencies aren't satisfied are deferred and retried, up to 20 passes).
- **Intent dependency checking** — `checkIntentDependencies()` validates that all forms, reports, and tables referenced by a module's intents exist in the database. `autoResolveGaps()` auto-resolves gap intents (DLookup, OpenForm, RunSQL) when the referenced object exists. Both server-side in `context.js`.
- **`check_deps` flag on generate-wiring endpoint** — `POST /api/chat/generate-wiring` accepts `check_deps: true` to skip generation when dependencies are unsatisfied, returning `{skipped: true, missing_deps: [...]}` instead.
- **PRODUCT.md** — Full product description covering the import pipeline, intent extraction, transform architecture, and the three-phase trajectory from migration tool to AI agent substrate.
- **Access &-hotkey rendering** — Captions with `&` markers (e.g. `"Product &Vendors"`) now render the hotkey letter with an underline, matching Access display behavior. Applies to buttons, checkboxes, option buttons, toggle buttons, tab pages, labels, and default controls across both forms and reports.
- **Alt+letter keyboard shortcuts** — Pressing Alt+letter in Form View activates the control whose caption has the matching `&`-hotkey. Buttons are clicked, inputs are focused. Label hotkeys focus the next control in tab order.

## [0.2.0] - 2026-02-10

### Added
- **Table import pipeline** — Import tables from Access with full structure (columns, types, PKs, indexes) and all row data via a single server-side endpoint (`POST /api/access-import/import-table`). Uses `export_table.ps1` (DAO) to extract, maps Access type codes to PostgreSQL types, batch-inserts rows (500/stmt), resets identity sequences, creates non-PK indexes — all in one transaction.
- Comprehensive error logging to `shared.events` table across all server routes and frontend error sites
- Report editor with banded design (report-header, page-header, group bands, detail, page-footer, report-footer)
- Table Design View with Access-style split pane (field grid + property sheet)
- Dependency/intent graph system (`shared._nodes`, `shared._edges`) for cross-object analysis
- Lint/validation system for forms and reports (structural + cross-object checks)
- Access database import via PowerShell scripts (forms, reports, tables, queries, modules)
- AI chat with tool use (query dependencies, query intent, propose intent)
- Continuous Forms support (header once, detail per record, footer once)
- Popup/modal form support
- Subform support with linked master/child fields
- UI state persistence (open tabs, active database) across sessions
- Multi-database support with schema-per-database isolation

### Fixed
- Form controls now render correctly after JSON round-trip (keyword/type normalization)
- Case-insensitive field binding for imported Access forms
