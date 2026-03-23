# VBA Translation Guide

Translating Access VBA modules in the AccessClone application. VBA source is stored in `shared.modules`. Two outputs are produced: (1) structured intents for LLM reasoning, and (2) JavaScript handlers for runtime execution.

## Current Architecture

**Runtime execution uses JavaScript.** The `vba-to-js.js` parser deterministically converts VBA event procedures into JS strings that call `window.AC.*` methods. These are stored in `shared.modules.js_handlers` and executed client-side via `(js/Function. js-code)`. See `skills/event-runtime.md` for full details.

**Intents are for LLM reasoning only**. Intent extraction (`POST /api/chat/extract-intents`) produces structured JSON describing what VBA procedures do. The intent mapper (`vba-intent-mapper.js`) classifies 30 intent types. These are used by:
- The chat system prompt when reasoning about modules
- The App Viewer's gap decisions pipeline for dependency analysis
- `autoResolveGaps()` to verify referenced objects exist
- The Module Viewer's intent summary panel for human inspection

Intents do NOT execute at runtime.

## Prerequisites: Import All Objects First

**Do NOT begin translation until ALL objects from the Access database have been imported.** VBA modules reference queries, forms, tables, and other modules. If the LLM cannot see the actual definitions, it will guess at the logic and produce incorrect results.

Import completeness is enforced automatically -- the app checks before allowing intent extraction and shows a clear message listing what's missing.

## VBA-to-JS Parser

`server/lib/vba-to-js.js` -- deterministic parser that converts VBA event procedures into executable JavaScript strings.

### Supported VBA Patterns

| VBA Statement | Generated JavaScript |
|--------------|---------------------|
| `DoCmd.OpenForm "frmOrders"` | `AC.openForm("frmOrders")` |
| `DoCmd.OpenReport "rptSales"` | `AC.openReport("rptSales")` |
| `DoCmd.Close` | `AC.closeForm()` |
| `DoCmd.GoToRecord , , acNewRec` | `AC.gotoRecord("new")` |
| `DoCmd.RunSQL "INSERT..."` | `AC.runSQL("INSERT...")` |
| `DoCmd.Save` | `AC.saveRecord()` |
| `DoCmd.Requery` | `AC.requery()` |
| `Me.ctrlName.Visible = True` | `AC.setVisible("ctrlName", true)` |
| `Me.ctrlName.Enabled = False` | `AC.setEnabled("ctrlName", false)` |
| `Me.ctrlName = value` | `AC.setValue("ctrlName", value)` |
| `Me.ctrlName.SourceObject = "..."` | `AC.setSubformSource("ctrlName", "...")` |
| `MsgBox "text"` | `alert("text")` |

JS handlers are generated and stored when a module is saved (`PUT /api/modules/:name`).

## Runtime API

`ui/src/app/runtime.cljs` exposes `window.AC` with framework methods callable from generated JavaScript:

| Method | Description |
|--------|-------------|
| `AC.openForm(name)` | Open a form tab by name |
| `AC.openReport(name)` | Open a report tab by name |
| `AC.closeForm()` | Close the active tab |
| `AC.gotoRecord(direction)` | Navigate: "first", "last", "next", "previous", "new" |
| `AC.saveRecord()` | Save the current record |
| `AC.requery()` | Reload form data |
| `AC.setVisible(ctrl, bool)` | Toggle control visibility |
| `AC.setEnabled(ctrl, bool)` | Toggle control enabled state |
| `AC.setValue(ctrl, value)` | Set a control's value |
| `AC.setSubformSource(ctrl, src)` | Set a subform's source object |
| `AC.runSQL(sql)` | Execute INSERT/UPDATE/DELETE via POST /api/queries/execute |

## Intent Extraction

The intent pipeline extracts structured understanding of VBA code for LLM context:

1. **Extract Intents** -- LLM extracts structured JSON intents from VBA (`POST /api/chat/extract-intents`)
2. **Map Intents** -- `vba-intent-mapper.js` maps 30 intent types deterministically
3. **Resolve Gaps** -- `autoResolveGaps()` checks that referenced objects exist

The Module Viewer's "Extract Intents" button drives this pipeline. Results are stored in `shared.modules.intents` JSONB column.

## Common VBA Patterns Reference

These patterns are useful context for understanding what VBA does, even though runtime execution is now handled by `vba-to-js.js`:

### DoCmd Operations

| VBA | What it does |
|-----|-------------|
| `DoCmd.OpenForm "FormName"` | Opens a form |
| `DoCmd.Close acForm, "FormName"` | Closes a specific form |
| `DoCmd.GoToRecord , , acNewRec` | Navigates to a new record |
| `DoCmd.RunSQL "INSERT..."` | Executes action SQL |
| `DoCmd.Requery` | Refreshes the current form's data |
| `DoCmd.OpenReport "R", acViewPreview` | Opens a report in preview mode |

### Form References

| VBA | Meaning |
|-----|---------|
| `Me.txtField` | Current form's control value |
| `Me.txtField = value` | Set a control's value |
| `Forms!FormName!ControlName` | Cross-form reference |
| `Me.Dirty` | Whether current record has unsaved changes |
| `Me.Requery` | Refresh form data |

### DLookup / DCount / DSum / DMax

These are database aggregate lookups. In AccessClone, they translate to API calls since data lives in PostgreSQL. The `vba-to-js.js` parser does not currently handle these -- they appear as gaps in the intent summary.

### Error Handling

VBA `On Error GoTo Handler` patterns are stripped by `vba-to-js.js`'s `stripBoilerplate()`. Web-app error handling is done through try/catch in the generated JS.

## Translation Status

Each module has a `status` field tracking progress:

- **pending** -- VBA imported, no translation yet
- **translated** -- Intent extraction done, JS handlers generated
- **needs-review** -- Has known gaps or dependencies on other modules
- **complete** -- Verified and ready for use

## What NOT to Translate

Some VBA patterns are truly inapplicable in a web context:

- `CreateObject("Outlook.Application")` -- External COM automation
- `SendKeys` -- Keyboard simulation
- `DoCmd.TransferSpreadsheet` -- File import/export
- `DoCmd.OutputTo` -- Report export
- `Shell` -- Running external processes

These appear as gaps in the intent summary for human review.
