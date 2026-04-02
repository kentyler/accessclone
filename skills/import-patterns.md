# Import Patterns

<!-- INTENTS EXTRACTED → intents.json:
  whole file → import-pattern-ledger
-->

Known patterns the pipeline must handle when importing Access databases. Each pattern has a status:
- **Automated** — runs in the pipeline without manual intervention
- **Partial** — some cases handled, others not
- **Not implemented** — known problem, no code yet

When you solve a new import problem, add it here immediately.

---

## Pattern: VBA Expression Control-Source → Record-Source

**Status**: Automated (repair-pass.js step 2b)

**Problem**: Form has no record-source. A control has `control-source: =GetString(41)` — a VBA function call. The client-side expression evaluator can't call PG functions, so the control shows nothing.

**Solution**: Convert the expression to a server-side query and set it as the form's record-source.
- Before: form has no record-source, control has `control-source: =GetString(41)`
- After: form has `record-source: SELECT schema.getstring(41) AS txtabout`, control has `field: txtabout`

**Scope**: Single function call expressions like `=GetString(41)`, `=GetVersion()`. Does NOT handle complex multi-function expressions or expressions with field references.

**Code**: `server/routes/database-import/repair-pass.js` step 2b. Checks that the function exists as a PG stub/real function before converting.

**Example**: frmAbout in Northwind — `txtAbout` control had `=GetString(41)`.

---

## Pattern: VBA Stub Functions for UDFs

**Status**: Automated (vba-stub-generator.js)

**Problem**: Queries reference user-defined VBA functions that don't exist in PG yet. Views can't be created.

**Solution**: Parse VBA module declarations, create NULL-returning PG stubs with correct signatures so views compile. Real implementations come later (via LLM translation or resolve-expressions).

**Gotchas**:
- ParamArray params are variadic/optional in VBA — excluded from stub signatures
- VBA Enum types must map to `integer`, not `text` — `collectEnumNames()` scans for Enum declarations
- Stubs skip functions that already exist — bad stubs must be manually dropped
- `ensureStubsForSQL()` catches function references in converted SQL that aren't in any VBA module

**Code**: `server/lib/vba-stub-generator.js`

---

## Pattern: Query Dependency Retry Loop

**Status**: Automated (frontend import-all + server error categorization)

**Problem**: Query A depends on Query B which depends on Query C. Import order is unknown.

**Solution**: Multi-pass retry loop (up to 20 passes). Each pass imports what it can. Dependency errors (PG 42P01 undefined table, 42883 undefined function) are categorized as `missing-dependency` and retried. Column errors (42703) go to LLM fallback. Loop stops when zero progress or all done.

**Code**: `ui/src/app/views/access_database_viewer.cljs` (`import-queries-phase!`), `server/routes/database-import/import-query.js`

---

## Pattern: LLM Query Fallback

**Status**: Automated (llm-fallback.js)

**Problem**: Regex converter produces SQL that fails PG execution (syntax, missing columns, Access-specific patterns).

**Solution**: Send original Access SQL + failed PG SQL + error + full schema context + VBA function bodies + view column hints to Claude Sonnet. LLM returns corrected SQL.

**Key context builders**:
- `buildSchemaContext()` — tables, columns, types, views, function signatures
- `buildVbaContext()` — finds VBA functions matching missing column names
- `buildViewColumnHints()` — finds missing columns in views (Access queries reference calculated columns from other queries as table columns)

**Code**: `server/lib/query-converter/llm-fallback.js`

---

## Pattern: Form State Sync (Query Cross-Joins)

**Status**: Automated (form-state.js + runtime sync)

**Problem**: Access queries reference live form control values: `[Forms]![frmProducts]![cboCategory]`

**Solution**: Two-layer system:
1. Import time: `control_column_map` maps form controls → table.column. Query converter emits cross-joins against `shared.session_state`.
2. Runtime: User navigates records → tagged controls push values to `form_control_state` → views automatically filter.

**Import order dependency**: Forms must be imported before queries (populates control_column_map).

**Code**: `server/lib/query-converter/form-state.js`, `server/routes/form-state.js`, `skills/form-state-sync.md`

---

## Pattern: Form-Level and Global Variables

**Status**: Not implemented

**Problem**: VBA module-level variables (`Private m_lngVendorProductCount As Long`) are initialized in `Form_Load` or `Form_Current` (often via DCount/DLookup), then used across multiple event handlers. Global `TempVars` are used similarly. The current `form_control_state` table only maps table.column pairs for query cross-joins — it can't store arbitrary form-scoped variables.

**Needed**: A runtime store for:
- Module-level variables (scoped to form instance): `m_lngCustomerOrderCount`, `m_strMsgCaption`
- Computed values from Form_Load: DCount results, DLookup results
- OpenArgs parsed values: `strOpenArgCompanyTypeID`, `lngOpenArgCompanyID`
- TempVars (partially designed — `_tempvars` table_name in form_control_state — but runtime doesn't write them)

**Example**: frmCompanyDetail — `Form_Load` parses OpenArgs dictionary, sets module variables used by `cmd-save.on-click`, `cbo-company-type-id.before-update`, etc. All commented out in current JS translation because variable conditions can't be evaluated.

**Design direction**: Extend `form_control_state` or add a parallel `form_variables` table keyed by `(session_id, form_name, variable_name)`. JS handlers would read/write via `AC.getVar(name)` / `AC.setVar(name, value)`. Module-level Dim statements would translate to `AC.setVar()` calls.

---

## Pattern: Image Extraction from OLE Objects

**Status**: Automated (export_images.ps1 + import-images.js)

**Problem**: Access stores images as OLE objects with proprietary headers wrapping the actual image data.

**Solution**: `Find-ImageStart()` scans past OLE header looking for image signatures (JPEG FF D8 FF, PNG 89 50 4E 47, BMP 42 4D, GIF 47 49 46 38, DIB 28 00 00 00). SaveAsText outputs PictureData as hex blocks, parsed by stack-based state machine.

**Gotchas**:
- DIB images (raw BITMAPINFOHEADER) need 14-byte BMP file header prepended for browser rendering
- MSysResources shared images accessed via child recordset (attachment field type 101)
- Property blocks (ObjectPalette, NameMap, PrtMip) use same Begin/End syntax — tracked separately to avoid mis-popping stack
- Images saved as new form/report version (append-only)

**Code**: `scripts/access/export_images.ps1`, `server/routes/database-import/import-images.js`

---

## Pattern: VBA-to-JS Event Handler Translation

**Status**: Partial

**What works**:
- DoCmd calls: OpenForm, OpenReport, Close, GoToRecord, RunSQL, Save, Quit, Requery
- Me.control assignments: Visible, Enabled, Value, SourceObject, Caption
- MsgBox → confirm() / alert()
- If/ElseIf/Else/End If with translatable conditions
- Select Case → switch (variables, Me.OpenArgs, Me.ctrl)
- Numeric For loops
- Dim → let declarations, variable tracking

**What doesn't work** (emitted as JS comments):
- Conditions involving local variables (`If Len(strVar) > 0`)
- For Each loops (dictionary iteration, OpenArgs parsing)
- Do/While loops
- DLookup/DCount/DSum calls
- External VBA function calls (ValidateForm, GetString, StringFormat, IsFormOpen)
- Complex string building with field concatenation
- Me.Filter / Me.FilterOn / Me.control.Undo / Cancel = True
- DoCmd.SearchForRecord

**Code**: `server/lib/vba-to-js.js`, `ui/src/app/runtime.cljs` (window.AC API)

---

## Pattern: Field Binding Case Fix

**Status**: Automated (repair-pass.js + normalize-form-definition)

**Problem**: Access exports field="Carrier" but PG column is "carrier" (lowercase). Case mismatch breaks data loading.

**Solution**: Two layers:
1. `normalize-form-definition` in state_form.cljs coerces all control `:type` to keywords on load
2. Repair pass does case-insensitive field binding check with Levenshtein suggestions

**Code**: `server/routes/database-import/repair-pass.js`, `ui/src/app/state_form.cljs`

---

## Pattern: Zero-Height Controls

**Status**: Automated (PowerShell export scripts)

**Problem**: SaveAsText omits Height when it matches Access's internal default. Forms often have no defaults block.

**Solution**: Post-parse height defaults applied if height=0:
- text-box: 252 (forms), 300 (reports)
- command-button: 360
- check-box: 240
- lines: stay 0

**Code**: `scripts/access/export_form.ps1`, `scripts/access/export_report.ps1`

---

## Pattern: Division by Zero in Converted Queries

**Status**: Automated (syntax.js)

**Problem**: Access silently returns Null for division by zero. PG throws an error.

**Solution**: Blanket `NULLIF(denominator, 0)` transform in syntax.js using `withStringLiteralsMasked` to protect string literals. Applies to simple identifier denominators only.

**Code**: `server/lib/query-converter/syntax.js`

---

## Pattern: Re-Import with Query + Module + Validation

**Status**: Automated (reimport-object! in frontend)

**Problem**: Re-importing a single form/report needs to also re-convert its backing query and re-translate its class module.

**Solution**: `reimport-object!` runs 3 additional steps after re-export:
1. Re-convert record-source query via `import-query!` with `force? true`
2. Re-translate class module (`Form_X`/`Report_X`) via `translate-modules` with `module_names` filter
3. Run repair pass + validation pass

**Code**: `ui/src/app/views/access_database_viewer.cljs` (`reimport-object!`)

---

## Pattern: AutoExec Macro Handling

**Status**: Automated (disable_autoexec.ps1)

**Problem**: AutoExec macros run when Access opens a database, blocking automation.

**Solution**: `disable_autoexec.ps1` renames AutoExec → xAutoExec in MSysObjects via DAO (engine-level, no UI trigger). Restore after listing/export. Called automatically by scan endpoint.

**Code**: `scripts/access/disable_autoexec.ps1`, `server/routes/database-import/export.js`

---

## Pattern: .mdb Auto-Conversion

**Status**: Automated (convert_mdb.ps1)

**Problem**: .mdb files (Access 97-2003) can't use modern features. Pipeline expects .accdb.

**Solution**: Auto-convert via `Access.Application.SaveAsNewDatabase` (format 12). Handles AutoExec internally. Response includes `convertedFrom` flag.

**Code**: `scripts/access/convert_mdb.ps1`, wired into `GET /api/database-import/database`

---

## Pattern: LLM Autofix for Unresolved Bindings

**Status**: Automated (autofix-pass.js)

**Problem**: After repair + validation, some field bindings still can't be resolved.

**Solution**: Send definition + issues + schema to Claude Sonnet. LLM suggests field renames, record-source fixes, combo-box SQL corrections. All verified before applying (EXPLAIN for SQL, schema existence for fields).

**Code**: `server/routes/database-import/autofix-pass.js`

---

## Pattern: Expression-to-Computed-Function Pipeline

**Status**: Automated (expression-converter/pipeline.js + resolve-expressions.js)

**Problem**: Access control-source expressions like `=IIf(IsNull([Discount]),0,[Discount]*[UnitPrice])` need to work in the web app.

**Solution**: Two systems:
1. `processDefinitionExpressions()` translates expressions to PG SQL for server-side evaluation (computed functions in form/report definitions)
2. `resolve-expressions.js` translates VBA function stubs into real PG implementations, then re-runs the expression pipeline

**Code**: `server/lib/expression-converter/pipeline.js`, `server/routes/database-import/resolve-expressions.js`
