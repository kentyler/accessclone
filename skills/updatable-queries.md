# Updatable Queries

How AccessClone handles the gap between Access's updatable queries and PostgreSQL's read-only views.

## The Access Behavior

In Access, queries that join tables are often updatable. A form's Record Source can be a query like:

```sql
SELECT Orders.*, OrderStatus.OrderStatusName
FROM Orders INNER JOIN OrderStatus ON Orders.OrderStatusID = OrderStatus.OrderStatusID
```

Users edit fields directly in this query's result set. Access figures out which table each field belongs to and writes to the correct one. This is fundamental to how Access applications work -- nearly every non-trivial form uses a query as its record source to pull in lookup values (status names, customer names, employee names) alongside the editable data.

### Access's Updatability Rules

Access determines whether a query is updatable based on:

- **One-to-many joins**: The "many" side is updatable, the "one" (lookup) side is not
- **Inner joins**: Updatable on both sides if each side has a unique index on the join field
- **Outer joins**: Only the side that returns all rows is updatable
- **Aggregates/DISTINCT/UNION/subqueries**: Not updatable
- **Crosstab queries**: Not updatable
- **Calculated fields**: Never updatable (but other fields in the same query can be)

In practice, the dominant pattern is: one "main" data table joined to several lookup tables for display names. The main table is updatable; the lookup fields are read-only.

## The PostgreSQL Limitation

PostgreSQL only auto-updates "simple" views -- those that SELECT from a single table with no joins, aggregation, DISTINCT, or set operations. Any view with a JOIN is not automatically updatable. Attempting INSERT/UPDATE/DELETE on such a view produces:

```
ERROR: cannot insert into view "qryorder"
DETAIL: Views that do not select from a single table or view are not automatically updatable.
HINT: To enable inserting into the view, provide an INSTEAD OF INSERT trigger.
```

PostgreSQL does support `INSTEAD OF` triggers on views, which could make any view writable. But generating correct triggers for every imported query would be complex and fragile.

## Our Strategy: View Metadata at Import Time

Instead of making views updatable, we identify the main table and its writable columns at import time and store that metadata. At runtime, writes are redirected to the base table, and non-writable fields are visually disabled in forms.

### The `shared.view_metadata` Table

```sql
CREATE TABLE shared.view_metadata (
    database_id VARCHAR(100) NOT NULL,
    view_name   TEXT NOT NULL,
    base_table  TEXT NOT NULL,       -- the "main" table (most columns)
    pk_column   TEXT,                -- primary key of the base table
    writable_columns TEXT[],         -- columns belonging to the base table
    PRIMARY KEY (database_id, view_name)
);
```

Populated at three points:
1. **Query import** (`import-query.js`): after a view is successfully created, `view_column_usage` resolves the base table, PK, and writable columns
2. **Server startup backfill** (`schema.js`): `backfillViewMetadata()` runs in `initializeSchema()` and populates metadata for databases imported before this table existed
3. **Introspection fallback** (`metadata.js`, `data.js`): if `view_metadata` has no entry, the runtime queries `information_schema.view_column_usage` directly

### How Base Table Resolution Works

For each view, we query which base tables contribute columns:

```sql
SELECT table_name, COUNT(*) AS col_count
FROM information_schema.view_column_usage
WHERE view_schema = $1 AND view_name = $2
  AND table_schema = $1 AND table_name != $2
GROUP BY table_name
ORDER BY col_count DESC
LIMIT 1
```

The table with the most columns is the "main" data table. For `qryOrder` in Northwind:

| table_name  | col_count |
|-------------|-----------|
| orders      | 18        |
| orderstatus | 2         |

So `orders` is the base table. Its columns (`orderid`, `customerid`, `employeeid`, `notes`, etc.) are writable. `orderstatusname` from `orderstatus` is read-only.

## Runtime Behavior

### Write-Target Resolution (`data.js`)

On POST/PUT/DELETE to `/api/data/:table`:

1. Check `shared.view_metadata` for a fast lookup (by `database_id` + `view_name`)
2. If found, redirect the write to `base_table`
3. If not found, fall back to `information_schema` introspection
4. Validate columns and PK against the **base table**, not the view
5. Columns from lookup tables are silently stripped (they don't exist on the base table)

Results are cached with a 5-minute TTL.

### PK Detection (`metadata.js`)

`GET /api/queries` returns `isPrimaryKey` and `isWritable` per field:

- `isPrimaryKey: true` for the base table's PK column (e.g. `orderid`)
- `isWritable: true` for columns from the base table, `false` for lookup columns

This lets the frontend's `detect-pk-field` find the right PK (instead of defaulting to `"id"`) so edits go through PUT (update) instead of POST (insert).

### Form UI (`form_view.cljs`)

Controls bound to non-writable fields are:

- **Disabled** -- the control won't accept input (read-only/disabled attribute)
- **Grey background** (`#f0f0f0`) -- visual cue that it's a lookup value
- **Tooltip** -- "(lookup field - read only)" appended to the control's tooltip

Controls bound to writable fields behave normally. Labels, buttons, and controls without a field binding are unaffected.

The writability check happens in `form-view-control`: it looks up the control's field in the record source's field list (via `get-record-source-fields`), checks the `:writable` flag, and passes `field-writable?` into the `effective-edits?` calculation alongside `allow-edits?`, `ctrl-enabled?`, and `ctrl-locked?`.

### Save Without Record Replacement (`state_form.cljs`, `flows/form.cljs`)

After a successful UPDATE, the frontend does NOT replace the in-memory record with the server response. The server's `RETURNING *` only returns base-table columns, which would wipe out lookup values (e.g. `orderstatusname`). Instead:

- **UPDATE**: The user's in-memory `:current-record` (which has all columns including lookups) is synced into the `:records` vector at the current position, and `record-dirty?` is set to false. The server response body is ignored.
- **INSERT**: The server response (with auto-generated PK) is merged into the existing in-memory record, preserving lookup columns while picking up the new PK value.

Both code paths are consistent: the flow-based save (`save-current-record-flow`) and the legacy save (`do-update-record!` / `do-insert-record!`).

### Read Path Unchanged

GET requests still read from the view. The JOIN provides lookup values (status names, etc.) that the form needs to display. Only writes are redirected.

## Known Limitations

### Multiple Writable Tables

Access can sometimes update fields on both sides of a join. Our strategy only writes to the single table with the most columns. If a form needs to write to two tables through one query, only the dominant table's fields will save.

### Views on Views

If a view references another view (not a base table), `view_column_usage` may return the intermediate view rather than the ultimate base table. This would need recursive resolution. Not yet implemented.

### Aggregated/Complex Views

Views with GROUP BY, DISTINCT, UNION, or subqueries aren't updatable in Access either, so this isn't really a gap. But if such a view is used as a form's record source, `resolveWriteTarget` would still try to find a base table -- and might pick something nonsensical.

### INSTEAD OF Triggers

If someone manually creates INSTEAD OF triggers on a view, our redirect would bypass them (we write to the base table, not the view).

## Files

| File | What |
|------|------|
| `server/graph/schema.js` | `shared.view_metadata` DDL, `backfillViewMetadata()` startup migration |
| `server/routes/access-import/import-query.js` | Populates `view_metadata` after each view import |
| `server/routes/data.js` | `resolveWriteTarget()` -- redirects writes to base table |
| `server/routes/metadata.js` | `GET /api/queries` -- adds `isPrimaryKey` and `isWritable` per field |
| `ui/src/app/state.cljs` | `transform-api-field` -- maps `isWritable` to `:writable` |
| `ui/src/app/views/form_view.cljs` | `form-view-control` -- disables + greys out non-writable controls |
| `skills/updatable-queries.md` | This file |

## See Also

- `skills/conversion-queries.md` -- How Access queries become PostgreSQL views
- `skills/form-state-sync.md` -- How form/query cross-references work at runtime
