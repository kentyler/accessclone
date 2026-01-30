/**
 * Graph Query Functions
 * Core operations for finding, creating, and traversing graph nodes and edges
 */

/**
 * Find a node by type, name, and optionally database_id
 * @param {Pool} pool
 * @param {string} nodeType - 'table', 'column', 'form', 'control', 'intent'
 * @param {string} name - Node name
 * @param {string|null} databaseId - Database ID (null for intents)
 * @returns {Promise<Object|null>}
 */
async function findNode(pool, nodeType, name, databaseId = null) {
  const query = databaseId
    ? `SELECT * FROM shared._nodes WHERE node_type = $1 AND name = $2 AND database_id = $3`
    : `SELECT * FROM shared._nodes WHERE node_type = $1 AND name = $2 AND database_id IS NULL`;

  const params = databaseId ? [nodeType, name, databaseId] : [nodeType, name];
  const result = await pool.query(query, params);
  return result.rows[0] || null;
}

/**
 * Find a node by ID
 * @param {Pool} pool
 * @param {string} nodeId - UUID
 * @returns {Promise<Object|null>}
 */
async function findNodeById(pool, nodeId) {
  const result = await pool.query('SELECT * FROM shared._nodes WHERE id = $1', [nodeId]);
  return result.rows[0] || null;
}

/**
 * Find nodes by type and optional database_id
 * @param {Pool} pool
 * @param {string} nodeType
 * @param {string|null} databaseId
 * @returns {Promise<Array>}
 */
async function findNodesByType(pool, nodeType, databaseId = null) {
  let query, params;
  if (databaseId) {
    query = 'SELECT * FROM shared._nodes WHERE node_type = $1 AND database_id = $2 ORDER BY name';
    params = [nodeType, databaseId];
  } else if (nodeType === 'intent') {
    query = 'SELECT * FROM shared._nodes WHERE node_type = $1 ORDER BY name';
    params = [nodeType];
  } else {
    query = 'SELECT * FROM shared._nodes WHERE node_type = $1 ORDER BY database_id, name';
    params = [nodeType];
  }
  const result = await pool.query(query, params);
  return result.rows;
}

/**
 * Create or update a node (upsert)
 * @param {Pool} pool
 * @param {Object} node - { node_type, name, database_id, scope, origin, metadata }
 * @returns {Promise<Object>} - The created/updated node
 */
async function upsertNode(pool, node) {
  const {
    node_type,
    name,
    database_id = null,
    scope = node_type === 'intent' ? 'global' : 'local',
    origin = null,
    metadata = {}
  } = node;

  // First, try to find existing node
  const existing = await findNode(pool, node_type, name, database_id);

  if (existing) {
    // Update existing node
    const updateResult = await pool.query(`
      UPDATE shared._nodes
      SET origin = COALESCE($1, origin),
          metadata = metadata || $2,
          updated_at = NOW()
      WHERE id = $3
      RETURNING *
    `, [origin, JSON.stringify(metadata), existing.id]);
    return updateResult.rows[0];
  }

  // Insert new node
  const insertResult = await pool.query(`
    INSERT INTO shared._nodes (node_type, name, database_id, scope, origin, metadata)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING *
  `, [node_type, name, database_id, scope, origin, JSON.stringify(metadata)]);

  return insertResult.rows[0];
}

/**
 * Delete a node and its edges
 * @param {Pool} pool
 * @param {string} nodeId - UUID
 * @returns {Promise<boolean>}
 */
async function deleteNode(pool, nodeId) {
  const result = await pool.query('DELETE FROM shared._nodes WHERE id = $1', [nodeId]);
  return result.rowCount > 0;
}

/**
 * Get all edges for a node
 * @param {Pool} pool
 * @param {string} nodeId - UUID
 * @param {string} direction - 'outgoing', 'incoming', or 'both'
 * @returns {Promise<Array>}
 */
async function getEdges(pool, nodeId, direction = 'both') {
  let query;
  if (direction === 'outgoing') {
    query = `
      SELECT e.*, n.node_type as to_type, n.name as to_name, n.database_id as to_database
      FROM shared._edges e
      JOIN shared._nodes n ON e.to_id = n.id
      WHERE e.from_id = $1
    `;
  } else if (direction === 'incoming') {
    query = `
      SELECT e.*, n.node_type as from_type, n.name as from_name, n.database_id as from_database
      FROM shared._edges e
      JOIN shared._nodes n ON e.from_id = n.id
      WHERE e.to_id = $1
    `;
  } else {
    query = `
      SELECT e.*,
        fn.node_type as from_type, fn.name as from_name, fn.database_id as from_database,
        tn.node_type as to_type, tn.name as to_name, tn.database_id as to_database
      FROM shared._edges e
      JOIN shared._nodes fn ON e.from_id = fn.id
      JOIN shared._nodes tn ON e.to_id = tn.id
      WHERE e.from_id = $1 OR e.to_id = $1
    `;
  }
  const result = await pool.query(query, [nodeId]);
  return result.rows;
}

/**
 * Create or update an edge (upsert)
 * @param {Pool} pool
 * @param {Object} edge - { from_id, to_id, rel_type, status, proposed_by, metadata }
 * @returns {Promise<Object>}
 */
async function upsertEdge(pool, edge) {
  const {
    from_id,
    to_id,
    rel_type,
    status = null,
    proposed_by = null,
    metadata = {}
  } = edge;

  const result = await pool.query(`
    INSERT INTO shared._edges (from_id, to_id, rel_type, status, proposed_by, metadata)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (from_id, to_id, rel_type)
    DO UPDATE SET
      status = COALESCE(EXCLUDED.status, shared._edges.status),
      proposed_by = COALESCE(EXCLUDED.proposed_by, shared._edges.proposed_by),
      metadata = shared._edges.metadata || EXCLUDED.metadata
    RETURNING *
  `, [from_id, to_id, rel_type, status, proposed_by, JSON.stringify(metadata)]);

  return result.rows[0];
}

/**
 * Delete an edge
 * @param {Pool} pool
 * @param {string} fromId - UUID
 * @param {string} toId - UUID
 * @param {string} relType
 * @returns {Promise<boolean>}
 */
async function deleteEdge(pool, fromId, toId, relType) {
  const result = await pool.query(
    'DELETE FROM shared._edges WHERE from_id = $1 AND to_id = $2 AND rel_type = $3',
    [fromId, toId, relType]
  );
  return result.rowCount > 0;
}

/**
 * Traverse dependencies from a node
 * @param {Pool} pool
 * @param {string} nodeId - Starting node UUID
 * @param {string} direction - 'upstream' (what this depends on) or 'downstream' (what depends on this)
 * @param {number} maxDepth - Maximum traversal depth
 * @param {Array<string>} relTypes - Edge types to follow (null = all)
 * @returns {Promise<Array>} - Array of { node, edge, depth }
 */
async function traverseDependencies(pool, nodeId, direction = 'downstream', maxDepth = 3, relTypes = null) {
  const results = [];
  const visited = new Set();

  async function traverse(currentId, depth) {
    if (depth > maxDepth || visited.has(currentId)) return;
    visited.add(currentId);

    const edges = await getEdges(pool, currentId, direction === 'downstream' ? 'incoming' : 'outgoing');

    for (const edge of edges) {
      if (relTypes && !relTypes.includes(edge.rel_type)) continue;

      const neighborId = direction === 'downstream' ? edge.from_id : edge.to_id;
      if (visited.has(neighborId)) continue;

      const neighbor = await findNodeById(pool, neighborId);
      if (neighbor) {
        results.push({ node: neighbor, edge, depth });
        await traverse(neighborId, depth + 1);
      }
    }
  }

  await traverse(nodeId, 1);
  return results;
}

/**
 * Find structures that serve an intent
 * @param {Pool} pool
 * @param {string} intentId - Intent node UUID
 * @returns {Promise<Array>}
 */
async function getStructuresForIntent(pool, intentId) {
  const result = await pool.query(`
    SELECT n.*, e.status, e.proposed_by
    FROM shared._nodes n
    JOIN shared._edges e ON e.from_id = n.id
    WHERE e.to_id = $1 AND e.rel_type = 'serves'
    ORDER BY n.node_type, n.name
  `, [intentId]);
  return result.rows;
}

/**
 * Find intents that a structure serves
 * @param {Pool} pool
 * @param {string} structureId - Structure node UUID
 * @returns {Promise<Array>}
 */
async function getIntentsForStructure(pool, structureId) {
  const result = await pool.query(`
    SELECT n.*, e.status, e.proposed_by
    FROM shared._nodes n
    JOIN shared._edges e ON e.to_id = n.id
    WHERE e.from_id = $1 AND e.rel_type = 'serves'
    ORDER BY n.name
  `, [structureId]);
  return result.rows;
}

module.exports = {
  findNode,
  findNodeById,
  findNodesByType,
  upsertNode,
  deleteNode,
  getEdges,
  upsertEdge,
  deleteEdge,
  traverseDependencies,
  getStructuresForIntent,
  getIntentsForStructure
};
