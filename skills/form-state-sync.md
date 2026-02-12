# Form State Sync — Design Document

## Problem

Access queries can reference open form control values, e.g.:
```sql
WHERE CategoryID = [Forms]![frmProducts]![cboProductCategories]
```
Currently the query converter strips these references or converts them to function parameters (via `extractTempVars`), breaking queries that depend on live form values. TempVars have the same pattern — session-scoped name/value pairs converted to function parameters, forcing queries to become functions instead of views.

## Solution

A PostgreSQL state table holds current form control values. Converted queries reference it via subquery. The frontend keeps it in sync using control tags to identify which controls participate.

## Architecture

### 1. State Table

```sql
CREATE TABLE shared.form_control_state (
  session_id text,
  form_name text,
  control_name text,
  value text,
  PRIMARY KEY (session_id, form_name, control_name)
);
```

Session ID scopes values per user. Form name + control name identify the value. All values stored as text — PG handles implicit casting in WHERE clauses (e.g., `WHERE categoryid = (SELECT value FROM ...)` casts text to integer).

### 2. Query Converter Translation

The converter translates form references to subqueries against the state table:

```
[Forms]![frmProducts]![cboProductCategories]
→ (SELECT value FROM shared.form_control_state
   WHERE session_id = current_setting('app.session_id', true)
   AND form_name = 'frmproducts'
   AND control_name = 'cboproductcategories')
```

This happens in `applySyntaxTranslations()` in `query-converter.js`, alongside the existing `Forms!` bang-notation regex. The query stays a **view** — no function wrapping needed.

### 3. TempVars Migration

TempVars use the same mechanism with a reserved form name:

```
TempVars("CurrentUserID")
→ (SELECT value FROM shared.form_control_state
   WHERE session_id = current_setting('app.session_id', true)
   AND form_name = '_tempvars'
   AND control_name = 'currentuserid')
```

This replaces the current `extractTempVars()` approach that converts queries from views to functions with parameters.

### 4. Session ID

Each API request sets the session ID on the PG connection before running queries. The data route (`/api/data/:table`) wraps its query:

```javascript
await client.query(`SET LOCAL app.session_id = $1`, [sessionId]);
const result = await client.query(`SELECT * FROM ...`);
```

`SET LOCAL` scopes the setting to the current transaction — no leaking across pooled connections. The session ID comes from an HTTP header (e.g., `X-Session-ID`) set by the frontend.

### 5. Control Tags

Access controls have a `tag` property (already imported and stored in form definitions). Controls tagged with `"state"` (or similar) participate in state sync. The tag is set either:
- **Manually** in the Access database before import
- **Automatically** by the query converter when it encounters `[Forms]![formName]![controlName]` references — it could update the form definition to tag the referenced control

### 6. Frontend Sync

**On form load** (once):
1. Scan all controls in the form definition for the sync tag
2. Build a Set of tagged control names, store in form state as `:synced-controls`

**On record navigate** (`navigate-to-record!`):
1. After loading the new record, collect values for all tagged controls
2. Bulk upsert to `form_control_state` — single API call with all control name/value pairs

**On individual control change** (`on-change` handler):
1. Check if control name is in the `:synced-controls` Set — O(1) lookup
2. If yes, upsert that single control's value to `form_control_state`
3. If the control has dependents (e.g., a combo box that filters a subform), trigger a data refresh

### 7. API Endpoint

```
PUT /api/form-state
Body: {
  sessionId: "...",
  formName: "frmproducts",
  controls: { "cbocategories": "5", "cbovendor": "12" }
}
```

Handles both bulk (multiple controls) and single (one control) updates with the same endpoint. Server runs a multi-row UPSERT.

## Files to Modify

### Server
- **`server/lib/query-converter.js`** — Replace `Forms!` regex and `extractTempVars()` with subquery translations against `form_control_state`
- **`server/routes/data.js`** — Add `SET LOCAL app.session_id` before data queries
- **`server/routes/form-state.js`** (new) — PUT endpoint for upserting control state
- **`server/server.js`** — Register the new route, create `form_control_state` table on startup

### Frontend
- **`ui/src/app/state_form.cljs`** — Build `:synced-controls` Set on form load; call state sync API from `navigate-to-record!`; add `upsert-control-state!` function
- **`ui/src/app/views/form_view.cljs`** — In control `on-change`, check synced set and call individual upsert if tagged

### Scripts
- **`scripts/access/export_form.ps1`** — Already exports the `tag` property (confirmed in `access_database_viewer.cljs` control-base)

## Implementation Order

1. Create `shared.form_control_state` table (server startup)
2. Add PUT `/api/form-state` endpoint
3. Update query converter: `Forms!` → subquery, `TempVars` → subquery
4. Add `SET LOCAL app.session_id` to data route
5. Frontend: generate session ID, send as header
6. Frontend: scan tags on form load, build synced set
7. Frontend: bulk upsert on record navigate
8. Frontend: individual upsert on control change
9. Test with northwind queries that reference form controls

## Notes

- `current_setting('app.session_id', true)` returns NULL if not set (PG 9.6+), so queries degrade gracefully to returning no rows rather than erroring
- The state table is lightweight — one row per tagged control per session, cleaned up on session end or periodically
- Implicit text→integer/date casting works for most WHERE comparisons; explicit casts can be added to the converter if needed for edge cases
- This design unifies form refs and TempVars under one mechanism
