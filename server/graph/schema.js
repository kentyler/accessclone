/**
 * Shared Schema - CREATE TABLE statements and initialization
 * Defines the graph structure and UI object storage (forms, reports)
 */

const SCHEMA_SQL = `
-- Unified dependency/intent graph nodes
CREATE TABLE IF NOT EXISTS shared._nodes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    node_type VARCHAR(50) NOT NULL,  -- 'table', 'column', 'form', 'control', 'capability', 'potential', 'expression'
    name VARCHAR(255) NOT NULL,
    database_id VARCHAR(100),         -- NULL for global nodes (capability/potential), required for local (structural/expression)
    scope VARCHAR(50) NOT NULL,       -- 'global' for capability/potential, 'local' for structural/expression
    origin VARCHAR(50),               -- 'llm', 'user', 'system', 'imported', 'observed', 'extracted'
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    CONSTRAINT valid_scope CHECK (
        (node_type IN ('capability', 'potential') AND database_id IS NULL AND scope = 'global')
        OR (node_type NOT IN ('capability', 'potential') AND database_id IS NOT NULL AND scope = 'local')
    )
);

CREATE INDEX IF NOT EXISTS idx_nodes_type ON shared._nodes(node_type);
CREATE INDEX IF NOT EXISTS idx_nodes_database ON shared._nodes(database_id) WHERE database_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_nodes_name ON shared._nodes(name);
CREATE INDEX IF NOT EXISTS idx_nodes_type_db ON shared._nodes(node_type, database_id);

-- Unique constraint for upsert: type + name + database_id (with special handling for NULL)
CREATE UNIQUE INDEX IF NOT EXISTS idx_nodes_unique_with_db
  ON shared._nodes(node_type, name, database_id)
  WHERE database_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_nodes_unique_null_db
  ON shared._nodes(node_type, name)
  WHERE database_id IS NULL;

-- Migrate valid_scope constraint to capability/potential (for existing installs)
DO $$ BEGIN
  -- Rename existing intent nodes to potential before constraint update
  UPDATE shared._nodes SET node_type = 'potential' WHERE node_type = 'intent';
  -- Remove any application-typed nodes (applications are expressions, not graph entities)
  DELETE FROM shared._nodes WHERE node_type = 'application';
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'valid_scope' AND conrelid = 'shared._nodes'::regclass
  ) THEN
    ALTER TABLE shared._nodes DROP CONSTRAINT valid_scope;
    ALTER TABLE shared._nodes ADD CONSTRAINT valid_scope CHECK (
      (node_type IN ('capability', 'potential') AND database_id IS NULL AND scope = 'global')
      OR (node_type NOT IN ('capability', 'potential') AND database_id IS NOT NULL AND scope = 'local')
    );
  END IF;
END $$;

-- Unified dependency/intent graph edges
CREATE TABLE IF NOT EXISTS shared._edges (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    from_id UUID NOT NULL REFERENCES shared._nodes(id) ON DELETE CASCADE,
    to_id UUID NOT NULL REFERENCES shared._nodes(id) ON DELETE CASCADE,
    rel_type VARCHAR(50) NOT NULL,    -- 'contains', 'references', 'bound_to', 'serves', 'requires', 'enables', 'expresses', 'refines', 'actualizes'
    status VARCHAR(50),               -- For 'serves' edges: 'confirmed', 'proposed'
    proposed_by VARCHAR(50),          -- For 'serves': 'llm', 'user'
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),

    CONSTRAINT unique_edge UNIQUE (from_id, to_id, rel_type)
);

CREATE INDEX IF NOT EXISTS idx_edges_from ON shared._edges(from_id);
CREATE INDEX IF NOT EXISTS idx_edges_to ON shared._edges(to_id);
CREATE INDEX IF NOT EXISTS idx_edges_rel ON shared._edges(rel_type);
CREATE INDEX IF NOT EXISTS idx_edges_status ON shared._edges(status) WHERE status IS NOT NULL;

-- ============================================================
-- Databases - registry of managed databases with schema mapping
-- ============================================================
CREATE TABLE IF NOT EXISTS shared.databases (
    database_id VARCHAR(100) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    schema_name VARCHAR(255) NOT NULL,
    description TEXT,
    last_accessed TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- Applications - business systems above databases
-- An application is the business concept; a database is where it lives.
-- An application may have an Access source (migration), a PG database
-- (implementation), both, or neither (aspirational from capabilities).
-- ============================================================
CREATE TABLE IF NOT EXISTS shared.applications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    description TEXT,
    database_id VARCHAR(100) REFERENCES shared.databases(database_id),  -- current PG home (nullable)
    source_path TEXT,                       -- Access file it came from (nullable)
    metadata JSONB DEFAULT '{}',            -- provenance, history, tags
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- Forms - UI form definitions (JSON) with append-only versioning
-- ============================================================
CREATE TABLE IF NOT EXISTS shared.forms (
    id SERIAL PRIMARY KEY,
    database_id VARCHAR(100) NOT NULL,
    name VARCHAR(255) NOT NULL,
    definition JSONB NOT NULL,
    record_source VARCHAR(255),
    description TEXT,
    version INT NOT NULL DEFAULT 1,
    is_current BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(database_id, name, version)
);

CREATE INDEX IF NOT EXISTS idx_forms_database ON shared.forms(database_id);
CREATE INDEX IF NOT EXISTS idx_forms_current ON shared.forms(database_id, name) WHERE is_current = true;

-- ============================================================
-- Reports - UI report definitions (JSON) with append-only versioning
-- ============================================================
CREATE TABLE IF NOT EXISTS shared.reports (
    id SERIAL PRIMARY KEY,
    database_id VARCHAR(100) NOT NULL,
    name VARCHAR(255) NOT NULL,
    definition JSONB NOT NULL,
    record_source VARCHAR(255),
    description TEXT,
    version INT NOT NULL DEFAULT 1,
    is_current BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(database_id, name, version)
);

CREATE INDEX IF NOT EXISTS idx_reports_database ON shared.reports(database_id);
CREATE INDEX IF NOT EXISTS idx_reports_current ON shared.reports(database_id, name) WHERE is_current = true;

-- ============================================================
-- Modules - VBA source storage with optional ClojureScript translation
-- ============================================================
CREATE TABLE IF NOT EXISTS shared.modules (
    id SERIAL PRIMARY KEY,
    database_id VARCHAR(100) NOT NULL,
    name VARCHAR(255) NOT NULL,
    vba_source TEXT,
    cljs_source TEXT,
    description TEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',  -- pending, translated, needs-review, complete
    review_notes TEXT,                               -- why this needs revisiting
    version INT NOT NULL DEFAULT 1,
    is_current BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(database_id, name, version)
);

CREATE INDEX IF NOT EXISTS idx_modules_database ON shared.modules(database_id);
CREATE INDEX IF NOT EXISTS idx_modules_current ON shared.modules(database_id, name) WHERE is_current = true;

-- Add status/review_notes columns if missing (for existing installs)
ALTER TABLE shared.modules ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'pending';
ALTER TABLE shared.modules ADD COLUMN IF NOT EXISTS review_notes TEXT;
ALTER TABLE shared.modules ADD COLUMN IF NOT EXISTS intents JSONB;

-- Migrate definition columns from TEXT to JSONB (for existing installs)
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'shared' AND table_name = 'forms'
    AND column_name = 'definition' AND data_type = 'text'
  ) THEN
    ALTER TABLE shared.forms ALTER COLUMN definition TYPE jsonb USING definition::jsonb;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'shared' AND table_name = 'reports'
    AND column_name = 'definition' AND data_type = 'text'
  ) THEN
    ALTER TABLE shared.reports ALTER COLUMN definition TYPE jsonb USING definition::jsonb;
  END IF;
END $$;

-- ============================================================
-- Macros - Access macro XML storage with optional ClojureScript translation
-- ============================================================
CREATE TABLE IF NOT EXISTS shared.macros (
    id SERIAL PRIMARY KEY,
    database_id VARCHAR(100) NOT NULL,
    name VARCHAR(255) NOT NULL,
    macro_xml TEXT,              -- Raw XML from Access SaveAsText
    cljs_source TEXT,            -- Optional ClojureScript translation
    description TEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    review_notes TEXT,
    version INT NOT NULL DEFAULT 1,
    is_current BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(database_id, name, version)
);

CREATE INDEX IF NOT EXISTS idx_macros_database ON shared.macros(database_id);
CREATE INDEX IF NOT EXISTS idx_macros_current ON shared.macros(database_id, name) WHERE is_current = true;

-- ============================================================
-- Events - application event log
-- ============================================================
CREATE TABLE IF NOT EXISTS shared.events (
    id SERIAL PRIMARY KEY,
    event_type VARCHAR(50) NOT NULL,
    source VARCHAR(100),
    database_id VARCHAR(100),
    user_id VARCHAR(100),
    session_id UUID,
    message TEXT,
    details JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_events_type ON shared.events(event_type);
CREATE INDEX IF NOT EXISTS idx_events_created ON shared.events(created_at);

-- ============================================================
-- Import Log - tracks Access database import operations
-- ============================================================
CREATE TABLE IF NOT EXISTS shared.import_log (
    id SERIAL PRIMARY KEY,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    source_path TEXT,
    source_object_name TEXT,
    source_object_type TEXT,
    target_database_id TEXT,
    status TEXT,
    error_message TEXT,
    details JSONB
);

-- ============================================================
-- Source Discovery - tracks what objects exist in the Access source
-- ============================================================
CREATE TABLE IF NOT EXISTS shared.source_discovery (
    id SERIAL PRIMARY KEY,
    database_id VARCHAR(100) NOT NULL UNIQUE,
    source_path TEXT NOT NULL,
    discovery JSONB NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- Gap Questions - persisted gap questions + answers per database
-- ============================================================
CREATE TABLE IF NOT EXISTS shared.gap_questions (
    database_id VARCHAR(100) NOT NULL UNIQUE,
    questions JSONB NOT NULL DEFAULT '[]',
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- Import Issues - persistent issue registry for imported objects
-- ============================================================
CREATE TABLE IF NOT EXISTS shared.import_issues (
    id SERIAL PRIMARY KEY,
    import_log_id INTEGER REFERENCES shared.import_log(id) ON DELETE CASCADE,
    database_id VARCHAR(100) NOT NULL,
    object_name VARCHAR(255) NOT NULL,
    object_type VARCHAR(50) NOT NULL,
    severity VARCHAR(20) NOT NULL DEFAULT 'error',
    category VARCHAR(50),
    location TEXT,
    message TEXT NOT NULL,
    suggestion TEXT,
    resolved BOOLEAN NOT NULL DEFAULT false,
    resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_import_issues_db ON shared.import_issues(database_id);
CREATE INDEX IF NOT EXISTS idx_import_issues_unresolved ON shared.import_issues(database_id, resolved) WHERE resolved = false;
CREATE INDEX IF NOT EXISTS idx_import_log_db ON shared.import_log(target_database_id);

-- ============================================================
-- Chat Transcripts - persistent chat history per object
-- ============================================================
CREATE TABLE IF NOT EXISTS shared.chat_transcripts (
    id SERIAL PRIMARY KEY,
    database_id VARCHAR(100) NOT NULL,
    object_type VARCHAR(50) NOT NULL,
    object_name VARCHAR(255) NOT NULL,
    transcript JSONB DEFAULT '[]',
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(database_id, object_type, object_name)
);

-- ============================================================
-- Issues - structured findings from LLM auto-analysis
-- ============================================================
CREATE TABLE IF NOT EXISTS shared.issues (
    id SERIAL PRIMARY KEY,
    database_id VARCHAR(100) NOT NULL,
    object_type VARCHAR(50) NOT NULL,
    object_name VARCHAR(255) NOT NULL,
    category VARCHAR(50),
    severity VARCHAR(20) NOT NULL DEFAULT 'warning',
    message TEXT NOT NULL,
    suggestion TEXT,
    resolution VARCHAR(20) DEFAULT 'open',
    resolution_notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    resolved_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_issues_db ON shared.issues(database_id);
CREATE INDEX IF NOT EXISTS idx_issues_open
  ON shared.issues(database_id, resolution) WHERE resolution = 'open';
CREATE UNIQUE INDEX IF NOT EXISTS idx_issues_dedup
  ON shared.issues(database_id, object_type, object_name, category, message);

-- ============================================================
-- Form Control State - live form control values for query subqueries
-- Keyed by (session, table, column) so queries don't need form identity
-- ============================================================
CREATE TABLE IF NOT EXISTS shared.form_control_state (
    session_id TEXT NOT NULL,
    table_name TEXT NOT NULL,
    column_name TEXT NOT NULL,
    value TEXT,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (session_id, table_name, column_name)
);
CREATE INDEX IF NOT EXISTS idx_form_control_state_session ON shared.form_control_state(session_id);

-- Migrate old form_control_state schema (form_name/control_name → table_name/column_name)
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'shared' AND table_name = 'form_control_state' AND column_name = 'form_name'
  ) THEN
    TRUNCATE shared.form_control_state;
    ALTER TABLE shared.form_control_state DROP CONSTRAINT form_control_state_pkey;
    ALTER TABLE shared.form_control_state RENAME COLUMN form_name TO table_name;
    ALTER TABLE shared.form_control_state RENAME COLUMN control_name TO column_name;
    ALTER TABLE shared.form_control_state ADD PRIMARY KEY (session_id, table_name, column_name);
  END IF;
END $$;

-- ============================================================
-- Control Column Map - maps form controls to their underlying table.column
-- Populated at form/report save time, consumed by query converter
-- ============================================================
CREATE TABLE IF NOT EXISTS shared.control_column_map (
    database_id VARCHAR(100) NOT NULL,
    form_name TEXT NOT NULL,
    control_name TEXT NOT NULL,
    table_name TEXT NOT NULL,
    column_name TEXT NOT NULL,
    PRIMARY KEY (database_id, form_name, control_name)
);
CREATE INDEX IF NOT EXISTS idx_ccm_table ON shared.control_column_map(database_id, table_name, column_name);

-- ============================================================
-- Attachments — files extracted from Access attachment columns (DAO type 101)
-- ============================================================
CREATE TABLE IF NOT EXISTS shared.attachments (
    id SERIAL PRIMARY KEY,
    database_id VARCHAR(100) NOT NULL,
    table_name VARCHAR(255) NOT NULL,
    pk_column VARCHAR(255) NOT NULL,
    pk_value TEXT NOT NULL,
    column_name VARCHAR(255) NOT NULL,
    file_name TEXT NOT NULL,
    file_path TEXT NOT NULL,
    mime_type VARCHAR(100),
    file_size INTEGER,
    sort_order INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_attachments_lookup
  ON shared.attachments(database_id, table_name, pk_value, column_name);
CREATE UNIQUE INDEX IF NOT EXISTS idx_attachments_unique
  ON shared.attachments(database_id, table_name, pk_value, column_name, file_name);

-- ============================================================
-- Session State View - pre-filtered on current session for cross-join usage in converted queries
-- ============================================================
CREATE OR REPLACE VIEW shared.session_state AS
SELECT table_name, column_name, value
FROM shared.form_control_state
WHERE session_id = current_setting('app.session_id', true);

-- ============================================================
-- Access Property Catalog - reference of all Access object properties
-- Tracks what properties exist, which we import, and version support
-- ============================================================
CREATE TABLE IF NOT EXISTS shared.access_property_catalog (
    id SERIAL PRIMARY KEY,
    access_version VARCHAR(20) NOT NULL,
    object_type VARCHAR(50) NOT NULL,
    object_subtype VARCHAR(50) NOT NULL DEFAULT '',  -- '' = object-level property
    property_name VARCHAR(100) NOT NULL,
    property_data_type VARCHAR(30),
    default_value TEXT,
    enum_values TEXT,
    import_status VARCHAR(20) NOT NULL DEFAULT 'planned',
    skip_reason TEXT,
    notes TEXT,
    UNIQUE(access_version, object_type, object_subtype, property_name)
);

CREATE INDEX IF NOT EXISTS idx_prop_catalog_version
    ON shared.access_property_catalog(access_version);
CREATE INDEX IF NOT EXISTS idx_prop_catalog_type
    ON shared.access_property_catalog(object_type, object_subtype);
`;

/**
 * Seed data for the access_property_catalog table.
 * Each entry: [access_version, object_type, object_subtype, property_name, property_data_type, default_value, enum_values, import_status, skip_reason, notes]
 * object_subtype: '' = object-level property; 'field', 'index', 'section', 'control', 'combo-box', etc. for sub-object props
 * import_status: 'imported' | 'skipped' | 'planned' | 'not-applicable'
 */
const PROPERTY_CATALOG_SEED = [
  // ============================================================
  // TABLE field-level properties (object_subtype = 'field')
  // Source: https://learn.microsoft.com/en-us/office/client-developer/access/desktop-database-reference/field-object-dao
  // ============================================================
  ['1997', 'table', 'field', 'Name', 'string', null, null, 'imported', null, null],
  ['1997', 'table', 'field', 'Type', 'integer', null, '1=Yes/No|2=Byte|3=Integer|4=Long|5=Currency|6=Single|7=Double|8=Date/Time|9=Binary|10=Text|11=OLE Object|12=Memo|15=GUID|16=BigInt|17=VarBinary|20=Decimal|101=Attachment|102-109=Complex/MultiValue', 'imported', null, 'DAO DataTypeEnum code; mapped to PG types by resolveType'],
  ['1997', 'table', 'field', 'Size', 'integer', null, null, 'imported', null, 'Field.Size — used for VARCHAR(n). Max 255 for Text.'],
  ['1997', 'table', 'field', 'Required', 'boolean', 'false', null, 'imported', null, 'Maps to NOT NULL'],
  ['1997', 'table', 'field', 'AllowZeroLength', 'boolean', 'false', null, 'imported', null, 'Text/Memo fields'],
  ['1997', 'table', 'field', 'DefaultValue', 'expression', null, null, 'imported', null, 'Column DEFAULT clause'],
  ['1997', 'table', 'field', 'Attributes', 'integer', '0', null, 'imported', null, 'Bitmask: 0x10=AutoNumber, 0x8000=Hyperlink, 0x01=FixedField, 0x02=VariableField'],
  ['2010', 'table', 'field', 'Expression', 'expression', null, null, 'imported', null, 'For calculated fields (type 18). Added in Access 2010'],
  ['2010', 'table', 'field', 'ResultType', 'integer', '10', null, 'imported', null, 'Return type of calculated field. Added in Access 2010'],
  ['1997', 'table', 'field', 'ValidationRule', 'expression', null, null, 'imported', null, 'Maps to CHECK constraint'],
  ['1997', 'table', 'field', 'ValidationText', 'string', null, null, 'imported', null, 'Error message for validation'],
  ['1997', 'table', 'field', 'Description', 'string', null, null, 'imported', null, 'Maps to pg_description COMMENT'],
  ['1997', 'table', 'field', 'Format', 'string', null, null, 'skipped', 'Display-only; no PG equivalent', null],
  ['1997', 'table', 'field', 'InputMask', 'string', null, null, 'skipped', 'Display-only; enforced client-side', null],
  ['1997', 'table', 'field', 'Caption', 'string', null, null, 'skipped', 'Display-only; used in forms/reports', null],
  ['1997', 'table', 'field', 'DecimalPlaces', 'integer', 'Auto', null, 'skipped', 'Display-only; PG uses precision/scale', null],
  ['2000', 'table', 'field', 'UnicodeCompression', 'boolean', 'true', null, 'not-applicable', 'PG uses native UTF-8. Added with Jet 4.0 (Access 2000)', null],
  ['1997', 'table', 'field', 'IMEMode', 'integer', '0', null, 'not-applicable', 'Input Method Editor — not relevant for web', null],
  ['1997', 'table', 'field', 'IMESentenceMode', 'integer', '3', null, 'not-applicable', 'Input Method Editor — not relevant for web', null],
  ['2003', 'table', 'field', 'SmartTags', 'string', null, null, 'not-applicable', 'Office SmartTags — deprecated feature. Added in Access 2003', null],
  ['1997', 'table', 'field', 'TextAlign', 'integer', '0', '0=General|1=Left|2=Center|3=Right', 'skipped', 'Display-only', null],
  ['1997', 'table', 'field', 'OrdinalPosition', 'integer', null, null, 'imported', null, 'Column order in table'],
  ['1997', 'table', 'field', 'CollatingOrder', 'integer', null, null, 'skipped', 'PG uses database collation', null],
  ['1997', 'table', 'field', 'SourceField', 'string', null, null, 'skipped', 'Read-only; original source field name', null],
  ['1997', 'table', 'field', 'SourceTable', 'string', null, null, 'skipped', 'Read-only; original source table name', null],
  // DAO DataTypeEnum — skipped/planned field types (by DAO type code)
  ['1997', 'table', 'field', 'OLEObject', 'integer', null, null, 'skipped', 'Type 11 (dbLongBinary) — no web equivalent for embedded OLE', null],
  ['1997', 'table', 'field', 'Binary', 'integer', null, null, 'skipped', 'Type 9 (dbBinary) — raw binary, no web equivalent', null],
  ['2000', 'table', 'field', 'VarBinary', 'integer', null, null, 'skipped', 'Type 17 (dbVarBinary) — ODBCDirect only', null],
  ['2000', 'table', 'field', 'Decimal', 'integer', null, null, 'planned', null, 'Type 20 (dbDecimal) — should map to NUMERIC(p,s). Added in Access 2000'],
  ['2007', 'table', 'field', 'Attachment', 'integer', null, null, 'skipped', 'Type 101 (dbAttachment) — multi-file attachment per record. Added in Access 2007', null],
  ['2010', 'table', 'field', 'Calculated', 'integer', null, null, 'imported', null, 'Type 18 — extracted as PG GENERATED columns. Added in Access 2010'],
  ['2016', 'table', 'field', 'BigInt', 'integer', null, null, 'imported', null, 'Type 16 (dbBigInt) — should map to PG bigint. UI support added in Access 2016'],
  ['2021', 'table', 'field', 'DateTimeExtended', 'integer', null, null, 'planned', null, 'Type 26 (dbDateTimeExtended) — nanosecond precision. Maps to PG timestamptz. Access 2021/365'],
  // Multi-valued complex types (Access 2007+) — all need junction-table decomposition
  ['2007', 'table', 'field', 'ComplexByte', 'integer', null, null, 'skipped', 'Type 102 — multi-valued Byte; needs junction table', 'Added in Access 2007'],
  ['2007', 'table', 'field', 'ComplexInteger', 'integer', null, null, 'skipped', 'Type 103 — multi-valued Integer; needs junction table', 'Added in Access 2007'],
  ['2007', 'table', 'field', 'ComplexLong', 'integer', null, null, 'skipped', 'Type 104 — multi-valued Long; needs junction table', 'Added in Access 2007'],
  ['2007', 'table', 'field', 'ComplexSingle', 'integer', null, null, 'skipped', 'Type 105 — multi-valued Single; needs junction table', 'Added in Access 2007'],
  ['2007', 'table', 'field', 'ComplexDouble', 'integer', null, null, 'skipped', 'Type 106 — multi-valued Double; needs junction table', 'Added in Access 2007'],
  ['2007', 'table', 'field', 'ComplexGUID', 'integer', null, null, 'skipped', 'Type 107 — multi-valued GUID; needs junction table', 'Added in Access 2007'],
  ['2007', 'table', 'field', 'ComplexDecimal', 'integer', null, null, 'skipped', 'Type 108 — multi-valued Decimal; needs junction table', 'Added in Access 2007'],
  ['2007', 'table', 'field', 'ComplexText', 'integer', null, null, 'skipped', 'Type 109 — multi-valued Text; needs junction table', 'Added in Access 2007'],
  // Memo field extensions (Access 2007+)
  ['2007', 'table', 'field', 'RichText', 'boolean', 'false', null, 'skipped', 'TextFormat property; stores HTML in memo fields', 'Added in Access 2007'],
  ['2007', 'table', 'field', 'AppendOnly', 'boolean', 'false', null, 'skipped', 'Memo history tracking; Access retains all prior versions', 'Added in Access 2007'],
  ['1997', 'table', 'field', 'Hyperlink', 'boolean', 'false', null, 'skipped', 'Attributes bit 0x8000 on Memo; display#address#subaddress#screentip format', 'Access 97+'],

  // TABLE index-level properties (object_subtype = 'index')
  // Source: https://learn.microsoft.com/en-us/office/client-developer/access/desktop-database-reference/index-object-dao
  ['1997', 'table', 'index', 'Name', 'string', null, null, 'imported', null, null],
  ['1997', 'table', 'index', 'Primary', 'boolean', 'false', null, 'imported', null, 'Maps to PRIMARY KEY'],
  ['1997', 'table', 'index', 'Unique', 'boolean', 'false', null, 'imported', null, 'Maps to UNIQUE index'],
  ['1997', 'table', 'index', 'Fields', 'string', null, null, 'imported', null, 'Comma-separated field names'],
  ['1997', 'table', 'index', 'IgnoreNulls', 'boolean', 'false', null, 'skipped', 'PG indexes include NULLs; partial index possible', null],
  ['1997', 'table', 'index', 'Required', 'boolean', 'false', null, 'skipped', 'Redundant with field-level Required', null],
  ['1997', 'table', 'index', 'Clustered', 'boolean', 'false', null, 'not-applicable', 'PG heap storage — no clustered indexes', null],
  ['1997', 'table', 'index', 'Foreign', 'boolean', null, null, 'skipped', 'Read-only; auto-created FK index. Handled via Relation objects', null],
  ['1997', 'table', 'index', 'DistinctCount', 'integer', null, null, 'skipped', 'Read-only; count of unique values', null],

  // TABLE table-level properties (object_subtype = '')
  // Source: https://learn.microsoft.com/en-us/office/client-developer/access/desktop-database-reference/tabledef-object-dao
  ['1997', 'table', '', 'Name', 'string', null, null, 'imported', null, 'TableDef.Name'],
  ['1997', 'table', '', 'Description', 'string', null, null, 'imported', null, 'Maps to pg_description COMMENT on table'],
  ['1997', 'table', '', 'ValidationRule', 'expression', null, null, 'planned', null, 'Table-level CHECK constraint'],
  ['1997', 'table', '', 'ValidationText', 'string', null, null, 'planned', null, 'Error message for table validation'],
  ['1997', 'table', '', 'Attributes', 'integer', '0', null, 'skipped', 'Bitmask: linked table, hidden, system flags', null],
  ['1997', 'table', '', 'DateCreated', 'string', null, null, 'skipped', 'Read-only; table creation date', null],
  ['1997', 'table', '', 'LastUpdated', 'string', null, null, 'skipped', 'Read-only; last design change', null],
  ['1997', 'table', '', 'RecordCount', 'integer', null, null, 'skipped', 'Read-only; number of records', null],
  ['1997', 'table', '', 'Connect', 'string', null, null, 'skipped', 'Connection string for linked tables', null],
  ['1997', 'table', '', 'SourceTableName', 'string', null, null, 'skipped', 'Source table name for linked tables', null],
  ['2000', 'table', '', 'SubDatasheetName', 'string', '[Auto]', null, 'not-applicable', 'UI-only subdatasheet link. Added in Access 2000', null],
  ['2000', 'table', '', 'SubDatasheetHeight', 'integer', '0', null, 'not-applicable', 'UI-only. Added in Access 2000', null],
  ['2000', 'table', '', 'LinkChildFields', 'string', null, null, 'not-applicable', 'UI-only subdatasheet binding', null],
  ['2000', 'table', '', 'LinkMasterFields', 'string', null, null, 'not-applicable', 'UI-only subdatasheet binding', null],
  ['1997', 'table', '', 'OrderByOn', 'boolean', 'false', null, 'not-applicable', 'UI-only sort state', null],
  ['1997', 'table', '', 'OrderBy', 'string', null, null, 'not-applicable', 'UI-only sort expression', null],
  ['1997', 'table', '', 'FilterOn', 'boolean', 'false', null, 'not-applicable', 'UI-only filter state', null],
  ['1997', 'table', '', 'Filter', 'string', null, null, 'not-applicable', 'UI-only filter expression', null],
  ['2010', 'table', '', 'DataMacroBeforeChange', 'string', null, null, 'planned', null, 'Table event macro — maps to BEFORE trigger. Added in Access 2010'],
  ['2010', 'table', '', 'DataMacroBeforeDelete', 'string', null, null, 'planned', null, 'Table event macro — maps to BEFORE DELETE trigger. Added in Access 2010'],
  ['2010', 'table', '', 'DataMacroAfterInsert', 'string', null, null, 'planned', null, 'Table event macro — maps to AFTER INSERT trigger. Added in Access 2010'],
  ['2010', 'table', '', 'DataMacroAfterUpdate', 'string', null, null, 'planned', null, 'Table event macro — maps to AFTER UPDATE trigger. Added in Access 2010'],
  ['2010', 'table', '', 'DataMacroAfterDelete', 'string', null, null, 'planned', null, 'Table event macro — maps to AFTER DELETE trigger. Added in Access 2010'],

  // ============================================================
  // QUERY properties (object_subtype = '' for query-level)
  // Source: https://learn.microsoft.com/en-us/office/client-developer/access/desktop-database-reference/querydef-object-dao
  // ============================================================
  ['1997', 'query', '', 'Name', 'string', null, null, 'imported', null, null],
  ['1997', 'query', '', 'Type', 'integer', null, '0=Select|16=Crosstab|32=Delete|48=Update|64=Append|80=MakeTable|96=DDL|112=PassThrough|128=Union|144=SPTBulk|160=Compound|224=Procedure|240=Action', 'imported', null, 'DAO QueryDefTypeEnum — complete list'],
  ['1997', 'query', '', 'SQL', 'string', null, null, 'imported', null, 'Full Access SQL text'],
  ['1997', 'query', '', 'Parameters', 'string', null, null, 'imported', null, 'Parameter definitions array'],
  ['1997', 'query', '', 'ReturnsRecords', 'boolean', 'true', null, 'skipped', 'Only relevant for passthrough queries', null],
  ['1997', 'query', '', 'Connect', 'string', null, null, 'skipped', 'ODBC connection string for passthrough', null],
  ['1997', 'query', '', 'ODBCTimeout', 'integer', '60', null, 'not-applicable', 'PG uses statement_timeout', null],
  ['1997', 'query', '', 'MaxRecords', 'integer', '0', null, 'skipped', 'Would need LIMIT clause', null],
  ['1997', 'query', '', 'RecordLocks', 'integer', '0', '0=No Locks|1=All Records|2=Edited Record', 'not-applicable', 'PG uses MVCC', null],
  ['1997', 'query', '', 'Description', 'string', null, null, 'skipped', 'Not extracted; could map to COMMENT ON VIEW', null],
  ['1997', 'query', '', 'DateCreated', 'string', null, null, 'skipped', 'Not tracked', null],
  ['1997', 'query', '', 'LastUpdated', 'string', null, null, 'skipped', 'Not tracked', null],
  ['1997', 'query', '', 'CacheSize', 'integer', null, null, 'not-applicable', 'ODBC record caching', null],
  ['1997', 'query', '', 'Prepare', 'boolean', null, null, 'not-applicable', 'Server-side query compilation', null],

  // ============================================================
  // FORM-LEVEL properties (object_subtype = '')
  // Source: https://learn.microsoft.com/en-us/office/vba/api/access.form
  // ============================================================
  // Data properties
  ['1997', 'form', '', 'Name', 'string', null, null, 'imported', null, null],
  ['1997', 'form', '', 'Caption', 'string', null, null, 'imported', null, 'Title bar text'],
  ['1997', 'form', '', 'RecordSource', 'string', null, null, 'imported', null, 'Table or query name'],
  ['1997', 'form', '', 'DefaultView', 'enum', '0', '0=Single Form|1=Continuous Forms|2=Datasheet|3=PivotTable|4=PivotChart|5=Split Form', 'imported', null, null],
  ['1997', 'form', '', 'RecordsetType', 'enum', '0', '0=Dynaset|1=Dynaset (Inconsistent Updates)|2=Snapshot', 'imported', null, null],
  ['1997', 'form', '', 'RecordLocks', 'enum', '0', '0=No Locks|1=All Records|2=Edited Record', 'skipped', 'PG uses MVCC — no record locking', null],
  ['1997', 'form', '', 'Filter', 'expression', null, null, 'imported', null, 'WHERE clause filter'],
  ['1997', 'form', '', 'FilterOn', 'boolean', 'false', null, 'imported', null, null],
  ['2007', 'form', '', 'FilterOnLoad', 'boolean', 'false', null, 'imported', null, 'Whether filter applies when form loads. Added in Access 2007'],
  ['1997', 'form', '', 'OrderBy', 'string', null, null, 'imported', null, null],
  ['1997', 'form', '', 'OrderByOn', 'boolean', 'false', null, 'imported', null, null],
  ['2007', 'form', '', 'OrderByOnLoad', 'boolean', 'false', null, 'imported', null, 'Whether sort applies when form loads. Added in Access 2007'],
  ['1997', 'form', '', 'AllowAdditions', 'boolean', 'true', null, 'imported', null, null],
  ['1997', 'form', '', 'AllowDeletions', 'boolean', 'true', null, 'imported', null, null],
  ['1997', 'form', '', 'AllowEdits', 'boolean', 'true', null, 'imported', null, null],
  ['1997', 'form', '', 'AllowFilters', 'boolean', 'true', null, 'imported', null, 'Whether users can apply filters'],
  ['1997', 'form', '', 'DataEntry', 'boolean', 'false', null, 'imported', null, 'Show only new record'],
  ['1997', 'form', '', 'FetchDefaults', 'boolean', 'true', null, 'skipped', 'Server default values for new records', null],
  ['1997', 'form', '', 'MaxRecords', 'integer', '0', null, 'skipped', 'Would need LIMIT clause', null],
  ['1997', 'form', '', 'InputParameters', 'string', null, null, 'skipped', 'Stored procedure params for record source', null],
  ['1997', 'form', '', 'UniqueTable', 'string', null, null, 'skipped', 'Multi-table join updatability', null],
  // Format / appearance
  ['1997', 'form', '', 'Width', 'integer', null, null, 'imported', null, 'Form width in twips'],
  ['1997', 'form', '', 'NavigationButtons', 'boolean', 'true', null, 'imported', null, null],
  ['2007', 'form', '', 'NavigationCaption', 'string', null, null, 'skipped', 'Caption for navigation bar. Added in Access 2007', null],
  ['1997', 'form', '', 'RecordSelectors', 'boolean', 'true', null, 'imported', null, null],
  ['1997', 'form', '', 'ScrollBars', 'enum', '3', '0=Neither|1=Horizontal|2=Vertical|3=Both', 'imported', null, null],
  ['1997', 'form', '', 'DividingLines', 'boolean', 'true', null, 'imported', null, null],
  ['1997', 'form', '', 'Picture', 'string', null, null, 'imported', null, 'Background image path'],
  ['1997', 'form', '', 'PictureType', 'enum', '0', '0=Embedded|1=Linked|2=Shared', 'imported', null, null],
  ['1997', 'form', '', 'PictureAlignment', 'enum', '2', '0=Top Left|1=Top Right|2=Center|3=Bottom Left|4=Bottom Right|5=Form Center', 'skipped', 'Background image alignment', null],
  ['1997', 'form', '', 'PictureSizeMode', 'enum', '0', '0=Clip|1=Stretch|3=Zoom|4=Stretch Horizontal|5=Stretch Vertical', 'imported', null, null],
  ['1997', 'form', '', 'PictureTiling', 'boolean', 'false', null, 'skipped', 'Whether picture repeats (tiles)', null],
  ['1997', 'form', '', 'ViewsAllowed', 'enum', '0', '0=Both|1=Form Only|2=Datasheet Only', 'skipped', 'Not enforced in web UI', null],
  ['1997', 'form', '', 'Orientation', 'enum', '0', '0=Left-to-Right|1=Right-to-Left', 'skipped', 'RTL layout direction', null],
  // Window / behavior
  ['1997', 'form', '', 'PopUp', 'boolean', 'false', null, 'imported', null, 'Renders as floating window'],
  ['1997', 'form', '', 'Modal', 'boolean', 'false', null, 'imported', null, 'Adds full-screen backdrop'],
  ['1997', 'form', '', 'Moveable', 'boolean', 'true', null, 'skipped', 'Whether form window can be moved', null],
  ['1997', 'form', '', 'MinMaxButtons', 'enum', '3', '0=None|1=Min Only|2=Max Only|3=Both', 'skipped', 'Not implemented in web UI', null],
  ['1997', 'form', '', 'CloseButton', 'boolean', 'true', null, 'skipped', 'Not implemented', null],
  ['1997', 'form', '', 'WhatsThisButton', 'boolean', 'false', null, 'not-applicable', 'Windows-only help feature', null],
  ['1997', 'form', '', 'ControlBox', 'boolean', 'true', null, 'skipped', 'Window control box', null],
  ['1997', 'form', '', 'BorderStyle', 'enum', '2', '0=None|1=Thin|2=Sizable|3=Dialog', 'skipped', 'Not implemented', null],
  ['1997', 'form', '', 'AutoResize', 'boolean', 'true', null, 'skipped', 'Not implemented', null],
  ['1997', 'form', '', 'AutoCenter', 'boolean', 'false', null, 'skipped', 'Not implemented', null],
  ['1997', 'form', '', 'Cycle', 'enum', '0', '0=All Records|1=Current Record|2=Current Page', 'skipped', 'Tab cycling behavior', null],
  ['1997', 'form', '', 'ShortcutMenu', 'boolean', 'true', null, 'skipped', 'Whether right-click menu is available', null],
  ['1997', 'form', '', 'MenuBar', 'string', null, null, 'not-applicable', 'Custom menu bar — no web equivalent', null],
  ['1997', 'form', '', 'Toolbar', 'string', null, null, 'not-applicable', 'Custom toolbar — no web equivalent', null],
  ['1997', 'form', '', 'ShortcutMenuBar', 'string', null, null, 'not-applicable', 'Custom context menu — not implemented', null],
  ['2007', 'form', '', 'RibbonName', 'string', null, null, 'not-applicable', 'Custom Ribbon XML name. Added in Access 2007', null],
  ['1997', 'form', '', 'HasModule', 'boolean', 'false', null, 'imported', null, 'Whether form has VBA code behind'],
  ['1997', 'form', '', 'Tag', 'string', null, null, 'imported', null, 'User-defined storage string'],
  ['1997', 'form', '', 'KeyPreview', 'boolean', 'false', null, 'planned', null, 'Form sees keystrokes before controls'],
  ['1997', 'form', '', 'TimerInterval', 'integer', '0', null, 'planned', null, 'Milliseconds between OnTimer events'],
  ['1997', 'form', '', 'GridX', 'integer', '24', null, 'skipped', 'Design grid spacing', null],
  ['1997', 'form', '', 'GridY', 'integer', '24', null, 'skipped', 'Design grid spacing', null],
  ['1997', 'form', '', 'LayoutForPrint', 'boolean', 'false', null, 'not-applicable', 'Printer font layout', null],
  // View permissions
  ['1997', 'form', '', 'AllowFormView', 'boolean', 'true', null, 'skipped', 'Not enforced in web UI', null],
  ['1997', 'form', '', 'AllowDatasheetView', 'boolean', 'true', null, 'skipped', 'Not enforced', null],
  ['2007', 'form', '', 'AllowLayoutView', 'boolean', 'true', null, 'skipped', 'Layout View not implemented. Added in Access 2007', null],
  ['1997', 'form', '', 'AllowPivotTableView', 'boolean', 'true', null, 'not-applicable', 'Pivot features removed in Access 2013', null],
  ['1997', 'form', '', 'AllowPivotChartView', 'boolean', 'true', null, 'not-applicable', 'Pivot features removed in Access 2013', null],
  ['1997', 'form', '', 'AllowDesignChanges', 'boolean', 'true', null, 'not-applicable', 'Access runtime property', null],
  // Datasheet format properties (bulk skip — web UI does not render Datasheet view)
  ['1997', 'form', '', 'DatasheetBackColor', 'integer', null, null, 'not-applicable', 'Datasheet view only', null],
  ['2007', 'form', '', 'DatasheetAlternateBackColor', 'integer', null, null, 'not-applicable', 'Datasheet view only. Added in Access 2007', null],
  ['1997', 'form', '', 'DatasheetForeColor', 'integer', null, null, 'not-applicable', 'Datasheet view only', null],
  ['1997', 'form', '', 'DatasheetGridlinesColor', 'integer', null, null, 'not-applicable', 'Datasheet view only', null],
  ['1997', 'form', '', 'DatasheetGridlinesBehavior', 'enum', null, null, 'not-applicable', 'Datasheet view only', null],
  ['1997', 'form', '', 'DatasheetCellsEffect', 'enum', null, null, 'not-applicable', 'Datasheet view only', null],
  ['1997', 'form', '', 'DatasheetFontName', 'string', null, null, 'not-applicable', 'Datasheet view only', null],
  ['1997', 'form', '', 'DatasheetFontHeight', 'integer', null, null, 'not-applicable', 'Datasheet view only', null],
  ['1997', 'form', '', 'DatasheetFontWeight', 'integer', null, null, 'not-applicable', 'Datasheet view only', null],
  ['1997', 'form', '', 'DatasheetFontItalic', 'boolean', 'false', null, 'not-applicable', 'Datasheet view only', null],
  ['1997', 'form', '', 'DatasheetFontUnderline', 'boolean', 'false', null, 'not-applicable', 'Datasheet view only', null],
  ['1997', 'form', '', 'RowHeight', 'integer', null, null, 'not-applicable', 'Datasheet view only', null],
  // Split Form properties (Access 2007+)
  ['2007', 'form', '', 'SplitFormDatasheet', 'enum', null, '0=Allow Edits|1=Read Only', 'not-applicable', 'Split Form not implemented. Added in Access 2007', null],
  ['2007', 'form', '', 'SplitFormOrientation', 'enum', null, '0=Datasheet on Top|1=Datasheet on Bottom|2=Datasheet on Left|3=Datasheet on Right', 'not-applicable', 'Split Form layout. Added in Access 2007', null],
  ['2007', 'form', '', 'SplitFormSize', 'integer', null, null, 'not-applicable', 'Split Form size in twips. Added in Access 2007', null],
  ['2007', 'form', '', 'SplitFormSplitterBar', 'boolean', 'true', null, 'not-applicable', 'Split Form splitter visibility. Added in Access 2007', null],
  ['2007', 'form', '', 'SplitFormPrinting', 'enum', null, '0=Form Only|1=Grid Only', 'not-applicable', 'Split Form print mode. Added in Access 2007', null],
  // Navigation form properties (Access 2010+)
  ['2010', 'form', '', 'NavigationTargetName', 'string', null, null, 'not-applicable', 'Navigation form target — not implemented', 'Added in Access 2010'],
  ['2010', 'form', '', 'NavigationWhereClause', 'string', null, null, 'not-applicable', 'Navigation form filter', 'Added in Access 2010'],
  // Events — imported (extracted from SaveAsText)
  ['1997', 'form', '', 'OnLoad', 'string', null, null, 'imported', null, 'Event procedure flag'],
  ['1997', 'form', '', 'OnOpen', 'string', null, null, 'imported', null, 'Event procedure flag'],
  ['1997', 'form', '', 'OnClose', 'string', null, null, 'imported', null, 'Event procedure flag'],
  ['1997', 'form', '', 'OnCurrent', 'string', null, null, 'imported', null, 'Event procedure flag'],
  ['1997', 'form', '', 'BeforeInsert', 'string', null, null, 'imported', null, 'Event procedure flag'],
  ['1997', 'form', '', 'AfterInsert', 'string', null, null, 'imported', null, 'Event procedure flag'],
  ['1997', 'form', '', 'BeforeUpdate', 'string', null, null, 'imported', null, 'Event procedure flag'],
  ['1997', 'form', '', 'AfterUpdate', 'string', null, null, 'imported', null, 'Event procedure flag'],
  ['1997', 'form', '', 'OnDelete', 'string', null, null, 'imported', null, 'Event procedure flag'],
  // Events — planned
  ['1997', 'form', '', 'OnTimer', 'string', null, null, 'planned', null, 'Timer event procedure'],
  ['1997', 'form', '', 'OnUnload', 'string', null, null, 'planned', null, 'Before form closes'],
  ['1997', 'form', '', 'OnActivate', 'string', null, null, 'planned', null, 'Form gets focus'],
  ['1997', 'form', '', 'OnDeactivate', 'string', null, null, 'planned', null, 'Form loses focus'],
  ['1997', 'form', '', 'OnError', 'string', null, null, 'planned', null, 'Error event handler'],
  ['1997', 'form', '', 'OnKeyDown', 'string', null, null, 'planned', null, 'Key down event'],
  ['1997', 'form', '', 'OnKeyUp', 'string', null, null, 'planned', null, 'Key up event'],
  ['1997', 'form', '', 'OnKeyPress', 'string', null, null, 'planned', null, 'Key press event'],
  ['2000', 'form', '', 'OnDirty', 'string', null, null, 'planned', null, 'Record first modified. Added in Access 2000'],
  ['2000', 'form', '', 'OnUndo', 'string', null, null, 'planned', null, 'User undoes change. Added in Access 2000'],
  ['1997', 'form', '', 'OnResize', 'string', null, null, 'planned', null, 'Form is resized'],
  ['1997', 'form', '', 'OnClick', 'string', null, null, 'planned', null, 'Form background click'],
  ['1997', 'form', '', 'OnDblClick', 'string', null, null, 'planned', null, 'Form background double-click'],
  ['1997', 'form', '', 'OnMouseDown', 'string', null, null, 'planned', null, 'Mouse button pressed'],
  ['1997', 'form', '', 'OnMouseUp', 'string', null, null, 'planned', null, 'Mouse button released'],
  ['1997', 'form', '', 'OnMouseMove', 'string', null, null, 'planned', null, 'Mouse moves over form'],
  ['1997', 'form', '', 'OnGotFocus', 'string', null, null, 'planned', null, 'Form gets focus (no active control)'],
  ['1997', 'form', '', 'OnLostFocus', 'string', null, null, 'planned', null, 'Form loses focus'],
  ['1997', 'form', '', 'OnApplyFilter', 'string', null, null, 'planned', null, 'Filter is applied or removed'],
  ['1997', 'form', '', 'OnFilter', 'string', null, null, 'planned', null, 'Filter window opens'],
  ['1997', 'form', '', 'BeforeDelConfirm', 'string', null, null, 'planned', null, 'Before delete confirmation dialog'],
  ['1997', 'form', '', 'AfterDelConfirm', 'string', null, null, 'planned', null, 'After user confirms deletion'],
  ['2007', 'form', '', 'MouseWheel', 'string', null, null, 'planned', null, 'Mouse wheel rotated. Added in Access 2007'],

  // FORM section-level properties (object_subtype = 'section')
  // Source: https://learn.microsoft.com/en-us/office/vba/api/access.section
  ['1997', 'form', 'section', 'Height', 'integer', null, null, 'imported', null, 'Section height in twips'],
  ['1997', 'form', 'section', 'AutoHeight', 'boolean', null, null, 'skipped', 'Auto-size to content', null],
  ['1997', 'form', 'section', 'BackColor', 'integer', null, null, 'imported', null, 'BGR color value'],
  ['2010', 'form', 'section', 'AlternateBackColor', 'integer', null, null, 'planned', null, 'Alternating row color (Detail). Added in Access 2010'],
  ['1997', 'form', 'section', 'SpecialEffect', 'enum', '0', '0=Flat|1=Raised|2=Sunken|3=Etched|4=Shadowed|5=Chiseled', 'skipped', '3D appearance', null],
  ['1997', 'form', 'section', 'Picture', 'string', null, null, 'imported', null, 'Background image'],
  ['1997', 'form', 'section', 'PictureSizeMode', 'enum', '0', '0=Clip|1=Stretch|3=Zoom', 'imported', null, null],
  ['1997', 'form', 'section', 'Visible', 'boolean', 'true', null, 'planned', null, 'Section visibility'],
  ['1997', 'form', 'section', 'CanGrow', 'boolean', 'false', null, 'planned', null, null],
  ['1997', 'form', 'section', 'CanShrink', 'boolean', 'false', null, 'planned', null, null],
  ['1997', 'form', 'section', 'DisplayWhen', 'enum', '0', '0=Always|1=Print Only|2=Screen Only', 'not-applicable', 'Print control — not relevant for web', null],
  ['1997', 'form', 'section', 'Tag', 'string', null, null, 'imported', null, 'User-defined string'],
  ['1997', 'form', 'section', 'OnClick', 'string', null, null, 'planned', null, null],
  ['1997', 'form', 'section', 'OnDblClick', 'string', null, null, 'planned', null, null],
  ['1997', 'form', 'section', 'OnMouseDown', 'string', null, null, 'planned', null, null],
  ['1997', 'form', 'section', 'OnMouseUp', 'string', null, null, 'planned', null, null],
  ['1997', 'form', 'section', 'OnMouseMove', 'string', null, null, 'planned', null, null],

  // ============================================================
  // FORM CONTROL properties — shared across all control types
  // ============================================================
  ['1997', 'form', 'control', 'Name', 'string', null, null, 'imported', null, 'Control name'],
  ['1997', 'form', 'control', 'ControlType', 'integer', null, null, 'imported', null, 'Mapped to keyword: text-box, label, etc.'],
  ['1997', 'form', 'control', 'Section', 'integer', '0', '0=Detail|1=Header|2=Footer', 'imported', null, null],
  ['1997', 'form', 'control', 'Left', 'integer', '0', null, 'imported', null, 'X position in twips'],
  ['1997', 'form', 'control', 'Top', 'integer', '0', null, 'imported', null, 'Y position in twips'],
  ['1997', 'form', 'control', 'Width', 'integer', null, null, 'imported', null, 'In twips'],
  ['1997', 'form', 'control', 'Height', 'integer', null, null, 'imported', null, 'In twips'],
  ['1997', 'form', 'control', 'Visible', 'boolean', 'true', null, 'imported', null, null],
  ['1997', 'form', 'control', 'Enabled', 'boolean', 'true', null, 'imported', null, null],
  ['1997', 'form', 'control', 'Locked', 'boolean', 'false', null, 'imported', null, null],
  ['1997', 'form', 'control', 'TabIndex', 'integer', null, null, 'imported', null, 'Tab order'],
  ['1997', 'form', 'control', 'TabStop', 'boolean', 'true', null, 'imported', null, null],
  ['1997', 'form', 'control', 'Tag', 'string', null, null, 'imported', null, 'User-defined tag string'],
  ['1997', 'form', 'control', 'ControlTipText', 'string', null, null, 'imported', null, 'Tooltip text'],
  ['1997', 'form', 'control', 'StatusBarText', 'string', null, null, 'skipped', 'Status bar message — no equivalent in web UI', null],
  ['1997', 'form', 'control', 'Caption', 'string', null, null, 'imported', null, 'Display text (labels, buttons)'],
  ['1997', 'form', 'control', 'ControlSource', 'expression', null, null, 'imported', null, 'Field binding or expression'],
  ['1997', 'form', 'control', 'DefaultValue', 'expression', null, null, 'imported', null, null],
  ['1997', 'form', 'control', 'Format', 'string', null, null, 'imported', null, 'Display format string'],
  ['1997', 'form', 'control', 'InputMask', 'string', null, null, 'imported', null, null],
  ['1997', 'form', 'control', 'ValidationRule', 'expression', null, null, 'imported', null, null],
  ['1997', 'form', 'control', 'ValidationText', 'string', null, null, 'imported', null, null],
  ['1997', 'form', 'control', 'ForeColor', 'integer', null, null, 'imported', null, 'BGR text color'],
  ['1997', 'form', 'control', 'BackColor', 'integer', null, null, 'imported', null, 'BGR background color'],
  ['1997', 'form', 'control', 'BorderColor', 'integer', null, null, 'imported', null, 'BGR border color'],
  ['1997', 'form', 'control', 'FontName', 'string', null, null, 'imported', null, null],
  ['1997', 'form', 'control', 'FontSize', 'integer', null, null, 'imported', null, null],
  ['1997', 'form', 'control', 'FontBold', 'boolean', 'false', null, 'imported', null, null],
  ['1997', 'form', 'control', 'FontItalic', 'boolean', 'false', null, 'imported', null, null],
  ['1997', 'form', 'control', 'FontUnderline', 'boolean', 'false', null, 'imported', null, null],
  ['1997', 'form', 'control', 'FontWeight', 'integer', '400', null, 'skipped', 'Covered by FontBold; 100-900 range', null],
  ['1997', 'form', 'control', 'TextAlign', 'enum', '0', '0=General|1=Left|2=Center|3=Right', 'planned', null, null],
  ['1997', 'form', 'control', 'BackStyle', 'enum', '1', '0=Transparent|1=Normal', 'skipped', 'Not implemented', null],
  ['1997', 'form', 'control', 'BorderStyle', 'enum', '0', '0=Transparent|1=Solid|2=Dashes|3=Short Dashes|4=Dots|5=Sparse Dots|6=Dash Dot|7=Dash Dot Dot', 'planned', null, null],
  ['1997', 'form', 'control', 'BorderWidth', 'integer', '1', null, 'skipped', 'Not implemented', null],
  ['1997', 'form', 'control', 'SpecialEffect', 'enum', '1', '0=Flat|1=Raised|2=Sunken|3=Etched|4=Shadowed|5=Chiseled', 'skipped', 'Visual chrome — not replicated', null],
  ['1997', 'form', 'control', 'DisplayWhen', 'enum', '0', '0=Always|1=Print Only|2=Screen Only', 'not-applicable', 'Print control', null],
  ['2007', 'form', 'control', 'HorizontalAnchor', 'enum', '0', '0=Left|1=Both|2=Right', 'skipped', 'Auto-resize anchoring. Added in Access 2007', null],
  ['2007', 'form', 'control', 'VerticalAnchor', 'enum', '0', '0=Top|1=Both|2=Bottom', 'skipped', 'Auto-resize anchoring. Added in Access 2007', null],
  // Events
  ['1997', 'form', 'control', 'OnClick', 'string', null, null, 'imported', null, 'Click event flag'],
  ['1997', 'form', 'control', 'OnDblClick', 'string', null, null, 'imported', null, 'Double-click event flag'],
  ['1997', 'form', 'control', 'OnChange', 'string', null, null, 'imported', null, 'Change event flag'],
  ['1997', 'form', 'control', 'OnEnter', 'string', null, null, 'imported', null, 'Enter event flag'],
  ['1997', 'form', 'control', 'OnExit', 'string', null, null, 'imported', null, 'Exit event flag'],
  ['1997', 'form', 'control', 'BeforeUpdate', 'string', null, null, 'imported', null, 'Before update event flag'],
  ['1997', 'form', 'control', 'AfterUpdate', 'string', null, null, 'imported', null, 'After update event flag'],
  ['1997', 'form', 'control', 'OnGotFocus', 'string', null, null, 'imported', null, 'Got focus event flag'],
  ['1997', 'form', 'control', 'OnLostFocus', 'string', null, null, 'imported', null, 'Lost focus event flag'],
  ['1997', 'form', 'control', 'OnKeyDown', 'string', null, null, 'planned', null, 'Key down event'],
  ['1997', 'form', 'control', 'OnKeyUp', 'string', null, null, 'planned', null, 'Key up event'],
  ['1997', 'form', 'control', 'OnKeyPress', 'string', null, null, 'planned', null, 'Key press event'],
  ['1997', 'form', 'control', 'OnMouseDown', 'string', null, null, 'planned', null, 'Mouse button pressed'],
  ['1997', 'form', 'control', 'OnMouseUp', 'string', null, null, 'planned', null, 'Mouse button released'],
  ['1997', 'form', 'control', 'OnMouseMove', 'string', null, null, 'planned', null, 'Mouse moves over control'],
  ['2000', 'form', 'control', 'OnDirty', 'string', null, null, 'planned', null, 'Control first modified'],
  ['2000', 'form', 'control', 'OnUndo', 'string', null, null, 'planned', null, 'User undoes change'],
  ['1997', 'form', 'control', 'ConditionalFormatting', 'string', null, null, 'planned', null, 'Conditional formatting rules'],

  // FORM combo-box / list-box specific (object_subtype = 'combo-box')
  ['1997', 'form', 'combo-box', 'RowSource', 'string', null, null, 'imported', null, 'SQL query or table name'],
  ['1997', 'form', 'combo-box', 'RowSourceType', 'string', 'Table/Query', 'Table/Query|Value List|Field List', 'imported', null, null],
  ['1997', 'form', 'combo-box', 'BoundColumn', 'integer', '1', null, 'imported', null, 'Which column value to store'],
  ['1997', 'form', 'combo-box', 'ColumnCount', 'integer', '1', null, 'imported', null, 'Number of columns to display'],
  ['1997', 'form', 'combo-box', 'ColumnWidths', 'string', null, null, 'imported', null, 'Semicolon-separated widths'],
  ['1997', 'form', 'combo-box', 'ColumnHeads', 'boolean', 'false', null, 'skipped', 'Column header row visibility', null],
  ['1997', 'form', 'combo-box', 'LimitToList', 'boolean', 'false', null, 'imported', null, 'Restrict to listed values'],
  ['1997', 'form', 'combo-box', 'ListRows', 'integer', '16', null, 'skipped', 'Dropdown height — CSS handles this', null],
  ['1997', 'form', 'combo-box', 'ListWidth', 'integer', null, null, 'skipped', 'Dropdown width — CSS auto', null],
  ['1997', 'form', 'combo-box', 'AutoExpand', 'boolean', 'true', null, 'planned', null, 'Type-ahead autocomplete'],
  ['2000', 'form', 'combo-box', 'AllowValueListEdits', 'boolean', 'false', null, 'planned', null, 'User can edit Value List items'],
  ['2000', 'form', 'combo-box', 'ListItemsEditForm', 'string', null, null, 'planned', null, 'Form for editing Value List items'],
  ['1997', 'form', 'combo-box', 'OnNotInList', 'string', null, null, 'imported', null, 'Event when value not in list'],

  // FORM list-box specific (object_subtype = 'list-box')
  ['1997', 'form', 'list-box', 'RowSource', 'string', null, null, 'imported', null, null],
  ['1997', 'form', 'list-box', 'RowSourceType', 'string', 'Table/Query', 'Table/Query|Value List|Field List', 'imported', null, null],
  ['1997', 'form', 'list-box', 'BoundColumn', 'integer', '1', null, 'imported', null, null],
  ['1997', 'form', 'list-box', 'ColumnCount', 'integer', '1', null, 'imported', null, null],
  ['1997', 'form', 'list-box', 'ColumnWidths', 'string', null, null, 'imported', null, null],
  ['1997', 'form', 'list-box', 'ColumnHeads', 'boolean', 'false', null, 'skipped', 'Column header row visibility', null],
  ['1997', 'form', 'list-box', 'MultiSelect', 'enum', '0', '0=None|1=Simple|2=Extended', 'planned', null, null],

  // FORM subform specific (object_subtype = 'subform')
  ['1997', 'form', 'subform', 'SourceObject', 'string', null, null, 'imported', null, 'Child form name'],
  ['1997', 'form', 'subform', 'LinkChildFields', 'string', null, null, 'imported', null, 'Child linking fields'],
  ['1997', 'form', 'subform', 'LinkMasterFields', 'string', null, null, 'imported', null, 'Parent linking fields'],

  // FORM tab-control specific (object_subtype = 'tab-control')
  ['1997', 'form', 'tab-control', 'Pages', 'string', null, null, 'imported', null, 'Array of page names'],
  ['1997', 'form', 'tab-control', 'Style', 'enum', '0', '0=Tabs|1=Buttons|2=None', 'skipped', 'Tab control style', null],
  ['1997', 'form', 'tab-control', 'MultiRow', 'boolean', 'false', null, 'skipped', 'Allow multiple tab rows', null],
  ['1997', 'form', 'tab-control', 'TabFixedWidth', 'integer', '0', null, 'skipped', 'Fixed width per tab; 0=auto', null],
  ['1997', 'form', 'tab-control', 'TabFixedHeight', 'integer', '0', null, 'skipped', 'Fixed height per tab; 0=auto', null],

  // FORM page (tab page) specific (object_subtype = 'page')
  ['1997', 'form', 'page', 'PageIndex', 'integer', null, null, 'imported', null, 'Order within tab control'],
  ['1997', 'form', 'page', 'Caption', 'string', null, null, 'imported', null, 'Tab label text'],
  ['1997', 'form', 'page', 'Visible', 'boolean', 'true', null, 'imported', null, 'Page visibility'],

  // FORM image specific (object_subtype = 'image')
  ['1997', 'form', 'image', 'Picture', 'string', null, null, 'imported', null, 'Image source path'],
  ['1997', 'form', 'image', 'SizeMode', 'enum', '0', '0=Clip|1=Stretch|3=Zoom', 'imported', null, null],
  ['1997', 'form', 'image', 'PictureType', 'enum', '0', '0=Embedded|1=Linked', 'imported', null, null],
  ['1997', 'form', 'image', 'Hyperlink', 'string', null, null, 'planned', null, 'Hyperlink address'],

  // FORM button specific (object_subtype = 'button')
  ['1997', 'form', 'button', 'Caption', 'string', null, null, 'imported', null, null],
  ['1997', 'form', 'button', 'Picture', 'string', null, null, 'imported', null, 'Button icon'],
  ['1997', 'form', 'button', 'PictureType', 'enum', '0', '0=Embedded|1=Linked', 'skipped', 'Button icon storage type', null],
  ['1997', 'form', 'button', 'OnClick', 'string', null, null, 'imported', null, 'Click event — primary button action'],
  ['1997', 'form', 'button', 'Transparent', 'boolean', 'false', null, 'skipped', 'Not implemented', null],
  ['1997', 'form', 'button', 'Default', 'boolean', 'false', null, 'planned', null, 'Enter key activates this button'],
  ['1997', 'form', 'button', 'Cancel', 'boolean', 'false', null, 'planned', null, 'Escape key activates this button'],

  // FORM option-group specific (object_subtype = 'option-group')
  ['1997', 'form', 'option-group', 'DefaultValue', 'integer', null, null, 'imported', null, 'Default selected option value'],
  ['1997', 'form', 'option-group', 'ControlSource', 'string', null, null, 'imported', null, 'Bound field'],

  // FORM toggle-button / option-button / checkbox (object_subtype = 'toggle-button')
  ['1997', 'form', 'toggle-button', 'OptionValue', 'integer', null, null, 'imported', null, 'Value when selected (within option group)'],
  ['1997', 'form', 'toggle-button', 'TripleState', 'boolean', 'false', null, 'skipped', 'Allow Null third state', null],

  // FORM line / rectangle (object_subtype = 'line')
  ['1997', 'form', 'line', 'LineSlant', 'enum', '0', '0=TopLeft to BottomRight|1=TopRight to BottomLeft', 'imported', null, null],
  ['1997', 'form', 'line', 'BorderWidth', 'integer', '1', null, 'imported', null, null],

  // FORM web-browser control (Access 2007+)
  ['2007', 'form', 'web-browser', 'ControlSource', 'string', null, null, 'imported', null, 'URL expression. Added in Access 2007'],

  // ============================================================
  // REPORT-LEVEL properties (object_subtype = '')
  // Source: https://learn.microsoft.com/en-us/office/vba/api/access.report
  // ============================================================
  ['1997', 'report', '', 'Name', 'string', null, null, 'imported', null, null],
  ['1997', 'report', '', 'Caption', 'string', null, null, 'imported', null, null],
  ['1997', 'report', '', 'RecordSource', 'string', null, null, 'imported', null, null],
  ['1997', 'report', '', 'Width', 'integer', null, null, 'imported', null, 'Report width in twips'],
  ['1997', 'report', '', 'PageHeader', 'enum', '0', '0=All Pages|1=Not With Rpt Hdr|2=Not With Rpt Ftr|3=Not With Rpt Hdr/Ftr', 'imported', null, null],
  ['1997', 'report', '', 'PageFooter', 'enum', '0', '0=All Pages|1=Not With Rpt Hdr|2=Not With Rpt Ftr|3=Not With Rpt Hdr/Ftr', 'imported', null, null],
  ['1997', 'report', '', 'Picture', 'string', null, null, 'imported', null, null],
  ['1997', 'report', '', 'PictureType', 'enum', '0', '0=Embedded|1=Linked|2=Shared', 'imported', null, null],
  ['1997', 'report', '', 'PictureAlignment', 'enum', '2', '0=Top Left|1=Top Right|2=Center|3=Bottom Left|4=Bottom Right', 'skipped', 'Background image alignment', null],
  ['1997', 'report', '', 'PictureSizeMode', 'enum', '0', '0=Clip|1=Stretch|3=Zoom', 'imported', null, null],
  ['1997', 'report', '', 'PictureTiling', 'boolean', 'false', null, 'skipped', 'Whether picture repeats', null],
  ['1997', 'report', '', 'PicturePages', 'enum', '0', '0=All Pages|1=First Page|2=No Pages', 'skipped', 'Which pages show background picture', null],
  ['1997', 'report', '', 'Filter', 'expression', null, null, 'planned', null, null],
  ['1997', 'report', '', 'FilterOn', 'boolean', 'false', null, 'planned', null, null],
  ['2007', 'report', '', 'FilterOnLoad', 'boolean', 'false', null, 'planned', null, 'Added in Access 2007'],
  ['1997', 'report', '', 'OrderBy', 'string', null, null, 'planned', null, null],
  ['1997', 'report', '', 'OrderByOn', 'boolean', 'false', null, 'planned', null, null],
  ['2007', 'report', '', 'OrderByOnLoad', 'boolean', 'false', null, 'planned', null, 'Added in Access 2007'],
  ['1997', 'report', '', 'InputParameters', 'string', null, null, 'skipped', 'Stored procedure params for record source', null],
  ['1997', 'report', '', 'GrpKeepTogether', 'enum', '0', '0=Per Page|1=Per Column', 'planned', null, null],
  ['1997', 'report', '', 'HasModule', 'boolean', 'false', null, 'imported', null, null],
  ['1997', 'report', '', 'Tag', 'string', null, null, 'imported', null, 'User-defined storage string'],
  ['1997', 'report', '', 'Orientation', 'enum', '0', '0=Left-to-Right|1=Right-to-Left', 'skipped', 'RTL layout direction', null],
  ['1997', 'report', '', 'AutoResize', 'boolean', 'true', null, 'skipped', 'Not implemented', null],
  ['1997', 'report', '', 'AutoCenter', 'boolean', 'false', null, 'skipped', 'Not implemented', null],
  ['1997', 'report', '', 'PopUp', 'boolean', 'false', null, 'planned', null, null],
  ['1997', 'report', '', 'Modal', 'boolean', 'false', null, 'planned', null, null],
  ['1997', 'report', '', 'DateGrouping', 'enum', '0', '0=Use System Settings|1=US Defaults', 'skipped', 'Locale-specific', null],
  ['1997', 'report', '', 'TimerInterval', 'integer', '0', null, 'planned', null, null],
  ['1997', 'report', '', 'GridX', 'integer', '24', null, 'skipped', 'Design grid', null],
  ['1997', 'report', '', 'GridY', 'integer', '24', null, 'skipped', 'Design grid', null],
  ['1997', 'report', '', 'PageHeight', 'integer', '15840', null, 'planned', null, 'Page size in twips'],
  ['1997', 'report', '', 'PageWidth', 'integer', '12240', null, 'planned', null, 'Page size in twips'],
  ['1997', 'report', '', 'TopMargin', 'integer', '1440', null, 'planned', null, null],
  ['1997', 'report', '', 'BottomMargin', 'integer', '1440', null, 'planned', null, null],
  ['1997', 'report', '', 'LeftMargin', 'integer', '1440', null, 'planned', null, null],
  ['1997', 'report', '', 'RightMargin', 'integer', '1440', null, 'planned', null, null],
  ['1997', 'report', '', 'FitToPage', 'boolean', 'true', null, 'planned', null, null],
  ['1997', 'report', '', 'MenuBar', 'string', null, null, 'not-applicable', 'Custom menu bar', null],
  ['1997', 'report', '', 'Toolbar', 'string', null, null, 'not-applicable', 'Custom toolbar', null],
  ['2007', 'report', '', 'RibbonName', 'string', null, null, 'not-applicable', 'Custom Ribbon XML name. Added in Access 2007', null],
  // Report events
  ['1997', 'report', '', 'OnOpen', 'string', null, null, 'imported', null, null],
  ['1997', 'report', '', 'OnClose', 'string', null, null, 'imported', null, null],
  ['1997', 'report', '', 'OnActivate', 'string', null, null, 'imported', null, null],
  ['1997', 'report', '', 'OnDeactivate', 'string', null, null, 'imported', null, null],
  ['1997', 'report', '', 'OnNoData', 'string', null, null, 'imported', null, null],
  ['1997', 'report', '', 'OnPage', 'string', null, null, 'imported', null, null],
  ['1997', 'report', '', 'OnError', 'string', null, null, 'imported', null, null],
  ['1997', 'report', '', 'OnTimer', 'string', null, null, 'planned', null, null],

  // REPORT grouping-level properties (object_subtype = 'grouping')
  ['1997', 'report', 'grouping', 'ControlSource', 'string', null, null, 'imported', null, 'Group-by field name'],
  ['1997', 'report', 'grouping', 'GroupHeader', 'boolean', 'true', null, 'imported', null, 'Show group header band'],
  ['1997', 'report', 'grouping', 'GroupFooter', 'boolean', 'false', null, 'imported', null, 'Show group footer band'],
  ['1997', 'report', 'grouping', 'SortOrder', 'enum', '0', '0=Ascending|1=Descending', 'imported', null, null],
  ['1997', 'report', 'grouping', 'GroupOn', 'enum', '0', '0=Each Value|1=Prefix Characters|2=Year|3=Quarter|4=Month|5=Week|6=Day|7=Hour|8=Minute|9=Interval', 'imported', null, null],
  ['1997', 'report', 'grouping', 'GroupInterval', 'integer', '1', null, 'imported', null, null],
  ['1997', 'report', 'grouping', 'KeepTogether', 'enum', '0', '0=No|1=Whole Group|2=With First Detail', 'imported', null, null],

  // REPORT section-level properties (object_subtype = 'section')
  ['1997', 'report', 'section', 'Height', 'integer', null, null, 'imported', null, 'Band height in twips'],
  ['1997', 'report', 'section', 'AutoHeight', 'boolean', null, null, 'skipped', 'Auto-size to content', null],
  ['1997', 'report', 'section', 'Visible', 'boolean', 'true', null, 'imported', null, null],
  ['1997', 'report', 'section', 'CanGrow', 'boolean', 'false', null, 'imported', null, null],
  ['1997', 'report', 'section', 'CanShrink', 'boolean', 'false', null, 'imported', null, null],
  ['1997', 'report', 'section', 'ForceNewPage', 'enum', '0', '0=None|1=Before Section|2=After Section|3=Before & After', 'imported', null, null],
  ['1997', 'report', 'section', 'KeepTogether', 'boolean', 'true', null, 'imported', null, null],
  ['1997', 'report', 'section', 'BackColor', 'integer', null, null, 'imported', null, 'BGR color'],
  ['2010', 'report', 'section', 'AlternateBackColor', 'integer', null, null, 'planned', null, 'Alternating row color. Added in Access 2010'],
  ['1997', 'report', 'section', 'SpecialEffect', 'enum', '0', '0=Flat|1=Raised|2=Sunken|3=Etched|4=Shadowed|5=Chiseled', 'skipped', '3D appearance', null],
  ['1997', 'report', 'section', 'Picture', 'string', null, null, 'imported', null, null],
  ['1997', 'report', 'section', 'PictureSizeMode', 'enum', '0', '0=Clip|1=Stretch|3=Zoom', 'imported', null, null],
  ['1997', 'report', 'section', 'Tag', 'string', null, null, 'imported', null, 'User-defined string'],
  ['1997', 'report', 'section', 'OnFormat', 'string', null, null, 'imported', null, 'Format event flag'],
  ['1997', 'report', 'section', 'OnPrint', 'string', null, null, 'imported', null, 'Print event flag'],
  ['1997', 'report', 'section', 'OnRetreat', 'string', null, null, 'imported', null, 'Retreat event flag'],
  ['1997', 'report', 'section', 'OnClick', 'string', null, null, 'planned', null, null],
  ['1997', 'report', 'section', 'OnDblClick', 'string', null, null, 'planned', null, null],
  ['1997', 'report', 'section', 'OnMouseDown', 'string', null, null, 'planned', null, null],
  ['1997', 'report', 'section', 'OnMouseUp', 'string', null, null, 'planned', null, null],
  ['1997', 'report', 'section', 'OnMouseMove', 'string', null, null, 'planned', null, null],
  ['1997', 'report', 'section', 'NewRowOrCol', 'enum', '0', '0=None|1=Before Section|2=After Section|3=Before & After', 'planned', null, null],
  ['1997', 'report', 'section', 'RepeatSection', 'boolean', 'false', null, 'planned', null, 'Repeat group header on each page'],
  ['1997', 'report', 'section', 'DisplayWhen', 'enum', '0', '0=Always|1=Print Only|2=Screen Only', 'planned', null, null],

  // ============================================================
  // REPORT CONTROL properties — shared across all report control types
  // ============================================================
  ['1997', 'report', 'control', 'Name', 'string', null, null, 'imported', null, null],
  ['1997', 'report', 'control', 'ControlType', 'integer', null, null, 'imported', null, null],
  ['1997', 'report', 'control', 'Left', 'integer', null, null, 'imported', null, 'X position in twips'],
  ['1997', 'report', 'control', 'Top', 'integer', null, null, 'imported', null, 'Y position in twips'],
  ['1997', 'report', 'control', 'Width', 'integer', null, null, 'imported', null, null],
  ['1997', 'report', 'control', 'Height', 'integer', null, null, 'imported', null, null],
  ['1997', 'report', 'control', 'Visible', 'boolean', 'true', null, 'imported', null, null],
  ['1997', 'report', 'control', 'Caption', 'string', null, null, 'imported', null, null],
  ['1997', 'report', 'control', 'ControlSource', 'expression', null, null, 'imported', null, 'Field binding or expression'],
  ['1997', 'report', 'control', 'Format', 'string', null, null, 'imported', null, null],
  ['1997', 'report', 'control', 'Tag', 'string', null, null, 'imported', null, null],
  ['1997', 'report', 'control', 'ControlTipText', 'string', null, null, 'imported', null, null],
  ['1997', 'report', 'control', 'ForeColor', 'integer', null, null, 'imported', null, null],
  ['1997', 'report', 'control', 'BackColor', 'integer', null, null, 'imported', null, null],
  ['1997', 'report', 'control', 'BorderColor', 'integer', null, null, 'imported', null, null],
  ['1997', 'report', 'control', 'FontName', 'string', null, null, 'imported', null, null],
  ['1997', 'report', 'control', 'FontSize', 'integer', null, null, 'imported', null, null],
  ['1997', 'report', 'control', 'FontBold', 'boolean', 'false', null, 'imported', null, null],
  ['1997', 'report', 'control', 'FontItalic', 'boolean', 'false', null, 'imported', null, null],
  ['1997', 'report', 'control', 'FontUnderline', 'boolean', 'false', null, 'imported', null, null],
  ['1997', 'report', 'control', 'RunningSum', 'enum', '0', '0=No|1=Over Group|2=Over All', 'imported', null, null],
  ['1997', 'report', 'control', 'CanGrow', 'boolean', 'false', null, 'imported', null, null],
  ['1997', 'report', 'control', 'CanShrink', 'boolean', 'false', null, 'imported', null, null],
  ['1997', 'report', 'control', 'HideDuplicates', 'boolean', 'false', null, 'imported', null, null],
  ['1997', 'report', 'control', 'TextAlign', 'enum', '0', '0=General|1=Left|2=Center|3=Right', 'planned', null, null],
  ['1997', 'report', 'control', 'BackStyle', 'enum', '1', '0=Transparent|1=Normal', 'skipped', 'Not implemented', null],
  ['1997', 'report', 'control', 'BorderStyle', 'enum', '0', '0=Transparent|1=Solid|2=Dashes|3=Short Dashes|4=Dots', 'planned', null, null],
  ['1997', 'report', 'control', 'BorderWidth', 'integer', '1', null, 'skipped', 'Not implemented', null],
  ['1997', 'report', 'control', 'SpecialEffect', 'enum', '1', '0=Flat|1=Raised|2=Sunken|3=Etched|4=Shadowed|5=Chiseled', 'skipped', 'Visual chrome', null],
  ['1997', 'report', 'control', 'DisplayWhen', 'enum', '0', '0=Always|1=Print Only|2=Screen Only', 'planned', null, null],
  ['2007', 'report', 'control', 'HorizontalAnchor', 'enum', '0', '0=Left|1=Both|2=Right', 'skipped', 'Auto-resize anchoring. Added in Access 2007', null],
  ['2007', 'report', 'control', 'VerticalAnchor', 'enum', '0', '0=Top|1=Both|2=Bottom', 'skipped', 'Auto-resize anchoring. Added in Access 2007', null],
  ['1997', 'report', 'control', 'OnFormat', 'string', null, null, 'imported', null, null],
  ['1997', 'report', 'control', 'OnPrint', 'string', null, null, 'imported', null, null],
  ['1997', 'report', 'control', 'OnClick', 'string', null, null, 'imported', null, null],
  ['1997', 'report', 'control', 'OnDblClick', 'string', null, null, 'planned', null, null],

  // REPORT subreport specific (object_subtype = 'subreport')
  ['1997', 'report', 'subreport', 'SourceObject', 'string', null, null, 'imported', null, 'Child report name'],
  ['1997', 'report', 'subreport', 'LinkChildFields', 'string', null, null, 'imported', null, null],
  ['1997', 'report', 'subreport', 'LinkMasterFields', 'string', null, null, 'imported', null, null],

  // ============================================================
  // RELATIONSHIP properties (planned — foreign keys not yet auto-imported)
  // Source: https://learn.microsoft.com/en-us/office/client-developer/access/desktop-database-reference/relation-object-dao
  // ============================================================
  ['1997', 'relationship', '', 'Name', 'string', null, null, 'planned', null, 'Relationship name'],
  ['1997', 'relationship', '', 'Table', 'string', null, null, 'planned', null, 'Primary (referenced) table'],
  ['1997', 'relationship', '', 'ForeignTable', 'string', null, null, 'planned', null, 'Foreign (referencing) table'],
  ['1997', 'relationship', '', 'Fields', 'string', null, null, 'planned', null, 'Field pairs (Name=PK field, ForeignName=FK field)'],
  ['1997', 'relationship', '', 'Attributes', 'integer', null, '1=Unique(1:1)|2=DontEnforce|4=Inherited|256=CascadeUpdate|4096=CascadeDelete|16777216=LeftJoin|33554432=RightJoin', 'planned', null, 'RelationAttributeEnum bitmask'],

  // ============================================================
  // MODULE properties
  // ============================================================
  ['1997', 'module', '', 'Name', 'string', null, null, 'imported', null, null],
  ['1997', 'module', '', 'Type', 'integer', null, '1=Standard|2=Class|100=Document', 'imported', null, 'VBE component type'],
  ['1997', 'module', '', 'CountOfLines', 'integer', null, null, 'imported', null, 'Line count (used for skip detection)'],
  ['1997', 'module', '', 'Source', 'string', null, null, 'imported', null, 'Full VBA source code'],
  ['1997', 'module', '', 'CountOfDeclarationLines', 'integer', null, null, 'skipped', 'Not extracted separately', null],

  // ============================================================
  // MACRO properties
  // ============================================================
  ['1997', 'macro', '', 'Name', 'string', null, null, 'imported', null, null],
  ['1997', 'macro', '', 'XML', 'string', null, null, 'imported', null, 'SaveAsText output — raw macro definition'],
  ['2010', 'macro', '', 'IsDataMacro', 'boolean', 'false', null, 'planned', null, 'Data macros introduced in Access 2010'],
  ['2007', 'macro', '', 'IsEmbedded', 'boolean', 'false', null, 'skipped', 'Embedded macros stored in form/report events. Added in Access 2007', null],
];

/**
 * Seed the property catalog table (idempotent via ON CONFLICT DO NOTHING)
 */
async function seedPropertyCatalog(pool) {
  if (PROPERTY_CATALOG_SEED.length === 0) return;

  const COLS_PER_ROW = 10;
  const BATCH_SIZE = 500;

  for (let i = 0; i < PROPERTY_CATALOG_SEED.length; i += BATCH_SIZE) {
    const batchRows = PROPERTY_CATALOG_SEED.slice(i, i + BATCH_SIZE);
    const batchValues = [];
    const batchParams = [];
    let idx = 1;

    for (const row of batchRows) {
      const placeholders = [];
      for (let j = 0; j < COLS_PER_ROW; j++) {
        placeholders.push(`$${idx++}`);
        batchParams.push(row[j] !== undefined ? row[j] : null);
      }
      batchValues.push(`(${placeholders.join(', ')})`);
    }

    await pool.query(`
      INSERT INTO shared.access_property_catalog
        (access_version, object_type, object_subtype, property_name,
         property_data_type, default_value, enum_values,
         import_status, skip_reason, notes)
      VALUES ${batchValues.join(',\n')}
      ON CONFLICT (access_version, object_type, object_subtype, property_name)
      DO NOTHING
    `, batchParams);
  }
}

/**
 * Initialize the shared schema in the database
 * Creates graph tables (_nodes, _edges) and UI object tables (forms, reports)
 * @param {Pool} pool - PostgreSQL connection pool
 * @returns {Promise<boolean>} - True if successful
 */
async function initializeSchema(pool) {
  try {
    // Ensure shared schema exists
    await pool.query('CREATE SCHEMA IF NOT EXISTS shared');

    // Create tables and indexes
    await pool.query(SCHEMA_SQL);

    // Seed property catalog (idempotent)
    await seedPropertyCatalog(pool);

    console.log('Shared schema initialized (graph, forms, reports, property catalog)');
    return true;
  } catch (err) {
    console.error('Error initializing shared schema:', err.message);
    throw err;
  }
}

// Alias for backwards compatibility
const initializeGraph = initializeSchema;

/**
 * Check if graph tables exist
 * @param {Pool} pool - PostgreSQL connection pool
 * @returns {Promise<boolean>}
 */
async function graphTablesExist(pool) {
  try {
    const result = await pool.query(`
      SELECT COUNT(*) as count FROM information_schema.tables
      WHERE table_schema = 'shared'
      AND table_name IN ('_nodes', '_edges')
    `);
    return parseInt(result.rows[0].count) === 2;
  } catch (err) {
    return false;
  }
}

/**
 * Check if all shared schema tables exist
 * @param {Pool} pool - PostgreSQL connection pool
 * @returns {Promise<boolean>}
 */
async function sharedTablesExist(pool) {
  try {
    const result = await pool.query(`
      SELECT COUNT(*) as count FROM information_schema.tables
      WHERE table_schema = 'shared'
      AND table_name IN ('_nodes', '_edges', 'forms', 'reports')
    `);
    return parseInt(result.rows[0].count) === 4;
  } catch (err) {
    return false;
  }
}

module.exports = {
  initializeSchema,
  initializeGraph,  // backwards compatibility alias
  graphTablesExist,
  sharedTablesExist,
  SCHEMA_SQL
};
