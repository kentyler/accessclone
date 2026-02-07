/**
 * Event logging routes
 * Handles logging and retrieving events
 */

const express = require('express');
const router = express.Router();

module.exports = function(pool, logEvent) {
  /**
   * POST /api/events
   * Log an event from the UI
   */
  router.post('/', async (req, res) => {
    const { event_type, source, message, details } = req.body;
    const databaseId = req.databaseId;

    if (!event_type || !message) {
      return res.status(400).json({ error: 'event_type and message are required' });
    }

    try {
      await logEvent(pool, event_type, source || 'ui', message, {
        databaseId,
        details
      });
      res.json({ success: true });
    } catch (err) {
      console.error('Error logging event:', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/events
   * Retrieve recent events
   * Query params: limit, offset, type, source
   */
  router.get('/', async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 50, 500);
    const offset = parseInt(req.query.offset) || 0;
    const eventType = req.query.type;
    const source = req.query.source;

    try {
      let query = `
        SELECT event_id, event_type, source, database_id, user_id, session_id,
               message, details, created_at
        FROM shared.events
        WHERE 1=1
      `;
      const params = [];
      let paramIndex = 1;

      if (eventType) {
        query += ` AND event_type = $${paramIndex++}`;
        params.push(eventType);
      }
      if (source) {
        query += ` AND source = $${paramIndex++}`;
        params.push(source);
      }

      query += ` ORDER BY created_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
      params.push(limit, offset);

      const result = await pool.query(query, params);
      res.json({ events: result.rows });
    } catch (err) {
      console.error('Error fetching events:', err);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
