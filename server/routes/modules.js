/**
 * Module routes with append-only versioning
 * Handles reading/writing VBA modules from shared.objects table (type='module')
 * Module-specific data (vba_source, js_handlers, etc.) stored in definition JSONB
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
        `SELECT name, description, status, definition->>'review_notes' as review_notes, version, created_at,
                (definition->>'vba_source' IS NOT NULL) as has_vba_source,
                (definition->>'cljs_source' IS NOT NULL) as has_cljs_source
         FROM shared.objects
         WHERE database_id = $1 AND type = 'module' AND is_current = true
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
   * GET /api/modules/:name/reactions
   * Extract simple reaction specs from a form module's after-update procedures.
   */
  router.get('/:name/reactions', async (req, res) => {
    try {
      const databaseId = req.databaseId;
      // Load intents from shared.intents via object lookup
      const objResult = await pool.query(
        `SELECT o.id FROM shared.objects o
         WHERE o.database_id = $1 AND o.type = 'module' AND o.name = $2 AND o.is_current = true`,
        [databaseId, req.params.name]
      );

      if (objResult.rows.length === 0) {
        return res.json([]);
      }

      const intentResult = await pool.query(
        `SELECT content FROM shared.intents
         WHERE object_id = $1 AND intent_type = 'gesture'
         ORDER BY created_at DESC LIMIT 1`,
        [objResult.rows[0].id]
      );

      if (intentResult.rows.length === 0 || !intentResult.rows[0].content) {
        return res.json([]);
      }

      const intents = intentResult.rows[0].content;
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
          // Load module definition + intents for resolving event-procedure handlers
          const modResult = await pool.query(
            `SELECT o.definition,
                    (SELECT i.content FROM shared.intents i WHERE i.object_id = o.id AND i.intent_type = 'gesture' ORDER BY i.created_at DESC LIMIT 1) as intents
             FROM shared.objects o
             WHERE o.database_id = $1 AND o.type = 'module' AND o.name = $2 AND o.is_current = true`,
            [databaseId, moduleName]
          );
          const def = modResult.rows[0]?.definition || {};
          const intents = modResult.rows[0]?.intents;
          const jsHandlers = def.js_handlers || [];
          const procedures = (intents?.mapped?.procedures) || [];
          const procMap = {};
          for (const proc of procedures) {
            if (proc.name) procMap[proc.name] = proc;
          }

          // Build lookup from js_handlers by key for merging :js code
          const jsMap = {};
          for (const jh of jsHandlers) {
            if (jh.key) jsMap[jh.key] = jh;
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
              // Merge JS code from js_handlers (generated by vba-to-js at save time)
              const jsHandler = jsMap[key];
              handlers.push({
                key,
                control: controlKw,
                event: eventKey,
                procedure: row.handler_ref,
                intents: proc?.intents || [],
                ...(jsHandler?.js ? { js: jsHandler.js } : {}),
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
        `SELECT o.definition,
                (SELECT i.content FROM shared.intents i WHERE i.object_id = o.id AND i.intent_type = 'gesture' ORDER BY i.created_at DESC LIMIT 1) as intents
         FROM shared.objects o
         WHERE o.database_id = $1 AND o.type = 'module' AND o.name = $2 AND o.is_current = true`,
        [databaseId, moduleName]
      );

      if (result.rows.length === 0) {
        return res.json([]);
      }

      const def = result.rows[0].definition || {};
      const intents = result.rows[0].intents;
      const js_handlers = def.js_handlers;

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

        const match = proc.name.match(/^(.+?)_(\w+)$/);
        if (!match) continue;

        const rawControl = match[1];
        const rawEvent = match[2];

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

  /**
   * GET /api/modules/:name
   * Read the current version of a module
   * Returns a flat object with vba_source, js_handlers, etc. extracted from definition JSONB
   */
  router.get('/:name', async (req, res) => {
    try {
      const databaseId = req.databaseId;

      const result = await pool.query(
        `SELECT o.name, o.definition, o.description, o.status, o.version, o.created_at,
                (SELECT i.content FROM shared.intents i WHERE i.object_id = o.id AND i.intent_type = 'gesture' ORDER BY i.created_at DESC LIMIT 1) as intents
         FROM shared.objects o
         WHERE o.database_id = $1 AND o.type = 'module' AND o.name = $2 AND o.is_current = true`,
        [databaseId, req.params.name]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Module not found' });
      }

      // Flatten definition fields into the response to maintain API compatibility
      const row = result.rows[0];
      const def = row.definition || {};
      res.json({
        name: row.name,
        vba_source: def.vba_source || null,
        cljs_source: def.cljs_source || null,
        description: row.description,
        status: row.status,
        review_notes: def.review_notes || null,
        intents: row.intents || null,
        js_handlers: def.js_handlers || null,
        version: row.version,
        created_at: row.created_at
      });
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
        `SELECT o.definition, o.description, o.status,
                (SELECT i.content FROM shared.intents i WHERE i.object_id = o.id AND i.intent_type = 'gesture' ORDER BY i.created_at DESC LIMIT 1) as intents
         FROM shared.objects o
         WHERE o.database_id = $1 AND o.type = 'module' AND o.name = $2 AND o.is_current = true`,
        [databaseId, moduleName]
      );
      const prev = currentResult.rows[0] || {};
      const prevDef = prev.definition || {};

      // Get max version across ALL rows (including non-current)
      const versionResult = await client.query(
        `SELECT COALESCE(MAX(version), 0) as max_version
         FROM shared.objects
         WHERE database_id = $1 AND type = 'module' AND name = $2`,
        [databaseId, moduleName]
      );
      const newVersion = versionResult.rows[0].max_version + 1;

      // Merge: use provided value when present, otherwise preserve current
      const finalVba = vba_source !== undefined ? vba_source : (prevDef.vba_source || null);
      const finalCljs = prevDef.cljs_source || null;
      const finalDesc = description !== undefined ? description : (prev.description || null);
      const finalStatus = status || prev.status || 'pending';
      const finalNotes = review_notes !== undefined ? review_notes : (prevDef.review_notes || null);
      const finalIntents = intents !== undefined ? intents : prev.intents;

      // Auto-generate JS handlers from VBA source when VBA changes
      let finalJsHandlers = js_handlers !== undefined ? js_handlers : (prevDef.js_handlers || null);
      if (vba_source !== undefined && vba_source) {
        try {
          const parsed = parseVbaToHandlers(vba_source, moduleName);
          finalJsHandlers = parsed.length > 0 ? parsed : null;
        } catch (e) {
          console.warn('Failed to parse VBA to JS handlers:', e.message);
        }
      }

      // Build definition JSONB
      const definition = {
        vba_source: finalVba,
        js_handlers: finalJsHandlers,
        cljs_source: finalCljs,
        review_notes: finalNotes
      };

      // Mark all existing versions as not current
      await client.query(
        `UPDATE shared.objects
         SET is_current = false
         WHERE database_id = $1 AND type = 'module' AND name = $2 AND is_current = true`,
        [databaseId, moduleName]
      );

      // Insert new version as current
      const insertResult = await client.query(
        `INSERT INTO shared.objects (database_id, type, name, definition, description, status, version, is_current)
         VALUES ($1, 'module', $2, $3, $4, $5, $6, true)
         RETURNING id`,
        [databaseId, moduleName, JSON.stringify(definition), finalDesc, finalStatus, newVersion]
      );

      // Save intents to shared.intents if provided
      if (finalIntents) {
        const objectId = insertResult.rows[0].id;
        await client.query(
          `INSERT INTO shared.intents (object_id, intent_type, content, generated_by)
           VALUES ($1, 'gesture', $2, 'import')`,
          [objectId, JSON.stringify(finalIntents)]
        );
      }

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
