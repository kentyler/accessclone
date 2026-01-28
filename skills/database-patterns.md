# Database Patterns Skill

This skill guides LLMs in creating and modifying PostgreSQL functions for this application.

---

## Conversion Workflow

When converting an MS Access database to PostgreSQL with CloneTemplate:

### Step 1: Ask for Target Name

Before starting, ask the user what the converted database/project should be called.

**Example:**
- Source: `Calculator3.accdb`
- User chooses: `calculator`

The source filename and target name may differ. Don't assume - always ask.

### Step 2: Create PostgreSQL Database

```sql
CREATE DATABASE calculator;
```

### Step 3: Install Infrastructure

Run the infrastructure script to create required tables and functions:

```bash
psql -h localhost -U postgres -d calculator -f server/infrastructure.sql
```

This creates:
- **Tables:** `execution_state`, `app_config`, `migration_log`
- **Functions:** Session management (`create_session`, `clear_session`, etc.), state getters/setters, config functions, migration logging

### Step 4: Create Project Folder

Copy the clonetemplate folder to a new folder with the target name:

```bash
cp -r clonetemplate/ calculator/
```

### Step 5: Update Configuration

Edit `calculator/server/config.js` to set the database name:

```javascript
${process.env.PGDATABASE || 'calculator'}
```

### Step 6: Migrate Components

1. **Tables** - Create tables in PostgreSQL matching Access structure
2. **Queries** - Convert to PostgreSQL views/functions
3. **Forms** - Export from Access using `export_form_to_edn.ps1`, place in `forms/`
4. **VBA Code** - Translate to PostgreSQL functions using session-state pattern

### Naming Convention

| Component | Naming |
|-----------|--------|
| PostgreSQL database | Target name (e.g., `calculator`) |
| Project folder | Target name (e.g., `calculator/`) |
| Forms directory | `calculator/forms/` |

---

## Core Principle

**All state passes through a database table, not function parameters.**

This makes functions simple, consistent, and debuggable. State is explicit and observable.

---

## Infrastructure

### State Table

```sql
CREATE TABLE execution_state (
    session_id uuid,
    var_name text,
    var_value text,
    var_type text,  -- 'text', 'integer', 'numeric', 'boolean', 'date'
    updated_at timestamp DEFAULT now(),
    PRIMARY KEY (session_id, var_name)
);
```

### Helper Functions

```sql
-- Session management
create_session()              -- Returns new uuid
clear_session(uuid)           -- Deletes all state for session

-- Getters
get_state(session, name)          -- Returns text
get_state_int(session, name)      -- Returns integer
get_state_numeric(session, name)  -- Returns numeric
get_state_bool(session, name)     -- Returns boolean
get_state_date(session, name)     -- Returns date

-- Setter
set_state(session, name, value, type)

-- Text normalization
normalize_text(value)    -- NULL → '', trims whitespace
```

---

## Function Patterns

### Standard Function Template

Every function follows this pattern:

```sql
CREATE FUNCTION functionname(p_session uuid)
RETURNS void AS $$
DECLARE
    -- Local variables for calculations
BEGIN
    -- Read inputs from state
    -- Do work
    -- Write outputs to state
END;
$$ LANGUAGE plpgsql;
```

### Naming Conventions

| Prefix | Purpose | Example |
|--------|---------|---------|
| `vba_` | Translated from original application | `vba_calculate_potency()` |
| `util_` | Pure utility (no side effects, can use regular params) | `util_random_number(1, 100)` |
| `entity_` | Entity operations (like class methods) | `invoice_insert()`, `invoice_delete()` |

### Two Function Types

| Type | Pattern | When to Use |
|------|---------|-------------|
| Session-state | `func(p_session uuid)` | Most functions - business logic, data operations |
| Utility | `func(param1, param2)` | Pure calculations, no side effects, no state needed |

Utility functions are clearer for simple calculations:
```sql
-- Utility: direct and readable
v_result := util_random_number(1, 100);

-- vs session-state: indirect
PERFORM set_state(p_session, 'lower', '1', 'integer');
PERFORM set_state(p_session, 'upper', '100', 'integer');
PERFORM vba_random_number(p_session);
v_result := get_state_int(p_session, 'result');
```

---

## Function Decomposition

Break complex operations into three types:

| Type | Purpose | Pattern |
|------|---------|---------|
| **Validator** | Check preconditions | Writes `user_message` to state if problem found |
| **Executor** | Do the actual work | Assumes preconditions met |
| **Orchestrator** | Wire units together | Calls validators, checks state, calls executors |

**Example:**

```sql
-- Validator: check for problems
CREATE FUNCTION validate_recipe(p_session uuid)
RETURNS void AS $$
BEGIN
    IF normalize_text(get_state(p_session, 'recipe_name')) = '' THEN
        PERFORM set_state(p_session, 'user_message', 'Recipe name required', 'text');
    END IF;
END;
$$ LANGUAGE plpgsql;

-- Executor: do the work (assumes validation passed)
CREATE FUNCTION generate_candidates_execute(p_session uuid)
RETURNS void AS $$
BEGIN
    -- actual work here
END;
$$ LANGUAGE plpgsql;

-- Orchestrator: wire together with deterministic logic
CREATE FUNCTION generate_candidates(p_session uuid)
RETURNS void AS $$
BEGIN
    PERFORM validate_recipe(p_session);

    IF get_state(p_session, 'user_message') IS NULL THEN
        PERFORM generate_candidates_execute(p_session);
    END IF;
END;
$$ LANGUAGE plpgsql;
```

**Deterministic decisions stay in code.** LLMs generate functions, not runtime branching.

---

## State Variable Naming

| Purpose | Pattern | Example |
|---------|---------|---------|
| Input parameter | descriptive name | `recipe_id`, `customer_name` |
| Function result | `result_` or descriptive | `result_total`, `calculated_amount` |
| User feedback | `user_message` | Always this name for messages to display |
| Navigation | `navigate_to` | Form/page to show next |
| Confirmation needed | `confirm_required`, `confirm_message` | For dialogs |
| Intermediate value | descriptive | `running_total`, `temp_count` |

---

## NULL vs Empty String

**Normalize to empty string for text fields.**

```sql
-- Normalize when reading
v_name := normalize_text(get_state(p_session, 'name'));

-- Check is simple
IF v_name = '' THEN
    PERFORM set_state(p_session, 'user_message', 'Name required', 'text');
END IF;

-- Concatenation just works
v_full := v_first || ' ' || v_last;
```

| Column Type | Normalize To |
|-------------|--------------|
| Text fields | Empty string `''` |
| Foreign keys | NULL |
| Numbers | NULL or 0 (depends on meaning) |

---

## Common Operations

### INSERT with Getting New ID

```sql
INSERT INTO recipe (recipe_name, created_date)
VALUES (v_name, current_date)
RETURNING id INTO v_new_id;

PERFORM set_state(p_session, 'new_recipe_id', v_new_id::text, 'integer');
```

### Iteration Over Results

```sql
FOR rec IN
    SELECT id, name, amount
    FROM items
    WHERE category_id = get_state_int(p_session, 'category_id')
LOOP
    -- Process each row
    PERFORM set_state(p_session, 'current_item_id', rec.id::text, 'integer');
    PERFORM process_item(p_session);
END LOOP;
```

### Confirmation Dialogs

```sql
-- Function requests confirmation
CREATE FUNCTION delete_record_request(p_session uuid)
RETURNS void AS $$
BEGIN
    PERFORM set_state(p_session, 'confirm_required', 'true', 'boolean');
    PERFORM set_state(p_session, 'confirm_message', 'Delete this record?', 'text');
    PERFORM set_state(p_session, 'confirm_action', 'delete_record', 'text');
END;
$$ LANGUAGE plpgsql;

-- Separate function does the actual delete (called after UI confirms)
CREATE FUNCTION delete_record_execute(p_session uuid)
RETURNS void AS $$
BEGIN
    DELETE FROM some_table WHERE id = get_state_int(p_session, 'record_id');
END;
$$ LANGUAGE plpgsql;
```

---

## Config Settings

```sql
-- Read a setting
v_tax_rate := get_config('tax_rate')::numeric;

-- Set a setting
SELECT set_config('tax_rate', '0.08', 'Default tax rate');
```

---

## Translating Access Queries

When translating queries from MS Access to PostgreSQL:

### Principle: Preserve Behavior, Don't Fix Design

Translation should produce functionally equivalent PostgreSQL code. Design issues are handled separately by a review process - they should **not** block translation.

### What to Preserve (Even If It Looks Wrong)

| Pattern | Action |
|---------|--------|
| Cartesian joins (cross joins) | Preserve - often intentional for generating combinations |
| Redundant columns in SELECT | Preserve - may be used by calling code |
| Unusual WHERE clauses | Preserve - translate literally |
| Inefficient query patterns | Preserve - optimization is separate |
| Nullable columns used oddly | Preserve - add COALESCE/NULLIF as needed |
| Duplicate calculations | Preserve - don't consolidate |

### What to Fix During Translation

| Issue | Action |
|-------|--------|
| Access-specific syntax | Convert to PostgreSQL equivalent |
| `[brackets]` around identifiers | Remove or quote if reserved word |
| `[TempVars]![name]` | Read from session state |
| Access functions (Nz, IIf, etc.) | Convert to PostgreSQL equivalents |
| `True`/`False` literals | Convert to `true`/`false` |
| String concatenation `&` | Convert to `||` |
| Division by zero risk | Add `NULLIF(denominator, 0)` |
| `SELECT *` or `table.*` | Expand to explicit column list |

### Expand SELECT * to Explicit Columns

Do not preserve `SELECT *` or `table.*` in translated queries. Always expand to explicit column names.

**Why:**
- Makes dependencies explicit and visible
- Prevents silent breakage when tables change
- LLMs can see exactly what data flows through
- Easier to modify (add/remove columns intentionally)

**Example - Before:**
```sql
SELECT recipe_candidates_temp.*, recipe.desired_ratio_cannabinoid1
FROM recipe_candidates_temp
INNER JOIN recipe ON ...
```

**Example - After:**
```sql
SELECT
    recipe_candidates_temp.recipe_id,
    recipe_candidates_temp.base_ingredient_id,
    recipe_candidates_temp.base_grams,
    recipe_candidates_temp.candidate_grams,
    -- ... all columns listed explicitly
    recipe.desired_ratio_cannabinoid1
FROM recipe_candidates_temp
INNER JOIN recipe ON ...
```

To get column names for expansion, query the schema:
```sql
SELECT column_name FROM information_schema.columns
WHERE table_name = 'recipe_candidates_temp'
ORDER BY ordinal_position;
```

**Exception - Wrapper functions:**

When a session-state wrapper delegates to a direct-parameter function with an identical `RETURNS TABLE` definition, `SELECT *` is acceptable:

```sql
-- This is OK - wrapper delegates to function with same signature
CREATE FUNCTION my_query(p_session uuid)
RETURNS TABLE (id integer, name varchar) AS $$
DECLARE v_id integer;
BEGIN
    v_id := get_state_int(p_session, 'id');
    RETURN QUERY SELECT * FROM my_query(v_id);  -- OK: same RETURNS TABLE
END;
$$ LANGUAGE plpgsql;
```

The `RETURNS TABLE` definition acts as an explicit contract. This is different from `SELECT *` against a table, where columns could change silently.

### Do NOT Do During Translation

- Rewrite queries to be "better"
- Remove columns that seem unused
- Change join types to fix perceived issues
- Add indexes or constraints
- Normalize denormalized data
- Split complex queries into simpler ones

Design improvements happen in a separate review phase where changes can be evaluated for impact.

---

## Adding New Functions

When asked to create a new function:

1. **Identify inputs** → these come from state
2. **Identify outputs** → these get written to state
3. **Identify side effects** → INSERT/UPDATE/DELETE operations
4. **Check for user feedback** → use `user_message` for errors/info
5. **Decompose if complex** → validator + executor + orchestrator
6. **Choose naming** → `vba_`, `util_`, or entity prefix
7. **Follow the template** → `(p_session uuid) RETURNS void`

---

## Example: Complete Function

**Request:** "Create a function to apply a discount to an invoice"

```sql
CREATE FUNCTION invoice_apply_discount(p_session uuid)
RETURNS void AS $$
DECLARE
    v_invoice_id integer;
    v_discount_percent numeric;
    v_subtotal numeric;
    v_discount_amount numeric;
    v_new_total numeric;
BEGIN
    -- Read inputs
    v_invoice_id := get_state_int(p_session, 'invoice_id');
    v_discount_percent := get_state_numeric(p_session, 'discount_percent');

    -- Validate
    IF v_invoice_id IS NULL THEN
        PERFORM set_state(p_session, 'user_message', 'No invoice selected', 'text');
        RETURN;
    END IF;

    IF v_discount_percent IS NULL OR v_discount_percent < 0 OR v_discount_percent > 100 THEN
        PERFORM set_state(p_session, 'user_message', 'Invalid discount percent', 'text');
        RETURN;
    END IF;

    -- Get current subtotal
    SELECT subtotal INTO v_subtotal
    FROM invoice
    WHERE invoice_id = v_invoice_id;

    -- Calculate
    v_discount_amount := ROUND(v_subtotal * v_discount_percent / 100, 2);
    v_new_total := v_subtotal - v_discount_amount;

    -- Update
    UPDATE invoice
    SET discount_percent = v_discount_percent,
        discount_amount = v_discount_amount,
        total_amount = v_new_total
    WHERE invoice_id = v_invoice_id;

    -- Write results
    PERFORM set_state(p_session, 'discount_amount', v_discount_amount::text, 'numeric');
    PERFORM set_state(p_session, 'new_total', v_new_total::text, 'numeric');
END;
$$ LANGUAGE plpgsql;
```

---

## UI Integration (ClojureScript)

The UI layer:
1. Creates a session: `(create-session)`
2. Sets input state: `(set-state session "invoice_id" "42" "integer")`
3. Calls the function: `(call-function "invoice_apply_discount" session)`
4. Checks for `user_message` → display if present
5. Checks for `confirm_required` → show dialog if true
6. Reads results: `(get-state session "new_total")`
7. Clears session when done: `(clear-session session)`

---

## Form Designer Integration

The CloneTemplate UI includes a visual form designer that generates form definitions as EDN data.

### Form Definition Storage

Forms are stored as EDN files in the `forms/` directory (not in the database):

```
forms/
├── _index.edn           # List of form filenames
├── recipe_calculator.edn
├── ingredient_entry.edn
└── inventory_list.edn
```

This approach:
- Makes forms version-controllable with git
- Allows distribution by copying the forms directory
- Keeps forms separate from runtime data
- Enables LLMs to directly read/write form definitions

Forms are explicitly created via the form designer or LLM assistance - there is no auto-generation from table metadata.

### Form Controls and Data Binding

Form controls can be bound to database fields. When a form loads:

1. Query the record source (table or query)
2. Populate bound controls with field values
3. Track changes in UI state

When saving:

1. Validate using `vba_validate_*` functions
2. If valid, call save function with form data in session state
3. Handle `user_message` for errors

### Button Actions → Function Calls

Form buttons trigger PostgreSQL functions:

```clojure
;; Form button definition
{:type :button
 :caption "Generate Candidates"
 :on-click {:function "vba_generate_candidates"
            :params {:recipe_id :current-record-id}}}
```

```clojure
;; ClojureScript handler
(defn handle-button-click [action current-record]
  (let [session (create-session)]
    ;; Set parameters from action config
    (doseq [[k v] (:params action)]
      (let [value (if (= v :current-record-id)
                    (:id current-record)
                    v)]
        (set-state session (name k) (str value) "integer")))

    ;; Call function
    (call-function (:function action) session)

    ;; Check for user message
    (when-let [msg (get-state session "user_message")]
      (show-message msg))

    ;; Check for navigation
    (when-let [nav (get-state session "navigate_to")]
      (navigate-to nav))

    (clear-session session)))
```

### Field List for Form Designer

The form designer shows available fields from the selected record source:

```sql
-- Get table columns
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public'
AND table_name = 'recipe'
ORDER BY ordinal_position;

-- Get view/function columns (for queries)
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public'
AND table_name = 'ingredient_with_total_grams_on_hand';
```

### See Also

- `CloneTemplate/skills/form-design.md` - Form definition structure and patterns
- `CloneTemplate/ui/README.md` - UI architecture and form designer usage

---

## Access Form Export

Forms can be extracted from Microsoft Access databases and converted to EDN format using the `export_form_to_edn.ps1` script in the Migration folder.

### Usage

```powershell
# Export single form to console
.\export_form_to_edn.ps1 -DatabasePath "C:\path\to\db.accdb" -FormName "FormName"

# Export to file
.\export_form_to_edn.ps1 -DatabasePath "C:\path\to\db.accdb" -FormName "FormName" -OutputPath "output.edn"
```

### Access Control Type Mapping

| Type Code | EDN Type | Description |
|-----------|----------|-------------|
| 100 | `:label` | Static text |
| 101 | `:rectangle` | Shape |
| 102 | `:line` | Line shape |
| 103 | `:image` | Image control |
| 104 | `:button` | Command button |
| 105 | `:option-button` | Radio button |
| 106 | `:check-box` | Checkbox |
| 107 | `:option-group` | Radio button group |
| 109 | `:text-box` | Text input |
| 110 | `:list-box` | List selection |
| 111 | `:combo-box` | Dropdown |
| 112 | `:subform` | Embedded form |
| 114 | `:object-frame` | OLE object |
| 118 | `:page-break` | Page break |
| 122 | `:toggle-button` | Toggle button |
| 123 | `:tab-control` | Tab container |
| 124 | `:page` | Tab page |

### Exported EDN Structure

```clojure
{:id nil
 :name "FormName"
 :type :form
 :caption "Form Title"           ; window title
 :record-source "table_name"     ; or query name
 :default-view "single"          ; "single", "continuous", or "datasheet"
 :form-width 20700               ; twips
 :form-height 10740              ; twips
 :navigation-buttons false       ; show record navigation
 :record-selectors false         ; show record selector
 :allow-additions false          ; can add records
 :allow-deletions false          ; can delete records
 :allow-edits false              ; can edit records
 :scroll-bars :neither           ; :neither, :horizontal, :vertical, :both
 :has-current-event true         ; form has OnCurrent event
 :controls [...]}
```

### Control Properties Captured

**All controls:**
- Position: `:x`, `:y`, `:width`, `:height` (in twips, 1440 twips = 1 inch)
- Font: `:font-name`, `:font-size`, `:font-bold`, `:font-italic`, `:font-underline`
- Colors: `:fore-color`, `:back-color`, `:border-color` (hex RGB like "#404040")
- States: `:enabled`, `:locked`, `:visible` (only if non-default)
- `:tab-index` - tab order

**Data-bound controls (text-box, combo-box, etc.):**
- `:field` - control source (field name or expression like `=[OtherControl]`)
- `:default-value` - default value expression
- `:format` - display format
- `:input-mask` - input mask
- `:validation-rule`, `:validation-text` - validation

**Combo-box / List-box:**
- `:row-source` - SQL query or table name
- `:bound-column` - which column value to store
- `:column-count` - number of columns
- `:column-widths` - widths like "0;2160;2160"
- `:limit-to-list` - must select from list

**Subform:**
- `:source-form` - name of embedded form
- `:link-child-fields` - child linking fields
- `:link-master-fields` - parent linking fields

**Tab control:**
- `:pages` - list of page names
- Child controls have `:parent-page` indicating which tab page they belong to

**Events (flagged as true if present):**
- `:has-click-event`, `:has-dblclick-event`
- `:has-change-event`, `:has-enter-event`, `:has-exit-event`
- `:has-before-update-event`, `:has-after-update-event`
- `:has-gotfocus-event`, `:has-lostfocus-event`

### Notes

- Access uses **twips** for measurements (1440 twips = 1 inch, 567 twips = 1 cm)
- Colors are stored as BGR in Access but converted to RGB hex in export
- Calculated field expressions start with `=` (e.g., `=[Form].[SubformName].[Form].[ControlName]`)
- Event flags indicate VBA code exists - the actual code must be extracted separately
