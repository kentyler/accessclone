# Event Runtime — Forms & Reports

How translated VBA event handlers execute client-side in AccessClone. Covers the full pipeline from intent extraction through runtime dispatch for both forms and reports.

## Overview

When VBA modules are translated, structured **intent trees** describe what each event handler does. At runtime, the **intent interpreter** (`ui/src/app/intent_interpreter.cljs`) walks these trees and dispatches to framework functions — opening forms, navigating records, showing messages, running domain lookups, toggling control visibility, etc.

The system is **async-capable**: sync intents (navigation, messages, control state) execute immediately; async intents (DLookup, DCount, DSum, RunSQL) make HTTP calls and await results before continuing to the next intent in the sequence.

## Architecture

```
VBA Source Code
     |
     v
Intent Extraction (LLM)         ── POST /api/chat/extract-intents
     |
     v
Intent Mapping (mechanical)      ── vba-intent-mapper.js
     |
     v
shared.modules.intents (JSONB)   ── stored in database
     |
     v
Handler Extraction               ── GET /api/modules/:name/handlers
     |                               (parses procedure names like btnSave_Click,
     |                                Form_Load, Report_Open into control+event pairs)
     |
     v
Client Registration              ── Forms:   projection/register-event-handlers
                                     Reports: state_report/load-event-handlers-for-report!
     |
     v
Runtime Dispatch                  ── intent-interpreter/execute-intents
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
| `on-click` | `btnName_Click` | Button click (3-tier: intent handler → `:on-click` property → caption match) |
| `after-update` | `ctrlName_AfterUpdate` | After a field value changes (via `update-record-field!`) |
| `on-enter` | `ctrlName_Enter` | Control receives focus (fires before GotFocus) |
| `on-gotfocus` | `ctrlName_GotFocus` | Control receives focus (fires after Enter) |
| `on-exit` | `ctrlName_Exit` | Control loses focus (fires before LostFocus) |
| `on-lostfocus` | `ctrlName_LostFocus` | Control loses focus (fires after Exit) |

### Focus Event Wiring

Focus events are attached to the `.view-control` wrapper div in `form_view.cljs`. React's `onFocus`/`onBlur` bubble from child inputs, so one attachment point covers all control types.

The projection's `field-triggers` map tracks which controls have focus event flags:
- `:has-enter-event`, `:has-exit-event`, `:has-gotfocus-event`, `:has-lostfocus-event`

Only controls with at least one flag get handlers attached (no overhead for controls without focus events).

### Button Click Resolution

Buttons use a 3-tier resolution in `resolve-button-action`:
1. **Intent handler**: Check projection `:event-handlers` for `ctrl-name.on-click`
2. **Property**: Check `:on-click` property (action map or function name)
3. **Caption**: Match button text to built-in actions ("Save", "Close", "Delete", "New Record", "Refresh")

## Report Events

### Loading Pipeline

When a report opens:

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

Reports are read-only previews — no control-level events (click, focus, value change) apply.

### Handler Key Format

The server generates handler keys like `"report.on-open"` (using `toKw(rawControl) + "." + eventKey`). Report-level events use `"report"` as the control name. The `fire-report-event!` function constructs the same key format for lookup.

## Intent Interpreter

### Async Execution Model

`execute-intents` returns a `core.async` channel (`go` block):

```
(execute-intents intents)           ;; fire-and-forget — go block runs in background
(execute-intents intents ctx)       ;; with initial context map
```

Internally, a loop processes intents sequentially. Each intent dispatches via `execute-single-intent`, which returns:
- `nil` for sync intents (already executed)
- A channel for async intents (awaited with `<!` before continuing)

### Context Threading

A `ctx` map threads through the intent loop:

- **`{last-result}`**: Always holds the most recent async result
- **`{result_var}`**: DLookup/DCount/DSum intents with `:result_var` also store results under named keys

Example flow from VBA:
```
DLookup("CompanyName", "Customers", "CustomerID = {CustomerID}")  → result_var: "ship_name"
write-field ShipName = {ship_name}
```

The `resolve-intent-value` function resolves `{var_name}` placeholders by checking ctx first, then the current form record.

### Supported Intent Types

**Sync intents** (execute immediately):

| Intent | Description |
|--------|-------------|
| `open-form` | Open a form tab by name |
| `open-report` | Open a report tab by name |
| `close-current` | Close the active tab |
| `goto-record` | Navigate to first/last/next/previous/new record |
| `new-record` | Create a new record |
| `save-record` | Save the current record |
| `delete-record` | Delete with confirmation |
| `requery` | Reload form data |
| `show-message` | `js/alert` with message text |
| `confirm-action` | `js/confirm` → then/else branches |
| `set-control-visible` | Toggle control visibility |
| `set-control-enabled` | Toggle control enabled state |
| `set-control-value` | Set control caption/text |
| `write-field` | Update a field value in the current record |
| `validate-required` | Alert + throw if field is blank (aborts remaining intents) |
| `value-switch` | Switch/case on a field value |
| `branch` | If/else with Access expression condition |
| `error-handler` | Try/catch wrapper for a sequence of intents |

**Async intents** (HTTP call, await response):

| Intent | Description | Endpoint |
|--------|-------------|----------|
| `dlookup` | SELECT field FROM table WHERE criteria LIMIT 1 | `POST /api/queries/run` |
| `dcount` | SELECT COUNT(field) FROM table WHERE criteria | `POST /api/queries/run` |
| `dsum` | SELECT SUM(field) FROM table WHERE criteria | `POST /api/queries/run` |
| `run-sql` | Execute INSERT/UPDATE/DELETE | `POST /api/queries/execute` |

### Branch Conditions

`:branch` intents evaluate conditions as Access expressions via the expression evaluator (`expressions.cljs`). Supported operators and functions:

- **Comparisons**: `=`, `<>`, `<`, `>`, `<=`, `>=`
- **Logical**: `And`, `Or`, `Not` (precedence: comparison → NOT → AND → OR)
- **Functions**: `IsNull()`, `IIf()`, `Nz()`, `Format()`, `Left()`, `Right()`, `Mid()`, `Len()`, `Trim()`, etc.
- **Field refs**: `[FieldName]` resolved from current record
- **Literals**: strings `"..."`, numbers, dates `#mm/dd/yyyy#`, `True`/`False`/`Null`

Access convention: `-1` = True, `0` = False.

### Criteria Resolution

Domain function criteria (DLookup, DCount, DSum) go through two-stage conversion:

1. **Placeholder resolution** (`resolve-criteria-placeholders`): `{FieldName}` → actual value from current record/ctx. Numbers inline directly; strings get single-quoted with `'` escaping.
2. **Syntax conversion** (`convert-criteria`): `[field]` → `"field"`, `#date#` → `'date'`, `True`/`False` → `true`/`false`.

Field and table names are also cleaned via `strip-brackets` to handle Access-style `[Name]` → `Name`.

## Server Endpoints

### GET /api/modules/:name/handlers

Extracts event handler descriptors from a module's stored intents. Returns an array of:

```json
[{
  "key": "btn-orders.on-click",
  "control": "btn-orders",
  "event": "on-click",
  "procedure": "btnOrders_Click",
  "intents": [...]
}]
```

Parses VBA procedure names (`btnOrders_Click` → control `btnOrders`, event `click`). Maps VBA event names to kebab-case keys:

| VBA Event | Handler Key |
|-----------|-------------|
| `Click` | `on-click` |
| `DblClick` | `on-dblclick` |
| `Load` | `on-load` |
| `Open` | `on-open` |
| `Close` | `on-close` |
| `Current` | `on-current` |
| `AfterUpdate` | `after-update` |
| `BeforeUpdate` | `before-update` |
| `Change` | `on-change` |
| `Enter` | `on-enter` |
| `Exit` | `on-exit` |
| `GotFocus` | `on-gotfocus` |
| `LostFocus` | `on-lostfocus` |
| `NoData` | `on-no-data` |

AfterUpdate handlers already covered by the reactions system are excluded.

### POST /api/queries/execute

Executes INSERT, UPDATE, or DELETE SQL. Rejects SELECT, DROP, ALTER, TRUNCATE, and multi-statement SQL. Sets the schema search_path before execution. Returns `{ rowCount }`.

Used by `run-sql` intents for data modification operations translated from VBA `DoCmd.RunSQL`.

## File Map

| File | Role |
|------|------|
| `ui/src/app/intent_interpreter.cljs` | Runtime: walks intent trees, dispatches actions, async loop |
| `ui/src/app/views/expressions.cljs` | Expression evaluator: parser + evaluator for Access expressions |
| `ui/src/app/projection.cljs` | Data projection: field-triggers, control-state, event-handlers |
| `ui/src/app/state_form.cljs` | Form state: `fire-form-event!`, `load-event-handlers-for-form!`, `update-record-field!` (AfterUpdate) |
| `ui/src/app/state_report.cljs` | Report state: `fire-report-event!`, `load-event-handlers-for-report!` |
| `ui/src/app/views/form_view.cljs` | Form rendering: button click resolution, focus event wiring |
| `ui/src/app/flows/report.cljs` | Report flows: preview data load, on-open/on-no-data firing |
| `ui/src/app/flows/navigation.cljs` | Tab close: fires report on-close before closing |
| `server/routes/modules.js` | Server: handler extraction from stored intents |
| `server/routes/metadata.js` | Server: `/api/queries/run` (SELECT) and `/api/queries/execute` (DML) |
| `server/lib/reactions-extractor.js` | Server: extracts AfterUpdate reactions, `toKw()` control name conversion |
| `server/lib/vba-intent-mapper.js` | Server: maps raw intents to mechanical/LLM-fallback/gap classifications |
