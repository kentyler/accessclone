# Conversion VBA Skill

> **Note**: For frontend VBA→ClojureScript translation, the preferred approach is now the **intent extraction pipeline** — see `skills/intent-extraction.md` and `skills/conversion-vba-cljs.md`. This file documents the **server-side PostgreSQL function** patterns used when VBA logic maps to database-level functions rather than frontend transforms.

Translates VBA code from Access to PostgreSQL functions using the session-state pattern.

## Prerequisites

- Phases 1-4 completed
- Tables, queries exist in PostgreSQL
- Forms exported (events identified)
- Understanding of `database-patterns.md`

## VBA Code Locations in Access

1. **Form Modules** - Code behind forms (event handlers)
2. **Standard Modules** - Shared functions and subs
3. **Class Modules** - Custom classes (rare in Access)
4. **Report Modules** - Code behind reports

## Step 1: Extract VBA Code

Use PowerShell to export VBA modules:

```powershell
$access = New-Object -ComObject Access.Application
$access.OpenCurrentDatabase("C:\path\to\database.accdb")

# Export all modules to text files
$vbProject = $access.VBE.ActiveVBProject
foreach ($component in $vbProject.VBComponents) {
    $name = $component.Name
    $type = $component.Type  # 1=Module, 2=ClassModule, 100=Form
    $code = $component.CodeModule.Lines(1, $component.CodeModule.CountOfLines)

    if ($code.Trim() -ne "") {
        $code | Out-File "vba_export\$name.vba" -Encoding UTF8
        Write-Host "Exported: $name ($type)"
    }
}

$access.CloseCurrentDatabase()
$access.Quit()
```

## Step 2: Analyze VBA Code

For each Sub/Function, identify:

1. **Inputs** - Parameters, form control values, TempVars
2. **Outputs** - Return values, modified controls, TempVars
3. **Side Effects** - Database operations (INSERT/UPDATE/DELETE)
4. **User Interaction** - MsgBox, InputBox, DoCmd operations
5. **Dependencies** - Other functions called

## Step 3: Map to Session-State Pattern

Every VBA function becomes a PostgreSQL function following `database-patterns.md`:

```sql
CREATE FUNCTION vba_function_name(p_session uuid)
RETURNS void AS $$
DECLARE
    -- Local variables
BEGIN
    -- Read inputs from state
    -- Do work
    -- Write outputs to state
END;
$$ LANGUAGE plpgsql;
```

## VBA to PostgreSQL Translation

### Variables

VBA:
```vba
Dim recipeID As Long
Dim recipeName As String
Dim totalAmount As Double
```

PostgreSQL:
```sql
DECLARE
    v_recipe_id integer;
    v_recipe_name text;
    v_total_amount numeric;
```

### Reading Form Values → Session State

VBA:
```vba
recipeID = Me.txtRecipeID
recipeName = Forms!MainForm!txtName
```

PostgreSQL:
```sql
v_recipe_id := get_state_int(p_session, 'recipe_id');
v_recipe_name := get_state(p_session, 'recipe_name');
```

### Writing to Form → Session State

VBA:
```vba
Me.txtTotal = totalAmount
Me.lblMessage.Caption = "Success!"
```

PostgreSQL:
```sql
PERFORM set_state(p_session, 'total', v_total_amount::text, 'numeric');
PERFORM set_state(p_session, 'user_message', 'Success!', 'text');
```

### TempVars → Session State

VBA:
```vba
TempVars!CurrentRecipeID = recipeID
x = TempVars!CurrentRecipeID
```

PostgreSQL:
```sql
PERFORM set_state(p_session, 'CurrentRecipeID', v_recipe_id::text, 'integer');
v_x := get_state_int(p_session, 'CurrentRecipeID');
```

### Conditionals

VBA:
```vba
If recipeID > 0 Then
    DoSomething
ElseIf recipeName <> "" Then
    DoOther
Else
    DoDefault
End If
```

PostgreSQL:
```sql
IF v_recipe_id > 0 THEN
    -- do something
ELSIF v_recipe_name <> '' THEN
    -- do other
ELSE
    -- do default
END IF;
```

### Loops

VBA:
```vba
For i = 1 To 10
    total = total + i
Next i
```

PostgreSQL:
```sql
FOR i IN 1..10 LOOP
    v_total := v_total + i;
END LOOP;
```

VBA (For Each with recordset):
```vba
Dim rs As DAO.Recordset
Set rs = CurrentDb.OpenRecordset("SELECT * FROM ingredient")
Do While Not rs.EOF
    Debug.Print rs!ingredient_name
    rs.MoveNext
Loop
rs.Close
```

PostgreSQL:
```sql
FOR rec IN SELECT * FROM ingredient LOOP
    RAISE NOTICE '%', rec.ingredient_name;
END LOOP;
```

### Database Operations

VBA INSERT:
```vba
CurrentDb.Execute "INSERT INTO ingredient (name) VALUES ('" & ingredientName & "')"
```

PostgreSQL (parameterized - safer):
```sql
INSERT INTO ingredient (name) VALUES (v_ingredient_name);
```

VBA UPDATE:
```vba
CurrentDb.Execute "UPDATE recipe SET name = '" & newName & "' WHERE id = " & recipeID
```

PostgreSQL:
```sql
UPDATE recipe SET name = v_new_name WHERE id = v_recipe_id;
```

### Getting New ID After Insert

VBA:
```vba
CurrentDb.Execute "INSERT INTO recipe (name) VALUES ('New')"
newID = DMax("recipe_id", "recipe")  ' Not reliable!
```

PostgreSQL:
```sql
INSERT INTO recipe (name) VALUES ('New')
RETURNING recipe_id INTO v_new_id;

PERFORM set_state(p_session, 'new_recipe_id', v_new_id::text, 'integer');
```

### DLookup / DCount / DSum / DMax

VBA:
```vba
total = DSum("amount", "recipe_ingredient", "recipe_id = " & recipeID)
name = DLookup("name", "recipe", "recipe_id = " & recipeID)
cnt = DCount("*", "ingredient", "active = True")
```

PostgreSQL:
```sql
SELECT SUM(amount) INTO v_total
FROM recipe_ingredient WHERE recipe_id = v_recipe_id;

SELECT name INTO v_name
FROM recipe WHERE recipe_id = v_recipe_id;

SELECT COUNT(*) INTO v_cnt
FROM ingredient WHERE active = true;
```

### MsgBox → user_message

VBA:
```vba
MsgBox "Recipe saved successfully!", vbInformation
```

PostgreSQL:
```sql
PERFORM set_state(p_session, 'user_message', 'Recipe saved successfully!', 'text');
```

The UI checks `user_message` after each function call and displays it.

### InputBox → Separate Function + UI

VBA InputBox requires user interaction. Split into:

1. Function that requests input (sets `input_required`)
2. UI displays input dialog
3. User enters value, UI sets state
4. Second function processes the input

### Confirmation Dialogs

VBA:
```vba
If MsgBox("Delete this record?", vbYesNo) = vbYes Then
    CurrentDb.Execute "DELETE FROM recipe WHERE id = " & recipeID
End If
```

PostgreSQL (two functions):

```sql
-- Request confirmation
CREATE FUNCTION vba_delete_recipe_request(p_session uuid)
RETURNS void AS $$
BEGIN
    PERFORM set_state(p_session, 'confirm_required', 'true', 'boolean');
    PERFORM set_state(p_session, 'confirm_message', 'Delete this record?', 'text');
    PERFORM set_state(p_session, 'confirm_action', 'vba_delete_recipe_execute', 'text');
END;
$$ LANGUAGE plpgsql;

-- Execute after confirmation
CREATE FUNCTION vba_delete_recipe_execute(p_session uuid)
RETURNS void AS $$
DECLARE
    v_recipe_id integer;
BEGIN
    v_recipe_id := get_state_int(p_session, 'recipe_id');
    DELETE FROM recipe WHERE recipe_id = v_recipe_id;
    PERFORM set_state(p_session, 'user_message', 'Record deleted.', 'text');
END;
$$ LANGUAGE plpgsql;
```

### DoCmd Operations

| VBA DoCmd | PostgreSQL Equivalent |
|-----------|----------------------|
| `DoCmd.OpenForm "X"` | `set_state(session, 'navigate_to', 'X', 'text')` |
| `DoCmd.Close` | `set_state(session, 'close_form', 'true', 'boolean')` |
| `DoCmd.Requery` | UI handles refresh after function returns |
| `DoCmd.GoToRecord , , acNewRec` | `set_state(session, 'new_record', 'true', 'boolean')` |
| `DoCmd.RunSQL "..."` | Execute SQL directly in function |
| `DoCmd.SetWarnings False` | Not needed - no warnings in PostgreSQL functions |

### Error Handling

VBA:
```vba
On Error GoTo ErrorHandler
' ... code ...
Exit Sub

ErrorHandler:
    MsgBox "Error: " & Err.Description
```

PostgreSQL:
```sql
BEGIN
    -- code
EXCEPTION WHEN OTHERS THEN
    PERFORM set_state(p_session, 'user_message', 'Error: ' || SQLERRM, 'text');
END;
```

## Step 4: Decompose Complex Functions

Follow the validator/executor/orchestrator pattern from `database-patterns.md`:

```sql
-- Validator
CREATE FUNCTION vba_save_recipe_validate(p_session uuid) ...

-- Executor
CREATE FUNCTION vba_save_recipe_execute(p_session uuid) ...

-- Orchestrator
CREATE FUNCTION vba_save_recipe(p_session uuid)
RETURNS void AS $$
BEGIN
    PERFORM vba_save_recipe_validate(p_session);
    IF get_state(p_session, 'user_message') IS NULL THEN
        PERFORM vba_save_recipe_execute(p_session);
    END IF;
END;
$$ LANGUAGE plpgsql;
```

## Step 5: Wire Events to Functions

Update form definitions with function calls:

```clojure
{:type :button
 :name "btnSave"
 :caption "Save"
 :has-click-event true
 :on-click {:function "vba_save_recipe"}}
```

## Naming Convention

| VBA Type | PostgreSQL Prefix |
|----------|-------------------|
| Form event handler | `vba_` |
| Utility function | `util_` |
| Entity operation | `entity_` (e.g., `recipe_save`) |

## Logging

Log each VBA translation:

```sql
SELECT log_migration(
    'session-uuid',
    'vba',
    'Form_Recipe_Calculator.btnGenerate_Click',
    'Form_Recipe_Calculator',
    '{"lines": 45, "calls_other": ["GenerateCandidates", "UpdateDisplay"]}'::jsonb,
    '{"function": "vba_generate_candidates", "pattern": "orchestrator"}'::jsonb,
    'CREATE FUNCTION vba_generate_candidates...',
    'completed',
    NULL
);
```

## Common Issues

### Implicit Type Conversion

VBA is loosely typed. PostgreSQL requires explicit casts:
```sql
v_id := v_string_value::integer;
```

### Null Handling

VBA:
```vba
If IsNull(x) Or x = "" Then
```

PostgreSQL:
```sql
IF normalize_text(v_x) = '' THEN
```

### Global Variables

VBA global variables → app_config or session state depending on scope.

### Late Binding / CreateObject

COM automation doesn't exist in PostgreSQL. Identify what these do and find alternatives.

## Outputs

After this phase:
- All VBA functions translated to PostgreSQL
- Form events wired to function calls
- Complex functions decomposed properly
- Error handling in place
- User messages flow through `user_message` state

## Completion

After Phase 5, return to the orchestrator (`conversion.md`) for final verification and testing.
