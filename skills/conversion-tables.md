# Conversion Tables Skill

Phase 2 of the conversion process. Migrates table structures and data from Access to PostgreSQL.

## Prerequisites

- Phase 1 (Setup) completed
- Access database accessible via COM automation (Windows/PowerShell)
- PostgreSQL database ready

## Data Type Mapping

| Access Type | PostgreSQL Type | Notes |
|-------------|-----------------|-------|
| Text(n) | varchar(n) | Or text for unlimited |
| Memo | text | Long text |
| Number (Byte) | smallint | |
| Number (Integer) | smallint | Access Integer = 2 bytes |
| Number (Long Integer) | integer | |
| Number (Single) | real | |
| Number (Double) | double precision | |
| Number (Decimal) | numeric(p,s) | |
| Currency | numeric(19,4) | |
| AutoNumber | serial | Or bigserial |
| Yes/No | boolean | |
| Date/Time | timestamp | Or date/time if appropriate |
| OLE Object | bytea | Binary data |
| Hyperlink | text | |
| Attachment | bytea | Consider separate table |
| Calculated | (skip) | Recreate as view/computed |

## Step 1: Extract Table Definitions

Use PowerShell to read Access table structure:

```powershell
$access = New-Object -ComObject Access.Application
$access.OpenCurrentDatabase("C:\path\to\database.accdb")
$db = $access.CurrentDb()

foreach ($table in $db.TableDefs) {
    if (-not $table.Name.StartsWith("MSys") -and -not $table.Name.StartsWith("~")) {
        Write-Host "Table: $($table.Name)"
        foreach ($field in $table.Fields) {
            Write-Host "  $($field.Name): Type=$($field.Type), Size=$($field.Size)"
        }
    }
}

$access.CloseCurrentDatabase()
$access.Quit()
```

Access field type codes:
| Code | Type |
|------|------|
| 1 | Yes/No |
| 2 | Byte |
| 3 | Integer |
| 4 | Long |
| 5 | Currency |
| 6 | Single |
| 7 | Double |
| 8 | Date/Time |
| 10 | Text |
| 11 | OLE Object |
| 12 | Memo |
| 15 | GUID |
| 16 | BigInt |

## Step 2: Generate CREATE TABLE Statements

For each table, generate PostgreSQL DDL:

```sql
CREATE TABLE ingredient (
    ingredient_id serial PRIMARY KEY,
    ingredient_name varchar(255) NOT NULL,
    ingredient_type_id integer REFERENCES ingredient_type(ingredient_type_id),
    created_date timestamp DEFAULT CURRENT_TIMESTAMP,
    notes text
);
```

### Naming Conventions

- Convert to lowercase with underscores: `IngredientType` → `ingredient_type`
- Or preserve original names in quotes: `"IngredientType"`
- Be consistent throughout the project

### Primary Keys

- AutoNumber fields → `serial PRIMARY KEY`
- Composite keys → `PRIMARY KEY (col1, col2)`

### Foreign Keys

Add after all tables are created to avoid ordering issues:

```sql
ALTER TABLE ingredient
ADD CONSTRAINT fk_ingredient_type
FOREIGN KEY (ingredient_type_id) REFERENCES ingredient_type(ingredient_type_id);
```

## Step 3: Migrate Data

### Option A: Export to CSV, Import to PostgreSQL

From Access (VBA or PowerShell):
```powershell
$access.DoCmd.TransferText(2, "", "TableName", "C:\export\tablename.csv", $true)
```

To PostgreSQL:
```sql
\copy tablename FROM 'C:\export\tablename.csv' WITH (FORMAT csv, HEADER true);
```

### Option B: Direct Insert via ODBC

Use a migration script that reads from Access and inserts to PostgreSQL.

### Option C: Use Migration Tool

Tools like pgloader can automate the process.

## Step 4: Verify Migration

```sql
-- Check row counts match
SELECT 'ingredient' as table_name, COUNT(*) as row_count FROM ingredient
UNION ALL
SELECT 'product', COUNT(*) FROM product
UNION ALL
-- ... etc
ORDER BY table_name;
```

Compare with Access row counts.

## Step 5: Create Indexes

```sql
-- Indexes on foreign keys
CREATE INDEX idx_ingredient_type_id ON ingredient(ingredient_type_id);

-- Indexes on frequently queried columns
CREATE INDEX idx_ingredient_name ON ingredient(ingredient_name);
```

## Logging

Log each table migration:

```sql
SELECT log_migration(
    'session-uuid-here',
    'table',
    'ingredient',
    NULL,
    '{"access_rows": 150}'::jsonb,
    '{"pg_rows": 150}'::jsonb,
    'CREATE TABLE ingredient (...)',
    'completed',
    NULL
);
```

## Common Issues

### Character Encoding

Access uses Windows-1252, PostgreSQL prefers UTF-8. Convert during export:
```powershell
Get-Content file.csv -Encoding Default | Set-Content file_utf8.csv -Encoding UTF8
```

### Date Format Issues

Access dates may need parsing. Use PostgreSQL's flexible date parsing or convert in export.

### NULL vs Empty String

Access often stores empty strings where NULL would be appropriate. Decide per-column whether to convert.

### Calculated Fields

Skip calculated fields in table definition. Recreate the logic as:
- A view (if based on same table)
- A function call
- A generated column (PostgreSQL 12+)

## Outputs

After this phase:
- All tables created in PostgreSQL
- All data migrated
- Row counts verified
- Indexes created
- Foreign keys established

## Next Phase

Proceed to `conversion-queries.md` for Phase 3: Query Conversion.
