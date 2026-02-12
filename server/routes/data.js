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
      const { source } = req.params;
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
            // Validate column name to prevent injection
            if (NAME_RE.test(col)) {
              conditions.push(`"${col}" = $${paramIdx}`);
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

      const result = await pool.query(query, params);

      // Get total count (with same filter)
      let countQuery = `SELECT COUNT(*) FROM "${source}"`;
      const countParams = [];
      if (req.query.filter) {
        try {
          const filter = JSON.parse(req.query.filter);
          const conditions = [];
          let ci = 1;
          for (const [col, val] of Object.entries(filter)) {
            if (NAME_RE.test(col)) {
              conditions.push(`"${col}" = $${ci}`);
              countParams.push(val);
              ci++;
            }
          }
          if (conditions.length > 0) {
            countQuery += ` WHERE ${conditions.join(' AND ')}`;
          }
        } catch (e) {}
      }
      const countResult = await pool.query(countQuery, countParams);
      const totalCount = parseInt(countResult.rows[0].count);

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

      // Validate columns against actual table schema
      const validColumns = await getTableColumns(pool, table, req.databaseId);
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
        INSERT INTO ${quoteIdent(table)} (${columns.map(c => quoteIdent(c)).join(', ')})
        VALUES (${placeholders.join(', ')})
        RETURNING *
      `;

      const result = await pool.query(query, values);
      res.status(201).json({ data: result.rows[0] });
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

      // Find primary key column (cached)
      const pkColumn = await getPrimaryKey(pool, table, req.databaseId);
      if (!pkColumn) {
        return res.status(400).json({ error: 'Table has no primary key' });
      }

      // Validate columns against actual table schema
      const validColumns = await getTableColumns(pool, table, req.databaseId);
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
        UPDATE ${quoteIdent(table)}
        SET ${setClause}
        WHERE ${quoteIdent(pkColumn)} = $${columns.length + 1}
        RETURNING *
      `;

      const result = await pool.query(query, [...values, id]);

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Record not found' });
      }

      res.json({ data: result.rows[0] });
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

      // Find primary key column (cached)
      const pkColumn = await getPrimaryKey(pool, table, req.databaseId);
      if (!pkColumn) {
        return res.status(400).json({ error: 'Table has no primary key' });
      }

      const result = await pool.query(
        `DELETE FROM "${table}" WHERE "${pkColumn}" = $1 RETURNING *`,
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
