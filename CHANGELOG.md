# Changelog

All notable changes to AccessClone will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added
- **File picker for import** — planned alternative to the full machine scan when importing Access databases

## [0.4.0] - 2026-02-17

### Added
- **Batch pipeline: Extract All → Resolve Gaps → Generate All Code** — App Viewer's Gap Decisions pane restructured as a 3-step pipeline with multi-pass dependency retry (max 20 passes)
- **Intent dependency checking** — `checkIntentDependencies()` and `autoResolveGaps()` validate and auto-resolve intent references against the dependency graph
- **Automatic .mdb → .accdb conversion** — `.mdb` files are silently converted when selected in the import UI via `convert_mdb.ps1`
- **Automatic AutoExec disabling** — `disable_autoexec.ps1` renames AutoExec macros via DAO before listing scripts, restores after
- **PRODUCT.md** — full product description covering the import pipeline, intent extraction, transform architecture, and three-phase trajectory
- **README rewrite** — "copy the intent, not the code" philosophy, AI-Assisted Setup section, OpenClaw appendix
- **INSTRUCTIONS.md rewrite** — distinguishes shell-access tools from chat-only tools with mode-specific guidance

## [0.3.0] - 2026-02-16

### Added
- **VBA intent extraction pipeline** — three-stage VBA migration: LLM extracts structured intents → deterministic mapping (30 intent types) → mechanical CLJS generation (22 templates) with LLM fallback
- **Pure state transform architecture** — 77 pure transforms, 75 flows across 10 domains; all views wired through `dispatch!` / `run-fire-and-forget!`
- **Access &-hotkey rendering** — captions with `&` markers render the hotkey letter underlined; Alt+letter activates controls in Form View
- **Control palette** — shared draggable/clickable toolbar for form (15 types) and report (9 types) Design Views
- **Query Design View** — visual table/join layout editor
- **Image import pipeline** — redesigned import UI with image support
- **Form state sync** — `session_state` cross-join pattern for form/TempVar references in converted queries; `control_column_map` populated at form/report save
- **LLM fallback for query conversion** — when regex converter output fails PG execution, falls back to Claude Sonnet with full schema context
- **VBA stub functions** — placeholder PG functions from VBA module declarations so views can reference user-defined functions
- **Dependency error handling** — PG errors 42P01/42883 bypass LLM fallback; frontend retry loop resolves across passes

### Fixed
- Blank page crash on forms with tab controls and `&` hotkeys
- Intent extraction JSON parsing for VBA expressions
- JSON escaping for large text fields with embedded quotes (`ConvertTo-SafeJson`)
- Form_/Report_ module import (VBE type 100 design-view fallback)
- Query re-import with `CREATE OR REPLACE VIEW` (column-change fallback with targeted `DROP CASCADE`)

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
