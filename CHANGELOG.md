# Changelog

All notable changes to PolyAccess will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

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
