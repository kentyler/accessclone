# PolyAccess Project Overview

*A document for LLM collaborators to understand this project*

## Vision

PolyAccess aims to be a **low-code platform for converting Microsoft Access databases to modern web applications**, with broader ambitions as a general database-backed application builder.

### Why This Matters

Millions of Access databases power small businesses, departments, and personal projects. They're stuck on Windows, single-user, and aging. There's no good migration path that preserves the "low-code" nature that made Access useful in the first place.

### Core Philosophy

1. **Access-familiar UX** - Users who know Access should feel at home
2. **AI-assisted development** - LLMs help users build and modify their apps
3. **Schema-per-database isolation** - Multi-tenant PostgreSQL backend
4. **Web-native** - Runs in browser, no desktop app required
5. **Pragmatic simplicity** - Ship useful features, avoid over-engineering

## Technical Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Browser                               │
│  ┌─────────────────────────────────────────────────────┐   │
│  │           ClojureScript/Reagent Frontend             │   │
│  │  - Form Designer (Design View)                       │   │
│  │  - Form Runner (Form View)                           │   │
│  │  - Object Browser (Tables, Queries, Forms)           │   │
│  │  - AI Chat Panel                                     │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                   Node.js/Express Backend                    │
│  - REST API for CRUD operations                             │
│  - Form definition storage (EDN files)                      │
│  - LLM integration (Anthropic API)                          │
│  - Database schema management                               │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                     PostgreSQL Database                      │
│  - shared schema: cross-database metadata                   │
│  - {app} schemas: isolated per-application data             │
│  - VBA functions converted to PL/pgSQL                      │
└─────────────────────────────────────────────────────────────┘
```

### Key Files

| Path | Purpose |
|------|---------|
| `ui/src/app/state.cljs` | State management, API calls, record CRUD |
| `ui/src/app/views/form_editor.cljs` | Form designer and form view |
| `ui/src/app/views/main.cljs` | Main layout, chat panel |
| `server/index.js` | Express server setup |
| `server/routes/data.js` | CRUD endpoints |
| `server/routes/chat.js` | LLM integration with tool use |
| `forms/*.edn` | Form definitions |

## Current Functionality (as of 2026-01-29)

### Working Features

**Form Designer (Design View)**
- Visual drag-drop form builder
- Three sections: Header, Detail, Footer (Access-style)
- Resizable sections via draggable dividers
- Property Sheet with Format/Data/Event/Other tabs
- Grid snapping (Ctrl bypasses for pixel-perfect)
- Field list from record source (drag to add)

**Form Runner (Form View)**
- Live data entry bound to PostgreSQL
- Record navigation (First/Prev/Next/Last/New)
- Auto-save on navigation
- Delete record with confirmation
- Dirty indicator on Save button

**AI Assistant**
- Chat panel for questions about database/forms
- Tool use for searching records (`search_records`)
- Tool use for data analysis (`analyze_data`)
- Can navigate user to found records

**Multi-Database Support**
- Database switcher in header
- Schema-per-database isolation
- `X-Database-ID` header for routing

### Not Yet Implemented

- Report designer
- Subforms (master-detail relationships)
- Combo box with row source
- Continuous forms view (repeating detail section)
- Query designer (visual SQL builder)
- User authentication
- PDF/print output
- Import from Access (.accdb)

## Form Definition Structure

Forms use EDN (Clojure data notation) with section-based layout:

```clojure
{:id 1
 :name "Recipe Calculator"
 :type "form"
 :record-source "ingredient"      ; Table or query name
 :default-view "single"           ; "single" or "continuous"

 :header {:height 40
          :controls [{:type :label
                      :text "Recipe Calculator"
                      :x 8 :y 8
                      :width 200 :height 24}]}

 :detail {:height 200
          :controls [{:type :text-box
                      :field "name"        ; Binds to database field
                      :x 20 :y 28
                      :width 200 :height 24}
                     {:type :label
                      :text "Name"
                      :x 20 :y 8
                      :width 100 :height 18}]}

 :footer {:height 30
          :controls []}}
```

### Control Types

| Type | Properties | Notes |
|------|------------|-------|
| `:label` | `:text` | Static text display |
| `:text-box` | `:field` | Bound to database field |
| `:button` | `:text`, `:on-click` | Action button |
| `:check-box` | `:field`, `:text` | Boolean field |
| `:combo-box` | `:field`, `:row-source` | Dropdown (row-source not implemented) |

## Design Decisions & Rationale

### Why ClojureScript?

- Immutable data structures fit form state management well
- Reagent (React wrapper) is concise and fast
- EDN is a natural fit for form definitions
- Hot reloading via shadow-cljs

### Why Not Datasheet View?

We're explicitly NOT implementing datasheet/grid views. Rationale:
- Adds significant complexity
- Many existing grid libraries available
- Focus on forms (Access's strength)
- Users who need grids can use external tools

### Why AI for Search Instead of Traditional UI?

- Natural language handles complex queries better
- Reduces UI complexity
- Aligns with "AI-assisted" philosophy
- Search box replaced with "Ask the AI" hint

### Form Sections vs Flat Controls

Access forms have Header/Detail/Footer sections. We match this because:
- Header: titles, logos (shown once)
- Detail: data fields (repeats in continuous forms)
- Footer: totals, buttons (shown once)
- Familiar to Access users
- Required for continuous forms later

## Conventions for LLM Collaborators

### When Modifying Code

1. **Read before writing** - Always read relevant files first
2. **Preserve patterns** - Match existing code style
3. **Keep it simple** - Avoid over-engineering
4. **Test builds** - Run `npx shadow-cljs compile app` after changes

### State Management

- All state in `app-state` atom
- Use `swap!` with `assoc-in` for updates
- Form editor state under `:form-editor` key
- Current form definition under `:form-editor :current`

### API Patterns

- CRUD: `GET/POST/PUT/DELETE /api/data/:table/:id`
- Database ID via `X-Database-ID` header
- Responses: `{data: [...], pagination: {...}}`

### Form Definition Updates

When modifying form structure:
1. Update form files in `forms/*.edn`
2. Update `form_editor.cljs` for design/view rendering
3. Update `state.cljs` if new state management needed
4. Update CSS in `style.css` for new elements

## Next Priorities

1. **Test and stabilize** current section-based forms
2. **Section divider improvements** - visual feedback during drag
3. **Continuous forms** - repeat detail section for multiple records
4. **Combo box row source** - populate dropdowns from queries
5. **Subforms** - embed child forms for master-detail

## Questions to Consider

When extending PolyAccess, consider:

- Does this match how Access does it? (familiarity)
- Can the AI help with this instead of building UI? (simplicity)
- Is this essential for database apps? (pragmatism)
- Does it work with the section-based form model? (consistency)
