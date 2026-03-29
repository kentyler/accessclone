/**
 * Macro routes with append-only versioning
 * Handles reading/writing Access macros from shared.objects table (type='macro')
 * Macro-specific data (macro_xml, cljs_source, review_notes) stored in definition JSONB
 * Each save creates a new version; old versions are preserved
 */

const express = require('express');
const router = express.Router();
const { logEvent, logError } = require('../lib/events');

function createRouter(pool) {
  /**
   * GET /api/macros
   * List all current macros for current database
   */
  router.get('/', async (req, res) => {
    try {
      const databaseId = req.databaseId;

      const result = await pool.query(
        `SELECT name, description, status, definition->>'review_notes' as review_notes, version, created_at,
                (definition->>'macro_xml' IS NOT NULL) as has_macro_xml,
                (definition->>'cljs_source' IS NOT NULL) as has_cljs_source
         FROM shared.objects
         WHERE database_id = $1 AND type = 'macro' AND is_current = true
         ORDER BY name`,
        [databaseId]
      );

      const macros = result.rows.map(r => r.name);
      res.json({ macros, details: result.rows });
    } catch (err) {
      console.error('Error listing macros:', err);
      logError(pool, 'GET /api/macros', 'Failed to list macros', err, { databaseId: req.databaseId });
      res.status(500).json({ error: 'Failed to list macros' });
    }
  });

  /**
   * GET /api/macros/:name
   * Read the current version of a macro
   * Returns a flat object with macro_xml, etc. extracted from definition JSONB
   */
  router.get('/:name', async (req, res) => {
    try {
      const databaseId = req.databaseId;

      const result = await pool.query(
        `SELECT name, definition, description, status, version, created_at
         FROM shared.objects
         WHERE database_id = $1 AND type = 'macro' AND name = $2 AND is_current = true`,
        [databaseId, req.params.name]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Macro not found' });
      }

      // Flatten definition fields into the response to maintain API compatibility
      const row = result.rows[0];
      const def = row.definition || {};
      res.json({
        name: row.name,
        macro_xml: def.macro_xml || null,
        cljs_source: def.cljs_source || null,
        description: row.description,
        status: row.status,
        review_notes: def.review_notes || null,
        version: row.version,
        created_at: row.created_at
      });
    } catch (err) {
      console.error('Error reading macro:', err);
      logError(pool, 'GET /api/macros/:name', 'Failed to read macro', err, { databaseId: req.databaseId });
      res.status(500).json({ error: 'Failed to read macro' });
    }
  });

  /**
   * PUT /api/macros/:name
   * Save a macro (creates new version, marks old as not current)
   */
  router.put('/:name', async (req, res) => {
    const client = await pool.connect();
    try {
      const databaseId = req.databaseId;
      const macroName = req.params.name;
      const { macro_xml, cljs_source, description, status, review_notes } = req.body;

      await client.query('BEGIN');

      // Get current max version for this macro
      const versionResult = await client.query(
        `SELECT COALESCE(MAX(version), 0) as max_version
         FROM shared.objects
         WHERE database_id = $1 AND type = 'macro' AND name = $2`,
        [databaseId, macroName]
      );
      const newVersion = versionResult.rows[0].max_version + 1;

      // Mark all existing versions as not current
      await client.query(
        `UPDATE shared.objects
         SET is_current = false
         WHERE database_id = $1 AND type = 'macro' AND name = $2 AND is_current = true`,
        [databaseId, macroName]
      );

      // Build definition JSONB
      const definition = {
        macro_xml: macro_xml || null,
        cljs_source: cljs_source || null,
        review_notes: review_notes || null
      };

      // Insert new version as current
      await client.query(
        `INSERT INTO shared.objects (database_id, type, name, definition, description, status, version, is_current)
         VALUES ($1, 'macro', $2, $3, $4, $5, $6, true)`,
        [databaseId, macroName, JSON.stringify(definition), description || null,
         status || 'pending', newVersion]
      );

      await client.query('COMMIT');

      console.log(`Saved macro: ${macroName} v${newVersion} (database: ${databaseId})`);
      res.json({ success: true, name: macroName, version: newVersion, database_id: databaseId });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('Error saving macro:', err);
      logError(pool, 'PUT /api/macros/:name', 'Failed to save macro', err, { databaseId: req.databaseId });
      res.status(500).json({ error: 'Failed to save macro' });
    } finally {
      client.release();
    }
  });

  return router;
}

module.exports = createRouter;
