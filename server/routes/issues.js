/**
 * Issues routes
 * CRUD for structured findings from LLM auto-analysis
 */

const express = require('express');
const { logError } = require('../lib/events');

module.exports = function(pool) {
  const router = express.Router();

  /**
   * GET /api/issues/summary
   * Aggregate counts for a database (must be before /:id)
   */
  router.get('/summary', async (req, res) => {
    try {
      const { database_id } = req.query;
      if (!database_id) {
        return res.status(400).json({ error: 'database_id is required' });
      }

      const [totalRes, openRes, byTypeRes, bySevRes, byCatRes] = await Promise.all([
        pool.query(
          'SELECT COUNT(*) AS total FROM shared.issues WHERE database_id = $1',
          [database_id]
        ),
        pool.query(
          `SELECT COUNT(*) AS open FROM shared.issues WHERE database_id = $1 AND resolution = 'open'`,
          [database_id]
        ),
        pool.query(
          `SELECT object_type, COUNT(*) AS count FROM shared.issues WHERE database_id = $1 AND resolution = 'open' GROUP BY object_type`,
          [database_id]
        ),
        pool.query(
          `SELECT severity, COUNT(*) AS count FROM shared.issues WHERE database_id = $1 AND resolution = 'open' GROUP BY severity`,
          [database_id]
        ),
        pool.query(
          `SELECT category, COUNT(*) AS count FROM shared.issues WHERE database_id = $1 AND resolution = 'open' GROUP BY category`,
          [database_id]
        )
      ]);

      const byType = {};
      byTypeRes.rows.forEach(r => { byType[r.object_type] = parseInt(r.count); });
      const bySeverity = {};
      bySevRes.rows.forEach(r => { bySeverity[r.severity] = parseInt(r.count); });
      const byCategory = {};
      byCatRes.rows.forEach(r => { byCategory[r.category] = parseInt(r.count); });

      res.json({
        total: parseInt(totalRes.rows[0].total),
        open: parseInt(openRes.rows[0].open),
        by_type: byType,
        by_severity: bySeverity,
        by_category: byCategory
      });
    } catch (err) {
      console.error('Error getting issues summary:', err);
      logError(pool, 'GET /api/issues/summary', 'Failed to get issues summary', err);
      res.status(500).json({ error: 'Failed to get issues summary' });
    }
  });

  /**
   * GET /api/issues
   * List issues, filtered by database_id (required) and optional filters
   */
  router.get('/', async (req, res) => {
    try {
      const { database_id, object_type, object_name, resolution, category, severity } = req.query;
      if (!database_id) {
        return res.status(400).json({ error: 'database_id is required' });
      }

      const conditions = ['database_id = $1'];
      const params = [database_id];
      let idx = 2;

      if (object_type) {
        conditions.push(`object_type = $${idx++}`);
        params.push(object_type);
      }
      if (object_name) {
        conditions.push(`object_name = $${idx++}`);
        params.push(object_name);
      }
      if (resolution) {
        conditions.push(`resolution = $${idx++}`);
        params.push(resolution);
      }
      if (category) {
        conditions.push(`category = $${idx++}`);
        params.push(category);
      }
      if (severity) {
        conditions.push(`severity = $${idx++}`);
        params.push(severity);
      }

      const result = await pool.query(`
        SELECT id, database_id, object_type, object_name,
               category, severity, message, suggestion,
               resolution, resolution_notes, created_at, resolved_at
        FROM shared.issues
        WHERE ${conditions.join(' AND ')}
        ORDER BY created_at DESC
      `, params);

      res.json({ issues: result.rows });
    } catch (err) {
      console.error('Error listing issues:', err);
      logError(pool, 'GET /api/issues', 'Failed to list issues', err);
      res.status(500).json({ error: 'Failed to list issues' });
    }
  });

  /**
   * PATCH /api/issues/:id
   * Update resolution status
   */
  router.patch('/:id', async (req, res) => {
    try {
      const { resolution, resolution_notes } = req.body;
      if (!resolution) {
        return res.status(400).json({ error: 'resolution is required' });
      }

      const validResolutions = ['open', 'fixed', 'dismissed', 'deferred'];
      if (!validResolutions.includes(resolution)) {
        return res.status(400).json({ error: `resolution must be one of: ${validResolutions.join(', ')}` });
      }

      const result = await pool.query(`
        UPDATE shared.issues
        SET resolution = $1,
            resolution_notes = $2,
            resolved_at = CASE WHEN $1 != 'open' THEN NOW() ELSE NULL END
        WHERE id = $3
        RETURNING *
      `, [resolution, resolution_notes || null, parseInt(req.params.id)]);

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Issue not found' });
      }

      res.json({ issue: result.rows[0] });
    } catch (err) {
      console.error('Error updating issue:', err);
      logError(pool, 'PATCH /api/issues/:id', 'Failed to update issue', err);
      res.status(500).json({ error: 'Failed to update issue' });
    }
  });

  /**
   * DELETE /api/issues/:id
   * Remove a single issue
   */
  router.delete('/:id', async (req, res) => {
    try {
      const result = await pool.query(
        'DELETE FROM shared.issues WHERE id = $1 RETURNING id',
        [parseInt(req.params.id)]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Issue not found' });
      }

      res.json({ deleted: true, id: result.rows[0].id });
    } catch (err) {
      console.error('Error deleting issue:', err);
      logError(pool, 'DELETE /api/issues/:id', 'Failed to delete issue', err);
      res.status(500).json({ error: 'Failed to delete issue' });
    }
  });

  return router;
};
