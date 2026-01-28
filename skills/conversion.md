# Conversion Orchestrator Skill

This skill guides the complete conversion of an MS Access database to a PostgreSQL + CloneTemplate application.

## Overview

Converting an Access database involves multiple phases, each handled by a specialized helper skill. This orchestrator tracks progress and coordinates the workflow.

## Conversion Phases

| Phase | Skill | Description |
|-------|-------|-------------|
| 1. Setup | `conversion-setup.md` | Create database, install infrastructure, create project folder |
| 2. Tables | `conversion-tables.md` | Migrate table structures and data |
| 3. Queries | `conversion-queries.md` | Convert queries to views/functions |
| 4. Forms | `conversion-forms.md` | Export forms to EDN format |
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
- EDN files for each form
- `_index.edn` listing all forms

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
