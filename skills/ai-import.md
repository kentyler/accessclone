# AI-Assisted Import Skill

This skill enables AI coding agents (Claude Code, Codex, or similar) to drive the Access database import process. It documents two paths: full-pipeline for agents with local machine access, and post-extraction for cloud-sandboxed agents.

## Which Path Are You?

| Capability | Full Pipeline (Claude Code) | Post-Extraction (Codex) |
|---|---|---|
| Shell access to Windows/WSL | Yes | No |
| Can run PowerShell + DAO COM | Yes | No |
| Can read .accdb files | Yes | No |
| Can call server APIs | Yes | Yes (if server accessible) |
| Can read/write project files | Yes | Yes |
| Can run psql | Yes | Maybe (needs credentials) |
| Can modify server code | Yes | Yes |

**Claude Code**: Start at Phase 0. You drive everything.

**Codex**: The human runs Phase 0-1 through the browser UI (click Import). You pick up at Phase 2 — the assessment JSON and scan data will be in `exports/` or passed to you in the task description. Focus on Phase 2 (analysis), Phase 3 (remediation), and Phase 4 (verification).

## Architecture

```
Access .accdb file
    |
[0] SCAN — PowerShell scripts extract metadata (local only)
    |
[1] IMPORT — Server APIs create PG tables, views, forms
    |
[2] ASSESS — Deterministic checks + LLM analysis
    |
[3] REMEDIATE — Fix issues found by assessment
    |
[4] VERIFY — Check data integrity, run tests
```

### Key Files

- PowerShell scripts: `scripts/access/*.ps1`
- Import API routes: `server/routes/access-import/`
- Query converter: `server/lib/query-converter/`
- VBA intent system: `server/lib/vba-intent-mapper.js`, `vba-intent-extractor.js`, `vba-wiring-generator.js`
- Frontend import UI: `ui/src/app/views/access_database_viewer.cljs`
- Assessment endpoint: `server/routes/access-import/assess.js`

## Phase 0: Scan the Access Database (Local Only)

### Prerequisites
- PowerShell with `DAO.DBEngine.120` (comes with Access or Access Database Engine)
- The `.accdb` file (or `.mdb` — will be auto-converted)

### Steps

1. **Scan for databases** (optional — if you already have the path, skip):
```powershell
# From the project root
powershell.exe -File scripts/access/list_tables.ps1 -DatabasePath "C:\path\to\database.accdb"
```

2. **Or use the server API** (server must be running):

`GET /api/access-import/database?path=C:\path\to\database.accdb`

Returns: tables, queries, forms, reports, modules, macros, relationships, accessVersion. Handles AutoExec disabling and .mdb conversion automatically.

3. **Run the assessment**:

`POST /api/access-import/assess`

Body — the scan data from the previous step:
```json
{
  "tables": [{"name": "Orders", "fieldCount": 12, "rowCount": 500}, ...],
  "queries": [{"name": "qryActiveOrders", "type": "Select"}, ...],
  "relationships": [{"name": "OrdersCustomers", "primaryTable": "Customers", "foreignTable": "Orders", "fields": [{"primary": "CustomerID", "foreign": "CustomerID"}]}, ...],
  "modules": [{"name": "modUtilities", "lineCount": 800}, ...],
  "forms": [{"name": "frmOrders"}, ...],
  "reports": [{"name": "rptSales"}, ...]
}
```

Returns grouped findings — structural, design, complexity — plus a summary.

4. **Save assessment for Codex handoff** (optional):

If a cloud agent will handle remediation, write the assessment output plus scan data to `exports/assessment-<dbname>.json`.

## Phase 1: Import Objects

### Import Order (matters)

1. **Tables** first — everything else depends on them
2. **Forms and Reports** — must exist before queries (for `shared.control_column_map` population)
3. **Modules** — VBA source stored, function stubs created
4. **Queries** last — converted to views/functions, may reference all of the above

### API Endpoints

**Import a table:**
```
POST /api/access-import/import-table
{
  "databasePath": "C:\\path\\to\\database.accdb",
  "tableName": "Orders",
  "targetDatabaseId": "<uuid>"
}
```
Returns: `{ success, tableName, fieldCount, rowCount, skippedColumns, calculatedColumns }`

**Import a query (with conversion):**
```
POST /api/access-import/import-query
{
  "databasePath": "C:\\path\\to\\database.accdb",
  "queryName": "qryActiveOrders",
  "targetDatabaseId": "<uuid>"
}
```
Returns: `{ success, queryName, pgObjectType, warnings, llmAssisted, category? }`

- `category: 'missing-dependency'` — retry later (another object must be imported first)
- `category: 'conversion-error'` — needs manual fix or LLM intervention

**Import forms/reports** (export from Access + save to PG):
```
POST /api/access-import/export-forms-batch
{
  "databasePath": "C:\\path\\to\\database.accdb",
  "objectNames": ["frmOrders", "frmCustomers"],
  "targetDatabaseId": "<uuid>"
}
```
Same pattern for `export-reports-batch`, `export-modules-batch`, `export-macros-batch`.

**Create function stubs** (after modules imported, before queries):
```
POST /api/access-import/create-function-stubs
{ "targetDatabaseId": "<uuid>" }
```
Creates placeholder PG functions from VBA declarations so query conversion doesn't fail on undefined function references.

### Query Retry Loop

Queries have dependency ordering. Import all queries, collect failures with `category: 'missing-dependency'`, retry in passes. Stop when a pass makes no progress. Max 20 passes.

```
Pass 1: import all 50 queries → 35 succeed, 15 fail (missing deps)
Pass 2: retry 15 → 10 succeed, 5 fail
Pass 3: retry 5 → 3 succeed, 2 fail
Pass 4: retry 2 → 0 succeed → stop (no progress)
→ 2 queries need manual attention
```

## Phase 2: Assess and Analyze

This is where AI adds value over the deterministic pipeline.

### What the Deterministic Assessment Catches

- **Reserved words**: table/query names that clash with PostgreSQL keywords
- **Wide tables**: >30 columns, possible denormalization
- **Empty tables**: 0 rows with no defined relationships
- **Action queries**: UPDATE/DELETE/INSERT queries that can't be views
- **Missing relationships**: naming-pattern heuristics (e.g., `OrderDetails` likely references `Orders`)
- **Large modules**: >500 lines of VBA
- **Crosstab queries**: need `tablefunc` extension
- **Naming inconsistency**: mixed PascalCase/camelCase/snake_case/spaces

### What the AI Agent Should Investigate

For each finding, the agent can do deeper analysis that the deterministic check cannot:

**Empty tables** — Read the VBA modules for references:
```
grep -i "tblcfousttemp" across all module VBA source
→ Found in modMigrateData line 234: "DoCmd.TransferDatabase acImport, ..."
→ Conclusion: scratch table used by migration code, safe to skip
```

**Wide tables** — Read the column names from PG after import:
```sql
SELECT column_name, data_type FROM information_schema.columns
WHERE table_schema = '<schema>' AND table_name = 'license'
ORDER BY ordinal_position;
```
Look for repeating groups (inspector_1_name, inspector_1_date, inspector_2_name, ...) that indicate denormalization.

**Missing relationships** — Validate with a data check:
```sql
-- Check if tblInspectionData.inspection_id references tblInspection
SELECT COUNT(*) FROM <schema>.tblinspectiondata d
LEFT JOIN <schema>.tblinspection i ON d.inspection_id = i.id
WHERE i.id IS NULL;
-- If 0 orphans → safe to create FK
```

**Crosstab queries** — Read the Access SQL and rewrite:
```sql
-- Access crosstab → PostgreSQL crosstab() or CASE pivot
-- The agent reads the original SQL from the query export and generates the PG equivalent
```

**Large VBA modules** — Analyze structure before translation:
- Count procedures, identify event handlers vs utilities
- Check for dead code (procedures never called)
- Map the call graph (which procedures call which)
- Identify form references to understand data flow

## Phase 3: Remediate

Actions the agent can take based on assessment findings.

### Create Missing Foreign Keys

After confirming data integrity (Phase 2):

```sql
ALTER TABLE <schema>.tblinspectiondata
ADD CONSTRAINT fk_inspectiondata_inspection
FOREIGN KEY (inspection_id) REFERENCES <schema>.tblinspection(id);
```

Use `NOT VALID` if you want to defer validation:
```sql
ALTER TABLE <schema>.tblinspectiondata
ADD CONSTRAINT fk_inspectiondata_inspection
FOREIGN KEY (inspection_id) REFERENCES <schema>.tblinspection(id)
NOT VALID;
```

### Install tablefunc for Crosstab Queries

```sql
CREATE EXTENSION IF NOT EXISTS tablefunc;
```

### Fix Failed Query Conversions

Read the import issues:
```
GET /api/import-issues?database_id=<uuid>
```

For each unresolved conversion error:
1. Read the original Access SQL (from the query export or `shared.import_issues` details)
2. Understand the intent
3. Write the correct PostgreSQL view/function
4. Execute via psql or the `update_query` chat tool

### Normalize Table Names

If the assessment flagged naming inconsistency, the agent can rename:
```sql
ALTER TABLE <schema>."tblCaseData" RENAME TO case_data;
-- Then update all views/functions that reference the old name
```

**Warning**: This cascades — every view, form record-source, and VBA reference must be updated. Only do this if you can update all references.

### Skip Empty Unreferenced Tables

If Phase 2 confirmed a table is unused, simply don't import it. Or if already imported:
```sql
DROP TABLE IF EXISTS <schema>.tblcfousttemp;
```

## Phase 4: Verify

### Data Integrity Checks

```sql
-- Row counts match source
SELECT '<table>', count(*) FROM <schema>.<table>
-- Compare against rowCount from scan data

-- No orphaned foreign keys
SELECT count(*) FROM <schema>.child c
LEFT JOIN <schema>.parent p ON c.parent_id = p.id
WHERE p.id IS NULL;
```

### Object Completeness

```
GET /api/access-import/import-completeness?database_id=<uuid>
```

Returns: `{ complete: bool, missing: { tables: [...], queries: [...], ... }, missing_count }`

### Query Validation

For each imported view:
```sql
SELECT * FROM <schema>.<view_name> LIMIT 1;
```
If it errors, the view has an unresolved dependency or conversion bug.

### Form/Report Validation

```
POST /api/lint/validate
Headers: X-Database-ID: <uuid>
```

Returns aggregated validation results for all forms and reports — missing field bindings, invalid record sources, structural issues.

## PowerShell Scripts Reference

| Script | Purpose | Input | Output |
|--------|---------|-------|--------|
| `list_tables.ps1` | Table names, field counts, row counts | `-DatabasePath` | JSON array |
| `list_queries.ps1` | Query names, types, SQL | `-DatabasePath` | JSON array |
| `list_forms.ps1` | Form names | `-DatabasePath` | JSON array |
| `list_reports.ps1` | Report names | `-DatabasePath` | JSON array |
| `list_modules.ps1` | Module names, line counts, types | `-DatabasePath` | JSON array |
| `list_macros.ps1` | Macro names | `-DatabasePath` | JSON array |
| `list_relationships.ps1` | Relationship definitions | `-DatabasePath` | JSON array |
| `export_table.ps1` | Full table export (schema + data) | `-DatabasePath -TableName` | JSON |
| `export_form.ps1` | Form definition extraction | `-DatabasePath -FormName` | JSON |
| `export_report.ps1` | Report definition extraction | `-DatabasePath -ReportName` | JSON |
| `export_module.ps1` | VBA source code | `-DatabasePath -ModuleName` | JSON |
| `export_macro.ps1` | Macro XML definition | `-DatabasePath -MacroName` | JSON |
| `diagnose_database.ps1` | Pre-flight diagnostic | `-DatabasePath` | JSON |
| `disable_autoexec.ps1` | Disable/restore AutoExec macro | `-DatabasePath [-Restore]` | JSON |
| `convert_mdb.ps1` | Convert .mdb to .accdb | `-DatabasePath` | JSON |

All scripts use `DAO.DBEngine.120` directly (no Access UI). Batch variants exist for forms, reports, modules, macros.

## Gotchas

### AutoExec macros
Always disabled automatically by `GET /api/access-import/database`. If calling PowerShell scripts directly, run `disable_autoexec.ps1` first, restore after.

### PowerShell JSON bugs
`ConvertTo-Json` has known bugs with embedded double quotes in large strings (HTML in memo fields). The `export_table.ps1` script uses a custom `ConvertTo-SafeJson` serializer.

### Form_ and Report_ modules
VBE type 100 modules (class modules behind forms/reports) may be inaccessible under `AutomationSecurity=3`. The export scripts use a design-view fallback — opening the form/report in design view via `DoCmd.OpenForm`/`DoCmd.OpenReport`.

### Query conversion: dependency errors vs real errors
PG errors 42P01 (relation not found) and 42883 (function not found) mean a dependency hasn't been imported yet — retry later. All other errors are conversion bugs that need fixing. The API returns `category: 'missing-dependency'` or `'conversion-error'` to distinguish.

### Import order matters
Tables first. Then forms/reports (to populate `shared.control_column_map`). Then function stubs. Then queries last. Queries reference everything else — importing them first will produce cascading dependency errors.

### CREATE OR REPLACE vs DROP CASCADE
The query importer uses `CREATE OR REPLACE VIEW/FUNCTION` to avoid destroying dependents. If a view's columns changed, it falls back to a targeted `DROP CASCADE` + `CREATE` for just that view. Never do a blanket `DROP CASCADE` on re-import — it destroys views imported earlier in the same pass.

## Related Skills

- `conversion.md` — Manual conversion orchestrator (browser-driven)
- `conversion-tables.md` — Detailed table export documentation
- `conversion-queries.md` — Query converter internals and LLM fallback
- `conversion-forms.md` — Form export transformations
- `conversion-vba.md` — VBA translation pipeline
- `testing.md` — How to run and write tests
