# PolyAccess Migration Plan

**Date:** 2026-01-30
**Status:** In Progress

## What We've Built So Far

### Access Import Feature (Complete)
- **Database selector**: "Access Import" appears as its own database in the dropdown
- **Sidebar**: Shows list of `.accdb` files found on the system (scanned from Desktop/Documents)
- **Center pane**: When an Access database is selected, shows:
  - Dropdown to select object type (Forms/Reports)
  - List of objects with checkboxes for selection
  - "Import to" dropdown to pick target PolyAccess database
  - Import button
- **Right panel**: Import log showing real-time progress
  - Success/error status with color coding
  - Timestamps
  - Error messages when failures occur

### Backend Infrastructure
- `/api/access-import/scan` - Finds .accdb files
- `/api/access-import/database?path=...` - Lists forms/reports in an Access file
- `/api/access-import/export-form` - Exports form via PowerShell, saves to shared.forms
- `/api/access-import/export-report` - Exports report via PowerShell, saves to shared.reports
- `/api/access-import/history` - Returns import log entries
- `shared.import_log` table - Tracks all import attempts with status/errors

### Form Versioning
- Forms table has `version` INT and `is_current` BOOLEAN columns
- Append-only pattern for history

---

## CloneAccess Features Available for Integration

### High Priority

#### 1. Table Structure Migration
**Files:** `CloneAccess/Migration/migrate_table_structure.ps1`
- Extracts Access table schemas
- Maps Access data types to PostgreSQL
- Handles primary keys, foreign keys, indexes
- **Why:** Can't use forms without the underlying tables

#### 2. Table Data Migration
**Files:** `CloneAccess/Migration/migrate_table_data.ps1`
- Exports data with proper escaping
- Batch processing for large tables
- Handles nulls, dates, special characters
- **Why:** Need actual data, not just structure

#### 3. Query Migration
**Files:** `CloneAccess/skills/query-migration.md`
- 15+ SQL syntax translation patterns
- Access-specific functions → PostgreSQL equivalents
- SELECT queries → Views
- Action queries → Functions
- **Why:** Queries are often the business logic

#### 4. VBA Extraction
**Files:**
- `CloneAccess/skills/migration-vba-to-postgresql.md`
- `CloneAccess/Desktop/VBATranslator.ps1`
- Validator/Executor/Orchestrator decomposition pattern
- **Why:** Even if we don't auto-translate, need to see what code exists

### Medium Priority

#### 5. Database Analysis Tool
**Files:** `CloneAccess/Migration/migration_analyzer.py`
- Scans Access database for compatibility issues
- Identifies: missing PKs, OLE objects, complex VBA, etc.
- Generates migration recommendations
- **Why:** Know what you're getting into before migrating

#### 6. Prose Schema Generation
**Files:** `CloneAccess/Migration/generate_prose_schema.ps1`
- Creates human/LLM-readable descriptions of tables
- Useful for chat context
- **Why:** Enriches the dependency graph

---

## Proposed Implementation Order

### Phase 1: Complete Object Import (Current)
- [x] Form listing and import
- [x] Report listing and import
- [x] Import progress logging
- [ ] Add "Queries" to object type dropdown
- [ ] Add "Modules" (VBA) to object type dropdown (read-only view)

### Phase 2: Table Migration
- [ ] Add "Tables" to object type dropdown
- [ ] Create `migrate_table_structure.ps1` wrapper endpoint
- [ ] Create `migrate_table_data.ps1` wrapper endpoint
- [ ] Show table list with row counts
- [ ] Import selected tables with data
- [ ] Log progress per table

### Phase 3: Query Migration
- [ ] List queries from Access database
- [ ] Show SQL preview for each query
- [ ] Create PostgreSQL view from SELECT queries
- [ ] Flag action queries for manual review
- [ ] Apply translation rules from query-migration.md

### Phase 4: Analysis & Reporting
- [ ] Pre-migration analysis endpoint
- [ ] Compatibility score display
- [ ] Issue list with severity levels
- [ ] Recommendations panel

### Phase 5: VBA Handling
- [ ] Extract VBA modules from Access
- [ ] Display code in viewer
- [ ] Parse for dependencies (which tables/queries referenced)
- [ ] Generate PostgreSQL function stubs

---

## Key Files in PolyAccess

### Backend
- `server/routes/access-import.js` - Import endpoints
- `server/routes/databases.js` - Database switching, object_types
- `server/routes/metadata.js` - Special handling for _access_import schema

### Frontend
- `ui/src/app/views/access_database_viewer.cljs` - Main import UI
- `ui/src/app/views/sidebar.cljs` - Dynamic object types from database
- `ui/src/app/views/main.cljs` - Routes to access viewer when type is :access_databases
- `ui/src/app/state.cljs` - load-access-databases!, load-objects-for-database!

### Database
- `shared.databases` - Has object_types JSONB column
- `shared.forms` - Imported forms with versioning
- `shared.reports` - Imported reports with versioning
- `shared.import_log` - Import attempt history

---

## PowerShell Scripts (in CloneAccess/Migration)

| Script | Purpose | Integrated? |
|--------|---------|-------------|
| list_forms.ps1 | List form names | Yes |
| list_reports.ps1 | List report names | Yes |
| export_form_to_edn.ps1 | Export form definition | Yes |
| export_report_to_edn.ps1 | Export report definition | Yes |
| migrate_table_structure.ps1 | Create PostgreSQL tables | No |
| migrate_table_data.ps1 | Copy data to PostgreSQL | No |
| migrate_access_database.ps1 | Full migration orchestration | No |
| generate_prose_schema.ps1 | LLM-readable schema | No |

---

## Notes

- All PowerShell scripts use COM automation (Access.Application)
- Scripts are called from Node.js via `spawn('powershell.exe', ...)`
- EDN format is used for form/report definitions (Clojure-compatible)
- Access databases must be closed in Access before migration
- Import log helps track multiple attempts on same database

---

## Tomorrow's Starting Point

1. Review this plan
2. Decide priority: Tables? Queries? Analysis?
3. Continue from Phase 1 or jump to Phase 2
4. Test existing import flow with real Access database

The Access Import UI is functional - select "Access Import" database, click an .accdb file, pick forms/reports, import to a target database, watch the log panel.
