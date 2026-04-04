/**
 * Wire Events — batch-populate shared.control_event_map for all forms/reports in a database.
 * POST /api/database-import/wire-events
 */

const { logError, logEvent } = require('../../lib/events');
const { populateControlEventMap } = require('../../lib/event-mapping');

module.exports = function (router, pool) {
  router.post('/wire-events', async (req, res) => {
    const databaseId = req.databaseId || req.headers['x-database-id'];
    if (!databaseId) {
      return res.status(400).json({ error: 'Missing X-Database-ID header' });
    }

    const errors = [];
    let formsWired = 0;
    let reportsWired = 0;

    try {
      // Load all current forms
      const formsResult = await pool.query(
        `SELECT name, definition as content FROM shared.objects
         WHERE database_id = $1 AND type = 'form' AND is_current = true`,
        [databaseId]
      );

      for (const row of formsResult.rows) {
        try {
          await populateControlEventMap(pool, databaseId, row.name, row.content, 'form');
          formsWired++;
        } catch (err) {
          errors.push({ type: 'form', name: row.name, error: err.message });
        }
      }

      // Load all current reports
      const reportsResult = await pool.query(
        `SELECT name, definition as content FROM shared.objects
         WHERE database_id = $1 AND type = 'report' AND is_current = true`,
        [databaseId]
      );

      for (const row of reportsResult.rows) {
        try {
          await populateControlEventMap(pool, databaseId, row.name, row.content, 'report');
          reportsWired++;
        } catch (err) {
          errors.push({ type: 'report', name: row.name, error: err.message });
        }
      }

      const secondaryObjects = [];
      if (formsWired > 0) secondaryObjects.push({ type: 'form', count: formsWired, change: 'events-wired' });
      if (reportsWired > 0) secondaryObjects.push({ type: 'report', count: reportsWired, change: 'events-wired' });
      logEvent(pool, 'info', 'POST /api/database-import/wire-events',
        `Wired events: ${formsWired} forms, ${reportsWired} reports, ${errors.length} errors`,
        { databaseId, propagation: { secondary_objects: secondaryObjects } });

      res.json({ formsWired, reportsWired, errors });
    } catch (err) {
      logError(pool, 'POST /api/database-import/wire-events', 'Failed to wire events', err, { databaseId });
      res.status(500).json({ error: 'Failed to wire events' });
    }
  });
};
