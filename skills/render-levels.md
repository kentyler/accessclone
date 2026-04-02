# Progressive Render Levels

<!-- INTENTS EXTRACTED → intents.json:
  concept → progressive-rendering
  NOTE: Status is "watching" — partially superseded by per-form-generation pipeline.
-->

## Concept

A per-object debug/development tool that builds up rendering in 5 progressive layers. Each level adds to the previous. Useful for:
- **Debugging**: isolate layout bugs from data bugs from event bugs
- **LLM reasoning**: request a specific level to focus on one concern
- **Form building**: validate structure before wiring data

## The Five Levels

| Level | Name | What it adds |
|-------|------|-------------|
| 1 | Chrome | Structural shell — sections/bands/grid frame, backgrounds, nav bar shell |
| 2 | Layout | Positioned elements with styling (controls, columns) — no data |
| 3 | Data Source | Fetch records, show record count — elements still show placeholders |
| 4 | Data Binding | Connect elements to field values, record navigation works |
| 5 | Interactivity | Events, editing, focus handlers — full behavior (default) |

## Cross-Object Applicability

| Level | Forms | Reports | Tables | Queries |
|-------|-------|---------|--------|---------|
| 1 Chrome | Border, sections, nav bar shell | Page layout, band structure | Grid frame, column count | Grid frame |
| 2 Layout | Controls positioned + styled | Controls in bands | Column headers + types | Column headers |
| 3 Data Source | Fetch records, show count | Fetch records, group breaks | Fetch rows, show count | Execute SQL |
| 4 Data Binding | Controls show values | Controls show values, aggregates | Cells show values | Cells show values |
| 5 Interactivity | Events, editing | Print/export, events | Inline editing, CRUD | (read-only) |

## Architecture

### Shared Module: `ui-react/src/lib/render-level.ts` (new)
- `RenderLevel` type (1-5)
- `RENDER_LEVELS` array with name + description per level
- Used by all object stores and UI components

### Reusable Component: `ui-react/src/components/RenderLevelSelector.tsx` (new)
- Dropdown: `1 - Chrome` through `5 - Interactivity`
- Yellow info bar when level < 5: what current level shows, what next level adds
- Props: `level`, `onChange` — works with any store

### Per-Store State
Each object store (form, report, table, query) owns its own `renderLevel` property.

## Implementation Plan — Forms First

### Files to Create
1. `ui-react/src/lib/render-level.ts` — shared types and metadata
2. `ui-react/src/components/RenderLevelSelector.tsx` — reusable UI component

### Files to Modify

#### `ui-react/src/store/form.ts`
- Add `renderLevel: RenderLevel` to `FormState` (default `5`)
- Add `setRenderLevel(level: RenderLevel)` to `FormActions`
- Gate `loadFormRecords()` in `setViewMode('view')` on `renderLevel >= 3`
- `setRenderLevel`: crossing 3 boundary up → trigger data load; crossing down → clear records

#### `ui-react/src/views/FormEditor/FormEditor.tsx`
- Import `RenderLevelSelector`, add to toolbar between view-mode buttons and save/undo
- Only visible in view mode

#### `ui-react/src/views/FormEditor/FormView.tsx` (core changes)

**FormView (main component, line 398)**:
- Read `renderLevel` from store
- Level 1-2: render section structure even without data (currently gated on `hasData` — loosen this)
- Nav bar at level 1: show chrome (disabled buttons, "0 of 0")
- Nav bar at level 3: show record count, editing buttons disabled
- Nav bar at level 4+: fully functional

**FormViewSection (line 238)**:
- Level 1: render section div with background/height but NO controls — show faint centered label ("header" / "detail" / "footer")
- Level 2+: render controls as today

**FormViewControl (line 56)**:
- Level < 4: pass `undefined` as value, no-op onChange, `false` for allowEdits. Text-boxes show `[fieldName]` placeholder.
- Level < 5: suppress focus event wiring, suppress button click handlers

#### Control Components
- `ButtonControl.tsx` — accept `suppressEvents?: boolean`, no-op click when true
- `ComboBoxControl.tsx` — gate `fetchRowSource()` on level >= 4, show `[fieldName]` placeholder at lower levels
- `SubFormControl.tsx` — render placeholder box `[Subform: sourceName]` at level < 4

#### `ui-react/public/css/style.css`
- `.render-level-selector` — toolbar dropdown
- `.render-level-info` — yellow info bar
- `.section-label-overlay` — faint label for level 1 empty sections

#### `server/routes/chat/index.js`
- If `form_context.render_level < 5`, append level info to LLM system prompt

#### `ui-react/src/store/ui.ts`
- Include `render_level` in `form_context` payload for chat messages

### Implementation Order
1. `render-level.ts` — shared types
2. `RenderLevelSelector.tsx` — reusable component
3. `store/form.ts` — state + data-loading gate
4. `FormEditor.tsx` — wire selector into toolbar
5. `FormView.tsx` — conditional rendering per level (biggest piece)
6. Control components — button, combo, subform adjustments
7. CSS — new styles
8. Chat context — expose level to LLM

## Verification (frmAbout in northwind_18)

1. Level 1 → 3 colored section bands with correct heights, nav bar shell, no controls
2. Level 2 → controls at correct positions with colors/fonts, text-boxes show `[txtabout]`, button shows "Close"
3. Level 3 → nav bar shows "1 of 1", controls still show placeholders
4. Level 4 → txtAbout displays actual text from getstring(41)
5. Level 5 → cmdClose fires AC.closeForm(), identical to current behavior
6. Level 5 regression check: zero visible difference from pre-change behavior

## Design Decisions

- **Level per store, not per form**: simpler; user works one form at a time. Can be upgraded to `Record<string, RenderLevel>` per form name later if needed.
- **Level 5 = zero overhead**: only adds a few `renderLevel >= N` comparisons (always true) to the render path.
- **Lower levels are faster**: they skip work (no data fetch, no event wiring, no row-source loading).
- **Hooks compliance**: `useFormStore(s => s.renderLevel)` is always called; only logic inside callbacks checks the level. No conditional hook calls.
