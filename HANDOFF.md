# Handoff Notes

Shared scratchpad for AI assistants working on this codebase. Read this at session start. Update it after significant changes.

---

## Current State

### Just Shipped (2026-03-18)
- **SaveAsText rewrite of all export scripts**: Rewrote all 4 PowerShell export scripts from COM design-view to `Application.SaveAsText` parsing:
  - `export_form.ps1` / `export_forms_batch.ps1` — context stack parser handling nested labels, tab controls with pages
  - `export_report.ps1` / `export_reports_batch.ps1` — simpler parser (all controls at same depth)
  - Both batch scripts include COM health check with auto-reconnect, `$accessApp.Visible = $false`
- **Macro export fixes**: Added `$accessApp.Visible = $false` to `export_macro.ps1` and `export_macros_batch.ps1`. Changed batch timeout from `max(60s, 10s/macro)` to `60s + 2s/macro` in `server/routes/database-import/export.js`.
- **cranbrook14 full pipeline success**: All 33 forms with controls (previously 7 had 0), all 7 reports with controls (MPG=26, Miles=35, RN=24), 38 modules translated, queries imported with multi-pass retry. First fully successful import of a complex .mdb database.
- **Business intent extraction** (March 17): LLM extracts purpose/category/data-flows/gaps from forms, reports, queries. Runs in import pipeline and as manual button in App Viewer. Stored in JSONB columns on shared.forms/reports/view_metadata. Integrated into chat context.

### Previously Shipped (2026-03-16)
- **Import pipeline folder rename**: `server/routes/access-import/` renamed to `server/routes/database-import/` to make the import pipeline platform-agnostic for upcoming FoxPro support. All references updated across frontend and backend. API prefix is `/api/database-import`.
- **Qualifying analysis: Import Difficulty Assessment**: New section in `scripts/qualifying-analysis.ps1` that scores databases on import difficulty (0-10+ weighted score) and recommends auto-import vs individual import.
  - Scoring based on: tables without PKs, action/crosstab/passthrough queries, form-referencing queries, complex forms (10+ events), subforms, VBA external deps, large modules, problematic column types.
  - Three levels: Low (0-2) = auto-import, Moderate (3-5) = auto with attention, High (6+) = individual import with suggested order (tables -> forms -> queries -> modules -> macros).
  - Report includes **Risk Factors** (what drives the score) and **Objects to Watch** (specific items needing attention with reasons).
- **Qualifying analysis: Timeout protection**: Access.Application phase now runs in a PowerShell background job with 120s timeout. If Access hangs (common with .mdb files that have VBA compile errors like missing PtrSafe, or startup forms), the script degrades gracefully and reports what DAO captured (tables, queries, relationships).
- **Qualifying analysis: AutoExec handling**: Calls `scripts/access/disable_autoexec.ps1` before opening with Access.Application, restores after. Prevents AutoExec macros from blocking the analysis.
- **Tested on ms-cranbrook.mdb**: Vehicle maintenance tracker (20 tables, 36 queries, 33 forms, 38 VBA modules/3,203 lines, 24 macros). Scored 9/High — correctly recommended individual import. Hit the PtrSafe compile error (32-bit API Declares in 64-bit Access), timeout caught it gracefully.

### Previously Shipped (2026-03-14)
- **Three Horse website initial build**: The threehorse database now functions as a public-facing website using the platform's own form rendering.
  - `skills/three-horse-chat.md`: System prompt for the Three Horse chat — distilled from `THREE-HORSE-PRELIMINARY.md` and `scripts/qualifying-guide.md`. Covers what TH does, platforms, migration process, AI partner, pricing, qualifying analysis tool, tone guidelines.
  - `server/routes/chat/index.js`: When `database_id === 'threehorse'`, uses the Three Horse skills file as the base system prompt instead of the generic AccessClone prompt. Page-specific context added based on which form is open (About, Qualifying Analysis, How It Works). Uses `claude-haiku-4-5` (cheap model) with no tools (pure conversation).
  - Three unbound forms (no record source) inserted into `shared.forms` as website pages: **About** (problem, solution, AI partner, platforms), **Qualifying Analysis** (what it does, safety, report contents, how to start), **How It Works** (6-step migration walkthrough). SQL seed script at `databases/threehorse/seed-pages.sql`.
  - Pages render in the center pane via standard form rendering. Chat pane has Three Horse context. Left nav shows the three pages.

### Previously Shipped (2026-03-13)
- **Event Runtime — Forms & Reports**: Full intent interpreter for executing translated VBA event handlers client-side.
  - **Expression evaluator**: Added `And`, `Or`, `Not` logical operators and `IsNull()` function to `expressions.cljs`. Precedence: comparison → NOT → AND → OR. Access convention: -1 = True, 0 = False.
  - **Async intent interpreter**: Rewrote `intent_interpreter.cljs` from sync `doseq` to async `go` loop. `execute-single-intent` returns nil (sync) or channel (async). Context map (`ctx`) threads `:last-result` and named `result_var` through the loop.
  - **Domain functions**: `dlookup`, `dcount`, `dsum` via `POST /api/queries/run`; `run-sql` via new `POST /api/queries/execute` (INSERT/UPDATE/DELETE only, rejects SELECT/DROP/ALTER/TRUNCATE).
  - **Criteria resolution**: Two-stage — `resolve-criteria-placeholders` replaces `{FieldName}` with actual values (numbers inline, strings single-quoted), then `convert-criteria` converts `[field]` → `"field"`, `#date#` → `'date'`, `True`/`False` → `true`/`false`.
  - **Report events**: `on-open` (after preview data loads with data), `on-close` (leaving preview or closing tab), `on-no-data` (0 rows). `load-event-handlers-for-report!` fetches `Report_{name}` handlers; `fire-report-event!` dispatches.
  - **Focus events**: `on-enter`, `on-gotfocus`, `on-exit`, `on-lostfocus` wired to `.view-control` wrapper div via React `onFocus`/`onBlur` bubbling. Only controls with focus event flags in `field-triggers` get handlers attached.
  - **New endpoint**: `POST /api/queries/execute` in `metadata.js` — executes DML SQL with schema search_path.
  - **New doc**: `skills/event-runtime.md` — comprehensive reference for the event runtime system.
  - **Server**: Added `'nodata': 'on-no-data'` to event map in `modules.js`.
  - Cache buster bumped to `?v=14`.
  - Files modified: `expressions.cljs`, `intent_interpreter.cljs`, `state_report.cljs`, `form_view.cljs`, `flows/report.cljs`, `flows/navigation.cljs`, `modules.js`, `metadata.js`, `index.html`, `CLAUDE.md`
- **Three Horse business concept**: Preliminary business plan in `THREE-HORSE-PRELIMINARY.md`. Three entry points (legacy migration, spreadsheet extraction, app builder), flat-fee revenue model, qualifying analysis, LLM-powered self-service modification. Next platform targets: FoxPro, then Paradox. Domain: three.horse.

### Previously Shipped (2026-03-10)
- **Form View color/layout fidelity overhaul**: Fixed multiple rendering issues where Form View didn't match Access's visual output.
  - **Rectangle z-index**: Decorative controls (rectangles, lines) were rendering on top of interactive controls (buttons, text boxes) because all use `position: absolute` and DOM order determined stacking. Fix: `z-index: 0` on `.view-control.rectangle, .view-control.line` + `pointer-events: none` on `.view-rectangle`. Control type now added as CSS class on `.view-control` div for targeting.
  - **Section background colors**: `section-view-style` in `form_view.cljs` now applies `:back-color` as CSS `background-color` on section divs.
  - **Control fore-color/back-color**: `control-style` in `editor_utils.cljs` now maps `:fore-color` → CSS `color` and `:back-color` → CSS `background-color`, gated by `back-style` (Access BackStyle property: 0=Transparent, 1=Normal).
  - **BackStyle property import**: Added `BackStyle` export to both `export_form.ps1` and `export_forms_batch.ps1`. Frontend converts `backStyle` → `:back-style` in `control-base` (`access_database_viewer.cljs`). Type-based fallback for older imports without `back-style` — labels, option-buttons, check-boxes, toggle-buttons, images, lines default to transparent; all others default to opaque.
  - **CSS inherit pattern**: Removed hardcoded colors from `.view-label`, `.view-button`, `.view-input`, `.view-option-group`, `.view-select` — all now use `color: inherit; background: inherit` so Access properties flow through from parent `.view-control` inline styles.
  - **Section flex layout**: Added `flex: 0 0 auto` to `.view-section.header, .view-section.footer` so they respect their Access-derived heights. Detail section uses `flex: 1`.
  - **Cache busters**: Bumped `index.html` CSS/JS query params to `?v=8`.
  - Files modified: `style.css`, `form_view.cljs`, `editor_utils.cljs`, `access_database_viewer.cljs`, `index.html`, `export_form.ps1`, `export_forms_batch.ps1`

### Previously Shipped (2026-03-09)
- **Server-side module translation during import**: New `POST /api/database-import/translate-modules` endpoint does the full extract→map→resolve→generate pipeline for all modules in one server call. Replaces the old fragile frontend orchestration (`batch-extract-intents!` → `auto-resolve-gaps!` → `batch-generate-code!`) which made N sequential LLM HTTP calls per module and silently failed. The new endpoint handles errors per-module so one failure doesn't abort the chain.
  - New file: `server/routes/database-import/translate-modules.js`
  - Extracted `autoResolveGapsLLM()` from inline chat handler into `server/routes/chat/context.js` for reuse
  - `import-all!` now calls the endpoint after the queries phase (`:translating` phase)
  - `auto-import-all!` simplified — translation handled inside `import-all!`
  - Import completeness banners (module_viewer, macro_viewer) changed from "blocked" to informational — translation was never actually gated, just the message was misleading
- **Personalized form/report versions + audit trail**: Users get their own version of forms/reports that diverges from the shared "standard" version.
  - `owner` column on `shared.forms` / `shared.reports`: `'standard'` = shared version, Windows username = personalized version. `modified_by` column tracks who created each version (audit trail).
  - `X-User-ID` header carries Windows username from frontend to server. `GET /api/whoami` returns `os.userInfo().username` for initialization.
  - **Load resolution**: `GET /api/forms/:name` returns personalized version if it exists for the user, otherwise standard. Response includes `_personalized: true/false`.
  - **Save semantics**: User edits fork into personalized versions. System processes (import, autofix, repair, validation, design-check) always operate on `owner = 'standard'`.
  - **Promote to Standard**: `POST /api/forms/:name/promote` copies a personalized definition as the new standard version for all users.
  - **Reset to Standard**: `DELETE /api/forms/:name/personalization` discards the user's personalized version.
  - UI: "(Personalized)" badge in form/report toolbars, "Promote to Standard" and "Reset to Standard" buttons visible when viewing a personalized version.
  - Same endpoints exist for reports (`/api/reports/:name/promote`, `/api/reports/:name/personalization`).
- **Multi-pass import pipeline**: Import now runs 4 passes automatically:
  - Pass 1: Faithful import (tables → forms → queries → modules → macros) — unchanged
  - Pass 2: Repair — validates field bindings (case-insensitive fix), checks record-source existence, reconciles control_column_map
  - Pass 3: Validation — runs structural + cross-object lint, checks subform references, validates combo-box SQL via EXPLAIN
  - Pass 4: Design review — LLM-based analysis against user-editable design patterns (`settings/design-patterns.json`)
- **Unified import log**: `shared.import_issues` migrated into `shared.import_log` (new columns: run_id, pass_number, phase, action, severity, category, message, suggestion, resolved). All 13 INSERT sites across 6 files updated.
- **Import runs**: New `shared.import_runs` table tracks each import with start/end times, status, and summary. Endpoints: `POST /api/database-import/start-run`, `POST /api/database-import/complete-run`, `GET /api/database-import/run/:runId`.
- **Design check system**: Standalone capability accessible from import (pass 4), App Viewer ("Run Design Check" button), and chat (LLM tool `run_design_check`). Checks configurable via `settings/design-patterns.json` (12 checks across architecture, UX, LLM-legibility). Endpoints: `GET/PUT /api/design-check/patterns`, `POST /api/design-check/run`.
- **Enhanced import log panel**: Groups entries by pass number with color-coded severity (info=grey, warning=amber, error=red). Shows design recommendations with accept/dismiss affordance.
- New files: `repair-pass.js`, `validation-pass.js`, `run.js` (in database-import/), `design-check.js` (in routes/), `design-patterns.json` (in settings/)

### Previously Shipped (2026-03-08)
- **SaveAsText-based image extraction**: Rewrote `scripts/access/export_images.ps1` to use `Application.SaveAsText` instead of COM `PictureData` property reading (which never worked). Stack-based parser extracts `PictureData` hex blocks from SaveAsText text output. Also handles non-PictureData property blocks (`ObjectPalette`, `NameMap`, etc.) so their `End` doesn't mis-pop the structural stack.
  - **MSysResources attachment fix**: `Data` column is type 101 (attachment field), not a simple blob. Uses child recordset + `SaveToFile` instead of `GetChunk`.
  - **DIB format support**: Access stores many embedded images as raw BITMAPINFOHEADER (no BMP file header). `Find-ImageStart` now detects DIB signatures and `Convert-HexToImage` prepends a 14-byte BMP file header so browsers can render them.
  - **Shared image resolution**: Parser tracks `Picture` property on stack entries. When an entry is popped with a `Picture` ref but no `PictureData`, looks up the name in MSysResources shared images.
  - **Tested on Northwind**: 15 shared PNGs loaded from MSysResources, 2 shared images resolved in forms (frmStartup, frmLogin), 2 embedded DIB images extracted from rptLearn.
  - **Ready to test full pipeline**: Run `POST /api/database-import/import-images` with `{"databasePath": "C:\\Users\\Ken\\Desktop\\cloneexamples\\northwinddev.accdb", "targetDatabaseId": "northwind4"}` to import images into form/report definitions in PostgreSQL. Then check forms in the app for visible images.
- **Auto-apply assessment fixes during import**: Assessment findings are now applied automatically — no user decisions needed. The widget is read-only informational; fixes execute during the import pipeline.
  - New endpoint: `POST /api/database-import/apply-fixes` in `server/routes/database-import/apply-fixes.js`. Accepts `skipEmptyTables`, `relationships`, `installTablefunc`, `reservedWords`. Each fix attempted individually with try/catch, results logged to `shared.import_log`.
  - `import-all!` in `access_database_viewer.cljs` now extracts fix data from assessment findings, filters empty tables out of the tables phase, and calls apply-fixes after tables are imported.
  - Assessment widget in `main.cljs` simplified: removed `import-mode` atom, radio buttons, checkboxes. Now shows findings as read-only list with a note that fixes are auto-applied.
  - Cleaned up `toggle-assessment-check` transform (removed from `ui.cljs` and `core.cljs`).
  - Reserved words are informational only — `sanitizeName()` + `quoteIdent()` already handle quoting.

### Previously Shipped (2026-03-05)
- **Projection Phase 0-3**: Pure data projection in `ui/src/app/projection.cljs` — a complete snapshot of form data concerns extracted from the form definition and kept in sync with live data.
  - Phase 0: `build-projection` extracts bindings, computed fields, row-sources, subforms, events, and field triggers from the form definition.
  - Phase 1: `hydrate-bindings`/`sync-records`/`sync-position` populate bindings with live record data. Wired in `state_form.cljs`.
  - Phase 2: Computed field evaluation + field-edit sync. `evaluate-computed` runs all computed fields after hydration; `evaluate-computed-for` selectively re-evaluates fields whose deps intersect changed fields; `update-field` updates a binding + re-evaluates dependents.
  - Phase 3: Row-source options mirrored into projection. `populate-row-source` sets `:options` on the matching row-source entry by `:source` string. Value-lists (e.g. `"Yes;No;Maybe"`) parsed eagerly at build time in `extract-row-sources`. SQL/query row-sources populated async when `cache-row-source!` fires in `state_form.cljs`.
  - **Still additive** — UI reads from `[:form-editor :row-source-cache]` not the projection. No UI behavior changed yet.
  - **Gotcha**: `flows/form.cljs` has a duplicate of `setup-form-editor!` in `load-form-for-editing-flow` — must keep both in sync (was missing `:projection` key).

### Previously Shipped (2026-03-02)
- **Updatable query support**: Forms whose record source is a multi-table view (like `qryOrder` joining `orders` + `orderstatus`) can now be edited. Full pipeline: `shared.view_metadata` stores base table, PK, and writable columns at import time. `resolveWriteTarget()` redirects writes to the base table. Non-writable lookup fields are greyed out and disabled in forms. After UPDATE, the in-memory record is preserved (not replaced by server response, which would lose lookup columns). After INSERT, server response is merged to pick up auto-generated PK. See `skills/updatable-queries.md`.

### Previously Shipped (2026-02-25)
- **Stripped Notes/Hub/Corpus code**: Removed hub.cljs, notes.cljs, llm_registry.cljs, meetings.cljs, messaging.cljs, email.cljs, flows/notes.cljs, transforms/notes.cljs, server/routes/notes.js, server/lib/llm-router.js, server/lib/embeddings.js, skills/notes-corpus.md, docs/corpus-medium-plans.md. Removed corpus_entries/corpus_retrievals tables and pgvector from schema.js. Removed llm-registry from config.json. Cleaned CSS (~750 lines), CLAUDE.md, codebase-guide.md. AccessClone is now purely the Access→PostgreSQL conversion tool. Historical references in sessions below are for context only.

### Previously Shipped (2026-02-24)
- **Pre-import database assessment**: Deterministic analysis of Access databases before import. `POST /api/database-import/assess` checks scan data for structural issues (reserved words, missing PKs), design issues (wide tables, empty unreferenced tables, missing relationships), and complexity issues (large VBA modules, crosstab queries, naming inconsistency). Results appear as an interactive widget in the chat panel.
  - Server: `server/routes/database-import/assess.js` — assessment endpoint with PG reserved word list, naming pattern detection, relationship heuristics.
  - PowerShell: `scripts/access/list_relationships.ps1` — extracts Access relationships via DAO, wired into `GET /api/database-import/database`.
  - Frontend: 3 transforms (`set-assessment`, `toggle-assessment-check`, `clear-assessment`), `run-assessment-flow` in `flows/ui.cljs`. Assessment triggers on target DB selection and after source DB scan loads; guards against re-running.
  - Widget: collapsible sections (structural/design/complexity), read-only informational display. Fixes auto-applied during import (see 2026-03-08).
  - LLM-enhanced: after deterministic assessment, findings + scan summary auto-sent to LLM for domain-aware analysis. Assessment context threaded into chat system prompt via `assessment_context` in `state.cljs` and `chat/index.js`.
- **AI agent import skill**: `skills/ai-import.md` documents two paths — full-pipeline (Claude Code, local machine) and post-extraction (Codex, cloud sandbox) — with complete API reference, PowerShell scripts table, and gotchas.
- **Unified corpus schema**: `shared.corpus_entries` expanded with `medium` column (default 'note'), plus `author`, `recipients`, `thread_id`, `session_id`, `subject`, `metadata` (JSONB). Partial indexes for zero cost on existing notes. All new columns nullable with defaults.
- **Multi-model LLM routing**: Secretary model (Claude Opus) routes entries to the most appropriate responder. LLM registry in `settings/config.json` defines 4 models (Claude Opus, Claude Sonnet, GPT-5.2, Gemini 3.1 Pro). `server/lib/llm-router.js` handles multi-provider dispatch. `server/lib/embeddings.js` for pgvector-backed semantic retrieval.
- **Regenerate responses**: `POST /api/notes/:id/regenerate` with user-chosen model, temperature, and sampling strategy. Response conditions UI with editable dropdowns per card.
- **Frontend**: LLM registry view (`llm_registry.cljs`), sidebar improvements, hub tweaks, 8 notes transforms, 4 notes flows.

### Previously Shipped (2026-02-20)
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
- **Automatic .mdb → .accdb conversion**: `convert_mdb.ps1` converts Access 97-2003 .mdb files to .accdb via `Access.Application.SaveAsNewDatabase`. Wired into `GET /api/database-import/database` — user selects an .mdb, pipeline silently converts and runs unchanged. Response includes `convertedFrom` field.
- **Automatic AutoExec disabling**: `disable_autoexec.ps1` renames AutoExec → xAutoExec via `DAO.DBEngine.120` (engine-level, no macro trigger). Called before/after listing scripts in the `/database` endpoint. No more manual renaming needed.
- **README rewrite**: "Copy the intent, not the code" philosophy — explains intent extraction pipeline as the core differentiator. Added AI-Assisted Setup section (shell-access vs chat-only tools). Added appendix positioning AccessClone as an AI agent substrate for OpenClaw integration.
- **INSTRUCTIONS.md rewrite**: Distinguishes shell-access tools (Claude Code, Codex, Cursor) from chat-only tools (ChatGPT, Claude web) with mode-specific guidance throughout all setup steps.

### Previously Shipped (2026-02-16)
- **Access &-hotkey rendering**: Captions with `&` markers now render the hotkey letter underlined (e.g. `"&Save"` → "**S**ave"). Alt+letter activates the matching control. Implementation: `render-hotkey-text` and `extract-hotkey` in `editor_utils.cljs`, hotkey handler in `form_view.cljs`, `.hotkey` CSS class. Applies to all control types via `display-text` (forms and reports). `strip-access-hotkey` made public for plain-text matching in `resolve-button-action`.

### Previously Shipped (2026-02-12)
- **LLM fallback for query conversion** (PR #23): When the regex-based Access→PG converter produces SQL that fails execution, automatically falls back to Claude Sonnet with schema context (tables, views, columns, functions), control mappings, and the PG error message. LLM-assisted conversions flagged in `shared.import_issues` with category `llm-assisted`. Graceful degradation when no API key configured.
- **VBA stub function generator**: `createStubFunctions()` parses VBA modules for function declarations and creates placeholder PG functions so views can reference user-defined functions. Endpoint: `POST /api/database-import/create-function-stubs`.
- **Query converter fixes**: EXTRACT(YEAR FROM ...) no longer schema-prefixes the FROM keyword. DAO parameters that are actually form/parent refs (`[Parent].[EmployeeID]`, `[Table].[Column]`) filtered out — queries stay as views instead of becoming functions.
- **Table-level form state sync**: `shared.form_control_state` keyed by `(session_id, table_name, column_name)`. `shared.control_column_map` maps form controls → table.column at save time. Query converter resolves `[Forms]![frmX]![ctrl]` via this mapping. See `skills/form-state-sync.md` for full architecture.
- **Import order**: tables → forms/reports → queries → macros → modules. Forms must be imported before queries so control_column_map exists.
- **Tested against two databases**: Northwind and a second Access database both import fully (tables, forms, reports, queries, modules, macros) without errors.

### Session Notes (2026-03-19)
- **Unbound forms showing "no records"**: `record-source` stored as `""` (empty string) was truthy in ClojureScript, bypassing the unbound-form render path. Fixed with `not-empty` in `form_view.cljs`, `state_form.cljs` (2 sites), and `flows/form.cljs`.
- **Division by zero in converted queries**: Added blanket `NULLIF(denominator, 0)` transform to `syntax.js` (`withStringLiteralsMasked` protects string literals). Applies to simple identifier denominators only. Design note in `skills/conversion-queries.md`.
- **translate-modules double-run**: Server-side `activeTranslations` Set in `translate-modules.js` blocks concurrent calls for the same database. Cause of duplicate was likely UI triggering import twice before guard flag was set.
- **`server/rebuild.bat`**: New script — compiles ClojureScript then starts the server (`set PGPASSWORD=7297`). Lives in `server/` folder, run directly when server is stopped.

### In Progress / Uncommitted
Working tree has uncommitted changes for: SaveAsText rewrite of all 4 export scripts (forms/reports single+batch), macro export Visible fix + timeout change, business intent extraction, lint test updates, schema updates, event-mapping module, wire-events module, and various route/frontend updates. SaveAsText now exports BackStyle so newly imported forms get correct transparency values.

### Next Up — Image Import Test
With the server running, test the full image import pipeline for Northwind:

curl -X POST http://localhost:3000/api/database-import/import-images -H "Content-Type: application/json" -d "{\"databasePath\": \"C:\\\\Users\\\\Ken\\\\Desktop\\\\cloneexamples\\\\northwinddev.accdb\", \"targetDatabaseId\": \"northwind4\"}"

This will run export_images.ps1 against all 28 forms and 15 reports, extract shared + embedded images, and patch the form/report definitions in PostgreSQL with data URIs. Then open forms in the app to verify images are visible.

Check results with: `GET /api/database-import/image-status?targetDatabaseId=northwind4`

### Next Up — Other
- Connect remaining hub sections to real functionality (Meetings, Messaging, Email are still stubs — Notes is now live)
- Link structural expression nodes to the seeded primitive potentials (e.g., link actual schema tables to "Schema Isolation" potential)
- Explore reflexivity: can the system reason about which primitives apply to a new migration target?
- Place `.accdb` source files in `databases/accessclone/source/` and `databases/threehorse/source/`
- Start importing into the new databases
- Clean up stale feature branches (22 listed)
- Test server-side module translation end-to-end: re-run auto-import and verify modules have intents + CLJS translations afterward
- Test .mdb → .accdb conversion end-to-end with a real .mdb file
- Test runtime form state sync end-to-end
- OpenClaw skill prototype: export intent graph + form definitions in a format an OpenClaw agent can consume

---

## Known Landmines

### API Contract Changes
- `X-User-ID` header now sent with all API requests (from `db-headers`). Server extracts as `req.userId`. Forms/reports load and save are owner-aware.
- `PUT /api/forms/:name` and `PUT /api/reports/:name` accept `?standard=true` query param to force saving as the standard version (used by system processes like import/autofix).
- `PUT /api/form-state` now expects `{sessionId, entries: [{tableName, columnName, value}]}`. The old format `{sessionId, formName, controls: {...}}` no longer works. Both server and frontend are updated.
- `GET /api/data/:table` no longer reads `X-Form-Name` header or sets `app.active_form`. Only `X-Session-ID` and `X-Database-ID` headers matter now.
- Graph endpoints renamed: `/api/graph/intents` → `/api/graph/potentials`, `/api/graph/intent` → `/api/graph/potential`, etc.
- Chat tools renamed: `query_intent` → `query_potential`, `propose_intent` → `propose_potential`

### Schema Migration
- `server/graph/schema.js` has migration blocks that run on startup:
  - Adds `owner TEXT DEFAULT 'standard'` and `modified_by TEXT` to `shared.forms` and `shared.reports`. Backfills NULL owners to `'standard'`. Creates unique indexes on `(database_id, name, owner) WHERE is_current = true`.
  - Renames `intent` → `potential` nodes, deletes `application` nodes, updates `valid_scope` constraint
  - Renames `form_name` → `table_name` and `control_name` → `column_name` in `form_control_state` (older migration)
  - Migrates `shared.import_issues` → `shared.import_log` (copies rows, drops old table). Idempotent.

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
- `server/__tests__/llm-router.test.js` — LLM router tests (multi-provider dispatch, model registry).
- No tests for route handlers. These are tested manually via the import pipeline.
- Frontend has no automated tests. Verify with `cd ui && npx shadow-cljs compile app` (should show only 5 harmless warnings: 2 `no.en.core` redefs + 3 others).

---

## Conventions

### Server-Side
- **Error logging**: `logError(pool, source, message, err, {databaseId})` for real errors. `logEvent(pool, 'warning', source, message, {databaseId, details})` for graceful degradation. Source format: `"METHOD /api/path"`.
- **Route structure**: Each route file exports `function(pool)` (or `function(pool, secrets)` for routes needing API keys) that returns an Express router.
- **Non-critical side effects** (graph population, control-column mapping) run outside the main transaction, wrapped in try/catch that logs warnings but doesn't fail the request.
- **Schema per database**: Each imported Access database gets its own PostgreSQL schema. The schema name comes from `shared.databases.schema_name`, selected by the `X-Database-ID` header.

### Frontend (ClojureScript)
- **Error reporting**: `log-error!` for user-visible errors (shows banner + logs to server). `log-event!` for background errors (server log only, no banner).
- **API calls**: Always use `db-headers` for the headers map. It includes `X-Session-ID`, `X-Database-ID`, and `X-User-ID`.
- **Naming**: ClojureScript uses kebab-case (`record-source`). JSON keys preserve Access-style kebab-case (`record-source`, `control-source`). PostgreSQL uses snake_case.

### Git
- Commit messages: imperative mood, 1-2 sentence summary, then details if needed.
- Co-author line: `Co-Authored-By: <Model> <noreply@anthropic.com>` (or appropriate email).
- Don't push to main without running tests (`npx jest`) and compiling frontend (`npx shadow-cljs compile app`).
