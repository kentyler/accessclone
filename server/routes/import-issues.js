/**
 * Import Issues routes
 * CRUD for persistent import issue tracking
 */

const express = require('express');
const router = express.Router();
const { logError } = require('../lib/events');

module.exports = function(pool) {

  /**
   * GET /api/import-issues/summary
   * Issue counts for a database (must be before /:id)
   */
  router.get('/summary', async (req, res) => {
    try {
      const { database_id } = req.query;
      if (!database_id) {
        return res.status(400).json({ error: 'database_id is required' });
      }

      const [totalRes, unresolvedRes, byTypeRes, bySevRes] = await Promise.all([
        pool.query(
          'SELECT COUNT(*) AS total FROM shared.import_issues WHERE database_id = $1',
          [database_id]
        ),
        pool.query(
          'SELECT COUNT(*) AS unresolved FROM shared.import_issues WHERE database_id = $1 AND NOT resolved',
          [database_id]
        ),
        pool.query(
          'SELECT object_type, COUNT(*) AS count FROM shared.import_issues WHERE database_id = $1 AND NOT resolved GROUP BY object_type',
          [database_id]
        ),
        pool.query(
          'SELECT severity, COUNT(*) AS count FROM shared.import_issues WHERE database_id = $1 AND NOT resolved GROUP BY severity',
          [database_id]
        )
      ]);

      const byType = {};
      byTypeRes.rows.forEach(r => { byType[r.object_type] = parseInt(r.count); });
      const bySeverity = {};
      bySevRes.rows.forEach(r => { bySeverity[r.severity] = parseInt(r.count); });

      res.json({
        total: parseInt(totalRes.rows[0].total),
        unresolved: parseInt(unresolvedRes.rows[0].unresolved),
        by_type: byType,
        by_severity: bySeverity
      });
    } catch (err) {
      console.error('Error getting import issues summary:', err);
      logError(pool, 'GET /api/import-issues/summary', 'Failed to get issues summary', err);
      res.status(500).json({ error: 'Failed to get issues summary' });
    }
  });

  /**
   * GET /api/import-issues
   * List issues, filtered by database_id (required) and optional filters
   */
  router.get('/', async (req, res) => {
    try {
      const { database_id, object_type, resolved, import_log_id } = req.query;
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
      if (resolved !== undefined) {
        conditions.push(`resolved = $${idx++}`);
        params.push(resolved === 'true');
      }
      if (import_log_id) {
        conditions.push(`import_log_id = $${idx++}`);
        params.push(parseInt(import_log_id));
      }

      const result = await pool.query(`
        SELECT id, import_log_id, database_id, object_name, object_type,
               severity, category, location, message, suggestion,
               resolved, resolved_at, created_at
        FROM shared.import_issues
        WHERE ${conditions.join(' AND ')}
        ORDER BY created_at DESC
      `, params);

      res.json({ issues: result.rows });
    } catch (err) {
      console.error('Error listing import issues:', err);
      logError(pool, 'GET /api/import-issues', 'Failed to list import issues', err);
      res.status(500).json({ error: 'Failed to list import issues' });
    }
  });

  /**
   * PATCH /api/import-issues/:id
   * Toggle resolved status
   */
  router.patch('/:id', async (req, res) => {
    try {
      const { resolved } = req.body;
      if (resolved === undefined) {
        return res.status(400).json({ error: 'resolved field is required' });
      }

      const result = await pool.query(`
        UPDATE shared.import_issues
        SET resolved = $1, resolved_at = CASE WHEN $1 THEN NOW() ELSE NULL END
        WHERE id = $2
        RETURNING *
      `, [resolved, parseInt(req.params.id)]);

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Issue not found' });
      }

      res.json({ issue: result.rows[0] });
    } catch (err) {
      console.error('Error updating import issue:', err);
      logError(pool, 'PATCH /api/import-issues/:id', 'Failed to update import issue', err);
      res.status(500).json({ error: 'Failed to update import issue' });
    }
  });

  return router;
};
