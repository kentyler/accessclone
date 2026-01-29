/**
 * Data CRUD routes
 * Handles reading/writing records to tables
 */

const express = require('express');
const router = express.Router();

module.exports = function(pool) {
  /**
   * GET /api/data/:source
   * Fetch records from a table or view
   * Query params: limit, offset, orderBy, orderDir
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
      if (orderBy && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(orderBy)) {
        query += ` ORDER BY "${orderBy}" ${orderDir}`;
      }
      query += ` LIMIT $1 OFFSET $2`;

      const result = await pool.query(query, [limit, offset]);

      // Get total count
      const countResult = await pool.query(`SELECT COUNT(*) FROM "${source}"`);
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
      res.status(500).json({ error: 'Failed to fetch data', details: err.message });
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

      // Find primary key column
      const pkResult = await pool.query(`
        SELECT kcu.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
        WHERE tc.table_name = $1
          AND tc.constraint_type = 'PRIMARY KEY'
        LIMIT 1
      `, [source]);

      if (pkResult.rows.length === 0) {
        return res.status(400).json({ error: 'Table has no primary key' });
      }

      const pkColumn = pkResult.rows[0].column_name;
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
      res.status(500).json({ error: 'Failed to fetch record', details: err.message });
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
      res.status(500).json({ error: 'Failed to insert record', details: err.message });
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

      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) {
        return res.status(400).json({ error: 'Invalid table name' });
      }

      // Find primary key column
      const pkResult = await pool.query(`
        SELECT kcu.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
        WHERE tc.table_name = $1
          AND tc.constraint_type = 'PRIMARY KEY'
        LIMIT 1
      `, [table]);

      if (pkResult.rows.length === 0) {
        return res.status(400).json({ error: 'Table has no primary key' });
      }

      const pkColumn = pkResult.rows[0].column_name;
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
      res.status(500).json({ error: 'Failed to update record', details: err.message });
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

      // Find primary key column
      const pkResult = await pool.query(`
        SELECT kcu.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
        WHERE tc.table_name = $1
          AND tc.constraint_type = 'PRIMARY KEY'
        LIMIT 1
      `, [table]);

      if (pkResult.rows.length === 0) {
        return res.status(400).json({ error: 'Table has no primary key' });
      }

      const pkColumn = pkResult.rows[0].column_name;
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
      res.status(500).json({ error: 'Failed to delete record', details: err.message });
    }
  });

  return router;
};
