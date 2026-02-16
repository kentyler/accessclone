# Transform Architecture (v2)

A plan for restructuring AccessClone's frontend state management around pure, enumerable, AI-composable transforms.

## Background

AccessClone converts Microsoft Access databases to PostgreSQL-backed web applications. The current frontend (~3800 lines across 5 state files) works correctly but mixes three concerns in every function:

1. **Pure state transforms** — `(old-state, args) -> new-state`
2. **Side effects** — HTTP calls, DOM alerts, transcript saves
3. **Event wiring** — "when X happens, do Y then Z"

This makes the codebase hard for an LLM to reason about. When asked "what happens when the user clicks Save?", the answer is buried in nested `go` blocks with interleaved `swap!` calls and HTTP requests.

## Goal

Separate transforms from effects and wiring so that:

- An LLM can answer "what writes to `[:form-editor :dirty?]`?" from data alone
- VBA import becomes intent extraction + transform mapping (not line-by-line code translation)
- Every state transition is testable without mocking HTTP or DOM
- The transform catalog itself becomes AI context — the LLM wires transforms, it doesn't write imperative code

## Foundations Already Built

### Step 1: State Schema (`state_schema.cljs`, commit `4a06069`)

Declares the complete shape of `app-state`: every path, its type, default, and description. 90+ paths across 14 top-level keys. An LLM can understand state structure without reading code.

### Step 2: Transform Registry (`state_transforms.cljs`, commit `96a4c6e`)

Catalogs all 62 pure sync transforms with reads/writes paths, arguments, domains, and descriptions. Plus 9 readers and 15 pure helpers. Query utilities answer questions like:

```clojure
(writes-to [:form-editor :dirty?])
;; => #{:set-form-definition! :delete-control! :update-control! :toggle-form-header-footer!}

(domain-transforms :table)
;; => all 12 table transforms with their full descriptors
```

## Current State Breakdown

| File | Sync | Async | Total |
|------|------|-------|-------|
| state.cljs | 45 | 36 | 81 |
| state_form.cljs | 18 | 30 | 48 |
| state_table.cljs | 27 | 11 | 38 |
| state_report.cljs | 9 | 5 | 14 |
| state_query.cljs | 3 | 4 | 7 |
| **Totals** | **102** | **86** | **188** |

The 102 sync functions can be mechanically extracted to pure transforms (remove `swap!`, take state as argument, return new state). The 86 async functions need decomposition: separate the I/O from the state update that follows it.

## Architecture

### Three Layers

```
EVENTS (user clicks, timer fires, websocket message)
  │
  ▼
WIRING (event → sequence of steps)
  │
  ├── pure TRANSFORM (state, args) → state
  ├── EFFECT (http-get, alert, save-transcript) → data
  ├── pure TRANSFORM (state, data) → state
  └── ...
```

**Transforms** are pure functions. They take the current state and arguments, return new state. No atoms, no side effects, no `go` blocks.

**Effects** are async operations that produce data: HTTP calls, DOM interactions, local storage reads. They don't touch app-state directly.

**Wiring** connects events to sequences of transforms and effects. This is where "click Save" becomes `[validate → lint-via-http → update-state-with-lint-result → save-to-api → mark-clean]`.

### Transform Shape

```clojure
;; Current (v1): imperative, side-effecting
(defn set-form-definition! [definition]
  (swap! app-state assoc-in [:form-editor :current] definition)
  (swap! app-state assoc-in [:form-editor :dirty?]
         (not= definition (get-in @app-state [:form-editor :original]))))

;; v2: pure function, no atom
(defn set-form-definition [state definition]
  (-> state
      (assoc-in [:form-editor :current] definition)
      (assoc-in [:form-editor :dirty?]
                (not= definition (get-in state [:form-editor :original])))))
```

The v2 version is trivially testable:

```clojure
(let [state {:form-editor {:original {:name "A"} :current {:name "A"} :dirty? false}}
      result (set-form-definition state {:name "B"})]
  (assert (= true (:dirty? (:form-editor result))))
  (assert (= {:name "B"} (get-in result [:form-editor :current]))))
```

### Effect Shape

```clojure
;; Effects are described as data, executed by a runner
{:type   :http-get
 :url    "/api/forms/my_form"
 :headers (db-headers state)
 :on-success [:form-loaded]    ;; event to dispatch with response
 :on-error   [:form-load-failed]}
```

Or as simple async functions that return data (no state mutation):

```clojure
(defn fetch-form [form-name headers]
  ;; Returns a channel/promise with the response data
  (http/get (str api-base "/api/forms/" form-name)
            {:headers headers}))
```

### Wiring Shape

```clojure
;; Wiring defines the sequence for an event
(def save-form-flow
  [{:type :transform :fn set-loading :args [true]}
   {:type :transform :fn clear-lint-errors}
   {:type :effect    :fn lint-form  :input-from [:form-editor :current]}
   {:type :branch
    :test (fn [state lint-result] (:valid lint-result))
    :then [{:type :transform :fn do-save-form}
           {:type :effect    :fn save-form-to-api :input-from [:form-editor :current]}
           {:type :transform :fn mark-form-clean}]
    :else [{:type :transform :fn set-lint-errors :args-from-effect true}]}
   {:type :transform :fn set-loading :args [false]}])
```

## Async Decomposition

Every current async function follows the same pattern:

```
1. Update state (loading, clear errors)     ← TRANSFORM
2. Make HTTP call                            ← EFFECT
3. Update state with response                ← TRANSFORM
4. Possibly trigger another async operation  ← WIRING
```

Example — `load-form-for-editing!` decomposes into:

| Current Code | v2 Layer |
|-------------|----------|
| `auto-save-form-state!` | Wiring: conditionally call save transforms |
| `clear-row-source-cache!` | Transform: `(assoc-in state [:form-editor :row-source-cache] {})` |
| `clear-subform-cache!` | Transform: `(assoc-in state [:form-editor :subform-cache] {})` |
| `http/get "/api/forms/..."` | Effect: returns form definition data |
| `normalize-form-definition` | Pure helper: normalizes the definition |
| `setup-form-editor!` | Transform: installs definition + synced-controls into state |
| `maybe-auto-analyze!` | Wiring: conditionally trigger auto-analyze flow |
| `set-view-mode! :view` | Wiring: triggers view-mode flow (may load records) |

## VBA Import: Intent-Based Translation

### Current Approach (v1)

VBA code → LLM translates line-by-line → PostgreSQL function → ClojureScript wrapper

Problems:
- LLM generates imperative PG/CLJS code that may not match the app's patterns
- Translation errors are hard to diagnose (is the PG function wrong, or the CLJS wiring?)
- Each Access database requires unique translation work

### v2 Approach

VBA code → **extract intent** → **map to named transforms** → wire transforms

```
VBA Source:
  Private Sub btnSave_Click()
      If IsNull(Me.txtName) Then
          MsgBox "Name required"
          Exit Sub
      End If
      DoCmd.RunCommand acCmdSaveRecord
      Me.Requery
  End Sub

Extracted Intent:
  ON button-click "btnSave":
    1. VALIDATE field "txtName" is not null
       → on fail: SHOW MESSAGE "Name required", ABORT
    2. SAVE current record
    3. REFRESH form data

Mapped Transforms:
  [{:transform :validate-required-field :args {:field "txtName" :message "Name required"}}
   {:transform :save-current-record}
   {:transform :refresh-form-data}]
```

The LLM doesn't write code — it identifies **which existing transforms** to compose. If a needed transform doesn't exist (e.g., `:validate-required-field`), that's a clearly defined gap in the catalog, not a hallucinated code block.

### Transform Catalog in Chat Context

The transform catalog becomes part of the LLM system prompt:

```
Available transforms for form domain:
  set-form-definition -> writes [:form-editor :current] [:form-editor :dirty?]
  new-record! -> writes [:form-editor :records] [:form-editor :current-record] ...
  save-current-record -> effect: POST/PUT to /api/data/:table
  delete-control! -> writes [:form-editor :selected-control] [:form-editor :current] ...
  ...

Available transforms for table domain:
  select-table-cell! -> writes [:table-viewer :selected] [:table-viewer :context-menu]
  ...
```

The LLM can now answer: "To implement a button that saves and navigates to the next record, compose: `[:save-current-record :navigate-to-record]` with args `{:position (inc current)}`."

## State Model

### Single Nested Map

All state lives in one nested map (same as today's `app-state` atom, but the v2 transforms operate on the value, not the atom):

```clojure
{:loading? false
 :current-database {:database_id "northwind" :name "Northwind"}
 :form-editor {:current {...} :original {...} :dirty? false
               :records [...] :current-record {...}
               :synced-controls {...}}
 ...}
```

### Session State as Derived Projection

The tabular `shared.form_control_state` table is a **projection** of the nested state, not the source of truth. When a record changes in the form editor:

1. Transform updates `[:form-editor :current-record]` (pure)
2. Wiring derives synced entries from the new record + synced-controls map (pure)
3. Effect pushes entries to `PUT /api/form-state` (async)

The cross-join pattern for queries (`shared.session_state`) remains unchanged — it's a server-side concern that doesn't affect the frontend architecture.

## Northwind as Spec

Rather than inventing abstract transform names, derive the vocabulary from actual Northwind behavioral patterns:

| Northwind Behavior | Transforms Needed |
|-------------------|-------------------|
| Open Orders form, navigate records | `load-form-records`, `navigate-to-record`, `sync-form-state` |
| Filter orders by customer combo | `update-record-field` (combo change), `sync-form-state`, dependent query refilters via session_state |
| Click "New Order" button | `new-record`, `set-defaults` |
| Save order with validation | `validate-record`, `save-current-record` |
| Order Details subform filters by OrderID | `fetch-subform-records` (link-child/master) |
| Print invoice report | `load-report-records`, `group-and-render` |

Each row defines a **user-visible behavior** and the transforms that implement it. The transform vocabulary grows from real needs, not speculation.

## Build Plan

v2 is built as a **separate codebase** (not an incremental refactor). The current app continues working while v2 is developed alongside it.

### Phase 1: Pure Transform Library (no UI)

Create `ui/src/app/transforms/` with one file per domain:

```
transforms/
  core.cljs        ;; transform runner, composition helpers
  ui.cljs          ;; 16 UI transforms as pure functions
  chat.cljs        ;; 4 chat transforms
  form.cljs        ;; 16 form transforms
  report.cljs      ;; 8 report transforms
  table.cljs       ;; 12 table transforms
  query.cljs       ;; 2 query transforms
  module.cljs      ;; 2 module transforms
  macro.cljs       ;; 1 macro transform
  logs.cljs        ;; 1 logs transform
```

Each transform: `(defn transform-name [state & args] ...)` → returns new state.

**Deliverable**: All 62 transforms as pure functions with test coverage.

### Phase 2: Effect Descriptions

Define the effect vocabulary — every HTTP call, DOM interaction, and external operation:

```
effects/
  http.cljs        ;; HTTP effect runner (GET, POST, PUT, DELETE)
  dom.cljs         ;; alert, confirm, prompt
  storage.cljs     ;; localStorage, sessionStorage
```

Catalog the ~86 async operations as effect descriptors.

**Deliverable**: Effect types defined, runners implemented.

### Phase 3: Wiring Layer

Connect events to transform+effect sequences:

```
flows/
  form.cljs        ;; load-form, save-form, navigate, etc.
  report.cljs      ;; load-report, save-report, preview, etc.
  table.cljs       ;; load-table, save-cell, design-save, etc.
  query.cljs       ;; load-query, run-query, etc.
  chat.cljs        ;; send-message, auto-analyze, etc.
```

**Deliverable**: All current async operations expressed as flows.

### Phase 4: VBA Intent Extraction

Build the intent extraction pipeline:

1. Parse VBA source to identify: events handled, state read/written, side effects, control flow
2. Map each intent to existing transforms (or flag as missing)
3. Generate wiring definitions instead of imperative code

**Deliverable**: Northwind VBA modules imported via intent mapping.

### Phase 5: Swap UI Layer

Replace `swap! app-state` calls with transform dispatch. The Reagent views don't change — they still deref `app-state`. Only the mutation path changes:

```clojure
;; Before
(swap! app-state assoc :loading? true)

;; After
(dispatch! :set-loading true)
;; dispatch! applies the transform and swap!s the result into the atom
```

**Deliverable**: Full app running on v2 architecture.

## What Changes for the LLM Chat

Today the chat system prompt includes the form/report definition as JSON. With v2:

- **Transform catalog** added to context: all transforms with reads/writes/args
- **Current wiring** for the active form's events (what transforms fire on-click, on-current, etc.)
- **Available but unwired transforms**: the LLM can suggest new event wiring

The LLM shifts from "analyze this JSON" to "here are the available behaviors — which ones should this button trigger?"

## What Doesn't Change

- **Server-side**: PostgreSQL schema, session-state pattern, API routes — all unchanged
- **Reagent views**: Components still deref `app-state` and render — view layer is unaffected
- **Form/report JSON format**: Definitions stored in `shared.forms`/`shared.reports` stay the same
- **Import pipeline**: PowerShell extraction, table import, query converter — all server-side, unchanged

## Files Reference

| File | Purpose |
|------|---------|
| `ui/src/app/state_schema.cljs` | Declared shape of app-state (step 1) |
| `ui/src/app/state_transforms.cljs` | Transform registry with query utilities (step 2) |
| `ui/src/app/state.cljs` | Current: 81 functions (45 sync, 36 async) |
| `ui/src/app/state_form.cljs` | Current: 48 functions (18 sync, 30 async) |
| `ui/src/app/state_table.cljs` | Current: 38 functions (27 sync, 11 async) |
| `ui/src/app/state_report.cljs` | Current: 14 functions (9 sync, 5 async) |
| `ui/src/app/state_query.cljs` | Current: 7 functions (3 sync, 4 async) |
| `skills/form-state-sync.md` | Session-state cross-join pattern (runtime sync) |
| `skills/conversion-vba.md` | Current VBA translation approach (v1) |
| `skills/database-patterns.md` | PostgreSQL function patterns |
