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
const { parseVbaToHandlers, collectEnumValues, extractProcedureNames, extractProcedures } = require('../lib/vba-to-js');
const { writeHandlerFile, deleteHandlerFile, readHandlerFile, writeHandlerFileRaw } = require('../lib/handler-gen/writer');
const { needsLLMFallback, translateHandlerWithLLM } = require('../lib/vba-to-js-llm');

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
   * POST /api/modules/regenerate-handler-files
   * Re-parse all modules with VBA source and write handler files to disk.
   * For one-time migration of existing databases.
   */
  router.post('/regenerate-handler-files', async (req, res) => {
    const databaseId = req.databaseId;
    try {
      const result = await pool.query(
        `SELECT name, definition->>'vba_source' as vba_source
         FROM shared.objects
         WHERE database_id = $1 AND type = 'module' AND is_current = true
           AND definition->>'vba_source' IS NOT NULL`,
        [databaseId]
      );

      // Build combined enum map from all modules
      const enumMap = new Map();
      for (const row of result.rows) {
        const moduleEnums = collectEnumValues(row.vba_source);
        for (const [k, v] of moduleEnums) enumMap.set(k, v);
      }

      let written = 0;
      let skipped = 0;
      const errors = [];

      for (const row of result.rows) {
        try {
          const parsed = parseVbaToHandlers(row.vba_source, row.name, enumMap);
          if (parsed && parsed.length > 0) {
            writeHandlerFile(databaseId, row.name, parsed);
            written++;
          } else {
            skipped++;
          }
        } catch (e) {
          errors.push({ module: row.name, error: e.message });
        }
      }

      res.json({
        success: true,
        database_id: databaseId,
        total: result.rows.length,
        written,
        skipped,
        errors
      });
    } catch (err) {
      logError(pool, 'POST /api/modules/regenerate-handler-files', 'Failed to regenerate handler files', err, { databaseId });
      res.status(500).json({ error: 'Failed to regenerate handler files' });
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
   * GET /api/modules/:name/handler-file
   * Read the generated handler .ts file from disk
   */
  router.get('/:name/handler-file', async (req, res) => {
    try {
      const databaseId = req.databaseId;
      const moduleName = req.params.name;
      const result = readHandlerFile(databaseId, moduleName);
      if (!result) {
        return res.json({ exists: false, content: null });
      }
      res.json({ exists: true, content: result.content });
    } catch (err) {
      logError(pool, 'GET /api/modules/:name/handler-file', 'Failed to read handler file', err, { databaseId: req.databaseId });
      res.status(500).json({ error: 'Failed to read handler file' });
    }
  });

  /**
   * PUT /api/modules/:name/handler-file
   * Write raw content to the handler .ts file on disk
   */
  router.put('/:name/handler-file', async (req, res) => {
    try {
      const databaseId = req.databaseId;
      const moduleName = req.params.name;
      const { content } = req.body;
      if (typeof content !== 'string') {
        return res.status(400).json({ error: 'content must be a string' });
      }
      const { relativePath } = writeHandlerFileRaw(databaseId, moduleName, content);
      res.json({ success: true, relativePath });
    } catch (err) {
      logError(pool, 'PUT /api/modules/:name/handler-file', 'Failed to write handler file', err, { databaseId: req.databaseId });
      res.status(500).json({ error: 'Failed to write handler file' });
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
          // Build enum map from all modules for cross-module enum resolution
          const enumResult = await client.query(
            `SELECT definition->>'vba_source' as vba_source
             FROM shared.objects
             WHERE database_id = $1 AND type = 'module' AND is_current = true
               AND definition->>'vba_source' IS NOT NULL`,
            [databaseId]
          );
          const enumMap = new Map();
          for (const r of enumResult.rows) {
            const moduleEnums = collectEnumValues(r.vba_source);
            for (const [k, v] of moduleEnums) enumMap.set(k, v);
          }
          // Also collect from the new source being saved (may have new enums)
          const newEnums = collectEnumValues(vba_source);
          for (const [k, v] of newEnums) enumMap.set(k, v);

          const parsed = parseVbaToHandlers(vba_source, moduleName, enumMap);
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

      // Write handler file to disk (non-fatal)
      try {
        if (finalJsHandlers && finalJsHandlers.length > 0) {
          writeHandlerFile(databaseId, moduleName, finalJsHandlers);
        } else {
          deleteHandlerFile(databaseId, moduleName);
        }
      } catch (fileErr) {
        console.warn('Failed to write handler file:', fileErr.message);
      }

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

  /**
   * POST /api/modules/:name/llm-translate
   * Run LLM fallback on a single module's handlers.
   * Requires ANTHROPIC_API_KEY environment variable.
   */
  router.post('/:name/llm-translate', async (req, res) => {
    const databaseId = req.databaseId;
    const moduleName = req.params.name;
    const apiKey = process.env.ANTHROPIC_API_KEY;

    if (!apiKey) {
      return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
    }

    try {
      // Load module
      const modResult = await pool.query(
        `SELECT o.id, o.definition,
                (SELECT i.content FROM shared.intents i WHERE i.object_id = o.id AND i.intent_type = 'gesture' ORDER BY i.created_at DESC LIMIT 1) as intents
         FROM shared.objects o
         WHERE o.database_id = $1 AND o.type = 'module' AND o.name = $2 AND o.is_current = true`,
        [databaseId, moduleName]
      );

      if (modResult.rows.length === 0) {
        return res.status(404).json({ error: 'Module not found' });
      }

      const row = modResult.rows[0];
      const def = row.definition || {};
      const vbaSource = def.vba_source;
      if (!vbaSource) {
        return res.status(400).json({ error: 'Module has no VBA source' });
      }

      // Build enum map and fn registry from all modules
      const allModules = await pool.query(
        `SELECT definition->>'vba_source' as vba_source
         FROM shared.objects WHERE database_id = $1 AND type = 'module' AND is_current = true
           AND definition->>'vba_source' IS NOT NULL`,
        [databaseId]
      );
      const enumMap = new Map();
      const fnRegistry = new Set();
      for (const r of allModules.rows) {
        const e = collectEnumValues(r.vba_source);
        for (const [k, v] of e) enumMap.set(k, v);
        for (const name of extractProcedureNames(r.vba_source)) {
          fnRegistry.add(name.toLowerCase());
        }
      }

      // Deterministic parse
      const handlers = parseVbaToHandlers(vbaSource, moduleName, enumMap, fnRegistry);
      if (!handlers || handlers.length === 0) {
        return res.json({ handlers: [], stats: { total: 0, clean: 0, llm_improved: 0, still_untranslated: 0 } });
      }

      // Build procedure and intent lookups
      const procedures = extractProcedures(vbaSource);
      const procByName = {};
      for (const proc of procedures) {
        procByName[proc.name] = proc.body;
      }

      const moduleIntents = row.intents;
      const intentProcs = {};
      if (moduleIntents?.mapped?.procedures) {
        for (const proc of moduleIntents.mapped.procedures) {
          if (proc.name) intentProcs[proc.name] = proc;
        }
      }

      // LLM pass
      let llmImproved = 0;
      let stillUntranslated = 0;
      for (let i = 0; i < handlers.length; i++) {
        const h = handlers[i];
        if (!needsLLMFallback(h)) continue;

        const vbaBody = procByName[h.procedure] || null;
        const intent = intentProcs[h.procedure] || null;

        try {
          const result = await translateHandlerWithLLM(h, vbaBody, intent, handlers, apiKey);
          if (result) {
            handlers[i] = { ...h, js: result.js, llm: true };
            llmImproved++;
          } else {
            stillUntranslated++;
          }
        } catch (err) {
          stillUntranslated++;
          console.error(`LLM translate error for ${moduleName} → ${h.key}:`, err.message);
        }
      }

      // Count clean handlers (no comment lines)
      const clean = handlers.filter(h => h.js && !h.js.includes('// [VBA]')).length;

      // Save updated handlers to DB
      await pool.query(
        `UPDATE shared.objects SET definition = jsonb_set(definition, '{js_handlers}', $1::jsonb) WHERE id = $2`,
        [JSON.stringify(handlers), row.id]
      );

      // Write handler file
      writeHandlerFile(databaseId, moduleName, handlers);

      res.json({
        handlers,
        stats: {
          total: handlers.length,
          clean,
          llm_improved: llmImproved,
          still_untranslated: stillUntranslated,
        },
      });
    } catch (err) {
      logError(pool, 'POST /api/modules/:name/llm-translate', 'Failed to LLM translate module', err, { databaseId });
      res.status(500).json({ error: 'Failed to LLM translate module' });
    }
  });

  return router;
}

module.exports = createRouter;
