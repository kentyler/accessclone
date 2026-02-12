/**
 * Query import and state-control tagging routes.
 * POST /import-query — Convert Access query to PG view/function
 * POST /tag-state-controls — Auto-tag controls referenced by converted queries
 */

const path = require('path');
const { logError } = require('../../lib/events');
const { clearSchemaCache } = require('../data');
const { convertAccessQuery, sanitizeName } = require('../../lib/query-converter');
const { makeLogImport, runPowerShell } = require('./helpers');

module.exports = function(router, pool) {

  /**
   * POST /api/access-import/import-query
   */
  router.post('/import-query', async (req, res) => {
    const { databasePath, queryName, targetDatabaseId, force } = req.body;

    const logImport = makeLogImport(pool, databasePath, queryName, 'query', targetDatabaseId);

    try {
      if (!databasePath || !queryName || !targetDatabaseId) {
        await logImport('error', 'databasePath, queryName, and targetDatabaseId required');
        return res.status(400).json({ error: 'databasePath, queryName, and targetDatabaseId required' });
      }

      // 1. Look up target schema
      const dbResult = await pool.query(
        'SELECT schema_name FROM shared.databases WHERE database_id = $1',
        [targetDatabaseId]
      );
      if (dbResult.rows.length === 0) {
        await logImport('error', 'Target database not found');
        return res.status(404).json({ error: 'Target database not found' });
      }
      const schemaName = dbResult.rows[0].schema_name;

      // 2. Run export_query.ps1
      const scriptsDir = path.join(__dirname, '..', '..', '..', 'scripts', 'access');
      const exportScript = path.join(scriptsDir, 'export_query.ps1');
      const jsonOutput = await runPowerShell(exportScript, [
        '-DatabasePath', databasePath,
        '-QueryName', queryName
      ]);

      const cleanOutput = jsonOutput.replace(/^\uFEFF/, '').trim();
      const jsonStart = cleanOutput.indexOf('{');
      if (jsonStart === -1) {
        throw new Error('No JSON object found in PowerShell output');
      }
      const queryData = JSON.parse(cleanOutput.substring(jsonStart));

      // 3. Build column type map from the target schema for param type resolution
      const colTypesResult = await pool.query(`
        SELECT table_name, column_name, data_type
        FROM information_schema.columns
        WHERE table_schema = $1
      `, [schemaName]);
      const columnTypes = {};
      for (const row of colTypesResult.rows) {
        columnTypes[`${row.table_name}.${row.column_name}`] = row.data_type;
        columnTypes[row.column_name] = row.data_type;
      }

      // 3b. Load control-column mapping for form ref resolution
      const mappingResult = await pool.query(
        `SELECT form_name, control_name, table_name, column_name
         FROM shared.control_column_map WHERE database_id = $1`,
        [targetDatabaseId]
      );
      const controlMapping = {};
      for (const row of mappingResult.rows) {
        controlMapping[`${row.form_name}.${row.control_name}`] = {
          table: row.table_name, column: row.column_name
        };
      }

      // 4. Convert Access SQL → PostgreSQL
      const result = convertAccessQuery(queryData, schemaName, columnTypes, controlMapping);

      // Surface parameter extraction warning from PowerShell
      if (queryData.paramWarning) {
        result.warnings.push(queryData.paramWarning);
      }

      if (result.statements.length === 0) {
        await logImport('error', 'No SQL statements generated', { warnings: result.warnings });
        return res.status(400).json({ error: 'No SQL statements generated', warnings: result.warnings });
      }

      // 4. Check name conflicts (views + functions) — skip when force re-importing
      const pgName = result.pgObjectName;
      if (!force) {
        if (result.pgObjectType === 'view') {
          const existsResult = await pool.query(
            `SELECT 1 FROM information_schema.views WHERE table_schema = $1 AND table_name = $2`,
            [schemaName, pgName]
          );
          if (existsResult.rows.length > 0) {
            await logImport('error', `View "${pgName}" already exists in target database`);
            return res.status(409).json({ error: `View "${pgName}" already exists in target database` });
          }
        }
        if (result.pgObjectType === 'function') {
          const existsResult = await pool.query(
            `SELECT 1 FROM information_schema.routines WHERE routine_schema = $1 AND routine_name = $2`,
            [schemaName, pgName]
          );
          if (existsResult.rows.length > 0) {
            await logImport('error', `Function "${pgName}" already exists in target database`);
            return res.status(409).json({ error: `Function "${pgName}" already exists in target database` });
          }
        }
      }

      // 5. Execute statements in a transaction
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const stmt of result.statements) {
          // Skip comment-only statements
          if (stmt.trim().startsWith('--')) {
            result.warnings.push('Skipped comment-only statement');
            continue;
          }
          await client.query(stmt);
        }
        await client.query('COMMIT');
      } catch (txErr) {
        await client.query('ROLLBACK');
        // Log the failing SQL for diagnosis
        console.error(`[QUERY ${queryName}] Failed SQL statements:`);
        for (const stmt of result.statements) {
          console.error(stmt.substring(0, 500));
        }
        if (queryData.sql) {
          console.error(`[QUERY ${queryName}] Original Access SQL: ${queryData.sql.substring(0, 300)}`);
        }
        throw txErr;
      } finally {
        client.release();
      }

      // 6. Clear schema cache
      clearSchemaCache(targetDatabaseId);

      // 7. Log success
      const queryLogId = await logImport('success', null, {
        pgObjectType: result.pgObjectType,
        originalType: queryData.queryType,
        warnings: result.warnings.length > 0 ? result.warnings : undefined,
        extractedFunctions: result.extractedFunctions.length > 0 ? result.extractedFunctions.map(f => f.name) : undefined
      });

      // 8. Create issues for conversion warnings
      if (queryLogId && result.warnings.length > 0) {
        try {
          for (const warning of result.warnings) {
            await pool.query(`
              INSERT INTO shared.import_issues
                (import_log_id, database_id, object_name, object_type, severity, category, message)
              VALUES ($1, $2, $3, 'query', 'warning', 'conversion-warning', $4)
            `, [queryLogId, targetDatabaseId, queryName, warning]);
          }
        } catch (issueErr) {
          console.error('Error creating import issues for query warnings:', issueErr);
        }
      }

      res.json({
        success: true,
        queryName: pgName,
        pgObjectType: result.pgObjectType,
        warnings: result.warnings,
        originalType: queryData.queryType
      });
    } catch (err) {
      console.error(`Error importing query "${queryName}":`, err);
      logError(pool, 'POST /api/access-import/import-query', 'Failed to import query', err, {
        details: { databasePath, queryName, targetDatabaseId }
      });
      await logImport('error', err.message);
      res.status(500).json({ error: err.message || 'Failed to import query' });
    }
  });

  /**
   * POST /api/access-import/tag-state-controls
   * Auto-tag controls that are referenced by converted queries.
   */
  router.post('/tag-state-controls', async (req, res) => {
    try {
      const { targetDatabaseId, referencedEntries } = req.body;
      if (!targetDatabaseId || !referencedEntries || !Array.isArray(referencedEntries) || referencedEntries.length === 0) {
        return res.json({ tagged: 0 });
      }

      // Look up which controls map to the referenced table.column pairs
      const conditions = referencedEntries.map((_, i) =>
        `(table_name = $${i * 2 + 2} AND column_name = $${i * 2 + 3})`
      );
      const params = [targetDatabaseId];
      for (const entry of referencedEntries) {
        params.push(entry.tableName, entry.columnName);
      }

      const mappingResult = await pool.query(
        `SELECT DISTINCT form_name, control_name
         FROM shared.control_column_map
         WHERE database_id = $1 AND (${conditions.join(' OR ')})`,
        params
      );

      if (mappingResult.rows.length === 0) {
        return res.json({ tagged: 0 });
      }

      // Group by form name
      const byForm = {};
      for (const row of mappingResult.rows) {
        if (!byForm[row.form_name]) byForm[row.form_name] = new Set();
        byForm[row.form_name].add(row.control_name);
      }

      let taggedCount = 0;
      for (const [formName, controlNames] of Object.entries(byForm)) {
        // Load current form definition
        const formResult = await pool.query(
          `SELECT definition FROM shared.forms
           WHERE database_id = $1 AND name = $2 AND is_current = true`,
          [targetDatabaseId, formName]
        );
        if (formResult.rows.length === 0) continue;

        let definition;
        try { definition = JSON.parse(formResult.rows[0].definition); }
        catch { continue; }

        let modified = false;
        // Scan all sections for matching controls
        for (const [key, section] of Object.entries(definition)) {
          if (!section || !Array.isArray(section.controls)) continue;
          for (const ctrl of section.controls) {
            const ctrlName = sanitizeName(ctrl.name || ctrl.id || '');
            if (controlNames.has(ctrlName) && ctrl.tag !== 'state') {
              ctrl.tag = 'state';
              modified = true;
              taggedCount++;
            }
          }
        }

        if (modified) {
          await pool.query(
            `UPDATE shared.forms SET definition = $1
             WHERE database_id = $2 AND name = $3 AND is_current = true`,
            [JSON.stringify(definition), targetDatabaseId, formName]
          );
        }
      }

      res.json({ tagged: taggedCount });
    } catch (err) {
      console.error('Error tagging state controls:', err);
      logError(pool, 'POST /api/access-import/tag-state-controls', 'Failed to tag state controls', err);
      res.status(500).json({ error: 'Failed to tag state controls' });
    }
  });

};
