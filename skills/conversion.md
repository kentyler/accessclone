# Conversion Orchestrator Skill

This skill guides the complete conversion of an MS Access database to a PostgreSQL + AccessClone application.

## Overview

Converting an Access database involves multiple phases, each handled by a specialized helper skill. This orchestrator tracks progress and coordinates the workflow.

## AutoExec Warning

**Before opening any Access database via COM automation**, check if it has an AutoExec macro. If it does, rename it to "xAutoExec" first — otherwise the macro will fire on open, potentially showing a login dialog or running startup code that hangs the PowerShell process. Rename it back after conversion is complete.

## Conversion Phases

| Phase | Skill / Tool | Description |
|-------|--------------|-------------|
| 0. Diagnose | `diagnose_database.ps1` | Pre-flight check of the Access database for conversion blockers |
| 1. Setup | `conversion-setup.md` | Create database, install infrastructure, create project folder |
| 2. Tables | `conversion-tables.md` | Migrate table structures and data |
| 3. Queries | `conversion-queries.md` | Convert queries to views/functions |
| 4. Forms | `conversion-forms.md` | Import forms via UI (stored as JSON in PostgreSQL) |
| 5. VBA | `conversion-vba.md` | Translate VBA to PostgreSQL functions |
| 6. Macros | `conversion-macros.md` | Import macros for viewing, analysis, and translation |
| 7. Wiring | Manual | Connect forms to functions, test |

## Starting a Conversion

### Step 1: Ask for Target Name

**Always ask first.** The target name determines:
- PostgreSQL database name
- Project folder name
- All subsequent references

```
User wants to convert: Calculator3.accdb
Ask: "What should the converted database/project be called?"
User answers: "calculator"
```

### Step 2: Record Conversion State

Track the conversion in a simple structure:

```
Conversion: calculator
Source: C:\path\to\Calculator3.accdb
Status: in_progress

Phases:
  [x] Setup - completed
  [x] Tables - completed (17 tables)
  [ ] Queries - in progress (12/24 done)
  [ ] Forms - pending
  [ ] VBA - pending
```

### Step 3: Execute Phases in Order

For each phase:
1. Announce which phase is starting
2. Delegate to the helper skill
3. Record completion status
4. Handle any errors before proceeding

### Critical: Import Everything Before Translation

**Do NOT attempt to translate VBA modules, macros, or form code-behind until ALL objects discovered in the Access database have been imported into the target.** This is a hard rule. The check is simple: compare what the discovery scan found against what exists in the target database. If anything is missing, do not translate.

Without the full picture, the LLM guesses at query logic and produces incorrect, insecure code — fabricated SQL, string concatenation instead of parameterized queries, calls to non-existent endpoints. This was confirmed empirically: translating modules before queries were imported produced code that couldn't work.

Import order (dependencies flow downward):
1. Tables (no dependencies)
2. Queries (depend on tables)
3. Forms & Reports (reference tables and queries)
4. Modules & Macros (reference all of the above)
5. Translation (requires ALL of the above imported first)

**Planned**: The app should enforce this automatically — block translation in the chat panel until import completeness is verified, showing a clear message listing what's still missing.

## Phase Details

### Phase 0: Diagnose

Run the pre-conversion diagnostic against the live Access database:

```powershell
.\scripts\access\diagnose_database.ps1 -DatabasePath "C:\path\to\database.accdb" -OutputPath "C:\path\to\report.json"
```

The script opens the .accdb via COM and runs 12 checks:

| Check | Severity | What It Detects |
|-------|----------|-----------------|
| `tables-without-pk` | error | Tables missing primary keys — form editor can't do updates |
| `duplicate-candidate-keys` | warning | Columns in no-PK tables that have duplicates — can't be natural PK |
| `empty-tables` | warning | Tables with 0 rows |
| `problematic-data-types` | error/warning | OLE Object, Attachment, Calculated fields |
| `reserved-word-conflicts` | warning | Table/column names that are PostgreSQL reserved words |
| `case-collision-columns` | error | Columns that collide when lowercased (PG folds case) |
| `complex-queries` | warning/info | Action queries, Access-specific SQL functions, parameterized queries |
| `form-complexity` | warning/info | Subforms, VBA event counts, unbound forms, large control counts |
| `report-complexity` | warning/info | Subreports, report events, deep grouping |
| `vba-modules` | warning/info | Code size, external dependencies (COM, file I/O, email) |
| `relationship-issues` | error/info | Missing referenced tables, FK inventory |
| `size-and-scale` | warning/info | Very large tables, file size, total inventory |

**Output** is a JSON report with `summary`, `inventory`, `checks`, and `findings` arrays. Feed the report to the LLM to get a prioritized action plan before starting Phase 1.

**How to use the results:**

1. **Errors must be resolved** — these will block the conversion or cause broken behavior
2. **Warnings should be reviewed** — plan workarounds before starting
3. **Info items are awareness** — no action required but useful context

Example workflow:
```
User: "Convert Calculator3.accdb"
→ Run diagnose_database.ps1
→ LLM reads report JSON, summarizes: "3 tables missing PKs, 2 forms with subforms, 1 module with 400 lines of VBA"
→ User addresses blockers (or acknowledges workarounds)
→ Proceed to Phase 1
```

### Phase 1: Setup

Delegate to `conversion-setup.md`

Inputs needed:
- Target name (e.g., `calculator`)
- Source database path

Outputs:
- PostgreSQL database created
- Infrastructure installed
- Project folder created
- Git repository initialized (+ pushed to cloud if chosen)
- Config updated

### Phase 2: Tables

Delegate to `conversion-tables.md`

**Automated path (preferred):** Use the Access Database Viewer UI — select tables, pick target database, click Import. The server-side pipeline (`POST /api/access-import/import-table`) handles extraction, type mapping, table creation, data insertion, and index creation in one transaction.

**Manual path (fallback):** Follow the step-by-step instructions in `conversion-tables.md`.

Inputs needed:
- Source database path
- Target database connection (or target database selected in UI)

Outputs:
- All tables created in PostgreSQL
- Data migrated
- Primary keys and indexes created
- Foreign keys need to be added manually (not yet part of automated import)

### Phase 3: Queries

Delegate to `conversion-queries.md`

Inputs needed:
- Source database path (to read query definitions)
- Target database connection

Outputs:
- Simple SELECT queries → Views
- Parameterized queries → Functions
- Action queries → Functions

### Phase 4: Forms

Delegate to `conversion-forms.md`

Inputs needed:
- Source database path
- Target project forms/ folder

Outputs:
- Forms stored as JSON in `shared.forms` PostgreSQL table
- Each form versioned with append-only history

### Phase 5: VBA

Delegate to `conversion-vba.md`

Inputs needed:
- Source database path (to read VBA modules)
- Target database connection
- Existing function signatures (to avoid duplicates)

Outputs:
- PostgreSQL functions following session-state pattern
- Event handlers mapped to function calls

### Phase 6: Macros

Delegate to `conversion-macros.md`

Inputs needed:
- Source database path
- Target database configured in AccessClone
- AutoExec renamed to xAutoExec (if present)

Outputs:
- Macros stored in `shared.macros` with raw XML definitions
- LLM auto-analysis of each macro's structure and purpose
- Optional ClojureScript translations (via chat panel)

## Error Handling

When a phase fails:
1. Record the error and which object failed
2. Ask user: retry, skip, or abort?
3. If skip: mark object as "needs manual review"
4. Continue with next object or phase

## Resuming a Conversion

If a conversion was interrupted:
1. Check what phases are complete
2. Check for partially completed phases
3. Resume from last incomplete item

## Completion Checklist

Before marking conversion complete:

- [ ] All tables migrated
- [ ] All queries converted (or marked for manual review)
- [ ] All forms exported
- [ ] All VBA translated (or marked for manual review)
- [ ] All macros imported and analyzed
- [ ] Server starts without errors
- [ ] Can connect to database from UI
- [ ] At least one form renders correctly
- [ ] At least one function executes correctly

## Related Skills

- `database-patterns.md` - How to write PostgreSQL functions
- `form-design.md` - Form structure and control types
- `conversion-setup.md` - Phase 1 details
- `conversion-tables.md` - Phase 2 details
- `conversion-queries.md` - Phase 3 details
- `conversion-forms.md` - Phase 4 details
- `conversion-vba.md` - Phase 5 details
- `conversion-macros.md` - Phase 6 details
