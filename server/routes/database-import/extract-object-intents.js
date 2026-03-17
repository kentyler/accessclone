/**
 * POST /extract-object-intents — Batch extract business-level intents from all
 * forms, reports, and queries in a database using LLM analysis.
 *
 * Stores results in the `intents` JSONB column on shared.forms, shared.reports,
 * and shared.view_metadata respectively.
 */

const { logError, logEvent } = require('../../lib/events');
const { extractFormIntents, extractReportIntents, extractQueryIntents } = require('../../lib/object-intent-extractor');
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
          `SELECT id, name, definition, record_source FROM shared.forms
           WHERE database_id = $1 AND is_current = true`,
          [database_id]
        ),
        pool.query(
          `SELECT id, name, definition, record_source FROM shared.reports
           WHERE database_id = $1 AND is_current = true`,
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
        queries: { extracted: [], failed: [] }
      };

      // Extract form intents
      for (const form of formsResult.rows) {
        try {
          const intents = await extractFormIntents(form.definition, form.name, graphContext, apiKey);
          await pool.query(
            `UPDATE shared.forms SET intents = $1 WHERE id = $2`,
            [JSON.stringify(intents), form.id]
          );
          results.forms.extracted.push(form.name);
        } catch (err) {
          console.error(`Failed to extract intents for form "${form.name}":`, err.message);
          results.forms.failed.push({ name: form.name, error: err.message });
        }
      }

      // Extract report intents
      for (const report of reportsResult.rows) {
        try {
          const intents = await extractReportIntents(report.definition, report.name, graphContext, apiKey);
          await pool.query(
            `UPDATE shared.reports SET intents = $1 WHERE id = $2`,
            [JSON.stringify(intents), report.id]
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

      const totalExtracted = results.forms.extracted.length +
        results.reports.extracted.length + results.queries.extracted.length;
      const totalFailed = results.forms.failed.length +
        results.reports.failed.length + results.queries.failed.length;

      await logEvent(pool, 'info', 'POST /api/database-import/extract-object-intents',
        `Extracted business intents: ${totalExtracted} succeeded, ${totalFailed} failed`,
        { databaseId: database_id, details: JSON.stringify(results) });

      res.json(results);
    } catch (err) {
      await logError(pool, 'POST /api/database-import/extract-object-intents', err.message, err, { databaseId: database_id });
      res.status(500).json({ error: err.message });
    }
  });
};
