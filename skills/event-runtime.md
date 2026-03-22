# Event Runtime — Forms & Reports

How VBA event handlers execute client-side in AccessClone. VBA is parsed into JavaScript at import time, stored in the database, and eval'd at runtime via `window.AC` — a ClojureScript-backed runtime API.

## Architecture

**Key principle**: Intents are for LLM reasoning about code during translation. They play no part in runtime event execution. Buttons click, forms load, and reports open by running JavaScript — not by walking intent trees.

```
VBA Source Code
     |
     v
VBA-to-JS Parser (deterministic)   ── server/lib/vba-to-js.js
     |                                 (parses Sub btnSave_Click() into JS strings)
     |
     v
shared.modules.js_handlers (JSONB)  ── stored at module save time (PUT /api/modules/:name)
     |
     v
Handler Loading                     ── GET /api/modules/:name/handlers
     |                                 (returns [{key, control, event, procedure, js}])
     |
     v
Client Registration                 ── Forms:   projection/register-event-handlers
                                        Reports: state_report/load-event-handlers-for-report!
     |
     v
Runtime Execution                   ── (js/Function. js-code) → .call
                                        JS calls window.AC.openForm(), AC.closeForm(), etc.
```

**No fallbacks**: If a handler exists but has no `:js` code, a warning is logged. There is no silent fallback to caption-based guessing, intent execution, or server-side evaluation. Fallbacks mask bugs — if something fails, that's an error.

## VBA-to-JS Parser

`server/lib/vba-to-js.js` — deterministic parser that converts VBA event procedures into executable JavaScript strings.

### Pipeline

1. `extractProcedures(vbaSource)` — finds `Sub controlName_Event()...End Sub` blocks
2. `stripBoilerplate(body)` — removes line numbers, error handlers (`On Error`), labels, comments
3. `translateStatement(stmt)` — maps individual VBA statements to `AC.*` calls
4. `parseVbaToHandlers(vbaSource)` — returns `[{key, control, event, procedure, js}]`

### Supported VBA Patterns

| VBA Statement | Generated JavaScript |
|--------------|---------------------|
| `DoCmd.OpenForm "frmOrders"` | `AC.openForm("frmOrders")` |
| `DoCmd.OpenReport "rptSales"` | `AC.openReport("rptSales")` |
| `DoCmd.Close` | `AC.closeForm()` |
| `DoCmd.GoToRecord , , acNewRec` | `AC.gotoRecord("new")` |
| `DoCmd.GoToRecord , , acNext` | `AC.gotoRecord("next")` |
| `DoCmd.RunSQL "INSERT INTO..."` | `AC.runSQL("INSERT INTO...")` |
| `DoCmd.Save` | `AC.saveRecord()` |
| `DoCmd.Quit` | `AC.closeForm()` |
| `DoCmd.Requery` | `AC.requery()` |
| `DoCmd.RunCommand acCmdSaveRecord` | `AC.saveRecord()` |
| `MsgBox "text"` | `alert("text")` |
| `Me.Requery` | `AC.requery()` |
| `Me.Refresh` | `AC.requery()` |
| `Me.ctrlName.Visible = True` | `AC.setVisible("ctrlName", true)` |
| `Me.ctrlName.Enabled = False` | `AC.setEnabled("ctrlName", false)` |
| `Me.ctrlName = value` | `AC.setValue("ctrlName", value)` |
| `Me.ctrlName.SourceObject = "..."` | `AC.setSubformSource("ctrlName", "...")` |

### Storage

JS handlers are generated and stored when a module is saved:

```
PUT /api/modules/:name
  → if vba_source changed:
      parseVbaToHandlers(vba_source)
      → store result in js_handlers JSONB column
```

The `js_handlers` column on `shared.modules` stores an array of handler objects. Each has `key`, `control`, `event`, `procedure`, and `js` (the executable JavaScript string).

## Runtime API

`ui/src/app/runtime.cljs` — exposes `window.AC` with framework methods callable from generated JavaScript.

### Methods

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

Installed at app init in `core.cljs`:
```clojure
(runtime/install!)  ;; sets window.AC
```

## Form Events

### Loading Pipeline

When a form opens in view mode:

1. `load-form-for-editing!` fetches the form definition
2. `setup-form-editor!` builds the projection (bindings, row-sources, field-triggers, control-state)
3. `load-reactions-for-form!` fetches AfterUpdate reactions from the module
4. `load-event-handlers-for-form!` fetches `Form_{name}` handlers → registers into projection `:event-handlers`
5. `set-view-mode! :view` loads data, then fires `:on-load`

### Supported Form Events

| Event | VBA Source | When It Fires |
|-------|-----------|---------------|
| `on-load` | `Form_Load` | After records load in view mode |
| `on-current` | `Form_Current` | After navigating to a different record |
| `on-click` | `btnName_Click` | Button click |
| `after-update` | `ctrlName_AfterUpdate` | After a field value changes |
| `on-enter` | `ctrlName_Enter` | Control receives focus (fires before GotFocus) |
| `on-gotfocus` | `ctrlName_GotFocus` | Control receives focus (fires after Enter) |
| `on-exit` | `ctrlName_Exit` | Control loses focus (fires before LostFocus) |
| `on-lostfocus` | `ctrlName_LostFocus` | Control loses focus (fires after Exit) |

### Button Click Resolution

Simple: look up the handler in the projection's `:event-handlers` map with key `ctrl-name.on-click`. If found, execute the `:js` code. If not found, do nothing (no fallback, no caption guessing).

```clojure
(defn- resolve-button-action [ctrl]
  (let [ctrl-name (or (:name ctrl) "")
        projection (get-in @state/app-state [:form-editor :projection])
        handler (projection/get-event-handler projection ctrl-name "on-click")]
    (if handler
      (run-js-handler handler ctrl-name)
      (fn []))))
```

### Focus Event Wiring

Focus events attached to `.view-control` wrapper div. React's `onFocus`/`onBlur` bubble from child inputs. Only controls with focus event flags (`:has-enter-event`, `:has-exit-event`, `:has-gotfocus-event`, `:has-lostfocus-event`) get handlers attached.

### JS Execution

All event handler paths use the same pattern:

```clojure
(defn- run-js-handler [handler context-label]
  (if-let [js-code (:js handler)]
    #(try (let [f (js/Function. js-code)] (.call f))
          (catch :default e
            (js/console.warn "Error in event handler" context-label ":" (.-message e))))
    #(js/console.warn "Handler has no :js code:" context-label)))
```

## Report Events

### Loading Pipeline

1. `load-report-for-editing!` fetches the report definition
2. `setup-report-editor!` initializes state with `:event-handlers {}`
3. `load-event-handlers-for-report!` fetches `Report_{name}` handlers → stores in `[:report-editor :event-handlers]`
4. When entering preview mode, data loads, then events fire

### Supported Report Events

| Event | VBA Source | When It Fires |
|-------|-----------|---------------|
| `on-open` | `Report_Open` | After preview data loads (with data) |
| `on-close` | `Report_Close` | When leaving preview mode or closing the report tab |
| `on-no-data` | `Report_NoData` | After preview data loads with 0 rows |

Reports are read-only previews — no control-level events apply.

## Server Endpoints

### GET /api/modules/:name/handlers

Returns event handler descriptors with executable JS. Resolution order:
1. **Stored js_handlers** — read from `shared.modules.js_handlers` (authoritative, generated at import time)
2. **control_event_map + intents** — legacy fallback for modules imported before the JS handler system

Response format:
```json
[{
  "key": "btn-orders.on-click",
  "control": "btn-orders",
  "event": "on-click",
  "procedure": "btnOrders_Click",
  "js": "AC.openForm(\"frmOrders\")"
}]
```

### POST /api/queries/execute

Executes INSERT, UPDATE, or DELETE SQL. Rejects SELECT, DROP, ALTER, TRUNCATE, and multi-statement SQL. Used by `AC.runSQL()`.

## Intents — What They're For Now

Intent extraction (`POST /api/chat/extract-intents`) and the intent map (`shared.modules.intents`) remain in the system. Their role is purely as **LLM reasoning context**:

- The chat system prompt includes intent data when reasoning about forms/modules
- The App Viewer's gap decisions pipeline uses intents for dependency analysis
- `autoResolveGaps()` checks intents to verify referenced objects exist
- Module Viewer shows the intent summary panel for human inspection

Intents do NOT execute at runtime. The `intent_interpreter.cljs` file has been deleted.

## File Map

| File | Role |
|------|------|
| `server/lib/vba-to-js.js` | VBA-to-JS parser: converts VBA procedures to executable JavaScript |
| `ui/src/app/runtime.cljs` | Runtime API: `window.AC` object with framework methods |
| `ui/src/app/core.cljs` | App init: installs runtime via `(runtime/install!)` |
| `ui/src/app/views/form_view.cljs` | Form rendering: button click resolution, focus event wiring |
| `ui/src/app/state_form.cljs` | Form state: `fire-form-event!`, `load-event-handlers-for-form!`, after-update |
| `ui/src/app/state_report.cljs` | Report state: `fire-report-event!`, `load-event-handlers-for-report!` |
| `ui/src/app/projection.cljs` | Data projection: field-triggers, control-state, event-handlers |
| `ui/src/app/views/expressions.cljs` | Expression evaluator: used by computed fields and conditional formatting |
| `server/routes/modules.js` | Server: handler extraction, module save with JS generation |
| `server/routes/metadata.js` | Server: `/api/queries/run` and `/api/queries/execute` |
| `server/graph/schema.js` | Schema: `js_handlers JSONB` column on `shared.modules` |
