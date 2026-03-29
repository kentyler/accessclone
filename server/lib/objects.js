/**
 * Object CRUD helpers for shared.objects and shared.intents tables.
 * Centralizes common query patterns so route files stay thin.
 */

/**
 * Get the current version of an object.
 * For forms/reports with personalization, returns user's version if it exists, else standard.
 * @param {Pool} pool
 * @param {string} databaseId
 * @param {string} type - 'form', 'report', 'module', 'macro'
 * @param {string} name
 * @param {object} [opts]
 * @param {string} [opts.owner] - user ID for personalized versions (forms/reports)
 * @param {string[]} [opts.columns] - specific columns to select (default: all)
 * @returns {object|null} row or null
 */
async function getObject(pool, databaseId, type, name, opts = {}) {
  const { owner, columns } = opts;
  const cols = columns ? columns.join(', ') : '*';

  if (owner && (type === 'form' || type === 'report')) {
    // Prefer user's personalized version, fall back to standard
    const result = await pool.query(
      `SELECT ${cols} FROM shared.objects
       WHERE database_id = $1 AND type = $2 AND name = $3 AND is_current = true
         AND owner IN ($4, 'standard')
       ORDER BY CASE WHEN owner = 'standard' THEN 1 ELSE 0 END
       LIMIT 1`,
      [databaseId, type, name, owner]
    );
    return result.rows[0] || null;
  }

  const result = await pool.query(
    `SELECT ${cols} FROM shared.objects
     WHERE database_id = $1 AND type = $2 AND name = $3 AND is_current = true
     LIMIT 1`,
    [databaseId, type, name]
  );
  return result.rows[0] || null;
}

/**
 * Save a new version of an object (append-only versioning).
 * Marks previous current version as not current, inserts new version.
 * Must be called inside a transaction (client).
 * @param {Client} client - pg transaction client
 * @param {string} databaseId
 * @param {string} type
 * @param {string} name
 * @param {object} definition - JSONB definition
 * @param {object} [opts]
 * @param {string} [opts.recordSource]
 * @param {string} [opts.description]
 * @param {string} [opts.status]
 * @param {string} [opts.owner]
 * @param {string} [opts.modifiedBy]
 * @returns {{ id: number, version: number }}
 */
async function saveObject(client, databaseId, type, name, definition, opts = {}) {
  const { recordSource, description, status, owner = 'standard', modifiedBy } = opts;

  // Get next version
  const maxRes = await client.query(
    `SELECT COALESCE(MAX(version), 0) as max_version FROM shared.objects
     WHERE database_id = $1 AND type = $2 AND name = $3`,
    [databaseId, type, name]
  );
  const nextVersion = maxRes.rows[0].max_version + 1;

  // Mark current as not current
  await client.query(
    `UPDATE shared.objects SET is_current = false
     WHERE database_id = $1 AND type = $2 AND name = $3 AND owner = $4 AND is_current = true`,
    [databaseId, type, name, owner]
  );

  // Insert new version
  const insertRes = await client.query(
    `INSERT INTO shared.objects (database_id, type, name, definition, record_source, description, status, owner, modified_by, version, is_current)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true)
     RETURNING id, version`,
    [databaseId, type, name, definition, recordSource || null, description || null,
     status || 'complete', owner, modifiedBy || null, nextVersion]
  );

  return insertRes.rows[0];
}

/**
 * List current objects for a database, optionally filtered by type.
 * @param {Pool} pool
 * @param {string} databaseId
 * @param {string} [type] - optional type filter
 * @param {object} [opts]
 * @param {string} [opts.owner] - filter by owner (default: no filter, or 'standard' for forms/reports)
 * @param {string[]} [opts.columns] - specific columns to select
 * @returns {object[]} rows
 */
async function listObjects(pool, databaseId, type, opts = {}) {
  const { owner, columns } = opts;
  const cols = columns ? columns.join(', ') : 'name, type, record_source, description, status, version, created_at';

  const conditions = ['database_id = $1', 'is_current = true'];
  const params = [databaseId];

  if (type) {
    params.push(type);
    conditions.push(`type = $${params.length}`);
  }
  if (owner) {
    params.push(owner);
    conditions.push(`owner = $${params.length}`);
  }

  const result = await pool.query(
    `SELECT ${cols} FROM shared.objects WHERE ${conditions.join(' AND ')} ORDER BY name`,
    params
  );
  return result.rows;
}

/**
 * Get intents for an object.
 * @param {Pool} pool
 * @param {number} objectId
 * @param {string} [intentType] - optional type filter ('gesture', 'business', etc.)
 * @returns {object[]} rows
 */
async function getIntents(pool, objectId, intentType) {
  if (intentType) {
    const result = await pool.query(
      'SELECT * FROM shared.intents WHERE object_id = $1 AND intent_type = $2 ORDER BY created_at DESC',
      [objectId, intentType]
    );
    return result.rows;
  }
  const result = await pool.query(
    'SELECT * FROM shared.intents WHERE object_id = $1 ORDER BY created_at DESC',
    [objectId]
  );
  return result.rows;
}

/**
 * Save intents for an object. Replaces existing intents of the same type.
 * @param {Pool|Client} client
 * @param {number} objectId
 * @param {string} intentType
 * @param {object} content - JSONB content
 * @param {object} [opts]
 * @param {string} [opts.generatedBy] - 'llm', 'import', 'user'
 * @param {number} [opts.graphVersion]
 * @returns {object} inserted row
 */
async function saveIntents(client, objectId, intentType, content, opts = {}) {
  const { generatedBy, graphVersion } = opts;

  // Remove existing intents of this type for this object
  await client.query(
    'DELETE FROM shared.intents WHERE object_id = $1 AND intent_type = $2',
    [objectId, intentType]
  );

  const result = await client.query(
    `INSERT INTO shared.intents (object_id, intent_type, content, generated_by, graph_version)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [objectId, intentType, JSON.stringify(content), generatedBy || null, graphVersion || null]
  );
  return result.rows[0];
}

/**
 * Get intents by looking up the object by database_id/type/name.
 * Convenience for routes that don't have the object ID handy.
 * @param {Pool} pool
 * @param {string} databaseId
 * @param {string} type
 * @param {string} name
 * @param {string} [intentType]
 * @returns {object[]} intent rows
 */
async function getIntentsByObject(pool, databaseId, type, name, intentType) {
  const obj = await getObject(pool, databaseId, type, name, { columns: ['id'] });
  if (!obj) return [];
  return getIntents(pool, obj.id, intentType);
}

module.exports = {
  getObject,
  saveObject,
  listObjects,
  getIntents,
  saveIntents,
  getIntentsByObject
};
