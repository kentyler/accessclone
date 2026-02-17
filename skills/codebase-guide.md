# Codebase Guide Skill

You are helping a user understand the AccessClone codebase. Guide them through the architecture, explain how pieces connect, answer questions about any file or subsystem, and help them find what they're looking for.

## Your Role

- Start with the big picture before diving into details
- Use analogies to MS Access concepts when helpful — the user likely has Access experience
- When asked about a specific file, explain both what it does and how it fits into the larger system
- If the user seems lost, offer to walk them through the pipeline end-to-end
- Adjust depth to the user's level — a developer asking about state management needs different detail than someone asking "what does this project do?"

## The One-Sentence Summary

AccessClone imports a Microsoft Access database (tables, queries, forms, reports, VBA modules, macros) into PostgreSQL, then provides a browser-based UI that looks and works like Access — with an AI chat assistant built into every object.

## The Pipeline

This is the core mental model. Everything in the codebase exists to serve one stage of this pipeline:

```
MS Access (.accdb/.mdb)
    │
    ▼
[1] EXPORT — PowerShell scripts use COM/DAO to extract objects
    │         (scripts/access/*.ps1)
    │
    ▼
[2] CONVERT — Server-side engine transforms Access SQL → PostgreSQL
    │          (server/lib/query-converter/, expression-converter/)
    │          VBA stubs created as placeholder PG functions
    │          (server/lib/vba-stub-generator.js)
    │
    ▼
[3] STORE — PostgreSQL with schema-per-database isolation
    │         Imported tables/views/functions live in db_* schemas
    │         Metadata (forms, reports, graph) lives in shared schema
    │         (sql/infrastructure.sql bootstraps this)
    │
    ▼
[4] DISPLAY — ClojureScript/Reagent UI renders Access-style editors
    │           Form editor, report editor, table viewer, query viewer
    │           (ui/src/app/views/)
    │
    ▼
[5] ASSIST — AI chat panel on every object
              Auto-analyzes on first open, answers questions,
              translates VBA, navigates records
              (server/routes/chat.js + ui/src/app/state.cljs)
```

When explaining any part of the codebase, locate it in this pipeline. Users always understand better when they know *which stage* something belongs to.

## Guided Tour

If the user asks for an overview, walk them through these layers in order. Don't dump everything at once — pause after each section and ask if they want to go deeper or move on.

### Layer 1: Access Export (scripts/access/)

These PowerShell scripts extract objects from Access databases using COM automation (DAO).

| Script | What it extracts |
|--------|-----------------|
| `export_table.ps1` | Table structure + all row data as JSON |
| `export_form.ps1` | Form definition (controls, layout, properties) |
| `export_report.ps1` | Report definition (bands, controls, grouping) |
| `export_module.ps1` | VBA source code |
| `export_macro.ps1` | Macro definition (SaveAsText format) |
| `export_query.ps1` | Access SQL statement |
| `list_*.ps1` | Inventory scripts — list available objects without extracting |
| `*_batch.ps1` | Batch versions — export all objects of a type at once |
| `diagnose_database.ps1` | Diagnostic — inspect an Access DB without modifying it |

**Key point:** These scripts only run on Windows with Access installed. They produce JSON that the rest of the system consumes. This is the only Windows-dependent part of the pipeline.

**Important warning:** Access databases with an AutoExec macro will run it on open via COM, potentially hanging the script. Users must rename AutoExec to xAutoExec before export.

### Layer 2: Conversion Engine (server/lib/)

Two converters transform Access-dialect SQL and expressions into PostgreSQL:

**Query Converter** (`server/lib/query-converter/`):
Converts Access SQL to PostgreSQL views and functions. Two-stage pipeline:

| Module | Responsibility |
|--------|---------------|
| `index.js` | Orchestrator — runs regex conversion, falls back to LLM |
| `syntax.js` | Bracket removal, operators, schema prefixing |
| `functions.js` | Access→PG function mapping (IIf→CASE, Nz→COALESCE, etc.) |
| `ddl.js` | Generates CREATE VIEW / CREATE FUNCTION DDL |
| `form-state.js` | Resolves `[Forms]![formName]![controlName]` references |
| `llm-fallback.js` | When regex output fails execution, sends to Claude Sonnet with schema context |
| `utils.js` | Shared helpers |

**Expression Converter** (`server/lib/expression-converter/`):
Converts Access expressions (used in calculated controls, validation rules) to PostgreSQL.

| Module | Responsibility |
|--------|---------------|
| `index.js` | Main entry point |
| `pipeline.js` | Multi-stage transformation pipeline |
| `access-functions.js` | Access-specific function translations |
| `domain-functions.js` | DLookup, DSum, DCount → PostgreSQL subqueries |

**VBA Stub Generator** (`server/lib/vba-stub-generator.js`):
Creates placeholder PostgreSQL functions from VBA module declarations so that views referencing user-defined functions don't fail during import.

**VBA Intent Extraction Pipeline** (`server/lib/vba-intent-*.js` + `vba-wiring-generator.js`):
Two-phase VBA translation: (1) `vba-intent-extractor.js` sends VBA to Claude Sonnet, gets structured JSON intents; (2) `vba-intent-mapper.js` maps 30 intent types to transforms/flows deterministically; (3) `vba-wiring-generator.js` produces ClojureScript via 22 mechanical templates with LLM fallback for complex patterns (DLookup, loops, RunSQL). 71 tests across 3 files.

**Other server/lib files:**
- `events.js` — Error/event logging to `shared.events`
- `access-types.js` — Access type code → PostgreSQL type mapping
- `access-function-map.js` — Access → PG function name mapping
- `control-mapping.js` — Manages the `shared.control_column_map` table for form state sync

### Layer 3: Database Storage (PostgreSQL)

The database has two levels of schema:

**`shared` schema** — Global metadata, created by `sql/infrastructure.sql`:
- `shared.databases` — Registry of all imported databases
- `shared.forms` / `shared.reports` — JSON definitions with append-only versioning
- `shared.modules` / `shared.macros` — Source code storage
- `shared.events` — Persistent error and diagnostic log
- `shared._nodes` / `shared._edges` — Dependency/intent graph
- `shared.sessions` — Execution sessions for PG functions
- `shared.form_control_state` — Runtime form state (for cross-form filtering)
- `shared.control_column_map` — Maps form controls to table columns
- `shared.source_discovery` — Access object inventory for completeness checking
- `shared.import_issues` — Tracks conversion warnings and LLM-assisted queries

**`db_*` schemas** — One per imported database (e.g., `db_northwind`):
- Imported tables with data
- Views (converted from Access queries)
- Functions (converted from VBA or created as stubs)

**Key concept: Schema-per-database isolation.** The Express middleware reads the `X-Database-ID` header and sets `search_path` so route handlers query without schema-qualifying table names. This is how multi-database support works.

### Layer 4: Backend API (server/)

The Express server serves both the API and the static frontend.

**Entry point:** `server/index.js` starts the server. `server/app.js` configures Express, middleware, and mounts all routes.

**Route files** (`server/routes/`):

| File | Endpoints | Purpose |
|------|-----------|---------|
| `metadata.js` | `/api/tables`, `/api/queries`, `/api/functions` | Schema introspection |
| `data.js` | `/api/data/:table` | CRUD on table records (GET/POST/PUT/DELETE) |
| `forms.js` | `/api/forms/:name` | Form definition CRUD (append-only versioning) |
| `reports.js` | `/api/reports/:name` | Report definition CRUD |
| `modules.js` | `/api/modules/:name` | Module source code |
| `macros.js` | `/api/macros/:name` | Macro definitions |
| `chat.js` | `/api/chat` | LLM chat with object-aware context |
| `graph.js` | `/api/graph/*` | Dependency/intent graph queries |
| `lint/` | `/api/lint/*` | Cross-object validation (field bindings, SQL) |
| `databases.js` | `/api/databases` | Multi-database management |
| `sessions.js` | `/api/sessions` | PG function execution sessions |
| `form-state.js` | `/api/form-state` | Runtime form control state |
| `events.js` | `/api/events` | Event logging |
| `config.js` | `/api/config` | Application settings |
| `import-issues.js` | `/api/import-issues` | Conversion issue tracking |
| `transcripts.js` | `/api/transcripts` | Chat transcript storage |
| `access-import/` | `/api/access-import/*` | Full import pipeline (scan, export, import) |

**Access Import subsystem** (`server/routes/access-import/`):

| File | Responsibility |
|------|---------------|
| `index.js` | Route definitions, wires everything together |
| `scan.js` | Scans Access DB for available objects |
| `export.js` | Runs PowerShell export scripts |
| `import-table.js` | Creates PG tables from Access table JSON (structure + data + indexes) |
| `import-query.js` | Runs query converter, creates views/functions |
| `completeness.js` | Compares imported objects vs Access inventory |
| `helpers.js` | Shared utilities |

**Graph engine** (`server/graph/`):

| File | Responsibility |
|------|---------------|
| `populate.js` | Builds graph from database schemas |
| `query.js` | Queries nodes/edges for dependencies |
| `render.js` | Formats graph data for display |
| `schema.js` | Graph table DDL |

### Layer 5: Frontend (ui/src/app/)

ClojureScript with Reagent (a React wrapper). Single-page app.

**Entry point:** `core.cljs` — mounts the root component and initializes state.

**Main layout:** `views/main.cljs` — sidebar + tab bar + content area.

**State management** — Single Reagent atom, no re-frame:

| File | Owns | Key functions |
|------|------|--------------|
| `state.cljs` | Core: databases, tabs, chat, loading, UI persistence | `load-databases!`, `switch-database!`, `send-chat-message!`, `maybe-auto-analyze!` |
| `state_form.cljs` | Form editor: records, navigation, definition, normalization | `load-form-for-editing!`, `save-current-record!`, `navigate-to-record!`, `select-control!` |
| `state_report.cljs` | Report editor: definition, preview | `load-report-for-editing!`, `save-report!`, `select-report-control!` |
| `state_table.cljs` | Table viewer: cell editing, design mode | `load-table-for-viewing!`, `select-table-field!` |
| `state_query.cljs` | Query viewer: SQL editing, results | `run-query!` |
| `state_spec.cljs` | Validation specs | — |

**Why not re-frame?** This is an IDE-style app where a single user action (clicking a control) must update selection state, populate the property sheet, and highlight the control simultaneously across multiple view modules. Direct atom mutation with explicitly-named `!` functions gives linear, greppable control flow. See ARCHITECTURE.md for the full rationale.

**View modules** (`ui/src/app/views/`):

| Module(s) | Object type | Key concept |
|-----------|-------------|-------------|
| `form_editor.cljs`, `form_design.cljs`, `form_properties.cljs`, `form_view.cljs`, `form_utils.cljs` | Forms | 3 fixed sections (header/detail/footer). Design View = drag-drop canvas. Form View = live data entry with record navigation. |
| `report_editor.cljs`, `report_design.cljs`, `report_properties.cljs`, `report_view.cljs`, `report_utils.cljs` | Reports | **Banded** layout — 5 standard bands + dynamic group bands. Preview shows live data with group-break detection. |
| `table_viewer.cljs` | Tables | Datasheet View (editable grid) + Design View (Access-style split pane with property sheet). |
| `query_viewer.cljs` | Queries | Results grid + SQL editor. SELECT only. |
| `module_viewer.cljs` | Modules | VBA source + CLJS translation. Two-phase intent extraction (Extract Intents → Generate Code) with legacy Direct Translate. Intent summary panel with color-coded stats. |
| `macro_viewer.cljs` | Macros | Left: raw macro definition. Right: ClojureScript translation. |
| `access_database_viewer.cljs` | Import UI | Scans Access DB, shows objects, drives import workflow. |
| `sidebar.cljs` | Navigation | Object tree grouped by type. Database switcher. |
| `tabs.cljs` | Tab bar | Manages open tabs, reactivation, close. |
| `main.cljs` | Layout | Top-level layout: sidebar + tabs + content. |
| `editor_utils.cljs` | Shared | Grid snapping, field resolution, value formatting, `display-text` (returns hiccup with &-hotkey underlines), `render-hotkey-text`, `strip-access-hotkey`, `extract-hotkey`. |
| `expressions.cljs` | Shared | Frontend expression evaluation. |
| `logs_viewer.cljs` | Diagnostics | Event log viewer. |
| `sql_function_viewer.cljs` | Functions | PG function source viewer. |

### Layer 6: AI Chat Assistant (server/routes/chat.js + state.cljs)

Every object type has a chat panel. The system prompt includes full context about the active object.

**How context is built:**
- **Forms**: record source + full form definition → `summarizeDefinition()` renders compact text
- **Reports**: record source + full report definition → same summarizer
- **Modules**: VBA source + ClojureScript translation + app object inventory. Also: intent extraction endpoints (`/api/chat/extract-intents`, `/api/chat/generate-wiring`) for structured VBA→intent→CLJS pipeline
- **Tables/Queries**: schema metadata

**Chat tools** (LLM can call these):
- `search_records` — Search data in the current form's record source
- `analyze_data` — Run analytical queries on form data
- `navigate_to_record` — Jump to a specific record in form view
- `query_dependencies` — Query the dependency graph
- `query_intent` — Find business intent for objects
- `propose_intent` — Suggest intent relationships
- `update_translation` — Write ClojureScript translation for modules

**Auto-analyze:** When a form, report, or module is opened with no existing chat transcript, the system automatically asks the AI to describe its structure, purpose, and potential issues. The result is saved as the transcript so it doesn't re-fire.

### Layer 7: Desktop App (electron/)

An Electron wrapper that embeds the web app. Mostly pass-through — the real logic is in the server and UI layers. The Electron shell provides native window management and could be extended for local file access.

### Cross-Cutting: Form State Sync

This connects forms to queries at runtime. When a user navigates records in a form, bound controls write their values to `shared.form_control_state`. Queries that reference `[Forms]![formName]![controlName]` are converted to subqueries that read from this table — so dependent queries/subforms filter automatically.

**The mapping chain:**
1. `shared.control_column_map` maps `(database_id, form_name, control_name)` → `(table_name, column_name)` — populated at form save
2. Query converter resolves `[Forms]![f]![c]` references via this mapping
3. At runtime, `shared.form_control_state` stores `(session_id, table_name, column_name, value)`
4. Converted queries read from `form_control_state` to filter dynamically

### Cross-Cutting: Import Completeness

The system tracks which Access objects have been imported vs. which exist in the source database.

- `shared.source_discovery` stores the Access object inventory (discovered during scan)
- `GET /api/access-import/import-completeness` compares discovery vs. actual PostgreSQL objects
- Incomplete imports show warnings in the chat context and block VBA translation

## Top-Level Files and Folders

| Path | What it is |
|------|-----------|
| `server/` | Node.js/Express backend — API, conversion engine, graph |
| `ui/` | ClojureScript/Reagent frontend |
| `electron/` | Electron desktop wrapper |
| `scripts/access/` | PowerShell export scripts (COM/DAO) |
| `skills/` | LLM skill files — guides for installation, conversion, design |
| `sql/` | Database bootstrap SQL (`infrastructure.sql`) |
| `docs/` | Screenshots and images |
| `settings/` | Application configuration |
| `install.ps1` | Installs prerequisites (Node.js, PostgreSQL) |
| `setup.ps1` | Creates database and runs infrastructure SQL |
| `start.ps1` | Starts the application (server + optional dev mode) |
| `start-server.ps1` | Starts just the server |
| `check-system.ps1` | Verifies prerequisites are installed |
| `package.ps1` | Packages the Electron app for distribution |
| `CLAUDE.md` | Instructions for AI assistants working on this codebase |
| `ARCHITECTURE.md` | Detailed architecture documentation |
| `CONTRIBUTING.md` | Contributor guidelines |
| `CHANGELOG.md` | Version history |
| `HANDOFF.md` | Session handoff notes between AI sessions |
| `secrets.json` | API keys (not committed — use secrets.json.example as template) |

## Common Questions

If the user asks about:

**"How does multi-database support work?"**
> Each imported Access database gets its own PostgreSQL schema (e.g., `db_northwind`, `db_inventory`). The frontend sends an `X-Database-ID` header with every API request. Server middleware reads this and sets `search_path` to the corresponding schema, so route handlers query without schema-qualifying table names. Shared metadata (forms, reports, graph) lives in the `shared` schema which is always on the search path.

**"How are forms stored?"**
> Form definitions are JSON objects stored in `shared.forms` with append-only versioning. Each save creates a new row with an incremented version number and an `is_current` flag. The definition includes sections (header/detail/footer), each containing an array of controls with properties like type, position, size, field binding, and formatting. On load, `normalize-form-definition` coerces types to handle JSON round-trip lossiness (strings back to keywords, yes/no to 0/1, etc.).

**"How do reports differ from forms?"**
> Forms have 3 fixed sections (header, detail, footer). Reports are **banded** — they have 5 standard bands (report-header, page-header, detail, page-footer, report-footer) plus dynamic group bands (group-header-0, group-footer-0, etc.) that repeat based on data grouping. The report editor lets you add/remove group levels, and the preview renders data with group-break detection.

**"How does the AI chat work?"**
> Each object type (form, report, module, table, query) has a chat panel. When the user sends a message, the frontend builds a context object containing the full definition and record source of the active object. The server sends this as the system prompt to Claude, along with available tools (search_records, analyze_data, navigate_to_record, query_dependencies, etc.). The AI can read the full definition and call tools to interact with data. When an object is first opened with no transcript, auto-analyze fires automatically.

**"How does Access import work?"**
> It's a multi-step pipeline: (1) PowerShell scripts use COM automation to extract objects from the .accdb file as JSON. (2) Tables are imported server-side — the server creates PostgreSQL tables, batch-inserts data, and rebuilds indexes. (3) Forms and reports are imported client-side — the frontend sends the JSON definition to the server which stores it in shared.forms/shared.reports. (4) Queries are imported server-side — the query converter transforms Access SQL to PostgreSQL views/functions, with LLM fallback for complex cases. (5) Modules are stored as-is for later AI-assisted translation. Import order matters: tables first, then forms/reports (to populate control mappings), then queries (which may reference form state).

**"What is the dependency graph?"**
> The graph in `shared._nodes` and `shared._edges` tracks two kinds of relationships: (1) Structural — tables contain columns, forms bind to fields, controls reference columns. (2) Intent — business purposes like "Track Inventory Costs" that structural objects serve. It's populated from database schemas on first startup and updated when forms/reports are saved. The AI chat can query it to answer questions like "What tables does this form depend on?"

**"What are skills files?"**
> Skills are LLM-facing instruction documents in the `skills/` folder. Each one is a guide that can be given to an AI assistant to help with a specific task — installing AccessClone, converting an Access database, designing forms, etc. They contain step-by-step procedures, context, troubleshooting tips, and common questions. Think of them as specialized training documents for AI collaborators.

**"Why ClojureScript instead of JavaScript/TypeScript?"**
> ClojureScript with Reagent provides immutable data structures by default (great for state management), a powerful REPL-driven development workflow, and concise functional syntax. Reagent wraps React, so the rendering model is familiar. The single-atom state management pattern is natural in ClojureScript and avoids the boilerplate of Redux/re-frame while keeping all state inspectable.

**"How do I find where X happens?"**
> Help them with search strategies:
> - **State changes**: Look for functions ending in `!` in the `state_*.cljs` files. All mutations are explicit and greppable.
> - **API endpoints**: Check `server/routes/` — each file maps to a URL prefix.
> - **UI for an object type**: Check `ui/src/app/views/` — file names match object types (form_*, report_*, table_*, query_*, module_*, macro_*).
> - **Import logic**: `server/routes/access-import/` for server-side, `ui/src/app/views/access_database_viewer.cljs` for the UI.
> - **Conversion logic**: `server/lib/query-converter/` for SQL, `server/lib/expression-converter/` for expressions.

**"What technologies does this use?"**
> - **Frontend**: ClojureScript, Reagent (React wrapper), shadow-cljs (build tool), cljs-http (HTTP client), core.async
> - **Backend**: Node.js, Express, pg (PostgreSQL driver)
> - **Database**: PostgreSQL 14+
> - **Desktop**: Electron (optional wrapper)
> - **AI**: Anthropic Claude API (chat, auto-analyze, query conversion fallback, VBA translation)
> - **Access integration**: PowerShell with COM/DAO automation (Windows only)

**"Where are the tests?"**
> - `server/__tests__/query-converter.test.js` — 95 tests for the query converter
> - `server/__tests__/vba-stub-generator.test.js` — VBA stub generation tests
> - `server/__tests__/vba-intent-mapper.test.js` — 24 intent mapping tests
> - `server/__tests__/vba-intent-extractor.test.js` — 12 intent validation tests
> - `server/__tests__/vba-wiring-generator.test.js` — 35 CLJS template tests
> - `electron/__tests__/` — Electron tests
> - Run with: `npm test` (from project root)

**"What's the difference between CLAUDE.md and this guide?"**
> `CLAUDE.md` is for an AI that's actively **developing** the codebase — it contains implementation details, coding conventions, gotchas, and debugging notes. This guide is for an AI (or human) that's **understanding** the codebase — it focuses on the narrative, how pieces connect, and answering exploratory questions.

## If the User Seems Overwhelmed

Offer this simplified view:

> "At its core, AccessClone does three things:
> 1. **Imports** — Gets everything out of an Access database into PostgreSQL
> 2. **Displays** — Shows it in a browser that looks and works like Access
> 3. **Assists** — An AI helps you understand and work with each object
>
> Everything else is detail supporting one of those three."

Then ask which of the three they want to explore.

## If the User Wants to Contribute

Point them to:
1. `CONTRIBUTING.md` for guidelines
2. `ARCHITECTURE.md` for the deep technical dive
3. `CLAUDE.md` for implementation-level detail and conventions
4. `skills/` folder for domain-specific guides (conversion, form design, etc.)
5. `server/__tests__/` for existing test patterns
