/**
 * Import completeness and history routes.
 * PUT /source-discovery — Save discovery inventory
 * GET /import-completeness — Compare discovery vs actual
 * GET /history — Import history
 */

const { logError } = require('../../lib/events');

module.exports = function(router, pool) {

  /**
   * PUT /api/access-import/source-discovery
   */
  router.put('/source-discovery', async (req, res) => {
    try {
      const { database_id, source_path, discovery } = req.body;
      if (!database_id || !source_path || !discovery) {
        return res.status(400).json({ error: 'database_id, source_path, and discovery are required' });
      }
      await pool.query(`
        INSERT INTO shared.source_discovery (database_id, source_path, discovery)
        VALUES ($1, $2, $3)
        ON CONFLICT (database_id) DO UPDATE
          SET source_path = $2, discovery = $3, created_at = NOW()
      `, [database_id, source_path, JSON.stringify(discovery)]);
      res.json({ success: true });
    } catch (err) {
      console.error('Error saving source discovery:', err);
      logError(pool, 'PUT /api/access-import/source-discovery', 'Failed to save source discovery', err);
      res.status(500).json({ error: 'Failed to save source discovery' });
    }
  });

  /**
   * GET /api/access-import/import-completeness
   */
  router.get('/import-completeness', async (req, res) => {
    try {
      const { database_id } = req.query;
      if (!database_id) {
        return res.status(400).json({ error: 'database_id is required' });
      }

      // Load discovery
      const discResult = await pool.query(
        'SELECT discovery FROM shared.source_discovery WHERE database_id = $1',
        [database_id]
      );
      if (discResult.rows.length === 0) {
        return res.json({ has_discovery: false, complete: true, missing: {}, missing_count: 0, total_source_count: 0, imported_count: 0 });
      }
      const discovery = discResult.rows[0].discovery;

      // Load schema name
      const dbResult = await pool.query(
        'SELECT schema_name FROM shared.databases WHERE database_id = $1',
        [database_id]
      );
      if (dbResult.rows.length === 0) {
        return res.status(404).json({ error: 'Database not found' });
      }
      const schemaName = dbResult.rows[0].schema_name;

      // Query actual objects in parallel
      const [tablesRes, viewsRes, routinesRes, formsRes, reportsRes, modulesRes, macrosRes] = await Promise.all([
        pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE'`, [schemaName]),
        pool.query(`SELECT table_name FROM information_schema.views WHERE table_schema = $1`, [schemaName]),
        pool.query(`SELECT routine_name FROM information_schema.routines WHERE routine_schema = $1`, [schemaName]),
        pool.query(`SELECT DISTINCT name FROM shared.forms WHERE database_id = $1 AND is_current = true`, [database_id]),
        pool.query(`SELECT DISTINCT name FROM shared.reports WHERE database_id = $1 AND is_current = true`, [database_id]),
        pool.query(`SELECT DISTINCT name FROM shared.modules WHERE database_id = $1 AND is_current = true`, [database_id]),
        pool.query(`SELECT DISTINCT name FROM shared.macros WHERE database_id = $1 AND is_current = true`, [database_id])
      ]);

      const actualTables = new Set(tablesRes.rows.map(r => r.table_name.toLowerCase()));
      const actualViews = new Set(viewsRes.rows.map(r => r.table_name.toLowerCase()));
      const actualRoutines = new Set(routinesRes.rows.map(r => r.routine_name.toLowerCase()));
      const actualForms = new Set(formsRes.rows.map(r => r.name.toLowerCase()));
      const actualReports = new Set(reportsRes.rows.map(r => r.name.toLowerCase()));
      const actualModules = new Set(modulesRes.rows.map(r => r.name.toLowerCase()));
      const actualMacros = new Set(macrosRes.rows.map(r => r.name.toLowerCase()));

      function isImported(sourceName, actualSet) {
        const lower = sourceName.toLowerCase();
        const sanitized = lower.replace(/\s+/g, '_');
        return actualSet.has(lower) || actualSet.has(sanitized);
      }

      const missing = {};
      let missingCount = 0;
      let totalSource = 0;

      const srcTables = discovery.tables || [];
      totalSource += srcTables.length;
      const missingTables = srcTables.filter(n => !isImported(n, actualTables));
      if (missingTables.length > 0) { missing.tables = missingTables; missingCount += missingTables.length; }

      const srcQueries = discovery.queries || [];
      totalSource += srcQueries.length;
      const actualQueriesSet = new Set([...actualViews, ...actualRoutines]);
      const missingQueries = srcQueries.filter(n => !isImported(n, actualQueriesSet));
      if (missingQueries.length > 0) { missing.queries = missingQueries; missingCount += missingQueries.length; }

      const srcForms = discovery.forms || [];
      totalSource += srcForms.length;
      const missingForms = srcForms.filter(n => !isImported(n, actualForms));
      if (missingForms.length > 0) { missing.forms = missingForms; missingCount += missingForms.length; }

      const srcReports = discovery.reports || [];
      totalSource += srcReports.length;
      const missingReports = srcReports.filter(n => !isImported(n, actualReports));
      if (missingReports.length > 0) { missing.reports = missingReports; missingCount += missingReports.length; }

      const srcModules = discovery.modules || [];
      totalSource += srcModules.length;
      const missingModulesList = srcModules.filter(n => !isImported(n, actualModules));
      if (missingModulesList.length > 0) { missing.modules = missingModulesList; missingCount += missingModulesList.length; }

      const srcMacros = discovery.macros || [];
      totalSource += srcMacros.length;
      const missingMacrosList = srcMacros.filter(n => !isImported(n, actualMacros));
      if (missingMacrosList.length > 0) { missing.macros = missingMacrosList; missingCount += missingMacrosList.length; }

      res.json({
        has_discovery: true,
        complete: missingCount === 0,
        missing,
        missing_count: missingCount,
        total_source_count: totalSource,
        imported_count: totalSource - missingCount
      });
    } catch (err) {
      console.error('Error checking import completeness:', err);
      logError(pool, 'GET /api/access-import/import-completeness', 'Failed to check import completeness', err);
      res.status(500).json({ error: 'Failed to check import completeness' });
    }
  });

  /**
   * GET /api/access-import/history
   */
  router.get('/history', async (req, res) => {
    try {
      const { source_path, target_database_id, limit = 100 } = req.query;

      const conditions = [];
      const params = [];
      let idx = 1;

      if (source_path) {
        conditions.push(`il.source_path = $${idx++}`);
        params.push(source_path);
      }
      if (target_database_id) {
        conditions.push(`il.target_database_id = $${idx++}`);
        params.push(target_database_id);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      params.push(parseInt(limit));

      const query = `
        SELECT il.id, il.created_at, il.source_path, il.source_object_name, il.source_object_type,
               il.target_database_id, il.status, il.error_message, il.details,
               (SELECT COUNT(*) FROM shared.import_issues
                WHERE import_log_id = il.id AND NOT resolved) AS open_issue_count
        FROM shared.import_log il
        ${whereClause}
        ORDER BY il.created_at DESC
        LIMIT $${idx}
      `;

      const result = await pool.query(query, params);
      const history = result.rows.map(r => ({
        ...r,
        open_issue_count: parseInt(r.open_issue_count)
      }));
      res.json({ history });
    } catch (err) {
      console.error('Error fetching import history:', err);
      logError(pool, 'GET /api/access-import/history', 'Failed to fetch import history', err);
      res.status(500).json({ error: 'Failed to fetch import history' });
    }
  });

};
