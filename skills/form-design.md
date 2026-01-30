# Form Design Skill

This skill guides LLMs in creating and modifying form definitions for PolyAccess (formerly CloneTemplate).

## Current Implementation Status

The form editor now includes:
- **Design View**: Visual editor with drag-drop field placement
- **Form View**: Live data entry mode with record navigation
- **Access-style Property Sheet**: Tabbed interface (Format, Data, Event, Other, All)
- **Record Navigation**: First/Prev/Next/Last/New buttons with record counter
- **Auto-save**: Records save automatically when navigating or switching forms
- **CRUD Operations**: Create, read, update records against PostgreSQL

## Core Concept

Forms are defined as data (EDN), not code. Forms are explicitly created via:
- The visual form designer (drag fields, position controls)
- LLM assistance (describe what you want, get a form definition)

There is no auto-generation from table metadata - all forms are intentionally designed and saved.

## File Storage

Forms are stored as EDN files in the `forms/` directory:

```
CloneTemplate/
├── forms/
│   ├── _index.edn           # List of form filenames to load
│   ├── recipe_calculator.edn
│   ├── ingredient_entry.edn
│   └── ...
```

The `_index.edn` file lists all forms to load:

```clojure
["recipe_calculator"
 "ingredient_entry"
 "inventory_list"]
```

Each form file contains a complete form definition:

```clojure
{:id 1
 :name "Recipe Calculator"
 :type :form
 :record-source "recipe"
 :default-view "single"
 :controls [...]}
```

When distributing the app, include the entire `forms/` directory.

---

## Form Definition Structure

```clojure
{:type :form
 :record-source "table_or_query_name"  ; Data source
 :default-view "single"                 ; single or continuous
 :controls [...]}                       ; Array of control definitions
```

### Two Form Types Only

| Type | Purpose | Data Loading |
|------|---------|--------------|
| `single` | Edit one record | Fetch by ID, one record at a time |
| `continuous` | List of records | Paginated, server-side paging |

No datasheet mode - that's spreadsheet complexity we don't need.

### Control Types

| Type | Purpose | Key Properties |
|------|---------|----------------|
| `:text-box` | Data entry field | `:field` (bound column) |
| `:label` | Static text | `:text` |
| `:button` | Action trigger | `:caption`, `:on-click` |
| `:combo-box` | Dropdown selection | `:field`, `:row-source` |
| `:list-box` | Multi-select list | `:field`, `:row-source` |
| `:check-box` | Boolean toggle | `:field` |
| `:subform` | Embedded child form | `:source-form`, `:link-fields` |

### Control Properties

All controls have:

```clojure
{:type :text-box
 :x 20          ; Pixels from left
 :y 40          ; Pixels from top
 :width 150     ; Width in pixels
 :height 24     ; Height in pixels

 ;; Type-specific:
 :field "column_name"  ; For bound controls
 :text "Label Text"    ; For labels
 :caption "Click Me"   ; For buttons
 }
```

---

## Standard Form Patterns

### Data Entry Form

Simple form for editing a single record:

```clojure
{:type :form
 :record-source "recipe"
 :default-view "single"
 :controls
 [{:type :label :text "Recipe Name" :x 20 :y 20 :width 100 :height 18}
  {:type :text-box :field "name" :x 20 :y 40 :width 200 :height 24}

  {:type :label :text "Description" :x 20 :y 80 :width 100 :height 18}
  {:type :text-box :field "description" :x 20 :y 100 :width 300 :height 60}

  {:type :button :caption "Save" :x 20 :y 180 :width 80 :height 30
   :on-click :save-record}
  {:type :button :caption "Cancel" :x 110 :y 180 :width 80 :height 30
   :on-click :cancel}]}
```

### Master-Detail Form

Parent form with embedded child records:

```clojure
{:type :form
 :record-source "recipe"
 :default-view "single"
 :controls
 [{:type :label :text "Recipe" :x 20 :y 20 :width 100 :height 18}
  {:type :text-box :field "name" :x 20 :y 40 :width 200 :height 24}

  {:type :label :text "Ingredients" :x 20 :y 80 :width 100 :height 18}
  {:type :subform
   :x 20 :y 100 :width 400 :height 200
   :source-form "ingredient_subform"
   :link-master-fields ["id"]
   :link-child-fields ["recipe_id"]}

  {:type :button :caption "Add Ingredient" :x 20 :y 320 :width 120 :height 30
   :on-click :add-ingredient}]}
```

### List Form (Continuous/Paginated)

Display multiple records with server-side pagination:

```clojure
{:type :form
 :record-source "ingredient"
 :default-view "continuous"
 :page-size 20                ; Records per page (default 20)
 :controls
 [{:type :text-box :field "name" :x 20 :y 5 :width 150 :height 24}
  {:type :text-box :field "quantity" :x 180 :y 5 :width 80 :height 24}
  {:type :text-box :field "unit" :x 270 :y 5 :width 60 :height 24}]}
```

The runtime adds pagination controls automatically:
- Page navigation (prev/next, page numbers)
- Total record count
- Current page indicator

### Search Form

Form with filter controls and results list:

```clojure
{:type :form
 :record-source nil  ; Unbound - controlled by code
 :default-view "single"
 :controls
 [{:type :label :text "Search" :x 20 :y 20 :width 60 :height 18}
  {:type :text-box :field nil :name "search-box" :x 80 :y 20 :width 200 :height 24}
  {:type :button :caption "Find" :x 290 :y 20 :width 60 :height 24
   :on-click :search}

  {:type :list-box :name "results"
   :x 20 :y 60 :width 400 :height 300
   :row-source nil}]}  ; Populated by search
```

---

## Layout Guidelines

### Spacing Standards

| Element | Spacing |
|---------|---------|
| Label above field | 2-4px gap |
| Between field groups | 20px vertical |
| Left margin | 20px |
| Between columns | 20px |
| Button group spacing | 10px |

### Alignment

- Labels: Left-aligned, same X as their field
- Fields in a column: Same X, consistent width
- Buttons: Right-aligned or centered at bottom

### Standard Sizes

| Control | Width | Height |
|---------|-------|--------|
| Text box (short) | 100-150px | 24px |
| Text box (medium) | 200-250px | 24px |
| Text box (long) | 300-400px | 24px |
| Text area | 300px | 60-100px |
| Label | varies | 18px |
| Button | 80-120px | 30px |
| Combo box | 150-200px | 24px |
| Check box | 20px | 20px |

---

## Control Binding

### Bound Controls

Controls can be bound to database columns using either `:field` or `:control-source`:

- `:field` - Set automatically when dragging fields from the field list onto the form
- `:control-source` - Set via the Property Sheet's Data tab (matches Access terminology)

Both work identically - the runtime checks for either property:

{:type :text-box
 :field "recipe_name"  ; Reads/writes recipe.recipe_name
 :x 20 :y 40 :width 200 :height 24}

Or via Property Sheet:

{:type :text-box
 :control-source "recipe_name"  ; Same effect
 :x 20 :y 40 :width 200 :height 24}

**Important**: The field name must match the actual database column name exactly.

### Unbound Controls

Controls without `:field` are for display or user interaction:

```clojure
{:type :label
 :text "Total:"       ; Static text, not from database
 :x 20 :y 200 :width 60 :height 18}

{:type :text-box
 :name "calculated-total"  ; Named but not bound
 :x 80 :y 200 :width 100 :height 24}
```

### Calculated Fields

Use `:expression` for computed values:

```clojure
{:type :text-box
 :expression "(* quantity unit_price)"  ; Calculated at runtime
 :x 300 :y 40 :width 100 :height 24}
```

---

## Button Actions

### Standard Actions

| Action | Purpose |
|--------|---------|
| `:save-record` | Save current record changes |
| `:cancel` | Discard changes, close/reset |
| `:new-record` | Create new blank record |
| `:delete-record` | Delete current record (with confirm) |
| `:close-form` | Close the form |
| `:refresh` | Reload data |

### Custom Actions

Call PostgreSQL functions via session-state:

```clojure
{:type :button
 :caption "Generate Candidates"
 :on-click {:function "vba_generate_candidates"
            :params {:recipe_id :current-record-id}}}
```

---

## Combo Box / List Box

### Static Values

```clojure
{:type :combo-box
 :field "status"
 :x 20 :y 40 :width 150 :height 24
 :row-source-type :value-list
 :row-source ["Active" "Pending" "Completed"]}
```

### Table/Query Source

```clojure
{:type :combo-box
 :field "category_id"
 :x 20 :y 40 :width 200 :height 24
 :row-source-type :table-query
 :row-source "categories"
 :bound-column 0      ; Which column value to save (0 = id)
 :display-column 1    ; Which column to show (1 = name)
 :column-widths [0 150]}  ; Hide ID column, show name
```

---

## Subform Configuration

Link parent and child records:

```clojure
{:type :subform
 :source-form "recipe_ingredient_subform"
 :x 20 :y 100 :width 400 :height 200

 ;; Link fields - filter child records
 :link-master-fields ["id"]        ; Parent form field(s)
 :link-child-fields ["recipe_id"]  ; Child form field(s)

 ;; Optional settings
 :default-view "datasheet"         ; Override child form view
 :allow-additions true
 :allow-deletions true}
```

---

## Generating Forms from Description

When asked to create a form, follow this process:

### 1. Identify the Record Source

- What table or query provides the data?
- What fields are available?

### 2. Determine the Form Type

- Single record editing → `:default-view "single"`
- List display → `:default-view "continuous"` or "datasheet"
- Master-detail → Single with subform

### 3. Select Fields to Display

- Primary data fields (name, description, etc.)
- Foreign key lookups (use combo boxes)
- Calculated fields if needed

### 4. Add Standard Controls

- Labels for each field
- Input controls appropriate to field type
- Save/Cancel buttons for editable forms

### 5. Layout the Controls

- Group related fields
- Use consistent spacing
- Position buttons at bottom

---

## Example: Generate Form from Description

**Request:** "Create a form to edit recipes with name, description, and ingredients subform"

**Process:**

1. Record source: `recipe` table
2. Form type: Single record with subform
3. Fields: name, description, plus ingredients subform
4. Controls: labels, text boxes, subform, buttons

**Result:**

```clojure
{:type :form
 :record-source "recipe"
 :default-view "single"
 :controls
 [;; Header
  {:type :label :text "Recipe Editor"
   :x 20 :y 10 :width 200 :height 24
   :font-size 18 :font-weight "bold"}

  ;; Name field
  {:type :label :text "Recipe Name"
   :x 20 :y 50 :width 100 :height 18}
  {:type :text-box :field "name"
   :x 20 :y 70 :width 300 :height 24}

  ;; Description field
  {:type :label :text "Description"
   :x 20 :y 110 :width 100 :height 18}
  {:type :text-box :field "description"
   :x 20 :y 130 :width 400 :height 80}

  ;; Ingredients subform
  {:type :label :text "Ingredients"
   :x 20 :y 230 :width 100 :height 18}
  {:type :subform
   :source-form "recipe_ingredient_subform"
   :x 20 :y 250 :width 500 :height 200
   :link-master-fields ["id"]
   :link-child-fields ["recipe_id"]
   :default-view "datasheet"}

  ;; Buttons
  {:type :button :caption "Save"
   :x 20 :y 470 :width 80 :height 30
   :on-click :save-record}
  {:type :button :caption "Cancel"
   :x 110 :y 470 :width 80 :height 30
   :on-click :cancel}]}
```

---

## Validation Rules

### Field-Level Validation

```clojure
{:type :text-box
 :field "email"
 :x 20 :y 40 :width 250 :height 24
 :validation {:required true
              :pattern "^[^@]+@[^@]+$"
              :message "Valid email required"}}
```

### Form-Level Validation

```clojure
{:type :form
 :record-source "recipe"
 :validation-function "vba_validate_recipe"  ; Called before save
 :controls [...]}
```

---

## Conditional Visibility

Show/hide controls based on data:

```clojure
{:type :text-box
 :field "other_reason"
 :x 20 :y 100 :width 200 :height 24
 :visible-when {:field "reason" :equals "Other"}}
```

---

## Integration with Session-State

Forms interact with PostgreSQL functions:

### On Load
1. Create session
2. Set `record_id` in state
3. Fetch record data

### On Save
1. Set form field values in state
2. Call `vba_validate_*` function
3. Check `user_message` - display if error
4. If no error, call `vba_save_*` function
5. Clear session

### Button Actions
1. Set relevant state values
2. Call specified function
3. Check `user_message`, `navigate_to`, `confirm_required`
4. Handle response appropriately
