# Conversion Forms Skill

Phase 4 of the conversion process. Exports Access forms to EDN format for use with CloneTemplate UI.

## Prerequisites

- Phase 1-3 completed
- Access database accessible via COM automation
- Project `forms/` folder exists

## Tools

The form export uses PowerShell scripts in the `Migration/` folder:

- `export_form_to_edn.ps1` - Export single form
- `export_all_forms.ps1` - Batch export all forms

## COM Automation Options

### DAO.DBEngine.120 (Recommended)
More reliable for reading data, works without full Access UI:
```powershell
$daoEngine = New-Object -ComObject DAO.DBEngine.120
$db = $daoEngine.OpenDatabase($DatabasePath)

# Access tables
foreach ($table in $db.TableDefs) {
    if (-not $table.Name.StartsWith("MSys")) {
        Write-Host $table.Name
    }
}

$db.Close()
[System.Runtime.Interopservices.Marshal]::ReleaseComObject($daoEngine)
```

### Access.Application
Required for form design properties (controls, layout):
```powershell
$access = New-Object -ComObject Access.Application
$access.OpenCurrentDatabase($DatabasePath)
$access.DoCmd.OpenForm($FormName, 1)  # 1 = acDesign
$form = $access.Forms[$FormName]
# ... access form properties ...
$access.DoCmd.Close(2, $FormName, 0)  # 2 = acForm
$access.Quit()
```

## Step 1: List All Forms

```powershell
$access = New-Object -ComObject Access.Application
$access.OpenCurrentDatabase("C:\path\to\database.accdb")

foreach ($form in $access.CurrentProject.AllForms) {
    Write-Host $form.Name
}

$access.CloseCurrentDatabase()
$access.Quit()
```

## Step 2: Export Individual Form

```powershell
.\export_form_to_edn.ps1 -DatabasePath "C:\path\to\database.accdb" -FormName "Recipe_Calculator" -OutputPath "forms\Recipe_Calculator.edn"
```

## Step 3: Batch Export All Forms

```powershell
.\export_all_forms.ps1 -DatabasePath "C:\path\to\database.accdb" -OutputFolder "forms"
```

This creates:
- One `.edn` file per form
- `_index.edn` listing all form filenames

## EDN Form Structure

See `form-design.md` for complete details. Basic structure:

```clojure
{:id nil
 :name "Recipe_Calculator"
 :type "form"
 :text "Recipe Calculator"
 :record-source "recipe"
 :default-view "Single Form"
 :header {:height 40
          :controls [...]}
 :detail {:height 30
          :controls [...]}
 :footer {:height 20
          :controls [...]}}
```

## Critical Transformations

### Twips to Pixels
Access stores coordinates in twips (1440 per inch). PolyAccess uses pixels. **Divide by 15**:
```javascript
:x ${Math.round(parseInt(twips) / 15)}
:y ${Math.round(parseInt(twips) / 15)}
:width ${Math.round(parseInt(twips) / 15)}
:height ${Math.round(parseInt(twips) / 15)}
```

### Section Organization
Access controls have a `.Section` property:
- Section 0 = Detail (main body)
- Section 1 = Form Header
- Section 2 = Form Footer

Export must group controls by section:
```clojure
{:header {:height 40 :controls [...]}
 :detail {:height 30 :controls [...]}
 :footer {:height 20 :controls [...]}}
```

### Default View Values
Must match PolyAccess exactly (case-sensitive):
| Access Value | PolyAccess Value |
|--------------|------------------|
| 0 | "Single Form" |
| 1 | "Continuous Forms" |
| 2 | "Datasheet" |

### Type Format
Use string "form" not keyword :form:
```clojure
:type "form"  ; correct
:type :form   ; incorrect
```

### Caption to Text
PolyAccess uses `:text` not `:caption`:
```clojure
:text "Form Title"  ; correct
:caption "..."      ; incorrect
```

### BOM Removal
PowerShell may add UTF-8 BOM. Remove it:
```javascript
result = result.replace(/^\uFEFF/, '');
```

## Control Type Mapping

| Access Type | EDN Type | Notes |
|-------------|----------|-------|
| Label | `:label` | Static text |
| TextBox | `:text-box` | Text input |
| ComboBox | `:combo-box` | Dropdown |
| ListBox | `:list-box` | List selection |
| Button | `:button` | Command button |
| CheckBox | `:check-box` | Boolean |
| OptionButton | `:option-button` | Radio button |
| OptionGroup | `:option-group` | Radio group |
| SubForm | `:subform` | Embedded form |
| TabControl | `:tab-control` | Tab container |
| Rectangle | `:rectangle` | Shape |
| Line | `:line` | Shape |
| Image | `:image` | Static image |

## Properties Captured

### Form Properties
- `:record-source` - Table or query name
- `:default-view` - "Single Form", "Continuous Forms", or "Datasheet" (exact values!)
- Section heights in pixels (converted from twips)
- `:navigation-buttons` - Show record nav
- `:allow-additions`, `:allow-deletions`, `:allow-edits`
- `:scroll-bars` - `:neither`, `:horizontal`, `:vertical`, `:both`

### Control Properties
- Position: `:x`, `:y`, `:width`, `:height`
- Font: `:font-name`, `:font-size`, `:font-bold`, etc.
- Colors: `:fore-color`, `:back-color`, `:border-color` (as hex)
- Data: `:field` (control source), `:default-value`, `:format`
- Events: `:has-click-event`, `:has-change-event`, etc.

### Combo/List Box Specific
- `:row-source` - SQL query or table
- `:bound-column` - Which column's value to use
- `:column-count`, `:column-widths`
- `:limit-to-list`

### Subform Specific
- `:source-form` - Name of child form
- `:link-child-fields`, `:link-master-fields`

## Step 4: Review Exported Forms

After export, review each form for:

1. **Record Source** - Does the table/query exist in PostgreSQL?
2. **Field Bindings** - Do all `:field` values match PostgreSQL columns?
3. **Combo Row Sources** - Are SQL queries valid PostgreSQL?
4. **Subform Links** - Do link fields exist?
5. **Events** - Note which events have VBA code (Phase 5)

## Step 5: Fix Record Sources

Update record sources to match PostgreSQL objects:

Original:
```clojure
{:record-source "qryRecipeIngredients"}
```

If converted to a view:
```clojure
{:record-source "recipe_ingredients"}
```

If converted to a function:
```clojure
{:record-source {:function "get_recipe_ingredients"
                 :params [:current-recipe-id]}}
```

## Step 6: Fix Combo Box Row Sources

Original Access SQL in `:row-source`:
```sql
SELECT ingredient_id, ingredient_name FROM ingredient ORDER BY ingredient_name
```

Convert to valid PostgreSQL. Usually just syntax cleanup:
- Remove brackets: `[ingredient_id]` → `ingredient_id`
- Fix string quotes: `"text"` → `'text'`
- Fix booleans: `True` → `true`

## Step 7: Create _index.edn

The batch export creates this automatically. Format:

```clojure
[
  "Recipe_Calculator.edn"
  "Ingredient_Entry.edn"
  "Product_List.edn"
]
```

This tells the UI which forms are available.

## Standard Button Handlers

PolyAccess recognizes certain button captions and provides built-in functionality:

| Button Text | Action |
|-------------|--------|
| "Close" | Closes the current form tab |

Other buttons show an alert until their VBA is translated.

## Event Handlers

Forms with events need VBA translation (Phase 5). The export flags:
- `:has-click-event true`
- `:has-change-event true`
- `:has-before-update-event true`
- etc.

Map these to function calls:

```clojure
{:type :button
 :name "btnGenerate"
 :caption "Generate"
 :has-click-event true
 ;; After VBA translation, add:
 :on-click {:function "vba_generate_candidates"}}
```

## Logging

Log each form export:

```sql
SELECT log_migration(
    'session-uuid',
    'form',
    'Recipe_Calculator',
    NULL,
    '{"controls": 45, "has_subforms": true}'::jsonb,
    '{"edn_file": "Recipe_Calculator.edn"}'::jsonb,
    NULL,
    'completed',
    'Review: combo box row sources need conversion'
);
```

## Continuous Forms in PolyAccess

Forms with `:default-view "Continuous Forms"` render as a scrollable list:
- Header section displays once at top
- Detail section repeats for each record
- Footer section displays once at bottom
- Clicking a row selects that record
- New records appear at bottom with auto-focus
- Selected row shows live edits

The `:records` array in form-editor state holds all loaded records. The selected row uses `:current-record` for live editing.

### New Record Handling
New records are marked with `:__new__ true` to distinguish from existing records. This ensures:
- INSERT is used instead of UPDATE on save
- Primary key field is included in INSERT (for non-auto-increment PKs)
- Auto-focus triggers on the first text-box

## Common Issues

### Unicode/Special Characters

EDN files should be UTF-8. If Access has special characters, ensure PowerShell exports correctly:
```powershell
$edn | Out-File -FilePath $path -Encoding UTF8
```

### Missing Controls

Some controls may not export correctly:
- ActiveX controls - Manual recreation needed
- OLE objects - May need alternative approach
- Heavily customized controls - Document for manual handling

### Calculated Control Sources

Expressions like `=[Form]![SubForm].[Form]![Total]` need translation to session state reads or function calls.

## Outputs

After this phase:
- `forms/` folder populated with EDN files
- `forms/_index.edn` listing all forms
- Record sources identified for review
- Event handlers flagged for VBA translation

## Next Phase

Proceed to `conversion-vba.md` for Phase 5: VBA Translation.
