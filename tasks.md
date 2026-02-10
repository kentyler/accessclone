# Project Tasks

## Pending

- [ ] **Add file picker option for import mode** — Add a file picker as an alternative to the full machine scan when importing Access databases. Users should be able to directly select a .accdb/.mdb file instead of having their entire machine scanned for database files.

## In Progress

## Completed

- [x] **Table import pipeline (Access → PostgreSQL)** — `export_table.ps1` extracts structure + data via DAO; `POST /api/access-import/import-table` creates table, batch-inserts rows, creates indexes in one transaction; frontend wires up `:tables` in import flow. (PR #10, 2026-02-09)
