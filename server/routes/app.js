/**
 * App Viewer routes — application-level dashboard endpoints.
 */

const express = require('express');
const router = express.Router();
const { logError } = require('../lib/events');
const { checkImportCompleteness, buildGraphContext } = require('./chat/context');

module.exports = function(pool) {

  /**
   * GET /api/app/overview?database_id=X
   * Returns per-type import progress and translation summary for the dashboard.
   */
  router.get('/overview', async (req, res) => {
    const databaseId = req.query.database_id || req.headers['x-database-id'];
    if (!databaseId) {
      return res.status(400).json({ error: 'database_id is required' });
    }

    try {
      // Get schema name
      const dbResult = await pool.query(
        'SELECT schema_name, name FROM shared.databases WHERE database_id = $1',
        [databaseId]
      );
      if (dbResult.rows.length === 0) {
        return res.status(404).json({ error: 'Database not found' });
      }
      const { schema_name: schemaName, name: dbName } = dbResult.rows[0];

      // Import completeness (reuse existing helper)
      const completeness = await checkImportCompleteness(pool, databaseId);

      // Count actual imported objects
      const [tablesRes, viewsRes, routinesRes, formsRes, reportsRes, modulesRes, macrosRes] = await Promise.all([
        pool.query(`SELECT count(*) FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE'`, [schemaName]),
        pool.query(`SELECT count(*) FROM information_schema.views WHERE table_schema = $1`, [schemaName]),
        pool.query(`SELECT count(*) FROM information_schema.routines WHERE routine_schema = $1`, [schemaName]),
        pool.query(`SELECT count(DISTINCT name) FROM shared.forms WHERE database_id = $1 AND is_current = true`, [databaseId]),
        pool.query(`SELECT count(DISTINCT name) FROM shared.reports WHERE database_id = $1 AND is_current = true`, [databaseId]),
        pool.query(`SELECT count(DISTINCT name) FROM shared.modules WHERE database_id = $1 AND is_current = true`, [databaseId]),
        pool.query(`SELECT count(DISTINCT name) FROM shared.macros WHERE database_id = $1 AND is_current = true`, [databaseId])
      ]);

      const imported = {
        tables: parseInt(tablesRes.rows[0].count),
        queries: parseInt(viewsRes.rows[0].count) + parseInt(routinesRes.rows[0].count),
        forms: parseInt(formsRes.rows[0].count),
        reports: parseInt(reportsRes.rows[0].count),
        modules: parseInt(modulesRes.rows[0].count),
        macros: parseInt(macrosRes.rows[0].count)
      };

      // Source counts from discovery (if available)
      const source = {};
      if (completeness?.has_discovery) {
        const discResult = await pool.query(
          'SELECT discovery FROM shared.source_discovery WHERE database_id = $1',
          [databaseId]
        );
        if (discResult.rows.length > 0) {
          const disc = discResult.rows[0].discovery;
          source.tables = (disc.tables || []).length;
          source.queries = (disc.queries || []).length;
          source.forms = (disc.forms || []).length;
          source.reports = (disc.reports || []).length;
          source.modules = (disc.modules || []).length;
          source.macros = (disc.macros || []).length;
        }
      }

      // Module translation status counts
      let translationStatus = { pending: 0, draft: 0, reviewed: 0, approved: 0, total: 0 };
      let intentStats = { total: 0, mechanical: 0, llm_fallback: 0, gap: 0, modules_with_intents: 0 };
      try {
        const statusRes = await pool.query(
          `SELECT COALESCE(status, 'pending') as status, count(*) as cnt
           FROM (SELECT DISTINCT ON (name) name, status FROM shared.modules WHERE database_id = $1 AND is_current = true) sub
           GROUP BY status`,
          [databaseId]
        );
        for (const row of statusRes.rows) {
          translationStatus[row.status] = parseInt(row.cnt);
          translationStatus.total += parseInt(row.cnt);
        }

        // Aggregate intent stats across all modules
        const intentRes = await pool.query(
          `SELECT intents FROM shared.modules WHERE database_id = $1 AND is_current = true AND intents IS NOT NULL`,
          [databaseId]
        );
        for (const row of intentRes.rows) {
          const intents = row.intents;
          if (intents?.mapped?.procedures) {
            intentStats.modules_with_intents++;
            for (const proc of intents.mapped.procedures) {
              intentStats.mechanical += proc.stats?.mechanical || 0;
              intentStats.llm_fallback += proc.stats?.llm_fallback || 0;
              intentStats.gap += proc.stats?.gap || 0;
            }
          }
        }
        intentStats.total = intentStats.mechanical + intentStats.llm_fallback + intentStats.gap;
      } catch (err) {
        // Non-fatal: translation stats may fail if table doesn't exist
        console.log('Translation stats query failed:', err.message);
      }

      res.json({
        database_name: dbName,
        imported,
        source: Object.keys(source).length > 0 ? source : null,
        completeness: completeness ? {
          has_discovery: completeness.has_discovery,
          complete: completeness.complete,
          missing_count: completeness.missing_count || 0
        } : null,
        translation_status: translationStatus,
        intent_stats: intentStats
      });
    } catch (err) {
      console.error('Error loading app overview:', err);
      logError(pool, 'GET /api/app/overview', 'Failed to load app overview', err, { databaseId });
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/app/dependency-summary?database_id=X
   * Returns form→record-source bindings, query→table dependencies, orphaned objects.
   */
  router.get('/dependency-summary', async (req, res) => {
    const databaseId = req.query.database_id || req.headers['x-database-id'];
    if (!databaseId) {
      return res.status(400).json({ error: 'database_id is required' });
    }

    try {
      const graphCtx = await buildGraphContext(pool, databaseId);
      if (!graphCtx) {
        return res.status(404).json({ error: 'Database not found' });
      }

      const tableNames = new Set(graphCtx.tables.map(t => t.name));
      const viewNames = new Set(graphCtx.views.map(v => v.name));
      const allDataSources = new Set([...tableNames, ...viewNames]);

      // Form → record-source bindings
      const formBindings = graphCtx.forms
        .filter(f => f.record_source)
        .map(f => ({
          form: f.name,
          record_source: f.record_source,
          source_exists: allDataSources.has(f.record_source) ||
                         allDataSources.has(f.record_source.toLowerCase().replace(/\s+/g, '_'))
        }));

      // Report → record-source bindings
      const reportBindings = graphCtx.reports
        .filter(r => r.record_source)
        .map(r => ({
          report: r.name,
          record_source: r.record_source,
          source_exists: allDataSources.has(r.record_source) ||
                         allDataSources.has(r.record_source.toLowerCase().replace(/\s+/g, '_'))
        }));

      // Tables referenced by forms/reports
      const referencedSources = new Set([
        ...formBindings.map(b => b.record_source),
        ...reportBindings.map(b => b.record_source)
      ]);

      // Orphaned tables (no form or report references them)
      const orphanedTables = [...tableNames].filter(t => !referencedSources.has(t));

      // Module → form references (scan intents for open-form)
      let moduleFormRefs = [];
      try {
        const intentsRes = await pool.query(
          `SELECT name, intents FROM shared.modules WHERE database_id = $1 AND is_current = true AND intents IS NOT NULL`,
          [databaseId]
        );
        for (const row of intentsRes.rows) {
          const formRefs = new Set();
          function scanIntents(intents) {
            for (const intent of (intents || [])) {
              if ((intent.type === 'open-form' || intent.type === 'open-form-filtered') && intent.form) {
                formRefs.add(intent.form);
              }
              if (intent.then) scanIntents(intent.then);
              if (intent.else) scanIntents(intent.else);
              if (intent.children) scanIntents(intent.children);
            }
          }
          if (row.intents?.mapped?.procedures) {
            for (const proc of row.intents.mapped.procedures) {
              scanIntents(proc.intents);
            }
          }
          if (formRefs.size > 0) {
            moduleFormRefs.push({ module: row.name, forms: [...formRefs] });
          }
        }
      } catch (err) {
        // Non-fatal
      }

      res.json({
        form_bindings: formBindings,
        report_bindings: reportBindings,
        module_form_refs: moduleFormRefs,
        orphaned_tables: orphanedTables,
        summary: {
          total_tables: tableNames.size,
          total_views: viewNames.size,
          total_forms: graphCtx.forms.length,
          total_reports: graphCtx.reports.length,
          broken_form_bindings: formBindings.filter(b => !b.source_exists).length,
          broken_report_bindings: reportBindings.filter(b => !b.source_exists).length
        }
      });
    } catch (err) {
      console.error('Error loading dependency summary:', err);
      logError(pool, 'GET /api/app/dependency-summary', 'Failed to load dependency summary', err, { databaseId });
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/app/api-surface?database_id=X
   * Scan module intents for data operations — what API endpoints the translated code needs.
   */
  router.get('/api-surface', async (req, res) => {
    const databaseId = req.query.database_id || req.headers['x-database-id'];
    if (!databaseId) {
      return res.status(400).json({ error: 'database_id is required' });
    }

    try {
      const graphCtx = await buildGraphContext(pool, databaseId);
      if (!graphCtx) {
        return res.status(404).json({ error: 'Database not found' });
      }

      const existingTables = new Set(graphCtx.tables.map(t => t.name));
      const existingViews = new Set(graphCtx.views.map(v => v.name));
      const allDataSources = new Set([...existingTables, ...existingViews]);

      // Scan module intents for data operations
      const neededEndpoints = new Map(); // table -> { operations: Set, modules: Set }

      try {
        const intentsRes = await pool.query(
          `SELECT name, intents FROM shared.modules WHERE database_id = $1 AND is_current = true AND intents IS NOT NULL`,
          [databaseId]
        );

        for (const row of intentsRes.rows) {
          function scanForDataOps(intents) {
            for (const intent of (intents || [])) {
              // Check for data-related intent types
              if (intent.type === 'save-record' || intent.type === 'new-record' || intent.type === 'delete-record') {
                // These operate on the current form's record source
                const key = '__current_form__';
                if (!neededEndpoints.has(key)) neededEndpoints.set(key, { operations: new Set(), modules: new Set() });
                neededEndpoints.get(key).operations.add(intent.type);
                neededEndpoints.get(key).modules.add(row.name);
              }
              if (intent.type === 'gap' && intent.vba_line) {
                // Check for DLookup, DCount, RunSQL patterns
                const line = intent.vba_line.toLowerCase();
                const match = line.match(/d(?:lookup|count|sum|avg)\s*\([^,]*,\s*"([^"]+)"/i);
                if (match) {
                  const table = match[1];
                  if (!neededEndpoints.has(table)) neededEndpoints.set(table, { operations: new Set(), modules: new Set() });
                  neededEndpoints.get(table).operations.add('read');
                  neededEndpoints.get(table).modules.add(row.name);
                }
                const sqlMatch = line.match(/runsql.*"([^"]*(?:insert|update|delete)[^"]*)"/i);
                if (sqlMatch) {
                  if (!neededEndpoints.has('__runsql__')) neededEndpoints.set('__runsql__', { operations: new Set(), modules: new Set() });
                  neededEndpoints.get('__runsql__').operations.add('execute');
                  neededEndpoints.get('__runsql__').modules.add(row.name);
                }
              }
              if (intent.then) scanForDataOps(intent.then);
              if (intent.else) scanForDataOps(intent.else);
              if (intent.children) scanForDataOps(intent.children);
            }
          }
          if (row.intents?.mapped?.procedures) {
            for (const proc of row.intents.mapped.procedures) {
              scanForDataOps(proc.intents);
            }
          }
        }
      } catch (err) {
        // Non-fatal
      }

      // Build result
      const endpoints = [];
      for (const [table, info] of neededEndpoints) {
        endpoints.push({
          table,
          operations: [...info.operations],
          modules: [...info.modules],
          exists: table === '__current_form__' || table === '__runsql__' || allDataSources.has(table) ||
                  allDataSources.has(table.toLowerCase().replace(/\s+/g, '_'))
        });
      }

      // Also list form record sources as implicit data needs
      const formDataNeeds = graphCtx.forms
        .filter(f => f.record_source)
        .map(f => ({
          table: f.record_source,
          operations: ['read'],
          source: `form:${f.name}`,
          exists: allDataSources.has(f.record_source) ||
                  allDataSources.has(f.record_source.toLowerCase().replace(/\s+/g, '_'))
        }));

      res.json({
        module_endpoints: endpoints,
        form_data_needs: formDataNeeds,
        summary: {
          total_endpoints_needed: endpoints.length,
          missing_tables: endpoints.filter(e => !e.exists).length,
          missing_form_sources: formDataNeeds.filter(f => !f.exists).length
        }
      });
    } catch (err) {
      console.error('Error analyzing API surface:', err);
      logError(pool, 'GET /api/app/api-surface', 'Failed to analyze API surface', err, { databaseId });
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
