/**
 * Query import and state-control tagging routes.
 * POST /import-query — Convert Access query to PG view/function
 * POST /tag-state-controls — Auto-tag controls referenced by converted queries
 */

const path = require('path');
const { logError } = require('../../lib/events');
const { clearSchemaCache } = require('../data');
const { convertAccessQuery, sanitizeName } = require('../../lib/query-converter');
const { createStubFunctions } = require('../../lib/vba-stub-generator');
const { convertQueryWithLLM } = require('../../lib/query-converter/llm-fallback');
const { makeLogImport, runPowerShell } = require('./helpers');

module.exports = function(router, pool, secrets) {

  /**
   * POST /api/access-import/import-query
   */
  router.post('/import-query', async (req, res) => {
    const { databasePath, queryName, targetDatabaseId } = req.body;

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

      const pgName = result.pgObjectName;

      // 4. Ensure VBA stub functions exist before executing (idempotent, skips existing)
      await createStubFunctions(pool, schemaName, targetDatabaseId);

      // 5. Execute statements in a transaction (with LLM fallback on failure)
      let finalStatements = result.statements;
      let llmAssisted = false;

      async function executeStatements(client, statements) {
        await client.query('BEGIN');
        try {
          for (const stmt of statements) {
            if (stmt.trim().startsWith('--')) {
              result.warnings.push('Skipped comment-only statement');
              continue;
            }
            try {
              await client.query(stmt);
            } catch (stmtErr) {
              // CREATE OR REPLACE VIEW fails if column list changed (42P01 handled elsewhere).
              // Detect this and retry with DROP + CREATE.
              const isColumnChange = stmtErr.code === '42601' || // syntax
                (stmtErr.message && /cannot.*(?:change|drop|rename).*(?:column|view)/i.test(stmtErr.message));
              if (isColumnChange && /CREATE\s+OR\s+REPLACE\s+VIEW/i.test(stmt)) {
                const viewMatch = stmt.match(/VIEW\s+(\S+)\s+AS/i);
                if (viewMatch) {
                  await client.query(`DROP VIEW IF EXISTS ${viewMatch[1]} CASCADE`);
                  await client.query(stmt);
                  result.warnings.push(`Dropped and recreated view (column list changed)`);
                  continue;
                }
              }
              throw stmtErr;
            }
          }
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          throw err;
        }
      }

      const client = await pool.connect();
      try {
        // Attempt 1: regex-converted SQL
        try {
          await executeStatements(client, finalStatements);
        } catch (regexErr) {
          await client.query('ROLLBACK');

          // Missing dependency — skip LLM, let retry loop handle it
          const isDependencyError = regexErr.code === '42P01' || regexErr.code === '42883';
          if (isDependencyError) {
            console.log(`[QUERY ${queryName}] Missing dependency, will retry: ${regexErr.message}`);
            throw regexErr;
          }

          console.error(`[QUERY ${queryName}] Regex converter failed: ${regexErr.message}`);

          // Attempt 2: LLM fallback
          const apiKey = secrets?.anthropic?.api_key || process.env.ANTHROPIC_API_KEY;
          if (apiKey && queryData.sql) {
            console.log(`[QUERY ${queryName}] Trying LLM fallback...`);
            try {
              const llmResult = await convertQueryWithLLM({
                apiKey, pool, schemaName,
                databaseId: targetDatabaseId,
                originalAccessSQL: queryData.sql,
                failedPgSQL: result.statements.join(';\n'),
                pgError: regexErr.message,
                controlMapping
              });
              if (llmResult.statements.length > 0) {
                finalStatements = llmResult.statements;
                llmAssisted = true;
                result.warnings.push(...llmResult.warnings);
                // Detect if LLM changed the object type
                if (llmResult.pgObjectType) {
                  result.pgObjectType = llmResult.pgObjectType;
                }
                await executeStatements(client, finalStatements);
                console.log(`[QUERY ${queryName}] LLM fallback succeeded`);
              } else {
                throw regexErr;
              }
            } catch (llmErr) {
              if (llmErr === regexErr) throw regexErr;
              // LLM also failed — log both errors
              await client.query('ROLLBACK').catch(() => {});
              console.error(`[QUERY ${queryName}] LLM fallback also failed: ${llmErr.message}`);
              console.error(`[QUERY ${queryName}] Original regex error: ${regexErr.message}`);
              // Preserve PG error code so dependency errors are retryable
              const isDep = llmErr.code === '42P01' || llmErr.code === '42883';
              if (isDep) {
                throw llmErr;
              }
              const combinedErr = new Error(
                `Regex conversion failed: ${regexErr.message}\nLLM fallback also failed: ${llmErr.message}`
              );
              throw combinedErr;
            }
          } else {
            // No API key or no original SQL — can't fall back
            console.error(`[QUERY ${queryName}] Failed SQL statements:`);
            for (const stmt of result.statements) {
              console.error(stmt);
            }
            if (queryData.sql) {
              console.error(`[QUERY ${queryName}] Original Access SQL: ${queryData.sql}`);
            }
            throw regexErr;
          }
        }
      } finally {
        client.release();
      }

      // 6. Populate view_metadata (base table, PK, writable columns) for updatable query support
      if (result.pgObjectType === 'view') {
        try {
          // Find the base table (most columns) and its PK
          const baseResult = await pool.query(`
            WITH view_base AS (
              SELECT table_name,
                     ROW_NUMBER() OVER (ORDER BY COUNT(*) DESC) AS rn
              FROM information_schema.view_column_usage
              WHERE view_schema = $1 AND view_name = $2
                AND table_schema = $1 AND table_name != $2
              GROUP BY table_name
            )
            SELECT vb.table_name AS base_table, kcu.column_name AS pk_column
            FROM view_base vb
            LEFT JOIN information_schema.table_constraints tc
              ON tc.table_name = vb.table_name AND tc.table_schema = $1
              AND tc.constraint_type = 'PRIMARY KEY'
            LEFT JOIN information_schema.key_column_usage kcu
              ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = $1
            WHERE vb.rn = 1
            LIMIT 1
          `, [schemaName, pgName]);

          if (baseResult.rows.length > 0) {
            const { base_table, pk_column } = baseResult.rows[0];

            // Find which view columns come from the base table (these are writable)
            const writableCols = await pool.query(`
              SELECT DISTINCT column_name
              FROM information_schema.view_column_usage
              WHERE view_schema = $1 AND view_name = $2
                AND table_schema = $1 AND table_name = $3
            `, [schemaName, pgName, base_table]);
            const writableColumns = writableCols.rows.map(r => r.column_name);

            await pool.query(`
              INSERT INTO shared.view_metadata (database_id, view_name, base_table, pk_column, writable_columns)
              VALUES ($1, $2, $3, $4, $5)
              ON CONFLICT (database_id, view_name)
              DO UPDATE SET base_table = $3, pk_column = $4, writable_columns = $5
            `, [targetDatabaseId, pgName, base_table, pk_column, writableColumns]);
          }
        } catch (vmErr) {
          console.warn(`[QUERY ${queryName}] Could not populate view_metadata:`, vmErr.message);
        }
      }

      // 7. Clear schema cache
      clearSchemaCache(targetDatabaseId);

      // 8. Log success
      const queryLogId = await logImport('success', null, {
        pgObjectType: result.pgObjectType,
        originalType: queryData.queryType,
        llmAssisted: llmAssisted || undefined,
        warnings: result.warnings.length > 0 ? result.warnings : undefined,
        extractedFunctions: result.extractedFunctions.length > 0 ? result.extractedFunctions.map(f => f.name) : undefined
      });

      // 9. Log issues for conversion warnings
      if (result.warnings.length > 0) {
        try {
          for (const warning of result.warnings) {
            const category = warning.includes('LLM-assisted') ? 'llm-assisted' : 'conversion-warning';
            await pool.query(`
              INSERT INTO shared.import_log
                (target_database_id, source_object_name, source_object_type, status, severity, category, message)
              VALUES ($1, $2, 'query', 'issue', 'warning', $3, $4)
            `, [targetDatabaseId, queryName, category, warning]);
          }
        } catch (issueErr) {
          console.error('Error logging query warnings:', issueErr);
        }
      }

      res.json({
        success: true,
        queryName: pgName,
        pgObjectType: result.pgObjectType,
        warnings: result.warnings,
        originalType: queryData.queryType,
        llmAssisted
      });
    } catch (err) {
      const isDep = err.code === '42P01' || err.code === '42883';
      if (isDep) {
        // Dependency errors are expected during multi-pass import — log quietly
        console.log(`[QUERY ${queryName}] Deferred (missing dependency): ${err.message}`);
      } else {
        console.error(`Error importing query "${queryName}":`, err);
        logError(pool, 'POST /api/access-import/import-query', 'Failed to import query', err, {
          details: { databasePath, queryName, targetDatabaseId }
        });
      }
      await logImport('error', err.message);
      res.status(500).json({
        error: err.message || 'Failed to import query',
        category: isDep ? 'missing-dependency' : 'conversion-error'
      });
    }
  });

  /**
   * POST /api/access-import/tag-state-controls
   * Auto-tag controls that are referenced by converted queries.
   */
  /**
   * POST /api/access-import/create-function-stubs
   * Parse VBA modules for function declarations and create PG stub functions
   * so that views referencing user-defined functions can be created.
   */
  router.post('/create-function-stubs', async (req, res) => {
    try {
      const { targetDatabaseId } = req.body;
      if (!targetDatabaseId) {
        return res.status(400).json({ error: 'targetDatabaseId is required' });
      }

      // Look up target schema
      const dbResult = await pool.query(
        'SELECT schema_name FROM shared.databases WHERE database_id = $1',
        [targetDatabaseId]
      );
      if (dbResult.rows.length === 0) {
        return res.status(404).json({ error: 'Target database not found' });
      }
      const schemaName = dbResult.rows[0].schema_name;

      const result = await createStubFunctions(pool, schemaName, targetDatabaseId);

      console.log(`[STUBS] Created ${result.created.length}, skipped ${result.skipped.length}, warnings: ${result.warnings.length}`);

      res.json({
        success: true,
        created: result.created,
        skipped: result.skipped,
        warnings: result.warnings
      });
    } catch (err) {
      console.error('Error creating function stubs:', err);
      logError(pool, 'POST /api/access-import/create-function-stubs', 'Failed to create function stubs', err);
      res.status(500).json({ error: err.message || 'Failed to create function stubs' });
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
           WHERE database_id = $1 AND name = $2 AND is_current = true AND owner = 'standard'`,
          [targetDatabaseId, formName]
        );
        if (formResult.rows.length === 0) continue;

        const definition = formResult.rows[0].definition;
        if (!definition || typeof definition !== 'object') continue;

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
             WHERE database_id = $2 AND name = $3 AND is_current = true AND owner = 'standard'`,
            [definition, targetDatabaseId, formName]
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
