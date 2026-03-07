/**
 * Module routes with append-only versioning
 * Handles reading/writing VBA modules from shared.modules table
 * Each save creates a new version; old versions are preserved
 */

const express = require('express');
const router = express.Router();
const { logEvent, logError } = require('../lib/events');

function createRouter(pool) {
  /**
   * GET /api/modules
   * List all current modules for current database
   */
  router.get('/', async (req, res) => {
    try {
      const databaseId = req.databaseId;

      const result = await pool.query(
        `SELECT name, description, status, review_notes, version, created_at,
                (vba_source IS NOT NULL) as has_vba_source,
                (cljs_source IS NOT NULL) as has_cljs_source
         FROM shared.modules
         WHERE database_id = $1 AND is_current = true
         ORDER BY name`,
        [databaseId]
      );

      const modules = result.rows.map(r => r.name);
      res.json({ modules, details: result.rows });
    } catch (err) {
      console.error('Error listing modules:', err);
      logError(pool, 'GET /api/modules', 'Failed to list modules', err, { databaseId: req.databaseId });
      res.status(500).json({ error: 'Failed to list modules' });
    }
  });

  /**
   * GET /api/modules/:name
   * Read the current version of a module
   */
  /**
   * GET /api/modules/:name/reactions
   * Extract simple reaction specs from a form module's after-update procedures.
   * Returns [{trigger, ctrl, prop, value}] for procedures that are:
   *   - named FieldX_AfterUpdate
   *   - contain only set-control-visible / set-control-enabled / set-control-value intents
   *   - no branches, no async effects (dlookup, run-sql, etc.)
   */
  router.get('/:name/reactions', async (req, res) => {
    try {
      const databaseId = req.databaseId;
      const result = await pool.query(
        `SELECT intents FROM shared.modules
         WHERE database_id = $1 AND name = $2 AND is_current = true`,
        [databaseId, req.params.name]
      );

      if (result.rows.length === 0 || !result.rows[0].intents) {
        return res.json([]);
      }

      const intents = result.rows[0].intents;
      const procedures = (intents?.mapped?.procedures) || [];
      const reactions = [];

      const toKw = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');

      const propFor = (type) =>
        type === 'set-control-visible' ? 'visible' :
        type === 'set-control-enabled' ? 'enabled' : 'caption';

      const SIMPLE_TYPES = new Set(['set-control-visible', 'set-control-enabled', 'set-control-value']);
      const ASYNC_TYPES  = new Set(['dlookup', 'dcount', 'dsum', 'run-sql', 'loop', 'gap']);

      for (const proc of procedures) {
        if (proc.trigger !== 'after-update') continue;
        const match = (proc.name || '').match(/^(.+)_AfterUpdate$/i);
        if (!match) continue;
        const trigger = toKw(match[1]);

        const allIntents = proc.intents || [];
        // Skip if any intent is async, branching, or unknown
        const isSimple = allIntents.every(i =>
          SIMPLE_TYPES.has(i.type) && i.classification !== 'gap'
        );
        const hasAsync = allIntents.some(i => ASYNC_TYPES.has(i.type));
        if (!isSimple || hasAsync) continue;

        for (const intent of allIntents) {
          if (!SIMPLE_TYPES.has(intent.type)) continue;
          reactions.push({
            trigger,
            ctrl: toKw(intent.control),
            prop: propFor(intent.type),
            value: intent.value ?? null
          });
        }
      }

      res.json(reactions);
    } catch (err) {
      logError(pool, 'GET /api/modules/:name/reactions', 'Failed to extract reactions', err, { databaseId: req.databaseId });
      res.status(500).json({ error: 'Failed to extract reactions' });
    }
  });

  router.get('/:name', async (req, res) => {
    try {
      const databaseId = req.databaseId;

      const result = await pool.query(
        `SELECT name, vba_source, cljs_source, description, status, review_notes, intents, version, created_at
         FROM shared.modules
         WHERE database_id = $1 AND name = $2 AND is_current = true`,
        [databaseId, req.params.name]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Module not found' });
      }

      res.json(result.rows[0]);
    } catch (err) {
      console.error('Error reading module:', err);
      logError(pool, 'GET /api/modules/:name', 'Failed to read module', err, { databaseId: req.databaseId });
      res.status(500).json({ error: 'Failed to read module' });
    }
  });

  /**
   * PUT /api/modules/:name
   * Save a module (creates new version, marks old as not current)
   */
  router.put('/:name', async (req, res) => {
    const client = await pool.connect();
    try {
      const databaseId = req.databaseId;
      const moduleName = req.params.name;
      const { vba_source, cljs_source, description, status, review_notes, intents } = req.body;

      await client.query('BEGIN');

      // Load current version to preserve fields not being updated
      const currentResult = await client.query(
        `SELECT vba_source, cljs_source, description, status, review_notes, intents
         FROM shared.modules
         WHERE database_id = $1 AND name = $2 AND is_current = true`,
        [databaseId, moduleName]
      );
      const prev = currentResult.rows[0] || {};

      // Get max version across ALL rows (including non-current)
      const versionResult = await client.query(
        `SELECT COALESCE(MAX(version), 0) as max_version
         FROM shared.modules
         WHERE database_id = $1 AND name = $2`,
        [databaseId, moduleName]
      );
      const newVersion = versionResult.rows[0].max_version + 1;

      // Merge: use provided value when present, otherwise preserve current
      const finalVba = vba_source !== undefined ? vba_source : (prev.vba_source || null);
      const finalCljs = cljs_source !== undefined ? cljs_source : (prev.cljs_source || null);
      const finalDesc = description !== undefined ? description : (prev.description || null);
      const finalStatus = status || prev.status || 'pending';
      const finalNotes = review_notes !== undefined ? review_notes : (prev.review_notes || null);
      const finalIntents = intents !== undefined ? intents : prev.intents;

      // Mark all existing versions as not current
      await client.query(
        `UPDATE shared.modules
         SET is_current = false
         WHERE database_id = $1 AND name = $2 AND is_current = true`,
        [databaseId, moduleName]
      );

      // Insert new version as current
      await client.query(
        `INSERT INTO shared.modules (database_id, name, vba_source, cljs_source, description, status, review_notes, intents, version, is_current)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true)`,
        [databaseId, moduleName, finalVba, finalCljs, finalDesc,
         finalStatus, finalNotes, finalIntents ? JSON.stringify(finalIntents) : null, newVersion]
      );

      await client.query('COMMIT');

      console.log(`Saved module: ${moduleName} v${newVersion} (database: ${databaseId})`);
      res.json({ success: true, name: moduleName, version: newVersion, database_id: databaseId });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('Error saving module:', err);
      logError(pool, 'PUT /api/modules/:name', 'Failed to save module', err, { databaseId: req.databaseId });
      res.status(500).json({ error: 'Failed to save module' });
    } finally {
      client.release();
    }
  });

  return router;
}

module.exports = createRouter;
