# VBA to ClojureScript Translation Guide

Translating Access VBA modules to ClojureScript for the PolyAccess web application. The VBA source is stored in `shared.modules` and the ClojureScript translation lives alongside it.

## PolyAccess Architecture (for translation context)

- **UI**: Reagent (React wrapper) with a single `app-state` atom
- **State**: `app.state` namespace — shared helpers, tabs, database selection
- **Form state**: `app.state-form` — form CRUD, record ops, navigation
- **Report state**: `app.state-report` — report CRUD, preview
- **API calls**: `cljs-http.client` with `core.async` (`go` blocks, `<!`)
- **Backend**: Express.js REST API with PostgreSQL

## Translation Patterns

### DoCmd Operations

| VBA | ClojureScript |
|-----|---------------|
| `DoCmd.OpenForm "FormName"` | `(state/open-object! :forms form-id)` |
| `DoCmd.Close acForm, "FormName"` | `(state/close-tab! :forms form-id)` |
| `DoCmd.Close` (current form) | `(state/close-tab! (:type active-tab) (:id active-tab))` |
| `DoCmd.OpenForm "X", , , filter` | Open form + set filter in form-editor state |
| `DoCmd.GoToRecord , , acNewRec` | `(state-form/new-record!)` |
| `DoCmd.Requery` | Re-fetch records via `(state-form/load-records!)` |
| `DoCmd.RunSQL "INSERT..."` | `(http/post (str api-base "/api/data/tablename") {:json-params data})` |
| `DoCmd.SetWarnings False/True` | Not needed — no warning dialogs in web app |
| `DoCmd.OpenReport "R", acViewPreview` | `(state/open-object! :reports report-id)` |

### Form References

| VBA | ClojureScript |
|-----|---------------|
| `Me.txtField` | `(get-in @state/app-state [:form-editor :current-record :field])` |
| `Me.txtField = value` | `(swap! state/app-state assoc-in [:form-editor :current-record :field] value)` |
| `Forms!FormName!ControlName` | Look up form in open tabs, get its state |
| `Me.Dirty` | `(get-in @state/app-state [:form-editor :record-dirty?])` |
| `Me.Requery` | `(state-form/load-records!)` |
| `Me.RecordSource = "..."` | `(swap! state/app-state assoc-in [:form-editor :current :record-source] "...")` |

### DLookup / DCount / DSum / DMax

These become API calls since the data lives in PostgreSQL:

```clojure
;; VBA: DLookup("name", "carriers", "carrier_id = " & id)
(go
  (let [response (<! (http/get (str state/api-base "/api/data/carriers")
                               {:query-params {:filter (js/JSON.stringify
                                                        (clj->js {"carrier_id" id}))
                                               :limit 1}
                                :headers (state/db-headers)}))]
    (when (:success response)
      (get-in response [:body :records 0 :name]))))

;; VBA: DCount("*", "carriers", "active = True")
(go
  (let [response (<! (http/post (str state/api-base "/api/queries/run")
                                {:json-params {:sql "SELECT COUNT(*) as cnt FROM carriers WHERE active = true"}
                                 :headers (state/db-headers)}))]
    (when (:success response)
      (get-in response [:body :records 0 :cnt]))))
```

### MsgBox

| VBA | ClojureScript |
|-----|---------------|
| `MsgBox "Info", vbInformation` | `(js/alert "Info")` or `(state/set-error! "Info")` for UI banner |
| `MsgBox "Error!", vbCritical` | `(state/log-error! "Error!")` |
| `If MsgBox("Sure?", vbYesNo) = vbYes` | `(when (js/confirm "Sure?") ...)` |

### Variables and Types

| VBA | ClojureScript |
|-----|---------------|
| `Dim x As String` | `(let [x ""])` or just use directly |
| `Dim x As Long` | `(let [x 0])` |
| `Dim x As Boolean` | `(let [x false])` |
| `Set rs = CurrentDb.OpenRecordset(...)` | API call returning records vector |
| `Nz(value, default)` | `(or value default)` |
| `IsNull(x)` | `(nil? x)` |
| `x & y` (string concat) | `(str x y)` |

### Conditionals and Loops

```clojure
;; VBA: If x > 0 Then ... ElseIf y Then ... Else ... End If
(cond
  (> x 0) (do-something)
  y       (do-other)
  :else   (do-default))

;; VBA: For i = 1 To 10 ... Next
(doseq [i (range 1 11)]
  (do-something i))

;; VBA: For Each item In collection ... Next
(doseq [item collection]
  (do-something item))

;; VBA: Do While Not rs.EOF ... rs.MoveNext ... Loop
;; (records are just a vector from the API)
(doseq [record records]
  (do-something record))
```

### Error Handling

```clojure
;; VBA: On Error GoTo Handler ... Handler: MsgBox Err.Description
(try
  (do-something)
  (catch js/Error e
    (state/log-error! (.-message e) "function-name")))
```

### Database Operations (via API)

```clojure
;; VBA: CurrentDb.Execute "INSERT INTO tbl (col) VALUES ('val')"
(go
  (<! (http/post (str state/api-base "/api/data/tbl")
                 {:json-params {"col" "val"}
                  :headers (state/db-headers)})))

;; VBA: CurrentDb.Execute "UPDATE tbl SET col = 'val' WHERE id = " & id
(go
  (<! (http/put (str state/api-base "/api/data/tbl/" id)
                {:json-params {"col" "val"}
                 :headers (state/db-headers)})))

;; VBA: CurrentDb.Execute "DELETE FROM tbl WHERE id = " & id
(go
  (<! (http/delete (str state/api-base "/api/data/tbl/" id)
                   {:headers (state/db-headers)})))
```

### TempVars (Global State)

VBA TempVars are global variables. Map to keys in `app-state`:

```clojure
;; VBA: TempVars!CurrentID = 42
(swap! state/app-state assoc :temp-current-id 42)

;; VBA: x = TempVars!CurrentID
(let [x (:temp-current-id @state/app-state)])
```

## Namespace Template

Every translated module should follow this pattern:

```clojure
(ns app.modules.module-name
  "Translated from VBA module: ModuleName"
  (:require [app.state :as state]
            [cljs-http.client :as http]
            [cljs.core.async :refer [go <!]]))

;; Original VBA: Public Function FunctionName(arg As String)
(defn function-name
  "Brief description of what this does"
  [arg]
  ;; implementation
  )
```

## Common Gotchas

1. **Async operations**: VBA is synchronous; ClojureScript API calls are async. Wrap in `go` blocks and use `<!` to await responses. Functions that call the API cannot return values synchronously — use callbacks or return channels.

2. **String comparison**: VBA is case-insensitive by default (`Option Compare Database`). Use `clojure.string/lower-case` for comparisons: `(= (str/lower-case a) (str/lower-case b))`.

3. **1-based vs 0-based**: VBA arrays and collections are 1-based. ClojureScript vectors are 0-based. Adjust indices.

4. **Null vs Empty String**: VBA often treats `""` and `Null` interchangeably via `Nz()`. In ClojureScript, use `(or value "")` or `(when (seq value) ...)`.

5. **Form references across forms**: VBA can read `Forms!OtherForm!Control`. In PolyAccess, each form's state is independent. Cross-form communication goes through `app-state` keys or API calls.

6. **Event procedures**: VBA event handlers (OnClick, BeforeUpdate, etc.) become ClojureScript functions referenced in the form definition's event properties. The form editor wires these up.

7. **DoCmd.OpenForm with WhereCondition**: The filter needs to be set on the target form's state after opening it. This requires a two-step approach — open the tab, then set the filter.

## What NOT to Translate

Some VBA patterns have no web equivalent and should be noted as comments:

- `DoCmd.TransferSpreadsheet` — File import/export (needs separate implementation)
- `CreateObject("Outlook.Application")` — COM automation (not possible in browser)
- `SendKeys` — Keyboard simulation (not applicable)
- `DoCmd.OutputTo` — Report export (future feature)
- Direct file system operations (`Open`, `Print #`, `Close #`) — Use API endpoints instead
