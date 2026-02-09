# Conversion Orchestrator Skill

This skill guides the complete conversion of an MS Access database to a PostgreSQL + PolyAccess application.

## Overview

Converting an Access database involves multiple phases, each handled by a specialized helper skill. This orchestrator tracks progress and coordinates the workflow.

## Conversion Phases

| Phase | Skill / Tool | Description |
|-------|--------------|-------------|
| 0. Diagnose | `diagnose_database.ps1` | Pre-flight check of the Access database for conversion blockers |
| 1. Setup | `conversion-setup.md` | Create database, install infrastructure, create project folder |
| 2. Tables | `conversion-tables.md` | Migrate table structures and data |
| 3. Queries | `conversion-queries.md` | Convert queries to views/functions |
| 4. Forms | `conversion-forms.md` | Import forms via UI (stored as JSON in PostgreSQL) |
| 5. VBA | `conversion-vba.md` | Translate VBA to PostgreSQL functions |
| 6. Wiring | Manual | Connect forms to functions, test |

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

Inputs needed:
- Source database path
- Target database connection

Outputs:
- All tables created in PostgreSQL
- Data migrated
- Primary keys and indexes created
- Foreign keys created (if defined in Access)

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
