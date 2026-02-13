# Form State Sync

## Problem

Access queries can reference live form control values:

```sql
WHERE CategoryID = [Forms]![frmProducts]![cboCategory]
WHERE EmployeeID = [Parent].[EmployeeID]
WHERE Region = TempVars("CurrentRegion")
```

Without a mechanism to supply these values at runtime, converted queries would break or need to become parameterized functions instead of simple views.

## Solution Overview

A two-layer system:

1. **Import time**: A mapping table connects form controls to their underlying table columns. The query converter translates form/TempVar references into subqueries against a runtime state table.
2. **Runtime**: When a user opens a form and navigates records, tagged controls push their values to the state table. Views that reference form state automatically pick up current values.

## Data Flow

```
IMPORT TIME                              RUNTIME
───────────                              ───────

Form saved/imported                      User opens form in View mode
        │                                        │
        ▼                                        ▼
control_column_map populated             build-synced-controls scans
(form_name.control → table.column)       definition for tag="state"
        │                                        │
        ▼                                        ▼
Query imported                           User navigates to a record
        │                                        │
        ▼                                        ▼
convertAccessQuery() runs                Frontend reads tagged control values
        │                                        │
        ▼                                        ▼
translateFormRefs() resolves             PUT /api/form-state sends entries
[Forms]![f]![c] → table.column                   │
via control_column_map lookup                    ▼
        │                                form_control_state rows upserted
        ▼                                (session_id, table_name, column_name, value)
Subquery emitted in SQL:                         │
(SELECT value FROM                               ▼
 shared.form_control_state               Views using subqueries now
 WHERE session_id = ...                  return filtered results
 AND table_name = 'T'
 AND column_name = 'C')
```

## Tables

### shared.control_column_map (populated at import time)

Maps form controls to their underlying data source columns.

```
database_id | form_name    | control_name  | table_name | column_name
────────────┼──────────────┼───────────────┼────────────┼────────────
5           | frmproducts  | cbocategory   | categories | category_id
5           | frmorders    | cbocustomer   | customers  | customer_id
```

**Populated when**: A form or report is saved via `PUT /api/forms` or `PUT /api/reports`. The save endpoint scans the definition for controls with a `:control-source` or `:field` binding and inserts a row mapping `(database_id, form_name, control_name)` → `(table_name, column_name)`.

The `table_name` comes from the form's `:record-source` property. The `column_name` is the control's bound field.

### shared.form_control_state (populated at runtime)

Holds current control values per user session. Keyed by **table and column**, not by form — so two forms bound to the same underlying column share state.

```
session_id | table_name | column_name | value
───────────┼────────────┼─────────────┼──────
abc-123    | categories | category_id | 5
abc-123    | _tempvars  | currentuser | admin
```

**Keyed by table, not form**: This means if `frmProducts.cboCategory` and `frmInventory.cboCategory` both map to `categories.category_id`, writing from either form updates the same row. Queries that filter by `categories.category_id` see the value regardless of which form set it.

**TempVars**: Use the reserved table name `_tempvars` with the variable name as the column name.

## Query Converter: Form Reference Resolution

The converter (`form-state.js`) handles three reference patterns:

### 3-part: `[Forms]![formName]![controlName]`

Exact lookup in `control_column_map` by form name + control name.

```
[Forms]![frmProducts]![cboCategory]
→ looks up frmproducts.cbocategory in mapping
→ finds: table=categories, column=category_id
→ emits: (SELECT value::text FROM shared.form_control_state
          WHERE session_id = current_setting('app.session_id', true)
          AND table_name = 'categories' AND column_name = 'category_id')
```

### 2-part: `[Form]![controlName]` or `[Parent].[controlName]`

Cross-form lookup — searches all mappings for a matching control name (any form).

```
[Parent].[EmployeeID]
→ looks up *.employeeid in mapping
→ finds: table=employees, column=employee_id (from frmEmployees)
→ emits the same subquery pattern
```

### TempVars: `TempVars("varName")` or `[TempVars]![varName]`

Uses reserved table name `_tempvars`.

```
TempVars("CurrentRegion")
→ emits: (SELECT value::text FROM shared.form_control_state
          WHERE session_id = current_setting('app.session_id', true)
          AND table_name = '_tempvars' AND column_name = 'currentregion')
```

### Unresolved references

If a form reference can't be resolved via the mapping (form wasn't imported, or control not bound to a field), the converter emits `NULL` with a SQL comment explaining what was unresolved, and adds a warning.

### referencedStateEntries

The converter returns a `referencedStateEntries[]` array listing all `{tableName, columnName}` pairs that were resolved. This is used by the auto-tag endpoint to mark controls with `tag = 'state'`.

## Import Order Dependency

Forms must be imported **before** queries because:

1. Form import → form save → `control_column_map` populated
2. Query import → `translateFormRefs()` → looks up `control_column_map`

If queries are imported first, form references can't be resolved and fall back to NULL.

The frontend `import-all!` function enforces this order: tables → forms/reports → queries.

## Runtime: Frontend Sync

### On form load (`build-synced-controls`)

Scans the form definition for controls with `tag = "state"`. Returns a map of `{control-name → {:table-name t :column-name c}}` (looked up from `control_column_map`). Stored in the form editor state as `:synced-controls`.

### On record navigate

After loading a new record, the frontend:
1. Iterates `:synced-controls`
2. Reads the current value of each tagged control from the record data
3. Calls `PUT /api/form-state` with all entries at once

### API: PUT /api/form-state

```json
{
  "sessionId": "abc-123",
  "entries": [
    { "tableName": "categories", "columnName": "category_id", "value": "5" },
    { "tableName": "customers", "columnName": "customer_id", "value": "12" }
  ]
}
```

The server runs a multi-row UPSERT (INSERT ... ON CONFLICT UPDATE).

### Session ID

Each API request sets `SET LOCAL app.session_id` on the PG connection before running data queries. This scopes the setting to the current transaction — no leaking across pooled connections. The `current_setting('app.session_id', true)` call in subqueries returns NULL if not set, so queries degrade gracefully.

## Files

| File | Role |
|------|------|
| `server/lib/query-converter/form-state.js` | `translateFormRefs()`, `translateTempVars()`, `resolveControlMapping()` |
| `server/lib/query-converter/ddl.js` | `resolveParams()` filters out DAO params that are actually form/parent refs |
| `server/routes/access-import/import-query.js` | Loads `control_column_map`, passes to converter |
| `server/routes/form-state.js` | `PUT /api/form-state` endpoint |
| `server/routes/forms.js` | Populates `control_column_map` on form save |
| `server/routes/reports.js` | Populates `control_column_map` on report save |
| `ui/src/app/state_form.cljs` | `build-synced-controls`, sync on navigate |
| `ui/src/app/views/form_view.cljs` | Control change triggers individual sync |
