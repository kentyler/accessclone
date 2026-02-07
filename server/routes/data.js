/**
 * Data CRUD routes
 * Handles reading/writing records to tables
 */

const express = require('express');
const router = express.Router();
const { logError } = require('../lib/events');

// Cache: "databaseId:tableName" → pkColumnName
// Invalidated via clearPkCache() when table schema changes
const pkCache = new Map();

async function getPrimaryKey(pool, tableName, databaseId) {
  const cacheKey = `${databaseId}:${tableName}`;
  if (pkCache.has(cacheKey)) return pkCache.get(cacheKey);

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
  pkCache.set(cacheKey, pkColumn);
  return pkColumn;
}

function clearPkCache(databaseId) {
  if (databaseId) {
    for (const key of pkCache.keys()) {
      if (key.startsWith(`${databaseId}:`)) pkCache.delete(key);
    }
  } else {
    pkCache.clear();
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
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(source)) {
        return res.status(400).json({ error: 'Invalid source name' });
      }

      let query = `SELECT * FROM "${source}"`;
      const params = [];
      let paramIdx = 1;

      // Build WHERE clause from filter (JSON object of column=value pairs)
      if (req.query.filter) {
        try {
          const filter = JSON.parse(req.query.filter);
          const conditions = [];
          for (const [col, val] of Object.entries(filter)) {
            // Validate column name to prevent injection
            if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(col)) {
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

      if (orderBy && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(orderBy)) {
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
            if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(col)) {
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

      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(source)) {
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

      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) {
        return res.status(400).json({ error: 'Invalid table name' });
      }

      const columns = Object.keys(data);
      const values = Object.values(data);
      const placeholders = columns.map((_, i) => `$${i + 1}`);

      const query = `
        INSERT INTO "${table}" (${columns.map(c => `"${c}"`).join(', ')})
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
    console.log('PUT /api/data/:table/:id called', { table: req.params.table, id: req.params.id, body: req.body });
    try {
      const { table, id } = req.params;
      const data = req.body;

      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) {
        return res.status(400).json({ error: 'Invalid table name' });
      }

      // Find primary key column (cached)
      const pkColumn = await getPrimaryKey(pool, table, req.databaseId);
      if (!pkColumn) {
        return res.status(400).json({ error: 'Table has no primary key' });
      }

      const columns = Object.keys(data);
      const values = Object.values(data);

      const setClause = columns.map((col, i) => `"${col}" = $${i + 1}`).join(', ');
      const query = `
        UPDATE "${table}"
        SET ${setClause}
        WHERE "${pkColumn}" = $${columns.length + 1}
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

      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) {
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

module.exports.clearPkCache = clearPkCache;
