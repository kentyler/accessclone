# Structure Intent Extraction — Handoff Summary

## What Was Built

A new "structure" intent type that captures the architectural pattern of each form — what the form IS structurally (master-detail, search dashboard, switchboard, etc.) and its interaction subpatterns. This complements the existing "business" intents (what the form is FOR) and "gesture" intents (VBA behavioral).

## Files Created

### `skills/structure-intent-extraction.md` (new)
LLM prompt template for structure extraction. Defines:
- **11 pattern archetypes**: master-detail, data-entry, search-dashboard, switchboard, lookup-dialog, continuous-list, tabbed-form, wizard-form, report-launcher, settings-form, splash-screen
- **11 subpattern types**: cascading-filter, lookup-fill, computed-display, action-trigger, subform-link, record-navigation, conditional-visibility, tab-organization, combo-rowsource-query, default-values, validation-display
- Output schema: pattern, confidence, evidence, subpatterns, layout, navigation, record_interaction, similar_forms
- Three worked examples (master-detail, search-dashboard, switchboard)

### `scripts/extract-structure-intents.js` (new)
Standalone Node script to extract structure intents for all forms in a database.
Usage: `node scripts/extract-structure-intents.js <database_id> -Password <pg_password>`
Resolves modules from `server/node_modules`, uses `server/config.js` for DB connection.

## Files Modified

### `server/lib/object-intent-extractor.js`
- Added `structurePromptTemplate` loaded from `skills/structure-intent-extraction.md` at module init
- Added `VALID_PATTERNS` set for validation
- Added `callStructureLLM()` — separate LLM call function using the structure prompt
- Added `extractFormStructureIntents(definition, formName, graphContext, apiKey)` — public entry point
- Exported `extractFormStructureIntents`

### `server/routes/database-import/extract-object-intents.js`
- Imported `extractFormStructureIntents`
- Added `structure: { extracted: [], failed: [] }` to results
- Form loop now extracts BOTH business and structure intents sequentially
- Structure intents saved to `shared.intents` with `intent_type = 'structure'`
- Updated log message to include structure counts

### `server/routes/chat/context.js`
- Added `loadStructureIntents(pool, formName, databaseId)` — loads structure intents from `shared.intents`
- Added `formatStructureIntents(structure)` — formats structure intent as compact text for LLM system prompt (pattern, subpatterns, layout, navigation, record interaction)
- Exported both new functions

### `server/routes/chat/index.js`
- Imported `loadStructureIntents` and `formatStructureIntents`
- Chat route now loads structure intents alongside business intents for forms
- Appends formatted structure context to system prompt: `\n\nForm structural pattern:\n` + formatted text

## Storage

Structure intents are stored in the existing `shared.intents` table:
- `intent_type = 'structure'`
- `generated_by = 'llm'`
- `content` JSONB contains the full structure intent (pattern, subpatterns, layout, navigation, etc.)
- Uses the same replace-by-type semantics as business intents (DELETE + INSERT on re-extraction)

## Extraction Results (northwind_18)

40 forms extracted successfully, 0 failures. Distribution:
- continuous-list: 17 (subforms showing repeating records)
- master-detail: 7 (parent-child forms)
- data-entry: 6 (single-record editors)
- lookup-dialog: 4 (popup selection forms)
- settings-form: 3 (admin config subforms)
- splash-screen: 2 (startup/learn forms)
- report-launcher: 1 (frmReports)

Confidence range: 0.4 (ambiguous frmLearn) to 0.95 (frmOrderDetails, frmGenericDialog, frmOrderList).

## How It Works End-to-End

1. **At import time**: `POST /api/database-import/extract-object-intents` extracts both business and structure intents for all forms
2. **Or standalone**: `node scripts/extract-structure-intents.js northwind_18 -Password 7297`
3. **At chat time**: When user opens a form and chats, `loadStructureIntents()` loads the structure intent and `formatStructureIntents()` injects it into the system prompt
4. **LLM sees**: Pattern archetype, subpatterns with control names, layout style, navigation graph, record interaction mode

## Tests

All 575 server tests pass. No new tests were added for the structure extraction (it follows the same pattern as business extraction which also has no dedicated tests — both are LLM-dependent). The extraction was verified live against northwind_18.

## What's NOT Done

- Structure extraction for reports (only forms are covered)
- MCP PostgreSQL server for direct DB access from Cowork (attempted, npm package issues on Windows)
- No UI for viewing/editing structure intents (only accessible via DBeaver or chat context)
- No integration with the codegen pipeline (JSON + intents → TSX) — that's a separate future task

## Server Restart Required

The server must be restarted after these changes to pick up the new prompt template (loaded at `require` time).
