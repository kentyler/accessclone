# VBA to ClojureScript Translation Guide

Translating Access VBA modules to ClojureScript for the PolyAccess application. PolyAccess runs locally as an Electron app with a local Express backend — file system access and local paths are valid, but must route through backend API endpoints. The VBA source is stored in `shared.modules` and the ClojureScript translation lives alongside it.

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
;; → Use data API with filter (parameterized, safe):
(go
  (let [response (<! (http/get (str state/api-base "/api/data/carriers")
                               {:query-params {:filter (js/JSON.stringify
                                                        (clj->js {:carrier_id id}))
                                               :limit 1}
                                :headers (state/db-headers)}))]
    (when (:success response)
      (get-in response [:body :data 0 :name]))))

;; VBA: DCount("*", "carriers", "active = True")
;; → Use queries/run for aggregates (SELECT only):
(go
  (let [response (<! (http/post (str state/api-base "/api/queries/run")
                                {:json-params {:sql "SELECT COUNT(*) as cnt FROM carriers WHERE active = true"}
                                 :headers (state/db-headers)}))]
    (when (:success response)
      (get-in response [:body :data 0 :cnt]))))
```

**Response shapes:**
- `GET /api/data/:table` returns `{:data [...records...] :pagination {...}}`
- `POST /api/queries/run` returns `{:data [...records...] :fields [...] :rowCount N}`
- Both use `:data` for the records array (not `:records`)

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

**CRITICAL: Never build SQL by string concatenation.** VBA commonly builds SQL strings with user values spliced in. In PolyAccess, use the data API which handles parameterization automatically.

#### Writes — Use `/api/data/:table` (parameterized, safe)

```clojure
;; VBA: CurrentDb.Execute "INSERT INTO tbl (col1, col2) VALUES ('val', 42)"
(go
  (<! (http/post (str state/api-base "/api/data/tbl")
                 {:json-params {:col1 "val" :col2 42}
                  :headers (state/db-headers)})))

;; VBA: CurrentDb.Execute "UPDATE tbl SET col = 'val' WHERE id = " & id
(go
  (<! (http/put (str state/api-base "/api/data/tbl/" id)
                {:json-params {:col "val"}
                 :headers (state/db-headers)})))

;; VBA: CurrentDb.Execute "DELETE FROM tbl WHERE id = " & id
(go
  (<! (http/delete (str state/api-base "/api/data/tbl/" id)
                   {:headers (state/db-headers)})))

;; VBA: DELETE + INSERT pattern (common in VBA for "upsert"):
;;   CurrentDb.Execute "DELETE FROM tbl WHERE fk = " & id & " AND name = '" & name & "'"
;;   CurrentDb.Execute "INSERT INTO tbl (fk, name, value) VALUES (...)"
;; → First fetch matching record to get its PK, then delete by PK, then insert:
(go
  (let [response (<! (http/get (str state/api-base "/api/data/tbl")
                               {:query-params {:filter (js/JSON.stringify
                                                        (clj->js {:fk id :name name}))
                                               :limit 1}
                                :headers (state/db-headers)}))]
    ;; Delete existing if found
    (when-let [existing (first (get-in response [:body :data]))]
      (<! (http/delete (str state/api-base "/api/data/tbl/" (:pk-column existing))
                       {:headers (state/db-headers)})))
    ;; Insert new
    (<! (http/post (str state/api-base "/api/data/tbl")
                   {:json-params {:fk id :name name :value value}
                    :headers (state/db-headers)}))))
```

#### Reads — Use `/api/data/:table` with filter, or `/api/queries/run` for complex joins

```clojure
;; Simple lookup — use the data API filter:
;; VBA: DLookup("name", "carriers", "carrier_id = " & id)
(go
  (let [response (<! (http/get (str state/api-base "/api/data/carriers")
                               {:query-params {:filter (js/JSON.stringify
                                                        (clj->js {:carrier_id id}))
                                               :limit 1}
                                :headers (state/db-headers)}))]
    (get-in response [:body :data 0 :name])))

;; Complex joins/searches — use /api/queries/run (SELECT only, no writes!)
;; NOTE: /api/queries/run only accepts SELECT statements. It will reject
;; INSERT, UPDATE, DELETE, DROP, etc. with "Only SELECT queries are allowed".
;; NOTE: This endpoint does NOT support parameterized queries — values in the
;; SQL string are passed directly to PostgreSQL. Sanitize or validate inputs.
(go
  (let [response (<! (http/post (str state/api-base "/api/queries/run")
                                {:json-params {:sql "SELECT t.id, t.name FROM tbl t JOIN other o ON t.id = o.fk WHERE t.active = true ORDER BY t.name"}
                                 :headers (state/db-headers)}))]
    (get-in response [:body :data])))
```

**When to use which:**
| Operation | Endpoint | Parameterized? |
|-----------|----------|----------------|
| INSERT | `POST /api/data/:table` | Yes (pass JSON body) |
| UPDATE | `PUT /api/data/:table/:id` | Yes (pass JSON body) |
| DELETE | `DELETE /api/data/:table/:id` | Yes (PK in URL) |
| Simple SELECT with equality filters | `GET /api/data/:table?filter=...` | Yes (JSON filter) |
| Complex SELECT (joins, LIKE, aggregates) | `POST /api/queries/run` | No — SELECT only, validate inputs |

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

8. **SQL string building vs parameterized queries**: VBA commonly builds SQL by string concatenation with manual escaping (`"WHERE name = '" & EscQuote(name) & "'"`). This is **the most common translation mistake**. Rules:
   - **INSERT/UPDATE/DELETE** → Always use `/api/data/:table` endpoints (parameterized automatically). **Never** use `/api/queries/run` for writes — it rejects non-SELECT statements.
   - **Simple SELECT with equality filters** → Use `GET /api/data/:table?filter={"col":"val"}` (parameterized).
   - **Complex SELECT (joins, LIKE, aggregates)** → Use `/api/queries/run` but build the SQL with only safe, validated values. Never splice raw user input into SQL strings.
   - **SQL escaping helpers** (e.g. functions that double single quotes) → Mark `needs-review`. Callers should use the data API instead of building escaped SQL.
   - **VBA "delete then insert" upsert pattern** → Translate to: fetch by filter to get PK, delete by PK, then insert via data API.

9. **Forward references**: ClojureScript requires functions to be defined before use. If function A calls function B which is defined later in the file, add a `(declare B)` at the top of the namespace. The VBA had no such requirement.

## Runtime Capabilities

PolyAccess can run locally (Electron + Express) or as a web app. The server exposes capabilities via `/api/config`. Two helpers are available:

- `(state/has-capability? :file-system)` — silent check, returns true/false
- `(state/require-local! :file-system)` — checks and **alerts the user** if unavailable: *"This feature requires a local installation and can't run from the web. Visit accessclone.com for help converting your application to run on the web."* Returns true if available.

Available capabilities:
- `:file-system` — Local file read/write/copy via backend API
- `:powershell` — PowerShell available (Windows/WSL)
- `:access-import` — Access database import via COM

**Use `require-local!` to guard local-only operations.** This ensures web users get a clear message with a path to get help.

## File System & Path Operations

Guard all file system operations with `require-local!`. When running on the web, the user sees the accessclone.com message and the operation is skipped:

```clojure
;; VBA: Open "C:\path\file.txt" For Input As #1
;;      Line Input #1, strLine
;;      Close #1
(when (state/require-local! :file-system)
  (go
    (let [response (<! (http/post (str state/api-base "/api/files/read")
                                  {:json-params {:path file-path}
                                   :headers (state/db-headers)}))]
      (when (:success response)
        (:body response)))))

;; VBA: FileCopy source, dest
(when (state/require-local! :file-system)
  (go
    (<! (http/post (str state/api-base "/api/files/copy")
                   {:json-params {:source source-path :dest dest-path}
                    :headers (state/db-headers)}))))

;; VBA: Dir("C:\path\*.*")  (check file existence)
(when (state/require-local! :file-system)
  (go
    (let [response (<! (http/post (str state/api-base "/api/files/exists")
                                  {:json-params {:path file-path}
                                   :headers (state/db-headers)}))]
      (get-in response [:body :exists]))))
```

**Path handling**: Keep Windows-style paths as configuration values or derive them from backend settings. Don't hardcode paths — make them configurable or relative to a base directory.

**Revision/backup logic**: VBA modules that copy files for version control or backups should translate to backend API calls that perform the same operations server-side.

## Translation Status & Review Notes

Each module has a `status` field tracking translation progress:

- **pending** — VBA imported, no translation yet
- **translated** — First-pass translation done, may have issues
- **needs-review** — Translation exists but depends on other modules or has known issues
- **complete** — Translation verified and ready for use

**When to mark "needs-review"**: If the translated code includes functions or patterns that may become unnecessary once *other* modules are translated, set status to `needs-review` and explain why in `review_notes`. Common examples:

- **SQL string escaping** (e.g. `escape-single-quotes`): VBA builds SQL by concatenation, but PolyAccess uses parameterized queries via the API. These helper functions may be unnecessary once callers are translated to use API calls instead of string-built SQL. Mark as `needs-review` with a note like: "escape-single-quotes may be unnecessary — callers should use parameterized API queries instead of string concatenation."
- **Cross-module dependencies**: If module A calls functions from module B that hasn't been translated yet, mark A as `needs-review` with a note listing the dependencies.
- **Hardcoded paths or constants**: If the VBA has hardcoded file paths or configuration that should come from app config, mark for review.

When generating a translation, **end your response with a recommended status** and review notes if applicable:

```
;; STATUS: needs-review
;; REVIEW: escape-single-quotes may be unnecessary if callers use parameterized API queries
```

## What NOT to Translate

Some VBA patterns are truly inapplicable and should be noted as comments:

- `CreateObject("Outlook.Application")` — External COM automation (use backend email API instead)
- `SendKeys` — Keyboard simulation (not applicable in web UI)
- `DoCmd.TransferSpreadsheet` — Translate to backend API file import/export endpoint
- `DoCmd.OutputTo` — Report export (future feature, backend API)
- `Shell` — Running external processes (translate to backend API endpoint if needed)
