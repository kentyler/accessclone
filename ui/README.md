# CloneTemplate UI

Application template for cloned MS Access databases. Each cloned database gets its own instance of this UI.

## Quick Start

**1. Start the backend (for saving forms):**
```bash
cd server
npm install
npm start
```
Backend runs on http://localhost:3001

**2. Start the frontend:**
```bash
cd ui
npm install
npx shadow-cljs watch app
```
Frontend runs on http://localhost:8281

Both need to be running for form saving to work.

## Architecture

### ClojureScript + Reagent

The UI is built with ClojureScript and Reagent (React wrapper). State is managed via a single Reagent atom.

### Directory Structure

```
ui/
├── src/app/
│   ├── core.cljs           # Entry point, initialization
│   ├── state.cljs          # Application state management
│   └── views/
│       ├── main.cljs       # Main layout (header, body, error banner)
│       ├── sidebar.cljs    # Access-style navigation pane
│       ├── tabs.cljs       # Tab bar for open objects
│       └── form_editor.cljs # Form designer with AI assistant
├── resources/public/
│   ├── index.html
│   └── css/style.css
├── shadow-cljs.edn         # Build configuration
└── package.json            # NPM dependencies
```

## Features

### Access-Style Navigation (Sidebar)

- Collapsible left-hand navigation pane
- Object type dropdown (Tables, Queries, Forms, Reports, Macros, Modules)
- Object list for selected type
- "New Form" button when Forms is selected
- Click object to open in tab

### Tab Interface

- Multiple objects open simultaneously
- Click tab to switch
- X button to close tab
- Active tab highlighted

### Form Designer

The form designer replaces Access Design View with LLM-assisted development.

#### Layout

```
┌─────────────────────────────────────────────────────────────┐
│ [Design] [View]                              [Undo] [Save]  │ Toolbar
├──────────┬────────────────────────────┬─────────────────────┤
│ Controls │                            │ Form Properties     │
│ ──────── │                            │ ───────────────     │
│ Text Box │      Form Canvas           │ Record Source: [▼]  │
│ Label    │                            │ Default View:  [▼]  │
│ Button   │   (drag controls here)     │                     │
│ Combo    │                            │ Fields              │
│ ...      │                            │ ──────              │
│          │                            │ 🔑 id     integer   │
│ AI Asst  │                            │ 🔗 name   text      │
│ ──────── │                            │    desc   text      │
│ [prompt] │                            │    ...              │
│ [Generate]                            │                     │
└──────────┴────────────────────────────┴─────────────────────┘
```

#### Control Palette (Left Panel)

Standard form controls:
- Text Box
- Label
- Button
- Combo Box
- List Box
- Check Box
- Subform

#### AI Assistant (Left Panel)

Natural language form generation:
- Describe what you want: "Add a text box for recipe name"
- "Create a subform showing ingredients"
- "Add Save and Cancel buttons"

#### Form Properties (Right Panel)

- **Record Source**: Select table or query for the form's data
- **Form Type**:
  - **Single Record** - Edit one record at a time, fetched by ID
  - **List (Paginated)** - Display multiple records with server-side paging

No datasheet mode - we keep it simple with just these two types.

#### Field List (Right Panel)

When a record source is selected, shows:
- All fields from the table/query
- Field types (integer, text, numeric, etc.)
- Primary key indicator (🔑)
- Foreign key indicator (🔗)

Fields are draggable - drag onto canvas to create bound controls.

#### Form Canvas (Center)

Design surface where controls are placed:
- Drag fields from field list to create text box + label
- Drag existing controls to reposition
- Click control to select (blue outline)
- Delete key or X button to remove control
- Auto-saves when switching forms

#### Control Properties

Each control has:
- Position (x, y)
- Size (width, height)
- Type (text-box, label, button, etc.)
- Field binding (for bound controls)
- Label text

## State Management

All state in single atom (`app.state/app-state`):

```clojure
{:app-name "Application"
 :database-name "app_db"

 ;; UI state
 :loading? false
 :error nil

 ;; Sidebar
 :sidebar-collapsed? false
 :sidebar-object-type :forms

 ;; Objects (loaded from database)
 :objects {:tables [{:id 1 :name "recipe" :fields [...]}]
           :queries [...]
           :forms [{:id 1 :name "Form1" :definition {...}}]
           :reports []
           :macros []
           :modules []}

 ;; Tabs
 :open-objects [{:type :forms :id 1 :name "Form1"}]
 :active-tab {:type :forms :id 1}

 ;; Form editor
 :form-editor {:dirty? false
               :original {...}
               :current {...}
               :selected-control nil}}
```

## Form Definition Structure

Forms are stored as EDN data:

```clojure
{:type :form
 :record-source "recipe"        ; table or query name
 :default-view "single"         ; single, continuous, datasheet
 :controls [{:type :label
             :text "Recipe Name"
             :x 20 :y 20
             :width 100 :height 18}
            {:type :text-box
             :field "name"
             :label "name"
             :x 20 :y 40
             :width 150 :height 24}]}
```

## Key Functions

### State Functions (state.cljs)

| Function | Purpose |
|----------|---------|
| `toggle-sidebar!` | Collapse/expand sidebar |
| `set-sidebar-object-type!` | Change object type filter |
| `open-object!` | Open object in tab |
| `close-tab!` | Close a tab |
| `create-new-form!` | Create blank form |
| `set-form-definition!` | Update form being edited |
| `save-form!` | Save form changes |
| `select-control!` | Select control for editing |
| `delete-control!` | Remove control from form |

### Form Editor Functions (form_editor.cljs)

| Function | Purpose |
|----------|---------|
| `add-field-control!` | Add text box + label for field |
| `move-control!` | Reposition existing control |
| `get-record-source-fields` | Get fields from selected table/query |

## CSS Classes

Key classes in style.css:

| Class | Purpose |
|-------|---------|
| `.sidebar` | Navigation pane container |
| `.sidebar.collapsed` | Collapsed state (36px wide) |
| `.object-item` | Object in sidebar list |
| `.object-item.active` | Selected object |
| `.tab` | Tab in tab bar |
| `.tab.active` | Active tab |
| `.form-editor` | Form designer container |
| `.form-canvas` | Design surface |
| `.form-control` | Control on canvas |
| `.form-control.selected` | Selected control |
| `.control-delete` | Delete button on control |
| `.field-item` | Draggable field in field list |

## Integration Points

### Form Storage

Forms are stored as EDN files in the `forms/` directory:

```
CloneTemplate/
├── forms/
│   ├── _index.edn           # List of form filenames
│   ├── recipe_calculator.edn
│   ├── ingredient_entry.edn
│   └── inventory_list.edn
└── ui/
    └── resources/public/forms/  # Copy for dev server
```

**Loading:** Forms are loaded via HTTP from `/forms/*.edn` at startup.

**Saving:** Currently logs to console. Requires a backend to write files (see TODO below).

### Backend

The `server/` directory contains a Node.js backend that handles:
- Writing form EDN files when saving
- Updating `_index.edn` when forms are added/deleted
- Serving forms via API

**Endpoints:**
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/forms` | List all forms |
| GET | `/api/forms/:name` | Read a form file |
| PUT | `/api/forms/:name` | Save a form file |
| DELETE | `/api/forms/:name` | Delete a form file |

**Still TODO:**
- Loading table/query metadata from PostgreSQL
- Calling PostgreSQL functions (session-state pattern)

### Session State

Forms call PostgreSQL functions using the session-state pattern:
1. Create session: `SELECT create_session()`
2. Set parameters: `SELECT set_state(session, 'field', 'value', 'type')`
3. Call function: `SELECT vba_function_name(session)`
4. Check user_message: Display if present
5. Read results: `SELECT get_state(session, 'result_name')`

See `CloneTemplate/skills/database-patterns.md` for full pattern documentation.
