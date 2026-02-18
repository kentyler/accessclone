# Project Tasks

## Pending

- [ ] **Add file picker option for import mode** — Add a file picker as an alternative to the full machine scan when importing Access databases. Users should be able to directly select a .accdb/.mdb file instead of having their entire machine scanned for database files.
- [ ] **Test batch pipeline end-to-end** — Run extract all → resolve gaps → generate all code against a real database and verify results.
- [ ] **Test .mdb → .accdb conversion end-to-end** — Test with a real .mdb file to verify the conversion pipeline works.
- [ ] **Test runtime form state sync end-to-end** — Open a form, navigate records, verify `form_control_state` is populated and dependent views filter correctly.
- [ ] **OpenClaw skill prototype** — Export intent graph + form definitions in a format an OpenClaw agent can consume.
- [ ] **Upload social preview image** — Set `docs/social-preview.png` as the repo social preview in GitHub Settings → Social preview (manual step).

## In Progress

## Completed

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
