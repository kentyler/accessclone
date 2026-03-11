# Project Tasks

## Pending

- [ ] **Test image import end-to-end** — Run `POST /api/access-import/import-images` against northwind4, verify images appear in form/report definitions and render in the app. Check `GET /api/access-import/image-status?targetDatabaseId=northwind4`.
- [ ] **Add file picker option for import mode** — Add a file picker as an alternative to the full machine scan when importing Access databases. Users should be able to directly select a .accdb/.mdb file instead of having their entire machine scanned for database files.
- [ ] **Test server-side module translation end-to-end** — Re-run auto-import on northwind4 and verify modules have intents + CLJS translations afterward. The old frontend orchestration silently failed; the new `POST /api/access-import/translate-modules` endpoint should handle it.
- [ ] **Test .mdb → .accdb conversion end-to-end** — Test with a real .mdb file to verify the conversion pipeline works.
- [ ] **Test runtime form state sync end-to-end** — Open a form, navigate records, verify `form_control_state` is populated and dependent views filter correctly.
- [ ] **OpenClaw skill prototype** — Export intent graph + form definitions in a format an OpenClaw agent can consume.
- [ ] **Upload social preview image** — Set `docs/social-preview.png` as the repo social preview in GitHub Settings → Social preview (manual step).

## In Progress

## Completed

- [x] **Form View color/layout fidelity** — Fixed rectangle z-index covering buttons, added section background colors, control fore-color/back-color with BackStyle transparency, CSS inherit pattern for inner elements, flex layout for header/footer sections. Updated PowerShell scripts to export BackStyle. (2026-03-10)

- [x] **Server-side module translation** — New `POST /api/access-import/translate-modules` endpoint replaces fragile frontend N-sequential-LLM orchestration. Extracted `autoResolveGapsLLM()` into reusable function. Import completeness banners changed from "blocked" to informational. (2026-03-09)
- [x] **Multi-pass import + design revision** — 4-pass import pipeline (faithful → repair → validate → design review), unified import_log replacing import_issues, import_runs tracking, design check system (import/App Viewer/chat tool), enhanced log panel with pass grouping. 12 steps, 6 new server files, settings/design-patterns.json. (2026-03-09)

- [x] **SaveAsText-based image extraction** — Rewrote `export_images.ps1` to use `SaveAsText` instead of COM `PictureData` (which never worked). Fixed MSysResources attachment field access, added DIB format support. Tested on Northwind: 15 shared PNGs + 2 embedded DIBs extracted. (2026-03-08)
- [x] **Auto-apply assessment fixes** — Assessment findings now auto-applied during import. New `apply-fixes.js` endpoint. Widget is read-only informational. (2026-03-08)
- [x] **Pre-import database assessment** — Deterministic assessment endpoint, relationship extraction, interactive widget in chat panel, LLM-enhanced analysis, AI agent skill file. (2026-02-24)
- [x] **Unified corpus schema** — Medium column, multi-model LLM routing with secretary pattern, embeddings, regenerate with model/temperature/sampling controls. (2026-02-24)
- [x] **Notes corpus** — Append-only corpus with LLM response (PR #32). Three-pane UI, global chronological entries, four unnamed LLM operations. (2026-02-20)
- [x] **Hub home page** — 3-column hub landing page with three-layer architecture, standalone architecture page, graph primitives seeded. (2026-02-19)
- [x] **Capability ontology rename** — Graph node type `intent` → `potential`, `application` removed (PR #31). (2026-02-18)
- [x] **Batch pipeline** — App Viewer 3-step pipeline: Extract All → Resolve Gaps → Generate All Code with multi-pass dependency retry. (2026-02-17)
- [x] **Automatic .mdb → .accdb conversion** — `convert_mdb.ps1` converts .mdb files silently during import. (2026-02-17)
- [x] **Automatic AutoExec disabling** — `disable_autoexec.ps1` handles AutoExec macros via DAO. (2026-02-17)
- [x] **README and INSTRUCTIONS.md rewrite** — "Copy the intent, not the code" philosophy; shell-access vs chat-only AI guidance. (2026-02-17)
- [x] **PRODUCT.md** — Full product description with AI automation thesis. (2026-02-17)
- [x] **VBA intent extraction pipeline** — 30 intent types, mechanical templates + LLM fallback, 71 tests. (2026-02-16)
- [x] **Pure state transform architecture** — 77 transforms, 75 flows, all views wired. (2026-02-16)
- [x] **Access &-hotkey rendering** — Underlined hotkey letters + Alt+key activation. (2026-02-16)
- [x] **Control palette** — Draggable/clickable toolbar for form + report Design Views. (2026-02-15)
- [x] **Form state sync** — session_state cross-join pattern, control_column_map. (2026-02-14)
- [x] **Query re-import & retry loop** — CREATE OR REPLACE VIEW, multi-pass retry, dependency error handling. (2026-02-14)
- [x] **LLM fallback for query conversion** — Claude Sonnet fallback with schema context when regex converter fails. (2026-02-12)
- [x] **VBA stub functions** — Placeholder PG functions from VBA module declarations. (2026-02-12)
- [x] **Import completeness check** — `shared.source_discovery` table, completeness API, UI warnings. (2026-02-10)
- [x] **Table import pipeline** — Server-side Access → PostgreSQL table import with full fidelity. (2026-02-09)
