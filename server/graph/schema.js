/**
 * Graph Schema - CREATE TABLE statements and initialization
 * Defines the unified dependency/intent graph structure
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
`;

/**
 * Initialize the graph schema in the database
 * @param {Pool} pool - PostgreSQL connection pool
 * @returns {Promise<boolean>} - True if successful
 */
async function initializeGraph(pool) {
  try {
    // Ensure shared schema exists
    await pool.query('CREATE SCHEMA IF NOT EXISTS shared');

    // Create tables and indexes
    await pool.query(SCHEMA_SQL);

    console.log('Graph schema initialized successfully');
    return true;
  } catch (err) {
    console.error('Error initializing graph schema:', err.message);
    throw err;
  }
}

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

module.exports = {
  initializeGraph,
  graphTablesExist,
  SCHEMA_SQL
};
