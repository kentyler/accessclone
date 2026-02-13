# Conversion Queries Skill

Phase 3 of the conversion process. Converts Access queries to PostgreSQL views and functions.

## Prerequisites

- Phase 2 (Tables) completed
- All tables exist in PostgreSQL
- Access database accessible

## Query Types in Access

| Access Type | PostgreSQL Equivalent |
|-------------|----------------------|
| Select Query | View or Function |
| Parameter Query | Function with parameters |
| Crosstab Query | View with crosstab extension or function |
| Make-Table Query | Function that creates table |
| Append Query | Function with INSERT |
| Update Query | Function with UPDATE |
| Delete Query | Function with DELETE |

## Step 1: Extract Query Definitions

Use PowerShell to read Access queries:

```powershell
$access = New-Object -ComObject Access.Application
$access.OpenCurrentDatabase("C:\path\to\database.accdb")
$db = $access.CurrentDb()

foreach ($query in $db.QueryDefs) {
    if (-not $query.Name.StartsWith("~")) {
        Write-Host "=== $($query.Name) ==="
        Write-Host $query.SQL
        Write-Host ""
    }
}

$access.CloseCurrentDatabase()
$access.Quit()
```

## Step 2: Classify Each Query

For each query, determine:
1. Is it a SELECT or action query?
2. Does it have parameters?
3. Does it reference TempVars?
4. Does it use Access-specific functions?

## Step 3: Convert Simple SELECT Queries to Views

Access:
```sql
SELECT ingredient.ingredient_name, ingredient_type.type_name
FROM ingredient INNER JOIN ingredient_type
ON ingredient.ingredient_type_id = ingredient_type.ingredient_type_id
WHERE ingredient.active = True;
```

PostgreSQL View:
```sql
CREATE OR REPLACE VIEW active_ingredients AS
SELECT
    ingredient.ingredient_name,
    ingredient_type.type_name
FROM ingredient
INNER JOIN ingredient_type
    ON ingredient.ingredient_type_id = ingredient_type.ingredient_type_id
WHERE ingredient.active = true;
```

## Step 4: Convert Parameter Queries to Functions

Access query with parameter `[Enter Recipe ID]`:
```sql
SELECT * FROM recipe_ingredient WHERE recipe_id = [Enter Recipe ID];
```

PostgreSQL function (two versions):

**Direct parameter version:**
```sql
CREATE OR REPLACE FUNCTION get_recipe_ingredients(p_recipe_id integer)
RETURNS TABLE (
    ingredient_id integer,
    ingredient_name varchar,
    amount numeric
) AS $$
    SELECT ingredient_id, ingredient_name, amount
    FROM recipe_ingredient
    WHERE recipe_id = p_recipe_id;
$$ LANGUAGE sql;
```

**Session-state wrapper:**
```sql
CREATE OR REPLACE FUNCTION get_recipe_ingredients(p_session uuid)
RETURNS TABLE (
    ingredient_id integer,
    ingredient_name varchar,
    amount numeric
) AS $$
DECLARE
    v_recipe_id integer;
BEGIN
    v_recipe_id := get_state_int(p_session, 'recipe_id');
    RETURN QUERY SELECT * FROM get_recipe_ingredients(v_recipe_id);
END;
$$ LANGUAGE plpgsql;
```

## Step 5: Convert TempVar References

Access TempVars become session state:

Access:
```sql
SELECT * FROM recipe WHERE recipe_id = [TempVars]![CurrentRecipeID]
```

PostgreSQL:
```sql
CREATE OR REPLACE FUNCTION current_recipe(p_session uuid)
RETURNS TABLE (...) AS $$
BEGIN
    RETURN QUERY
    SELECT * FROM recipe
    WHERE recipe_id = get_state_int(p_session, 'CurrentRecipeID');
END;
$$ LANGUAGE plpgsql;
```

## Step 6: Convert Access Functions

| Access Function | PostgreSQL Equivalent |
|-----------------|----------------------|
| `Nz(x, default)` | `COALESCE(x, default)` |
| `IIf(cond, t, f)` | `CASE WHEN cond THEN t ELSE f END` |
| `IsNull(x)` | `x IS NULL` |
| `Trim(x)` | `TRIM(x)` |
| `Left(x, n)` | `LEFT(x, n)` |
| `Right(x, n)` | `RIGHT(x, n)` |
| `Mid(x, s, n)` | `SUBSTRING(x FROM s FOR n)` |
| `Len(x)` | `LENGTH(x)` |
| `InStr(x, y)` | `POSITION(y IN x)` |
| `DateSerial(y,m,d)` | `make_date(y, m, d)` |
| `DateAdd("d", n, d)` | `d + INTERVAL 'n days'` |
| `DateDiff("d", d1, d2)` | `d2 - d1` (returns integer) |
| `Format(x, "fmt")` | `to_char(x, 'fmt')` |
| `Val(x)` | `x::numeric` (with error handling) |
| `Round(x, n)` | `ROUND(x, n)` |
| `Int(x)` | `FLOOR(x)` |
| `True` / `False` | `true` / `false` |
| `& (concat)` | `||` |
| `[Forms]![x]![y]` | Session state |

## Step 7: Convert Action Queries

### Append Query → INSERT Function

Access:
```sql
INSERT INTO archive_table SELECT * FROM current_table WHERE date < #1/1/2024#;
```

PostgreSQL:
```sql
CREATE OR REPLACE FUNCTION archive_old_records(p_session uuid)
RETURNS void AS $$
DECLARE
    v_cutoff_date date;
BEGIN
    v_cutoff_date := get_state_date(p_session, 'cutoff_date');

    INSERT INTO archive_table
    SELECT * FROM current_table WHERE date < v_cutoff_date;
END;
$$ LANGUAGE plpgsql;
```

### Update Query → UPDATE Function

Access:
```sql
UPDATE product SET price = price * 1.1 WHERE category = [TempVars]![SelectedCategory];
```

PostgreSQL:
```sql
CREATE OR REPLACE FUNCTION increase_prices(p_session uuid)
RETURNS integer AS $$
DECLARE
    v_category text;
    v_count integer;
BEGIN
    v_category := get_state(p_session, 'SelectedCategory');

    UPDATE product SET price = price * 1.1
    WHERE category = v_category;

    GET DIAGNOSTICS v_count = ROW_COUNT;
    PERFORM set_state(p_session, 'rows_updated', v_count::text, 'integer');
    RETURN v_count;
END;
$$ LANGUAGE plpgsql;
```

### Delete Query → DELETE Function

Similar pattern to UPDATE.

## Important: Preserve Behavior

From `database-patterns.md`:

> Translation should produce functionally equivalent PostgreSQL code. Design issues are handled separately by a review process - they should **not** block translation.

Do NOT:
- Rewrite queries to be "better"
- Remove columns that seem unused
- Change join types
- Fix perceived inefficiencies

DO:
- Translate syntax accurately
- Expand `SELECT *` to explicit columns
- Add `NULLIF(x, 0)` for division
- Convert Access functions to PostgreSQL equivalents

## Automated Pipeline

The UI's "Import All" button handles query conversion automatically:

1. **Export**: PowerShell `export_query.ps1` extracts the Access SQL and parameters via DAO
2. **Convert**: `convertAccessQuery()` (regex-based) translates Access SQL → PostgreSQL DDL
3. **Execute**: Runs the DDL in a transaction to create the view/function
4. **LLM Fallback**: If the regex-converted SQL fails, sends the original Access SQL + PG error + schema context to Claude for a corrected conversion (see below)
5. **Log**: Records success/failure and any warnings in `shared.import_log` and `shared.import_issues`

### LLM Fallback (`server/lib/query-converter/llm-fallback.js`)

The regex converter handles ~90% of queries, but Access SQL has many edge cases. When the converted SQL fails execution:

```
Regex-converted SQL
    ↓
Execute in transaction
    ├── Success → commit, done
    └── Failure → rollback
            ↓
        Send to Claude with context:
        - Original Access SQL
        - Failed PostgreSQL SQL
        - PostgreSQL error message
        - Full schema (tables, views, columns, types)
        - Available PG functions (including VBA stubs)
        - Form control → table.column mapping
            ↓
        Execute LLM result in transaction
            ├── Success → commit (flagged as "LLM-assisted")
            └── Failure → report both errors
```

LLM-assisted conversions are flagged in the import log (`llmAssisted: true`) and create an import issue with category `llm-assisted` for review.

If no Anthropic API key is configured, the fallback is skipped and the original error is returned.

### Form State References

Queries that reference form controls (e.g., `[Forms]![frmProducts]![cboCategory]`) are converted to subqueries against `shared.form_control_state`. See `form-state-sync.md` for full details.

**Import order matters**: forms must be imported before queries so that `shared.control_column_map` is populated for form reference resolution.

## Logging

Log each query conversion:

```sql
SELECT log_migration(
    'session-uuid',
    'query',
    'recipe_ingredients_totals',
    NULL,
    '{"access_sql": "SELECT ..."}'::jsonb,
    '{"pg_type": "view"}'::jsonb,
    'CREATE VIEW recipe_ingredients_totals AS ...',
    'completed',
    NULL
);
```

## Outputs

After this phase:
- Simple queries → Views
- Parameter queries → Functions (both direct and session-state versions)
- Action queries → Functions
- All Access-specific syntax converted

## Next Phase

Proceed to `conversion-forms.md` for Phase 4: Form Export.
