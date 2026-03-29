/**
 * Evaluation routes — run and query evaluation history for forms and reports.
 */

const express = require('express');
const { logEvent } = require('../lib/events');
const { runAndRecordEvaluation } = require('../lib/pipeline-evaluator');

function createRouter(pool) {
  const router = express.Router();

  /**
   * POST /api/evaluations/run-all
   * Evaluate all current forms and reports in the database.
   * Returns per-object results and a summary.
   */
  router.post('/run-all', async (req, res) => {
    try {
      const databaseId = req.databaseId;

      const objectsResult = await pool.query(
        `SELECT id, type, name, definition, version
         FROM shared.objects
         WHERE database_id = $1 AND type IN ('form', 'report') AND is_current = true AND owner = 'standard'
         ORDER BY type, name`,
        [databaseId]
      );

      const results = [];
      for (const row of objectsResult.rows) {
        const def = typeof row.definition === 'string' ? JSON.parse(row.definition) : row.definition;
        try {
          const evaluation = await runAndRecordEvaluation(pool, {
            objectId: row.id,
            databaseId,
            objectType: row.type,
            objectName: row.name,
            version: row.version,
            definition: def,
            trigger: 'manual'
          });
          results.push({ type: row.type, name: row.name, version: row.version, ...evaluation });
        } catch (err) {
          results.push({ type: row.type, name: row.name, version: row.version, error: err.message });
        }
      }

      const passed = results.filter(r => r.overall_passed === true).length;
      const failed = results.filter(r => r.overall_passed === false).length;
      const errored = results.filter(r => r.error).length;

      res.json({
        results,
        summary: {
          total: results.length,
          passed,
          failed,
          errored
        }
      });
    } catch (err) {
      console.error('Error running evaluations:', err);
      logEvent(pool, 'error', 'POST /api/evaluations/run-all', 'Batch evaluation failed', { databaseId: req.databaseId, details: { error: err.message } });
      res.status(500).json({ error: 'Failed to run evaluations' });
    }
  });

  /**
   * POST /api/evaluations/:type/:name/run
   * Evaluate a single object on demand.
   */
  router.post('/:type/:name/run', async (req, res) => {
    try {
      const databaseId = req.databaseId;
      const { type, name } = req.params;

      if (type !== 'form' && type !== 'report') {
        return res.status(400).json({ error: 'type must be form or report' });
      }

      const objectResult = await pool.query(
        `SELECT id, definition, version
         FROM shared.objects
         WHERE database_id = $1 AND type = $2 AND name = $3 AND is_current = true AND owner = 'standard'
         LIMIT 1`,
        [databaseId, type, name]
      );

      if (objectResult.rows.length === 0) {
        return res.status(404).json({ error: `${type} "${name}" not found` });
      }

      const row = objectResult.rows[0];
      const def = typeof row.definition === 'string' ? JSON.parse(row.definition) : row.definition;

      const evaluation = await runAndRecordEvaluation(pool, {
        objectId: row.id,
        databaseId,
        objectType: type,
        objectName: name,
        version: row.version,
        definition: def,
        trigger: 'manual'
      });

      res.json(evaluation);
    } catch (err) {
      console.error('Error running evaluation:', err);
      logEvent(pool, 'error', `POST /api/evaluations/${req.params.type}/${req.params.name}/run`, 'Evaluation failed', { databaseId: req.databaseId, details: { error: err.message } });
      res.status(500).json({ error: 'Failed to run evaluation' });
    }
  });

  /**
   * GET /api/evaluations/:type/:name
   * Paginated evaluation history for an object.
   * Query params: limit (default 10, max 100), offset (default 0)
   */
  router.get('/:type/:name', async (req, res) => {
    try {
      const databaseId = req.databaseId;
      const { type, name } = req.params;
      const limit = Math.min(parseInt(req.query.limit) || 10, 100);
      const offset = parseInt(req.query.offset) || 0;

      const result = await pool.query(
        `SELECT id, object_id, object_type, object_name, version, trigger,
                overall_passed, failure_class, checks, check_count, passed_count, failed_count,
                duration_ms, created_at
         FROM shared.evaluations
         WHERE database_id = $1 AND object_type = $2 AND object_name = $3
         ORDER BY created_at DESC
         LIMIT $4 OFFSET $5`,
        [databaseId, type, name, limit, offset]
      );

      const countResult = await pool.query(
        `SELECT COUNT(*) FROM shared.evaluations
         WHERE database_id = $1 AND object_type = $2 AND object_name = $3`,
        [databaseId, type, name]
      );

      res.json({
        evaluations: result.rows,
        total: parseInt(countResult.rows[0].count),
        limit,
        offset
      });
    } catch (err) {
      console.error('Error fetching evaluations:', err);
      res.status(500).json({ error: 'Failed to fetch evaluations' });
    }
  });

  /**
   * GET /api/evaluations/:type/:name/latest
   * Most recent evaluation for an object.
   */
  router.get('/:type/:name/latest', async (req, res) => {
    try {
      const databaseId = req.databaseId;
      const { type, name } = req.params;

      const result = await pool.query(
        `SELECT id, object_id, object_type, object_name, version, trigger,
                overall_passed, failure_class, checks, check_count, passed_count, failed_count,
                duration_ms, created_at
         FROM shared.evaluations
         WHERE database_id = $1 AND object_type = $2 AND object_name = $3
         ORDER BY created_at DESC
         LIMIT 1`,
        [databaseId, type, name]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'No evaluations found' });
      }

      res.json(result.rows[0]);
    } catch (err) {
      console.error('Error fetching latest evaluation:', err);
      res.status(500).json({ error: 'Failed to fetch latest evaluation' });
    }
  });

  return router;
}

module.exports = createRouter;
