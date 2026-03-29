/**
 * Pipeline routes — per-module step execution and full pipeline runs.
 *
 * POST /api/pipeline/step  — Execute a single pipeline step for one module
 * POST /api/pipeline/run   — Execute the full pipeline for one module
 * GET  /api/pipeline/status — Get pipeline status for all modules
 */

const express = require('express');
const router = express.Router();
const { logError } = require('../lib/events');
const { runStep, runPipeline, getModuleStatus, STEP_ORDER, listStrategies } = require('../lib/pipeline');

module.exports = function(pool, secrets) {
  const apiKey = () => secrets.anthropic?.api_key || process.env.ANTHROPIC_API_KEY;

  /**
   * POST /api/pipeline/step
   * Execute a single pipeline step for one module.
   *
   * Body: { module_name, step, strategy?, database_id }
   * Returns: { step, strategy, result, duration, module_status }
   */
  router.post('/step', async (req, res) => {
    const { module_name, step, strategy, database_id } = req.body;

    if (!module_name || !step) {
      return res.status(400).json({ error: 'module_name and step are required' });
    }

    if (!STEP_ORDER.includes(step)) {
      return res.status(400).json({
        error: `Invalid step "${step}". Valid steps: ${STEP_ORDER.join(', ')}`
      });
    }

    const databaseId = database_id || req.headers['x-database-id'];

    try {
      // Load module data from DB
      const moduleResult = await pool.query(
        `SELECT o.name, o.definition, o.status,
                (SELECT i.content FROM shared.intents i WHERE i.object_id = o.id AND i.intent_type = 'gesture' ORDER BY i.created_at DESC LIMIT 1) as intents
         FROM shared.objects o
         WHERE o.type = 'module' AND o.name = $1 AND o.database_id = $2
         ORDER BY o.version DESC LIMIT 1`,
        [module_name, databaseId]
      );

      if (moduleResult.rows.length === 0) {
        return res.status(404).json({ error: `Module "${module_name}" not found` });
      }

      const row = moduleResult.rows[0];
      const def = row.definition || {};
      const intentsData = row.intents || {};

      // Build step input from module data
      let input;
      switch (step) {
        case 'extract':
          input = {
            vbaSource: def.vba_source,
            moduleName: module_name,
            appObjects: await getAppObjects(pool, databaseId)
          };
          break;
        case 'map':
          input = { intents: intentsData.intents || intentsData };
          break;
        case 'gap-questions': {
          const mapped = intentsData.mapped;
          const { collectGaps } = require('../lib/vba-intent-extractor');
          const gaps = collectGaps(mapped || {});
          input = { gaps, vbaSource: def.vba_source, moduleName: module_name };
          break;
        }
        case 'resolve-gaps':
          input = { mapped: intentsData.mapped };
          break;
      }

      const context = { apiKey: apiKey(), pool, databaseId };
      const result = await runStep(step, input, context, strategy);

      // Persist step results back to module
      await persistStepResult(pool, module_name, databaseId, step, result, intentsData);

      // Get updated module status
      const updatedMod = await pool.query(
        `SELECT o.definition,
                (SELECT i.content FROM shared.intents i WHERE i.object_id = o.id AND i.intent_type = 'gesture' ORDER BY i.created_at DESC LIMIT 1) as intents
         FROM shared.objects o
         WHERE o.type = 'module' AND o.name = $1 AND o.database_id = $2
         ORDER BY o.version DESC LIMIT 1`,
        [module_name, databaseId]
      );
      const updatedRow = updatedMod.rows[0] || {};
      const updatedDef = updatedRow.definition || {};
      const moduleStatus = getModuleStatus({
        intents: updatedRow.intents,
        cljs_source: updatedDef.cljs_source
      });

      res.json({ ...result, module_status: moduleStatus });
    } catch (err) {
      console.error(`Pipeline step "${step}" failed for "${module_name}":`, err);
      logError(pool, 'POST /api/pipeline/step', `Step ${step} failed`, err, { databaseId });
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/pipeline/run
   * Execute the full pipeline for one module.
   *
   * Body: { module_name, config?, database_id }
   * config: { extract: 'llm', 'gap-questions': 'skip', 'resolve-gaps': 'skip', generate: 'mechanical' }
   * Returns: { status, results: [{step, result, duration}], module_status }
   */
  router.post('/run', async (req, res) => {
    const { module_name, config, database_id } = req.body;

    if (!module_name) {
      return res.status(400).json({ error: 'module_name is required' });
    }

    const databaseId = database_id || req.headers['x-database-id'];

    try {
      // Load module data
      const moduleResult = await pool.query(
        `SELECT o.name, o.definition, o.status,
                (SELECT i.content FROM shared.intents i WHERE i.object_id = o.id AND i.intent_type = 'gesture' ORDER BY i.created_at DESC LIMIT 1) as intents
         FROM shared.objects o
         WHERE o.type = 'module' AND o.name = $1 AND o.database_id = $2
         ORDER BY o.version DESC LIMIT 1`,
        [module_name, databaseId]
      );

      if (moduleResult.rows.length === 0) {
        return res.status(404).json({ error: `Module "${module_name}" not found` });
      }

      const row = moduleResult.rows[0];
      const def = row.definition || {};
      const intentsData = row.intents || {};

      const moduleData = {
        vbaSource: def.vba_source,
        moduleName: module_name,
        appObjects: await getAppObjects(pool, databaseId),
        intents: intentsData.intents || null,
        mapped: intentsData.mapped || null
      };

      const context = { apiKey: apiKey(), pool, databaseId };
      const result = await runPipeline(moduleData, context, config || {});

      // Persist all step results
      for (const stepResult of result.results) {
        await persistStepResult(pool, module_name, databaseId, stepResult.step, stepResult, intentsData);
      }

      // Get final module status
      const updatedMod = await pool.query(
        `SELECT o.definition,
                (SELECT i.content FROM shared.intents i WHERE i.object_id = o.id AND i.intent_type = 'gesture' ORDER BY i.created_at DESC LIMIT 1) as intents
         FROM shared.objects o
         WHERE o.type = 'module' AND o.name = $1 AND o.database_id = $2
         ORDER BY o.version DESC LIMIT 1`,
        [module_name, databaseId]
      );
      const updatedRow = updatedMod.rows[0] || {};
      const updatedDef = updatedRow.definition || {};
      result.moduleStatus = getModuleStatus({
        intents: updatedRow.intents,
        cljs_source: updatedDef.cljs_source
      });

      res.json(result);
    } catch (err) {
      console.error(`Pipeline run failed for "${module_name}":`, err);
      logError(pool, 'POST /api/pipeline/run', 'Pipeline run failed', err, { databaseId });
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/pipeline/status
   * Get pipeline status for all modules in a database.
   *
   * Query: ?database_id=N
   * Returns: { modules: [{ name, status, step, has_vba, has_cljs }] }
   */
  router.get('/status', async (req, res) => {
    const databaseId = req.query.database_id || req.headers['x-database-id'];

    if (!databaseId) {
      return res.status(400).json({ error: 'database_id is required' });
    }

    try {
      const result = await pool.query(
        `SELECT DISTINCT ON (o.name) o.name, o.definition, o.status,
                (SELECT i.content FROM shared.intents i WHERE i.object_id = o.id AND i.intent_type = 'gesture' ORDER BY i.created_at DESC LIMIT 1) as intents
         FROM shared.objects o
         WHERE o.database_id = $1 AND o.type = 'module' AND o.is_current = true
         ORDER BY o.name, o.version DESC`,
        [databaseId]
      );

      const modules = result.rows.map(row => {
        const def = row.definition || {};
        const pipelineStatus = getModuleStatus({
          intents: row.intents,
          cljs_source: def.cljs_source
        });
        return {
          name: row.name,
          step: pipelineStatus.step,
          status: pipelineStatus.status,
          has_vba: !!def.vba_source,
          has_cljs: !!def.cljs_source,
          module_status: row.status
        };
      });

      res.json({ modules });
    } catch (err) {
      console.error('Pipeline status failed:', err);
      logError(pool, 'GET /api/pipeline/status', 'Status query failed', err, { databaseId });
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};

// ============================================================
// Helpers
// ============================================================

/**
 * Get app objects (tables, queries, forms, reports) for a database.
 */
async function getAppObjects(pool, databaseId) {
  try {
    const dbResult = await pool.query(
      'SELECT schema_name FROM shared.databases WHERE database_id = $1',
      [databaseId]
    );
    if (dbResult.rows.length === 0) return {};
    const schema = dbResult.rows[0].schema_name;

    const [tables, views, forms, reports] = await Promise.all([
      pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE'`, [schema]),
      pool.query(`SELECT table_name FROM information_schema.views WHERE table_schema = $1`, [schema]),
      pool.query(`SELECT DISTINCT name FROM shared.objects WHERE database_id = $1 AND type = 'form' AND is_current = true`, [databaseId]),
      pool.query(`SELECT DISTINCT name FROM shared.objects WHERE database_id = $1 AND type = 'report' AND is_current = true`, [databaseId])
    ]);

    return {
      tables: tables.rows.map(r => r.table_name),
      queries: views.rows.map(r => r.table_name),
      forms: forms.rows.map(r => r.name),
      reports: reports.rows.map(r => r.name)
    };
  } catch (err) {
    console.error('Error loading app objects:', err.message);
    return {};
  }
}

/**
 * Persist a step result back to shared.intents for the module.
 */
async function persistStepResult(pool, moduleName, databaseId, stepName, stepResult, intentsData) {
  const result = stepResult.result;
  if (!result) return;

  let updated = false;

  switch (stepName) {
    case 'extract': {
      intentsData.intents = result.intents;
      intentsData.validation = result.validation;
      updated = true;
      break;
    }
    case 'map': {
      intentsData.mapped = result.mapped;
      intentsData.stats = result.stats;
      updated = true;
      break;
    }
    case 'gap-questions': {
      intentsData.gap_questions = result.gapQuestions;
      updated = true;
      break;
    }
    case 'resolve-gaps': {
      intentsData.mapped = result.mapped;
      updated = true;
      break;
    }
  }

  if (updated) {
    // Look up the object ID, then upsert into shared.intents
    const objResult = await pool.query(
      `SELECT id FROM shared.objects
       WHERE type = 'module' AND name = $1 AND database_id = $2
       AND version = (SELECT MAX(version) FROM shared.objects WHERE type = 'module' AND name = $1 AND database_id = $2)`,
      [moduleName, databaseId]
    );
    if (objResult.rows.length > 0) {
      const objectId = objResult.rows[0].id;
      await pool.query('DELETE FROM shared.intents WHERE object_id = $1 AND intent_type = $2', [objectId, 'gesture']);
      await pool.query(
        `INSERT INTO shared.intents (object_id, intent_type, content, generated_by) VALUES ($1, 'gesture', $2, 'pipeline')`,
        [objectId, JSON.stringify(intentsData)]
      );
    }
  }
}
