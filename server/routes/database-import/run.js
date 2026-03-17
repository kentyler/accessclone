/**
 * Import run lifecycle routes.
 * POST /start-run — Create a new import run
 * POST /complete-run — Finalize an import run with summary
 * GET /run/:runId — Get full log for a run
 * GET /run/:runId/summary — Per-pass summary stats
 */

const { logError } = require('../../lib/events');
const { createImportRun, completeImportRun } = require('./helpers');

module.exports = function(router, pool) {

  router.post('/start-run', async (req, res) => {
    try {
      const { database_id, source_paths } = req.body;
      if (!database_id) {
        return res.status(400).json({ error: 'database_id is required' });
      }
      const runId = await createImportRun(pool, database_id, source_paths);
      res.json({ run_id: runId });
    } catch (err) {
      console.error('Error starting import run:', err);
      logError(pool, 'POST /api/database-import/start-run', 'Failed to start import run', err);
      res.status(500).json({ error: 'Failed to start import run' });
    }
  });

  router.post('/complete-run', async (req, res) => {
    try {
      const { run_id, summary } = req.body;
      if (!run_id) {
        return res.status(400).json({ error: 'run_id is required' });
      }
      await completeImportRun(pool, run_id, summary || {});
      res.json({ success: true });
    } catch (err) {
      console.error('Error completing import run:', err);
      logError(pool, 'POST /api/database-import/complete-run', 'Failed to complete import run', err);
      res.status(500).json({ error: 'Failed to complete import run' });
    }
  });

  router.get('/run/:runId', async (req, res) => {
    try {
      const runId = parseInt(req.params.runId);

      const [runRes, logRes] = await Promise.all([
        pool.query('SELECT * FROM shared.import_runs WHERE id = $1', [runId]),
        pool.query(`
          SELECT id, created_at, source_path, source_object_name, source_object_type,
                 target_database_id, status, error_message, details,
                 run_id, pass_number, phase, action, severity, category, message, suggestion,
                 resolved, resolved_at
          FROM shared.import_log
          WHERE run_id = $1
          ORDER BY pass_number, created_at
        `, [runId])
      ]);

      if (runRes.rows.length === 0) {
        return res.status(404).json({ error: 'Run not found' });
      }

      res.json({
        run: runRes.rows[0],
        entries: logRes.rows
      });
    } catch (err) {
      console.error('Error fetching import run:', err);
      logError(pool, 'GET /api/database-import/run/:runId', 'Failed to fetch import run', err);
      res.status(500).json({ error: 'Failed to fetch import run' });
    }
  });

  router.get('/run/:runId/summary', async (req, res) => {
    try {
      const runId = parseInt(req.params.runId);

      const result = await pool.query(`
        SELECT pass_number,
               COUNT(*) AS total,
               COUNT(*) FILTER (WHERE status = 'success') AS succeeded,
               COUNT(*) FILTER (WHERE status = 'error') AS failed,
               COUNT(*) FILTER (WHERE severity = 'warning') AS warnings,
               COUNT(*) FILTER (WHERE severity = 'error') AS errors
        FROM shared.import_log
        WHERE run_id = $1
        GROUP BY pass_number
        ORDER BY pass_number
      `, [runId]);

      res.json({ passes: result.rows });
    } catch (err) {
      console.error('Error fetching run summary:', err);
      logError(pool, 'GET /api/database-import/run/:runId/summary', 'Failed to fetch run summary', err);
      res.status(500).json({ error: 'Failed to fetch run summary' });
    }
  });

};
