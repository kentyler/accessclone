/**
 * Chat transcript routes
 * Persistent chat history per object (table, query, form, report, module)
 */

const express = require('express');
const router = express.Router();
const { logError } = require('../lib/events');

module.exports = function(pool) {
  /**
   * GET /api/transcripts/:type/:name
   * Get chat transcript for an object
   */
  router.get('/:type/:name', async (req, res) => {
    try {
      const { type, name } = req.params;
      const databaseId = req.databaseId;

      const result = await pool.query(
        `SELECT transcript FROM shared.chat_transcripts
         WHERE database_id = $1 AND object_type = $2 AND object_name = $3`,
        [databaseId, type, name]
      );

      if (result.rows.length > 0) {
        res.json({ transcript: result.rows[0].transcript });
      } else {
        res.json({ transcript: [] });
      }
    } catch (err) {
      logError(pool, 'GET /api/transcripts/:type/:name', 'Failed to load transcript', err, { databaseId: req.databaseId });
      res.json({ transcript: [] });
    }
  });

  /**
   * PUT /api/transcripts/:type/:name
   * Upsert chat transcript for an object
   */
  router.put('/:type/:name', async (req, res) => {
    try {
      const { type, name } = req.params;
      const databaseId = req.databaseId;
      const { transcript } = req.body;

      await pool.query(
        `INSERT INTO shared.chat_transcripts (database_id, object_type, object_name, transcript, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (database_id, object_type, object_name)
         DO UPDATE SET transcript = $4, updated_at = NOW()`,
        [databaseId, type, name, JSON.stringify(transcript)]
      );

      res.json({ success: true });
    } catch (err) {
      logError(pool, 'PUT /api/transcripts/:type/:name', 'Failed to save transcript', err, { databaseId: req.databaseId });
      res.status(500).json({ error: 'Failed to save transcript' });
    }
  });

  return router;
};
