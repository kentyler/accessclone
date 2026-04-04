/**
 * Data CRUD routes
 * Handles reading/writing records to tables
 */

const express = require('express');
const router = express.Router();
const { logError } = require('../lib/events');

// Valid SQL identifier pattern (table/column names)
const NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

// Cache: "databaseId:tableName" → { value, expiry }
// Invalidated via clearSchemaCache() when table schema changes, or auto-expires after TTL
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const pkCache = new Map();
const colCache = new Map();

function cacheGet(cache, key) {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiry) { cache.delete(key); return undefined; }
  return entry.value;
}

function cacheSet(cache, key, value) {
  cache.set(key, { value, expiry: Date.now() + CACHE_TTL_MS });
}

async function getPrimaryKey(pool, tableName, databaseId) {
  const cacheKey = `${databaseId}:${tableName}`;
  const cached = cacheGet(pkCache, cacheKey);
  if (cached !== undefined) return cached;

  const result = await pool.query(`
    SELECT kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
    WHERE tc.table_name = $1
      AND tc.constraint_type = 'PRIMARY KEY'
    LIMIT 1
  `, [tableName]);

  const pkColumn = result.rows.length > 0 ? result.rows[0].column_name : null;
  cacheSet(pkCache, cacheKey, pkColumn);
  return pkColumn;
}

async function getTableColumns(pool, tableName, databaseId) {
  const cacheKey = `${databaseId}:${tableName}`;
  const cached = cacheGet(colCache, cacheKey);
  if (cached !== undefined) return cached;

  const result = await pool.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = $1
  `, [tableName]);

  const columns = new Set(result.rows.map(r => r.column_name));
  cacheSet(colCache, cacheKey, columns);
  return columns;
}

function quoteIdent(name) {
  return '"' + name.replace(/"/g, '""') + '"';
}

// Cache: "schemaName:viewName" → base table name (or null if not a view)
const viewCache = new Map();

/**
 * For views, resolve the underlying base table that should receive writes.
 * Access allows updating through queries that join lookup tables;
 * PostgreSQL does not. This finds the "main" table — the one contributing
 * the most columns to the view — and redirects writes there.
 *
 * Returns { writeTable, isView } where writeTable is the name to use for
 * INSERT/UPDATE/DELETE. For base tables, writeTable === sourceName.
 */
/**
 * For views, resolve the underlying base table that should receive writes.
 * Access allows updating through queries that join lookup tables;
 * PostgreSQL does not. This finds the "main" table and redirects writes there.
 *
 * Uses shared.view_metadata (populated at import time) for fast lookup,
 * falling back to information_schema introspection for views imported
 * before view_metadata existed.
 *
 * Returns { writeTable, isView } where writeTable is the name to use for
 * INSERT/UPDATE/DELETE. For base tables, writeTable === sourceName.
 */
async function resolveWriteTarget(pool, sourceName, schemaName, databaseId) {
  const cacheKey = `${schemaName}:${sourceName}`;
  const cached = cacheGet(viewCache, cacheKey);
  if (cached !== undefined) return cached;

  // Fast path: check view_metadata table (populated at import time)
  if (databaseId) {
    try {
      const vmResult = await pool.query(
        `SELECT base_table FROM shared.view_metadata WHERE database_id = $1 AND view_name = $2`,
        [databaseId, sourceName]
      );
      if (vmResult.rows.length > 0) {
        const result = { writeTable: vmResult.rows[0].base_table, isView: true };
        cacheSet(viewCache, cacheKey, result);
        return result;
      }
    } catch (e) {
      // Table might not exist yet on older schemas — fall through
    }
  }

  // Is it a view?
  const typeResult = await pool.query(`
    SELECT table_type FROM information_schema.tables
    WHERE table_schema = $1 AND table_name = $2
  `, [schemaName, sourceName]);

  if (!typeResult.rows.length || typeResult.rows[0].table_type !== 'VIEW') {
    const result = { writeTable: sourceName, isView: false };
    cacheSet(viewCache, cacheKey, result);
    return result;
  }

  // Fallback: introspect view_column_usage for the base table with most columns
  const colUsage = await pool.query(`
    SELECT table_name, COUNT(*) AS col_count
    FROM information_schema.view_column_usage
    WHERE view_schema = $1 AND view_name = $2
      AND table_schema = $1 AND table_name != $2
    GROUP BY table_name
    ORDER BY col_count DESC
    LIMIT 1
  `, [schemaName, sourceName]);

  const writeTable = colUsage.rows.length > 0
    ? colUsage.rows[0].table_name
    : sourceName; // fallback: let PG error if no base table found

  const result = { writeTable, isView: true };
  cacheSet(viewCache, cacheKey, result);
  return result;
}

function clearSchemaCache(databaseId) {
  if (databaseId) {
    for (const key of pkCache.keys()) {
      if (key.startsWith(`${databaseId}:`)) pkCache.delete(key);
    }
    for (const key of colCache.keys()) {
      if (key.startsWith(`${databaseId}:`)) colCache.delete(key);
    }
  } else {
    pkCache.clear();
    colCache.clear();
    viewCache.clear();
  }
}

module.exports = function(pool) {
  /**
   * GET /api/data/:source
   * Fetch records from a table or view
   * Query params: limit, offset, orderBy, orderDir, filter (JSON object of column=value pairs)
   */
  router.get('/:source', async (req, res) => {
    try {
      const source = req.params.source.toLowerCase();
      const limit = parseInt(req.query.limit) || 100;
      const offset = parseInt(req.query.offset) || 0;
      const orderBy = req.query.orderBy || null;
      const orderDir = req.query.orderDir === 'desc' ? 'DESC' : 'ASC';

      // Validate source name (prevent SQL injection)
      if (!NAME_RE.test(source)) {
        return res.status(400).json({ error: 'Invalid source name' });
      }

      // Parse computed columns (server-side domain function results)
      let computedCols = [];
      if (req.query.computed) {
        try {
          const parsed = JSON.parse(req.query.computed);
          if (Array.isArray(parsed)) {
            for (const spec of parsed) {
              // Validate all names to prevent SQL injection
              if (spec.fn && NAME_RE.test(spec.fn) &&
                  spec.alias && NAME_RE.test(spec.alias) &&
                  Array.isArray(spec.params) && spec.params.every(p => NAME_RE.test(p))) {
                computedCols.push(spec);
              }
            }
          }
        } catch (e) {
          // Invalid computed JSON, ignore
        }
      }

      // Build SELECT clause — add computed function calls if any
      let selectClause;
      if (computedCols.length > 0) {
        const fnCalls = computedCols.map(spec => {
          const args = spec.params.map(p => `t.${quoteIdent(p)}`).join(', ');
          return `${quoteIdent(spec.fn)}(${args}) AS ${quoteIdent(spec.alias)}`;
        });
        selectClause = `SELECT t.*${fnCalls.length ? ', ' + fnCalls.join(', ') : ''} FROM "${source}" t`;
      } else {
        selectClause = `SELECT * FROM "${source}"`;
      }

      let query = selectClause;
      const params = [];
      let paramIdx = 1;

      // Build WHERE clause from filter (JSON object of column=value pairs)
      if (req.query.filter) {
        try {
          const filter = JSON.parse(req.query.filter);
          const conditions = [];
          for (const [col, val] of Object.entries(filter)) {
            const lcCol = col.toLowerCase();
            // Validate column name to prevent injection
            if (NAME_RE.test(lcCol)) {
              conditions.push(`"${lcCol}" = $${paramIdx}`);
              params.push(val);
              paramIdx++;
            }
          }
          if (conditions.length > 0) {
            query += ` WHERE ${conditions.join(' AND ')}`;
          }
        } catch (e) {
          // Invalid filter JSON, ignore
        }
      }

      if (orderBy && NAME_RE.test(orderBy)) {
        query += ` ORDER BY "${orderBy}" ${orderDir}`;
      }
      query += ` LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`;
      params.push(limit, offset);

      // Use a transaction with SET LOCAL so views referencing
      // shared.form_control_state can read the session_id
      const sessionId = req.headers['x-session-id'];
      const client = await pool.connect();
      let result, totalCount;
      try {
        // Set search_path on this dedicated client (middleware set it on a different pool connection)
        if (req.schemaName) {
          const quoted = '"' + req.schemaName.replace(/"/g, '""') + '"';
          await client.query(`SET search_path = ${quoted}, shared, public`);
        }
        await client.query('BEGIN');
        if (sessionId) {
          await client.query('SELECT set_config($1, $2, true)', ['app.session_id', sessionId]);
        }

        result = await client.query(query, params);

        // Get total count (with same filter)
        let countQuery = `SELECT COUNT(*) FROM "${source}"`;
        const countParams = [];
        if (req.query.filter) {
          try {
            const filter = JSON.parse(req.query.filter);
            const conditions = [];
            let ci = 1;
            for (const [col, val] of Object.entries(filter)) {
              const lcCol = col.toLowerCase();
              if (NAME_RE.test(lcCol)) {
                conditions.push(`"${lcCol}" = $${ci}`);
                countParams.push(val);
                ci++;
              }
            }
            if (conditions.length > 0) {
              countQuery += ` WHERE ${conditions.join(' AND ')}`;
            }
          } catch (e) {}
        }
        const countResult = await client.query(countQuery, countParams);
        totalCount = parseInt(countResult.rows[0].count);

        await client.query('COMMIT');
      } catch (txErr) {
        await client.query('ROLLBACK');
        throw txErr;
      } finally {
        client.release();
      }

      res.json({
        data: result.rows,
        pagination: {
          limit,
          offset,
          totalCount,
          hasMore: offset + result.rows.length < totalCount
        }
      });
    } catch (err) {
      // Relation doesn't exist yet (e.g. query not imported) — return empty data
      if (err.code === '42P01') {
        return res.json({ data: [], pagination: { limit: 50, offset: 0, totalCount: 0, hasMore: false } });
      }
      console.error('Error fetching data:', err);
      logError(pool, 'GET /api/data/:source', 'Failed to fetch data', err, { databaseId: req.databaseId });
      res.status(500).json({ error: 'Failed to fetch data' });
    }
  });

  /**
   * GET /api/data/:source/:id
   * Fetch a single record by primary key
   */
  router.get('/:source/:id', async (req, res) => {
    try {
      const { source, id } = req.params;

      if (!NAME_RE.test(source)) {
        return res.status(400).json({ error: 'Invalid source name' });
      }

      // Find primary key column (cached)
      const pkColumn = await getPrimaryKey(pool, source, req.databaseId);
      if (!pkColumn) {
        return res.status(400).json({ error: 'Table has no primary key' });
      }

      const result = await pool.query(
        `SELECT * FROM "${source}" WHERE "${pkColumn}" = $1`,
        [id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Record not found' });
      }

      res.json({ data: result.rows[0] });
    } catch (err) {
      console.error('Error fetching record:', err);
      logError(pool, 'GET /api/data/:source/:id', 'Failed to fetch record', err, { databaseId: req.databaseId });
      res.status(500).json({ error: 'Failed to fetch record' });
    }
  });

  /**
   * POST /api/data/:table
   * Insert a new record
   */
  router.post('/:table', async (req, res) => {
    try {
      const { table } = req.params;
      const data = req.body;

      if (!NAME_RE.test(table)) {
        return res.status(400).json({ error: 'Invalid table name' });
      }

      // If record source is a view, resolve to the underlying base table
      const { writeTable } = await resolveWriteTarget(pool, table, req.schemaName || 'public', req.databaseId);

      // Validate columns against the write target (base table, not the view)
      const validColumns = await getTableColumns(pool, writeTable, req.databaseId);
      const allKeys = Object.keys(data);
      const invalid = allKeys.filter(k => !validColumns.has(k));
      if (invalid.length > 0) {
        console.warn(`POST /api/data/${table}: stripping invalid columns:`, invalid);
      }
      const columns = allKeys.filter(k => validColumns.has(k));
      if (columns.length === 0) {
        return res.status(400).json({ error: 'No valid columns provided' });
      }
      const values = columns.map(c => data[c]);
      const placeholders = columns.map((_, i) => `$${i + 1}`);

      const query = `
        INSERT INTO ${quoteIdent(writeTable)} (${columns.map(c => quoteIdent(c)).join(', ')})
        VALUES (${placeholders.join(', ')})
        RETURNING *
      `;

      const result = await pool.query(query, values);
      let row = result.rows[0];

      // If we wrote to a base table but the form reads from a view,
      // re-read from the view so lookup columns are included
      if (writeTable !== table && row) {
        const insertedPk = await getPrimaryKey(pool, writeTable, req.databaseId);
        if (insertedPk && row[insertedPk] != null) {
          const viewRow = await pool.query(
            `SELECT * FROM ${quoteIdent(table)} WHERE ${quoteIdent(insertedPk)} = $1`,
            [row[insertedPk]]
          );
          if (viewRow.rows.length > 0) row = viewRow.rows[0];
        }
      }

      res.status(201).json({ data: row });
    } catch (err) {
      console.error('Error inserting record:', err);
      logError(pool, 'POST /api/data/:table', 'Failed to insert record', err, { databaseId: req.databaseId });
      res.status(500).json({ error: 'Failed to insert record' });
    }
  });

  /**
   * PUT /api/data/:table/:id
   * Update an existing record
   */
  router.put('/:table/:id', async (req, res) => {
    try {
      const { table, id } = req.params;
      const data = req.body;

      if (!NAME_RE.test(table)) {
        return res.status(400).json({ error: 'Invalid table name' });
      }

      // If record source is a view, resolve to the underlying base table
      const { writeTable } = await resolveWriteTarget(pool, table, req.schemaName || 'public', req.databaseId);

      // Find primary key column on the base table
      const pkColumn = await getPrimaryKey(pool, writeTable, req.databaseId);
      if (!pkColumn) {
        return res.status(400).json({ error: 'Table has no primary key' });
      }

      // Validate columns against the write target (base table, not the view)
      const validColumns = await getTableColumns(pool, writeTable, req.databaseId);
      const allKeys = Object.keys(data);
      const invalid = allKeys.filter(k => !validColumns.has(k));
      if (invalid.length > 0) {
        console.warn(`PUT /api/data/${table}/${id}: stripping invalid columns:`, invalid);
      }
      const columns = allKeys.filter(k => validColumns.has(k));
      if (columns.length === 0) {
        return res.status(400).json({ error: 'No valid columns provided' });
      }
      const values = columns.map(c => data[c]);

      const setClause = columns.map((col, i) => `${quoteIdent(col)} = $${i + 1}`).join(', ');
      const query = `
        UPDATE ${quoteIdent(writeTable)}
        SET ${setClause}
        WHERE ${quoteIdent(pkColumn)} = $${columns.length + 1}
        RETURNING *
      `;

      const result = await pool.query(query, [...values, id]);

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Record not found' });
      }

      let row = result.rows[0];

      // If we wrote to a base table but the form reads from a view,
      // re-read from the view so lookup columns are included
      if (writeTable !== table && row) {
        const viewRow = await pool.query(
          `SELECT * FROM ${quoteIdent(table)} WHERE ${quoteIdent(pkColumn)} = $1`,
          [id]
        );
        if (viewRow.rows.length > 0) row = viewRow.rows[0];
      }

      res.json({ data: row });
    } catch (err) {
      console.error('Error updating record:', err);
      logError(pool, 'PUT /api/data/:table/:id', 'Failed to update record', err, { databaseId: req.databaseId });
      res.status(500).json({ error: 'Failed to update record' });
    }
  });

  /**
   * DELETE /api/data/:table/:id
   * Delete a record
   */
  router.delete('/:table/:id', async (req, res) => {
    try {
      const { table, id } = req.params;

      if (!NAME_RE.test(table)) {
        return res.status(400).json({ error: 'Invalid table name' });
      }

      // If record source is a view, resolve to the underlying base table
      const { writeTable } = await resolveWriteTarget(pool, table, req.schemaName || 'public', req.databaseId);

      // Find primary key column on the base table
      const pkColumn = await getPrimaryKey(pool, writeTable, req.databaseId);
      if (!pkColumn) {
        return res.status(400).json({ error: 'Table has no primary key' });
      }

      const result = await pool.query(
        `DELETE FROM "${writeTable}" WHERE "${pkColumn}" = $1 RETURNING *`,
        [id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Record not found' });
      }

      res.json({ success: true, deleted: result.rows[0] });
    } catch (err) {
      console.error('Error deleting record:', err);
      logError(pool, 'DELETE /api/data/:table/:id', 'Failed to delete record', err, { databaseId: req.databaseId });
      res.status(500).json({ error: 'Failed to delete record' });
    }
  });

  return router;
};

module.exports.clearPkCache = clearSchemaCache;
module.exports.clearSchemaCache = clearSchemaCache;
