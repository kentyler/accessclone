/**
 * Form State routes
 * Manages live form control values in shared.form_control_state
 * so that PostgreSQL views can reference them via subqueries.
 */

const express = require('express');
const router = express.Router();
const { logError } = require('../lib/events');

module.exports = function(pool) {
  /**
   * PUT /api/form-state
   * Upsert control values keyed by table_name/column_name.
   *
   * Body: {
   *   sessionId: "...",
   *   entries: [
   *     { tableName: "products", columnName: "categoryid", value: "5" }
   *   ]
   * }
   */
  router.put('/', async (req, res) => {
    try {
      const { sessionId, entries } = req.body;

      if (!sessionId || !entries || !Array.isArray(entries)) {
        return res.status(400).json({ error: 'sessionId and entries array required' });
      }

      if (entries.length === 0) {
        return res.json({ updated: 0 });
      }

      // Build multi-row UPSERT
      const values = [];
      const rows = [];
      let idx = 1;
      for (const entry of entries) {
        rows.push(`($${idx}, $${idx + 1}, $${idx + 2}, $${idx + 3})`);
        values.push(
          sessionId,
          (entry.tableName || '').toLowerCase(),
          (entry.columnName || '').toLowerCase(),
          entry.value == null ? null : String(entry.value)
        );
        idx += 4;
      }

      await pool.query(
        `INSERT INTO shared.form_control_state (session_id, table_name, column_name, value)
         VALUES ${rows.join(', ')}
         ON CONFLICT (session_id, table_name, column_name)
         DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        values
      );

      res.json({ updated: entries.length });
    } catch (err) {
      console.error('Error upserting form state:', err);
      logError(pool, 'PUT /api/form-state', 'Failed to upsert form control state', err, {});
      res.status(500).json({ error: 'Failed to update form state' });
    }
  });

  /**
   * DELETE /api/form-state
   * Clear all state for a session (on logout/cleanup).
   *
   * Body: { sessionId: "..." }
   */
  router.delete('/', async (req, res) => {
    try {
      const { sessionId } = req.body;
      if (!sessionId) {
        return res.status(400).json({ error: 'sessionId required' });
      }

      const result = await pool.query(
        'DELETE FROM shared.form_control_state WHERE session_id = $1',
        [sessionId]
      );

      res.json({ deleted: result.rowCount });
    } catch (err) {
      console.error('Error clearing form state:', err);
      logError(pool, 'DELETE /api/form-state', 'Failed to clear form control state', err, {});
      res.status(500).json({ error: 'Failed to clear form state' });
    }
  });

  return router;
};
