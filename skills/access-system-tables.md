# Access System Tables

Access databases contain internal system tables (MSys* and USys* prefixes) that are part of the Jet/ACE engine. These tables are used by VBA code to enumerate objects, inspect relationships, and query metadata — functionality that AccessClone handles through its own infrastructure (dependency graph, `information_schema`, `shared.*` tables).

## Key System Tables

| Table | Purpose | AccessClone Equivalent |
|-------|---------|----------------------|
| MSysObjects | Master catalog of all objects (tables, queries, forms, reports, modules, macros) | `shared.source_discovery`, dependency graph (`shared._nodes`), `information_schema` |
| MSysRelationships | Foreign key / relationship definitions | `information_schema.table_constraints` + `key_column_usage` |
| MSysQueries | Query SQL and metadata | `information_schema.views`, `pg_get_viewdef()` |
| MSysACEs | Access Control Entries (security) | PostgreSQL role-based permissions |
| MSysAccessObjects | Access object metadata cache | Dependency graph |
| MSysAccessXML | XML import/export specs | Not applicable |
| MSysIMEXSpecs / MSysIMEXColumns | Import/Export specifications | Not applicable |
| MSysNavigatePane* | Navigation Pane layout/grouping | App Viewer UI |
| MSysDBTableAttributes | Table-level property storage | `pg_description`, column metadata |
| MSysComplexType_* | Multi-valued field backing tables | Not yet supported (planned: junction table decomposition) |
| MSysResources | Theme/icon resources | Not applicable |
| USysObjects | User-defined system objects | Not applicable |
| USysRibbons | Custom Ribbon XML definitions | Not applicable |
| USysApplicationLog | Application-level event log | `shared.events` |

## How They're Handled

### API Surface Analysis
The `GET /api/app/api-surface` endpoint in `server/routes/app.js` maintains an `ACCESS_SYSTEM_TABLES` set. When VBA module intents reference these tables (e.g. `DLookup("Name", "MSysObjects", ...)`), they are:
- Marked `exists: true` (no import needed)
- Flagged `system: true` (shown as "N/A" in the UI, not "Missing")

### Intent Extraction
When the LLM extracts intents from VBA that reads MSysObjects, the intent should be classified as a **gap** with resolution noting that object enumeration is handled by AccessClone's graph/metadata APIs. The VBA pattern is typically:
```vba
Set rs = db.OpenRecordset("SELECT Name FROM MSysObjects WHERE Type=1")
```
This is "list all tables" — equivalent to querying `information_schema.tables` or the dependency graph.

### Adding New System Tables
If a new Access database references a system table not in the set, add it to `ACCESS_SYSTEM_TABLES` in `server/routes/app.js`. The naming convention: all entries are lowercase (the lookup normalizes case).
