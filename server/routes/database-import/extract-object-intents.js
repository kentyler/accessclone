/**
 * POST /extract-object-intents — Batch extract business-level intents from all
 * forms, reports, and queries in a database using LLM analysis.
 *
 * Stores results in shared.intents table (linked to shared.objects),
 * and in the `intents` JSONB column on shared.view_metadata for queries.
 */

const { logError, logEvent } = require('../../lib/events');
const { extractFormIntents, extractReportIntents, extractQueryIntents, extractFormStructureIntents } = require('../../lib/object-intent-extractor');
const { buildGraphContext } = require('../chat/context');

module.exports = function(router, pool, secrets) {
  router.post('/extract-object-intents', async (req, res) => {
    req.setTimeout(600000);
    const { database_id } = req.body;

    if (!database_id) {
      return res.status(400).json({ error: 'database_id is required' });
    }

    const apiKey = secrets?.anthropic?.api_key || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.json({ skipped: true, message: 'No API key configured' });
    }

    try {
      // Get schema name for this database
      const dbResult = await pool.query(
        'SELECT schema_name FROM shared.databases WHERE database_id = $1',
        [database_id]
      );
      if (dbResult.rows.length === 0) {
        return res.status(404).json({ error: 'Database not found' });
      }
      const schemaName = dbResult.rows[0].schema_name;

      // Build graph context once for all extractions
      const graphContext = await buildGraphContext(pool, database_id);

      // Load all forms, reports, queries
      const [formsResult, reportsResult, viewsResult] = await Promise.all([
        pool.query(
          `SELECT id, name, definition, record_source FROM shared.objects
           WHERE database_id = $1 AND type = 'form' AND is_current = true`,
          [database_id]
        ),
        pool.query(
          `SELECT id, name, definition, record_source FROM shared.objects
           WHERE database_id = $1 AND type = 'report' AND is_current = true`,
          [database_id]
        ),
        pool.query(
          `SELECT view_name FROM shared.view_metadata
           WHERE database_id = $1`,
          [database_id]
        )
      ]);

      const results = {
        forms: { extracted: [], failed: [] },
        reports: { extracted: [], failed: [] },
        queries: { extracted: [], failed: [] },
        structure: { extracted: [], failed: [] }
      };

      // Extract form intents (business + structure)
      for (const form of formsResult.rows) {
        // Business intents
        try {
          const intents = await extractFormIntents(form.definition, form.name, graphContext, apiKey);
          // Save to shared.intents (replace existing business intents for this object)
          await pool.query('DELETE FROM shared.intents WHERE object_id = $1 AND intent_type = $2', [form.id, 'business']);
          await pool.query(
            `INSERT INTO shared.intents (object_id, intent_type, content, generated_by) VALUES ($1, 'business', $2, 'llm')`,
            [form.id, JSON.stringify(intents)]
          );
          results.forms.extracted.push(form.name);
        } catch (err) {
          console.error(`Failed to extract business intents for form "${form.name}":`, err.message);
          results.forms.failed.push({ name: form.name, error: err.message });
        }

        // Structure intents
        try {
          const structure = await extractFormStructureIntents(form.definition, form.name, graphContext, apiKey);
          await pool.query('DELETE FROM shared.intents WHERE object_id = $1 AND intent_type = $2', [form.id, 'structure']);
          await pool.query(
            `INSERT INTO shared.intents (object_id, intent_type, content, generated_by) VALUES ($1, 'structure', $2, 'llm')`,
            [form.id, JSON.stringify(structure)]
          );
          results.structure.extracted.push(form.name);
        } catch (err) {
          console.error(`Failed to extract structure intents for form "${form.name}":`, err.message);
          results.structure.failed.push({ name: form.name, error: err.message });
        }
      }

      // Extract report intents
      for (const report of reportsResult.rows) {
        try {
          const intents = await extractReportIntents(report.definition, report.name, graphContext, apiKey);
          // Save to shared.intents (replace existing business intents for this object)
          await pool.query('DELETE FROM shared.intents WHERE object_id = $1 AND intent_type = $2', [report.id, 'business']);
          await pool.query(
            `INSERT INTO shared.intents (object_id, intent_type, content, generated_by) VALUES ($1, 'business', $2, 'llm')`,
            [report.id, JSON.stringify(intents)]
          );
          results.reports.extracted.push(report.name);
        } catch (err) {
          console.error(`Failed to extract intents for report "${report.name}":`, err.message);
          results.reports.failed.push({ name: report.name, error: err.message });
        }
      }

      // Extract query intents — need SQL from pg_get_viewdef or pg_get_functiondef
      for (const view of viewsResult.rows) {
        try {
          // Try view first, then function
          let sql = null;
          try {
            const viewDefResult = await pool.query(
              `SELECT pg_get_viewdef($1 || '.' || $2, true) AS def`,
              [schemaName, view.view_name]
            );
            sql = viewDefResult.rows[0]?.def;
          } catch (_) {
            // Not a view — try function
          }

          if (!sql) {
            try {
              const funcResult = await pool.query(
                `SELECT pg_get_functiondef(p.oid) AS def
                 FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
                 WHERE n.nspname = $1 AND p.proname = $2`,
                [schemaName, view.view_name]
              );
              sql = funcResult.rows[0]?.def;
            } catch (_) {
              // Neither view nor function
            }
          }

          if (!sql) {
            results.queries.failed.push({ name: view.view_name, error: 'Could not retrieve SQL definition' });
            continue;
          }

          const intents = await extractQueryIntents(sql, view.view_name, graphContext, apiKey);
          await pool.query(
            `UPDATE shared.view_metadata SET intents = $1
             WHERE database_id = $2 AND view_name = $3`,
            [JSON.stringify(intents), database_id, view.view_name]
          );
          results.queries.extracted.push(view.view_name);
        } catch (err) {
          console.error(`Failed to extract intents for query "${view.view_name}":`, err.message);
          results.queries.failed.push({ name: view.view_name, error: err.message });
        }
      }

      // Extract macro gesture intents (deterministic — no LLM needed)
      results.macros = { extracted: [], failed: [] };
      const { extractIntentsForObject } = require('../../lib/intent-pipeline');

      const macrosResult = await pool.query(
        `SELECT id, name, definition FROM shared.objects
         WHERE database_id = $1 AND type = 'macro' AND is_current = true`,
        [database_id]
      );

      for (const macro of macrosResult.rows) {
        try {
          const def = typeof macro.definition === 'string' ? JSON.parse(macro.definition) : macro.definition;
          const result = await extractIntentsForObject(pool, {
            databaseId: database_id, objectType: 'macro', objectName: macro.name,
            objectId: macro.id, definition: def
          });
          if (result.extracted) {
            results.macros.extracted.push(macro.name);
          } else {
            results.macros.failed.push({ name: macro.name, error: result.error || 'No actions found' });
          }
        } catch (err) {
          results.macros.failed.push({ name: macro.name, error: err.message });
        }
      }

      // Extract table schema snapshots (deterministic — no LLM needed)
      results.tables = { extracted: [], failed: [] };

      const tablesResult = await pool.query(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY table_name`,
        [schemaName]
      );

      for (const tbl of tablesResult.rows) {
        try {
          const result = await extractIntentsForObject(pool, {
            databaseId: database_id, schemaName, objectType: 'table',
            objectName: tbl.table_name, objectId: null, definition: null
          });
          if (result.extracted) {
            results.tables.extracted.push(tbl.table_name);
          } else {
            results.tables.failed.push({ name: tbl.table_name, error: result.error || 'No columns found' });
          }
        } catch (err) {
          results.tables.failed.push({ name: tbl.table_name, error: err.message });
        }
      }

      const totalExtracted = results.forms.extracted.length +
        results.reports.extracted.length + results.queries.extracted.length +
        results.macros.extracted.length + results.tables.extracted.length;
      const totalFailed = results.forms.failed.length +
        results.reports.failed.length + results.queries.failed.length +
        results.macros.failed.length + results.tables.failed.length;
      const structureExtracted = results.structure.extracted.length;
      const structureFailed = results.structure.failed.length;

      const intentTypes = [];
      if (totalExtracted > 0) intentTypes.push('business');
      if (structureExtracted > 0) intentTypes.push('structure');
      if (results.macros.extracted.length > 0) intentTypes.push('gesture');
      if (results.tables.extracted.length > 0) intentTypes.push('schema');
      await logEvent(pool, 'info', 'POST /api/database-import/extract-object-intents',
        `Extracted intents: ${results.forms.extracted.length + results.reports.extracted.length} business, ${structureExtracted} structure, ${results.macros.extracted.length} gesture, ${results.tables.extracted.length} schema (${totalFailed + structureFailed} failed)`,
        { databaseId: database_id, details: JSON.stringify(results),
          propagation: { intents: intentTypes, intent_counts: { business: results.forms.extracted.length + results.reports.extracted.length, structure: structureExtracted, gesture: results.macros.extracted.length, schema: results.tables.extracted.length } } });

      res.json(results);
    } catch (err) {
      await logError(pool, 'POST /api/database-import/extract-object-intents', err.message, err, { databaseId: database_id });
      res.status(500).json({ error: err.message });
    }
  });
};
