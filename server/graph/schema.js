/**
 * Shared Schema - CREATE TABLE statements and initialization
 * Defines the graph structure and UI object storage (forms, reports)
 */

const SCHEMA_SQL = `
-- Unified dependency/intent graph nodes
CREATE TABLE IF NOT EXISTS shared._nodes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    node_type VARCHAR(50) NOT NULL,  -- 'table', 'column', 'form', 'control', 'intent'
    name VARCHAR(255) NOT NULL,
    database_id VARCHAR(100),         -- NULL for intents, required for structural nodes
    scope VARCHAR(50) NOT NULL,       -- 'global' for intents, 'local' for structural
    origin VARCHAR(50),               -- For intents: 'llm', 'user', 'system'
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    CONSTRAINT valid_scope CHECK (
        (node_type = 'intent' AND database_id IS NULL AND scope = 'global')
        OR (node_type != 'intent' AND database_id IS NOT NULL AND scope = 'local')
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

-- Unified dependency/intent graph edges
CREATE TABLE IF NOT EXISTS shared._edges (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    from_id UUID NOT NULL REFERENCES shared._nodes(id) ON DELETE CASCADE,
    to_id UUID NOT NULL REFERENCES shared._nodes(id) ON DELETE CASCADE,
    rel_type VARCHAR(50) NOT NULL,    -- 'contains', 'references', 'bound_to', 'serves', 'requires', 'enables'
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
-- Forms - UI form definitions (EDN) with append-only versioning
-- ============================================================
CREATE TABLE IF NOT EXISTS shared.forms (
    id SERIAL PRIMARY KEY,
    database_id VARCHAR(100) NOT NULL,
    name VARCHAR(255) NOT NULL,
    definition TEXT NOT NULL,
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
-- Reports - UI report definitions (EDN) with append-only versioning
-- ============================================================
CREATE TABLE IF NOT EXISTS shared.reports (
    id SERIAL PRIMARY KEY,
    database_id VARCHAR(100) NOT NULL,
    name VARCHAR(255) NOT NULL,
    definition TEXT NOT NULL,
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
`;

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

    console.log('Shared schema initialized (graph, forms, reports)');
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
