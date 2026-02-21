# Handoff Notes

Shared scratchpad for AI assistants working on this codebase. Read this at session start. Update it after significant changes.

---

## Current State

### Just Shipped (2026-02-20)
- **Notes corpus** (PR #32): Append-only corpus where a human writes entries and an LLM reads each new entry against everything that came before. Three-pane UI: sidebar (entry list), center (write/view), right (LLM response). Global (not per-database), chronological, no categories or tags.
  - Server: `server/routes/notes.js` — API endpoints, LLM prompt (four unnamed operations: boundary, transduction, resolution, trace), corpus context building. Model: Claude Sonnet, max 2048 tokens. Graceful degradation without API key.
  - Database: `shared.corpus_entries` table with `entry_type` ('human'/'llm'), `parent_id` linking responses to entries.
  - Frontend: 6 transforms, 3 flows (load, submit, select), three-pane view component. Hub integration shows 5 most recent notes.
  - Entry pane shows selected entry content in view mode; read pane shows response only; "+" button for new entries.
- **Notes documentation**: `skills/notes-corpus.md` created with full architecture documentation. Notes section added to CLAUDE.md.

### Previously Shipped (2026-02-19)
- **Hub home page**: Replaced the top nav bar with a proper hub landing page. 3-column layout: left menu (Home, Notes, Meetings, Messages, Email, AccessClone), center content (changes by selection), right contextual panel, collapsible chat. Default page is now `:hub` instead of `:accessclone`. Each section has an "Open" button that navigates to its full page; full pages have "Back to Hub" links.
  - Files: `ui/src/app/views/hub.cljs` (new), `ui/src/app/views/main.cljs` (restructured routing, removed `site-nav`), stub pages updated with back-to-hub links, CSS additions in `style.css`.
  - State: `:current-page :hub` (default), `:hub-selected :home` in `app-state`.
- **Three-layer architecture on hub home**: The home page center content presents a Deleuzian reading of the system's three-layer model:
  - **Could Do** — the virtual, the plane of consistency ("your wildest dreams")
  - **Should Do** — the abstract machine, the diagram ("sketches on the back of an envelope")
  - **Doing Now** — the concrete assemblage, the stratum ("the hurly-burly, the daily grind")
  - Plus sections on "Why Three Layers" and "Bidirectional Movement" (actualization ↓, deterritorialization ↑)
- **Standalone architecture page**: `ui/resources/public/architecture.html` — self-contained HTML page with the full explanation (three layers + four primitives + bidirectional movement + reflexivity). Linked from hub home with "Read the full explanation →".
- **Four architectural primitives seeded into graph**: `seedPrimitives()` in `server/graph/populate.js` creates 4 capability nodes and 21 potential nodes (manifestations) with `actualizes` edges, plus 3 `refines` edges (Trace as invariant-of the other three):
  - **Boundary** — Enclosure (schema isolation, tab workspaces, module namespaces, form/report sections)
  - **Transduction** — Isomorphism (SQL conversion, VBA→CLJS, intent extraction, form normalization, graph population)
  - **Resolution** — Gradient descent (multi-pass retry, batch code gen, gap decisions, LLM fallback, lint validation)
  - **Trace** (invariant) — Lineage (append-only versioning, event logging, transcript persistence, import history, edge provenance)
  - Endpoints: `POST /api/graph/seed-primitives` (standalone), also runs automatically on `POST /api/graph/populate`
  - Idempotent — safe to call multiple times
- **capability-ontology.md rewritten**: Updated to reflect Could Do / Should Do / Doing Now framing, four primitives, reflexivity vision.

### Previously Shipped (2026-02-18)
- **Capability ontology: intent → potential rename** (PR #31): Graph node type `intent` renamed to `potential` throughout. The three-layer model is now: capability (names) → potential (what's implied) → expression (what exists). `application` removed as a graph node type — applications are expressions. Schema migration renames existing nodes automatically on server restart.
- **Per-database folder structure**: `databases/accessclone/` and `databases/threehorse/` created with `source/`, `modules/`, and `notes.md`. `.gitignore` excludes `.accdb`/`.mdb` files from git.
- **Two new databases registered**: AccessClone (`db_accessclone`) and ThreeHorse (`db_threehorse`) schemas created in PostgreSQL via the app, registered in `shared.databases`.
- **capability-ontology.md**: Full rewrite documenting three-layer model, graph node types, edge types, API endpoints, chat tools.

### Previously Shipped (2026-02-17)
- **Batch pipeline: Extract → Resolve → Generate**: App Viewer's Gap Decisions pane restructured as a 3-step pipeline. Batch extract intents from all modules, auto-resolve gaps whose referenced objects exist, batch generate code with multi-pass dependency retry (max 20 passes). Same retry pattern as query imports.
- **Intent dependency checking**: `checkIntentDependencies()` and `autoResolveGaps()` in `server/routes/chat/context.js`. `POST /api/chat/generate-wiring` accepts `check_deps: true` to skip generation when deps unsatisfied.
- **3 new transforms**: `set-batch-generating`, `set-batch-gen-progress`, `set-batch-gen-results` (registered in core.cljs, domain count 11→14).
- **`batch-generate-code-flow`** in `flows/app.cljs` — loads all modules with intents, multi-pass generation with dependency retry, saves CLJS back to each module.
- **Pipeline UI**: `app_viewer.cljs` gap-decisions-pane now shows numbered step headers (Extract Intents → Resolve Gaps → Generate Code) with progress bars and color-coded results summary.
- **PRODUCT.md**: Full product description covering import pipeline, intent extraction, transform architecture as prelude to AI automation, three-phase trajectory (migration → AI-assisted → AI-automated).
- **Automatic .mdb → .accdb conversion**: `convert_mdb.ps1` converts Access 97-2003 .mdb files to .accdb via `Access.Application.SaveAsNewDatabase`. Wired into `GET /api/access-import/database` — user selects an .mdb, pipeline silently converts and runs unchanged. Response includes `convertedFrom` field.
- **Automatic AutoExec disabling**: `disable_autoexec.ps1` renames AutoExec → xAutoExec via `DAO.DBEngine.120` (engine-level, no macro trigger). Called before/after listing scripts in the `/database` endpoint. No more manual renaming needed.
- **README rewrite**: "Copy the intent, not the code" philosophy — explains intent extraction pipeline as the core differentiator. Added AI-Assisted Setup section (shell-access vs chat-only tools). Added appendix positioning AccessClone as an AI agent substrate for OpenClaw integration.
- **INSTRUCTIONS.md rewrite**: Distinguishes shell-access tools (Claude Code, Codex, Cursor) from chat-only tools (ChatGPT, Claude web) with mode-specific guidance throughout all setup steps.

### Previously Shipped (2026-02-16)
- **Access &-hotkey rendering**: Captions with `&` markers now render the hotkey letter underlined (e.g. `"&Save"` → "**S**ave"). Alt+letter activates the matching control. Implementation: `render-hotkey-text` and `extract-hotkey` in `editor_utils.cljs`, hotkey handler in `form_view.cljs`, `.hotkey` CSS class. Applies to all control types via `display-text` (forms and reports). `strip-access-hotkey` made public for plain-text matching in `resolve-button-action`.

### Previously Shipped (2026-02-12)
- **LLM fallback for query conversion** (PR #23): When the regex-based Access→PG converter produces SQL that fails execution, automatically falls back to Claude Sonnet with schema context (tables, views, columns, functions), control mappings, and the PG error message. LLM-assisted conversions flagged in `shared.import_issues` with category `llm-assisted`. Graceful degradation when no API key configured.
- **VBA stub function generator**: `createStubFunctions()` parses VBA modules for function declarations and creates placeholder PG functions so views can reference user-defined functions. Endpoint: `POST /api/access-import/create-function-stubs`.
- **Query converter fixes**: EXTRACT(YEAR FROM ...) no longer schema-prefixes the FROM keyword. DAO parameters that are actually form/parent refs (`[Parent].[EmployeeID]`, `[Table].[Column]`) filtered out — queries stay as views instead of becoming functions.
- **Table-level form state sync**: `shared.form_control_state` keyed by `(session_id, table_name, column_name)`. `shared.control_column_map` maps form controls → table.column at save time. Query converter resolves `[Forms]![frmX]![ctrl]` via this mapping. See `skills/form-state-sync.md` for full architecture.
- **Import order**: tables → forms/reports → queries → macros → modules. Forms must be imported before queries so control_column_map exists.
- **Tested against two databases**: Northwind and a second Access database both import fully (tables, forms, reports, queries, modules, macros) without errors.

### In Progress / Uncommitted
Working tree is clean as of 2026-02-20. All hub, primitives, and notes work has been committed and pushed.

### Next Up
- Connect remaining hub sections to real functionality (Meetings, Messaging, Email are still stubs — Notes is now live)
- Link structural expression nodes to the seeded primitive potentials (e.g., link actual schema tables to "Schema Isolation" potential)
- Explore reflexivity: can the system reason about which primitives apply to a new migration target?
- Place `.accdb` source files in `databases/accessclone/source/` and `databases/threehorse/source/`
- Start importing into the new databases
- Clean up stale feature branches (22 listed)
- Test batch pipeline end-to-end: extract all → resolve gaps → generate all code against a real database
- Test .mdb → .accdb conversion end-to-end with a real .mdb file
- Test runtime form state sync end-to-end
- OpenClaw skill prototype: export intent graph + form definitions in a format an OpenClaw agent can consume

---

## Known Landmines

### API Contract Changes
- `PUT /api/form-state` now expects `{sessionId, entries: [{tableName, columnName, value}]}`. The old format `{sessionId, formName, controls: {...}}` no longer works. Both server and frontend are updated.
- `GET /api/data/:table` no longer reads `X-Form-Name` header or sets `app.active_form`. Only `X-Session-ID` and `X-Database-ID` headers matter now.
- Graph endpoints renamed: `/api/graph/intents` → `/api/graph/potentials`, `/api/graph/intent` → `/api/graph/potential`, etc.
- Chat tools renamed: `query_intent` → `query_potential`, `propose_intent` → `propose_potential`

### Schema Migration
- `server/graph/schema.js` has migration blocks that run on startup:
  - Renames `intent` → `potential` nodes, deletes `application` nodes, updates `valid_scope` constraint
  - Renames `form_name` → `table_name` and `control_name` → `column_name` in `form_control_state` (older migration)

### Name Sanitization
- `sanitizeName()` in `query-converter.js` lowercases and replaces spaces with underscores, strips non-alphanumeric chars. All table names, column names, form names, and control names go through this. If you're comparing names across systems, always sanitize both sides.

### ClojureScript State Atom
- All state lives in a single Reagent atom `app-state` shared across `state.cljs`, `state_form.cljs`, and `state_report.cljs`. Mutations use `swap! app-state assoc-in [path...]`. Be careful with concurrent updates to nested paths.

### Form Definitions
- Controls have `:type` as keyword after normalization (`:text-box`, `:combo-box`), but arrive as strings from JSON round-trips. `normalize-form-definition` in `state_form.cljs` handles coercion. If you add new control properties, add normalization there too.

### Query Converter Pipeline
- **Regex converter** (`server/lib/query-converter/`): deterministic, fast, free — handles ~90% of queries. Split into modules: `index.js` (entry), `syntax.js` (brackets, operators, schema prefixing), `functions.js` (Access→PG function map), `ddl.js` (view/function DDL generation), `form-state.js` (form/TempVar ref resolution), `utils.js` (sanitizeName).
- **LLM fallback** (`server/lib/query-converter/llm-fallback.js`): called when regex output fails PG execution. Sends original Access SQL + failed PG SQL + error + full schema context (tables, views, columns, functions) to Claude Sonnet. Response parsed, executed in transaction.
- **VBA stubs** (`server/lib/vba-stub-generator.js`): creates placeholder PG functions from VBA module declarations so views referencing UDFs can be created before full VBA translation.

### Test Coverage
- `server/__tests__/query-converter.test.js` — 95 tests, comprehensive. Touch the converter? Run these.
- `server/__tests__/vba-stub-generator.test.js` — stub generator tests.
- No tests for route handlers. These are tested manually via the import pipeline.
- Frontend has no automated tests. Verify with `cd ui && npx shadow-cljs compile app` (should show only 2 harmless `no.en.core` redef warnings).

---

## Conventions

### Server-Side
- **Error logging**: `logError(pool, source, message, err, {databaseId})` for real errors. `logEvent(pool, 'warning', source, message, {databaseId, details})` for graceful degradation. Source format: `"METHOD /api/path"`.
- **Route structure**: Each route file exports `function(pool)` (or `function(pool, secrets)` for routes needing API keys) that returns an Express router.
- **Non-critical side effects** (graph population, control-column mapping) run outside the main transaction, wrapped in try/catch that logs warnings but doesn't fail the request.
- **Schema per database**: Each imported Access database gets its own PostgreSQL schema. The schema name comes from `shared.databases.schema_name`, selected by the `X-Database-ID` header.

### Frontend (ClojureScript)
- **Error reporting**: `log-error!` for user-visible errors (shows banner + logs to server). `log-event!` for background errors (server log only, no banner).
- **API calls**: Always use `db-headers` for the headers map. It includes `X-Session-ID` and `X-Database-ID`.
- **Naming**: ClojureScript uses kebab-case (`record-source`). JSON keys preserve Access-style kebab-case (`record-source`, `control-source`). PostgreSQL uses snake_case.

### Git
- Commit messages: imperative mood, 1-2 sentence summary, then details if needed.
- Co-author line: `Co-Authored-By: <Model> <noreply@anthropic.com>` (or appropriate email).
- Don't push to main without running tests (`npx jest`) and compiling frontend (`npx shadow-cljs compile app`).
