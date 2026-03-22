/**
 * Module routes with append-only versioning
 * Handles reading/writing VBA modules from shared.modules table
 * Each save creates a new version; old versions are preserved
 */

const express = require('express');
const router = express.Router();
const { logEvent, logError } = require('../lib/events');
const { extractReactions, toKw } = require('../lib/reactions-extractor');
const { parseVbaToHandlers } = require('../lib/vba-to-js');

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
      res.json(extractReactions(procedures));
    } catch (err) {
      logError(pool, 'GET /api/modules/:name/reactions', 'Failed to extract reactions', err, { databaseId: req.databaseId });
      res.status(500).json({ error: 'Failed to extract reactions' });
    }
  });

  /**
   * GET /api/modules/:name/handlers
   * Extract event handler descriptors from a form module's intents.
   * Returns [{key, control, event, procedure, intents}] for procedures
   * that have a trigger and are NOT already fully covered by reactions.
   */
  router.get('/:name/handlers', async (req, res) => {
    try {
      const databaseId = req.databaseId;
      const moduleName = req.params.name;

      // Determine object name/type from module name (Form_MyForm → form/MyForm)
      let objectName = null;
      let objectType = null;
      if (moduleName.startsWith('Form_')) {
        objectName = moduleName.slice(5);
        objectType = 'form';
      } else if (moduleName.startsWith('Report_')) {
        objectName = moduleName.slice(7);
        objectType = 'report';
      }

      // Try control_event_map first (authoritative when populated)
      if (objectName && objectType) {
        const cemResult = await pool.query(
          `SELECT control_name, event, handler_type, handler_ref, module_name
           FROM shared.control_event_map
           WHERE database_id = $1 AND object_name = $2`,
          [databaseId, objectName]
        );

        if (cemResult.rows.length > 0) {
          // Load module intents for resolving event-procedure handlers
          const modResult = await pool.query(
            `SELECT intents FROM shared.modules
             WHERE database_id = $1 AND name = $2 AND is_current = true`,
            [databaseId, moduleName]
          );
          const intents = modResult.rows[0]?.intents;
          const procedures = (intents?.mapped?.procedures) || [];
          const procMap = {};
          for (const proc of procedures) {
            if (proc.name) procMap[proc.name] = proc;
          }

          // Get the set of triggers already handled by reactions so we can exclude them
          const reactionTriggers = new Set(
            extractReactions(procedures).map(r => r.trigger)
          );

          const handlers = [];
          for (const row of cemResult.rows) {
            const controlName = row.control_name;
            const eventKey = row.event;

            // Normalize control name for key generation
            const controlKw = controlName === '_form' ? 'form'
              : controlName === '_report' ? 'report'
              : toKw(controlName);

            // Skip AfterUpdate procedures already fully covered by reactions
            if (eventKey === 'after-update' && controlKw !== 'form' && controlKw !== 'report') {
              if (reactionTriggers.has(controlKw)) continue;
            }

            const key = `${controlKw}.${eventKey}`;

            if (row.handler_type === 'event-procedure') {
              // Look up the procedure's intents from the module
              const proc = procMap[row.handler_ref];
              handlers.push({
                key,
                control: controlKw,
                event: eventKey,
                procedure: row.handler_ref,
                intents: proc?.intents || [],
              });
            } else if (row.handler_type === 'expression') {
              handlers.push({
                key,
                control: controlKw,
                event: eventKey,
                procedure: `=${row.handler_ref}()`,
                intents: [{ type: 'call-function', function: row.handler_ref }],
              });
            } else if (row.handler_type === 'macro') {
              handlers.push({
                key,
                control: controlKw,
                event: eventKey,
                procedure: row.handler_ref,
                intents: [{ type: 'run-macro', macro: row.handler_ref }],
              });
            }
          }

          return res.json(handlers);
        }
      }

      // Fallback: try stored js_handlers, then module intents
      const result = await pool.query(
        `SELECT intents, js_handlers FROM shared.modules
         WHERE database_id = $1 AND name = $2 AND is_current = true`,
        [databaseId, moduleName]
      );

      if (result.rows.length === 0) {
        return res.json([]);
      }

      const { intents, js_handlers } = result.rows[0];

      // JS handlers (generated at import time from VBA source)
      if (js_handlers && js_handlers.length > 0) {
        return res.json(js_handlers);
      }

      if (!intents) {
        return res.json([]);
      }

      const procedures = (intents?.mapped?.procedures) || [];

      // Get the set of triggers already handled by reactions so we can exclude them
      const reactionTriggers = new Set(
        extractReactions(procedures).map(r => r.trigger)
      );

      const handlers = [];
      for (const proc of procedures) {
        if (!proc.trigger || !proc.name) continue;

        // Parse control name and event from procedure name
        // e.g. "btnOrders_Click" → control="btnOrders", event="on-click"
        // e.g. "Form_Load" → control="Form", event="on-load"
        // e.g. "cboStatus_AfterUpdate" → control="cboStatus", event="after-update"
        const match = proc.name.match(/^(.+?)_(\w+)$/);
        if (!match) continue;

        const rawControl = match[1];
        const rawEvent = match[2];

        // Map VBA event names to kebab-case event keys
        const eventMap = {
          'click': 'on-click',
          'dblclick': 'on-dblclick',
          'load': 'on-load',
          'open': 'on-open',
          'close': 'on-close',
          'current': 'on-current',
          'afterupdate': 'after-update',
          'beforeupdate': 'before-update',
          'change': 'on-change',
          'enter': 'on-enter',
          'exit': 'on-exit',
          'gotfocus': 'on-gotfocus',
          'lostfocus': 'on-lostfocus',
          'nodata': 'on-no-data',
        };

        const eventKey = eventMap[rawEvent.toLowerCase()];
        if (!eventKey) continue;

        // Skip AfterUpdate procedures already fully covered by reactions
        if (eventKey === 'after-update') {
          const triggerKw = toKw(rawControl);
          if (reactionTriggers.has(triggerKw)) continue;
        }

        const key = `${toKw(rawControl)}.${eventKey}`;
        handlers.push({
          key,
          control: toKw(rawControl),
          event: eventKey,
          procedure: proc.name,
          intents: proc.intents || []
        });
      }

      res.json(handlers);
    } catch (err) {
      logError(pool, 'GET /api/modules/:name/handlers', 'Failed to extract handlers', err, { databaseId: req.databaseId });
      res.status(500).json({ error: 'Failed to extract handlers' });
    }
  });

  router.get('/:name', async (req, res) => {
    try {
      const databaseId = req.databaseId;

      const result = await pool.query(
        `SELECT name, vba_source, cljs_source, description, status, review_notes, intents, js_handlers, version, created_at
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
      const { vba_source, description, status, review_notes, intents, js_handlers } = req.body;

      await client.query('BEGIN');

      // Load current version to preserve fields not being updated
      const currentResult = await client.query(
        `SELECT vba_source, cljs_source, description, status, review_notes, intents, js_handlers
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
      const finalCljs = prev.cljs_source || null; // Historical only — no longer written from frontend
      const finalDesc = description !== undefined ? description : (prev.description || null);
      const finalStatus = status || prev.status || 'pending';
      const finalNotes = review_notes !== undefined ? review_notes : (prev.review_notes || null);
      const finalIntents = intents !== undefined ? intents : prev.intents;

      // Auto-generate JS handlers from VBA source when VBA changes
      let finalJsHandlers = js_handlers !== undefined ? js_handlers : (prev.js_handlers || null);
      if (vba_source !== undefined && vba_source) {
        try {
          const parsed = parseVbaToHandlers(vba_source);
          finalJsHandlers = parsed.length > 0 ? parsed : null;
        } catch (e) {
          console.warn('Failed to parse VBA to JS handlers:', e.message);
        }
      }

      // Mark all existing versions as not current
      await client.query(
        `UPDATE shared.modules
         SET is_current = false
         WHERE database_id = $1 AND name = $2 AND is_current = true`,
        [databaseId, moduleName]
      );

      // Insert new version as current
      await client.query(
        `INSERT INTO shared.modules (database_id, name, vba_source, cljs_source, description, status, review_notes, intents, js_handlers, version, is_current)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true)`,
        [databaseId, moduleName, finalVba, finalCljs, finalDesc,
         finalStatus, finalNotes, finalIntents ? JSON.stringify(finalIntents) : null,
         finalJsHandlers ? JSON.stringify(finalJsHandlers) : null, newVersion]
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
