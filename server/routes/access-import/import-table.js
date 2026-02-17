/**
 * Table import route.
 * POST /import-table — Extract structure + data from Access, create PG table.
 */

const path = require('path');
const { logError } = require('../../lib/events');
const { clearSchemaCache } = require('../data');
const { convertAccessExpression, sanitizeName } = require('../../lib/query-converter');
const { resolveType, mapAccessType, quoteIdent } = require('../../lib/access-types');
const { makeLogImport, runPowerShell } = require('./helpers');

module.exports = function(router, pool) {

  router.post('/import-table', async (req, res) => {
    const { databasePath, tableName, targetDatabaseId, force } = req.body;

    const logImport = makeLogImport(pool, databasePath, tableName, 'table', targetDatabaseId);

    try {
      if (!databasePath || !tableName || !targetDatabaseId) {
        await logImport('error', 'databasePath, tableName, and targetDatabaseId required');
        return res.status(400).json({ error: 'databasePath, tableName, and targetDatabaseId required' });
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

      // 2. Run export_table.ps1
      const scriptsDir = path.join(__dirname, '..', '..', '..', 'scripts', 'access');
      const exportScript = path.join(scriptsDir, 'export_table.ps1');
      const jsonOutput = await runPowerShell(exportScript, [
        '-DatabasePath', databasePath,
        '-TableName', tableName
      ]);

      const cleanOutput = jsonOutput.replace(/^\uFEFF/, '').trim();
      const jsonStart = cleanOutput.indexOf('{');
      if (jsonStart === -1) {
        throw new Error('No JSON object found in PowerShell output');
      }
      let tableData;
      try {
        tableData = JSON.parse(cleanOutput.substring(jsonStart));
      } catch (jsonErr) {
        const snippet = cleanOutput.substring(jsonStart).substring(Math.max(0, jsonErr.message.match(/position (\d+)/)?.[1] - 50 || 0), (jsonErr.message.match(/position (\d+)/)?.[1] || 0) + 50);
        throw new Error(`Invalid JSON from export_table.ps1: ${jsonErr.message}. Near: ${snippet}`);
      }

      const fields = tableData.fields || [];
      const indexes = tableData.indexes || [];
      const rows = tableData.rows || [];

      if (fields.length === 0) {
        await logImport('error', 'No importable fields found in table');
        return res.status(400).json({ error: 'No importable fields found in table' });
      }

      // mapAccessType is imported from ../../lib/access-types

      const pgTableName = sanitizeName(tableName);

      // Build column info array
      const columnInfo = fields.map(f => {
        const mapped = mapAccessType(f);
        const pgType = resolveType(mapped);
        return {
          originalName: f.name,
          pgName: sanitizeName(f.name),
          pgType,
          required: f.required,
          isAutoNumber: f.isAutoNumber,
          defaultValue: f.defaultValue,
          isCalculated: !!f.isCalculated,
          expression: f.expression || null
        };
      });

      // Find primary key fields from indexes
      const pkIndex = indexes.find(idx => idx.primary);
      const pkFieldNames = pkIndex ? pkIndex.fields.map(f => sanitizeName(f)) : [];

      // 4. Check table doesn't already exist (unless force re-import)
      const existsResult = await pool.query(
        `SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2`,
        [schemaName, pgTableName]
      );
      if (existsResult.rows.length > 0) {
        if (!force) {
          await logImport('error', `Table "${pgTableName}" already exists in target database`);
          return res.status(409).json({ error: `Table "${pgTableName}" already exists in target database` });
        }
      }

      // 5. BEGIN transaction
      const client = await pool.connect();
      const calculatedWarnings = [];
      try {
        await client.query('BEGIN');

        // Drop existing table if force re-import
        if (force && existsResult.rows.length > 0) {
          await client.query(`DROP TABLE IF EXISTS ${schemaName}.${quoteIdent(pgTableName)} CASCADE`);
        }

        // 6. CREATE TABLE
        const colDefs = columnInfo.map(col => {
          let def = `${quoteIdent(col.pgName)} `;
          if (col.isCalculated && col.expression) {
            try {
              const pgExpr = convertAccessExpression(col.expression);
              def += `${col.pgType} GENERATED ALWAYS AS (${pgExpr}) STORED`;
            } catch (exprErr) {
              calculatedWarnings.push(`Column "${col.originalName}": expression conversion failed (${exprErr.message}), created as nullable ${col.pgType} instead`);
              def += col.pgType;
            }
          } else if (col.isCalculated && !col.expression) {
            calculatedWarnings.push(`Column "${col.originalName}": no expression extracted from Access, created as nullable ${col.pgType} instead`);
            def += col.pgType;
          } else if (col.isAutoNumber) {
            def += 'integer GENERATED BY DEFAULT AS IDENTITY';
          } else {
            def += col.pgType;
          }
          if (col.required && !col.isAutoNumber && !col.isCalculated) {
            def += ' NOT NULL';
          }
          return def;
        });

        if (pkFieldNames.length > 0) {
          colDefs.push(`PRIMARY KEY (${pkFieldNames.map(n => quoteIdent(n)).join(', ')})`);
        }

        const createSQL = `CREATE TABLE ${quoteIdent(schemaName)}.${quoteIdent(pgTableName)} (\n  ${colDefs.join(',\n  ')}\n)`;
        await client.query(createSQL);

        // 7. Batch INSERT rows (500 per statement)
        const insertableColumns = columnInfo.filter(c => !c.isCalculated);
        const hasIdentity = insertableColumns.some(c => c.isAutoNumber);
        const BATCH_SIZE = 500;

        for (let i = 0; i < rows.length; i += BATCH_SIZE) {
          const batch = rows.slice(i, i + BATCH_SIZE);
          if (batch.length === 0) continue;

          const valueClauses = [];
          const params = [];
          let paramIdx = 1;

          for (const row of batch) {
            const placeholders = [];
            for (const col of insertableColumns) {
              const val = row[col.originalName];
              placeholders.push(`$${paramIdx++}`);
              params.push(val === undefined ? null : val);
            }
            valueClauses.push(`(${placeholders.join(', ')})`);
          }

          const colNames = insertableColumns.map(c => quoteIdent(c.pgName)).join(', ');
          const overriding = hasIdentity ? ' OVERRIDING SYSTEM VALUE' : '';
          const insertSQL = `INSERT INTO ${quoteIdent(schemaName)}.${quoteIdent(pgTableName)} (${colNames})${overriding}\nVALUES ${valueClauses.join(',\n')}`;
          await client.query(insertSQL, params);
        }

        // 8. Reset identity sequences
        for (const col of columnInfo) {
          if (col.isAutoNumber) {
            const seqResult = await client.query(
              `SELECT pg_get_serial_sequence($1, $2) AS seq`,
              [`${schemaName}.${pgTableName}`, col.pgName]
            );
            const seqName = seqResult.rows[0]?.seq;
            if (seqName && rows.length > 0) {
              await client.query(
                `SELECT setval($1, (SELECT COALESCE(MAX(${quoteIdent(col.pgName)}), 0) FROM ${quoteIdent(schemaName)}.${quoteIdent(pgTableName)}))`,
                [seqName]
              );
            }
          }
        }

        // 9. Create non-PK indexes
        for (const idx of indexes) {
          if (idx.primary) continue;
          const idxColNames = idx.fields.map(f => quoteIdent(sanitizeName(f))).join(', ');
          const idxName = `${pgTableName}_${sanitizeName(idx.name)}`;
          const uniqueStr = idx.unique ? 'UNIQUE ' : '';
          const createIdxSQL = `CREATE ${uniqueStr}INDEX IF NOT EXISTS ${quoteIdent(idxName)} ON ${quoteIdent(schemaName)}.${quoteIdent(pgTableName)} (${idxColNames})`;
          await client.query(createIdxSQL);
        }

        // 10. COMMIT
        await client.query('COMMIT');
      } catch (txErr) {
        await client.query('ROLLBACK');
        throw txErr;
      } finally {
        client.release();
      }

      // 11. Clear schema cache
      clearSchemaCache(targetDatabaseId);

      // 12. Log success
      const skippedNames = (tableData.skippedColumns || []).map(c => c.name);
      const calculatedCols = columnInfo.filter(c => c.isCalculated);
      const logId = await logImport('success', null, {
        fieldCount: fields.length,
        rowCount: rows.length,
        skippedColumns: skippedNames.length > 0 ? skippedNames : undefined,
        calculatedColumns: calculatedCols.length > 0 ? calculatedCols.map(c => c.originalName) : undefined,
        calculatedWarnings: calculatedWarnings.length > 0 ? calculatedWarnings : undefined
      });

      // 13. Create issues for skipped columns
      if (logId && skippedNames.length > 0) {
        try {
          for (const sc of tableData.skippedColumns) {
            await pool.query(`
              INSERT INTO shared.import_issues
                (import_log_id, database_id, object_name, object_type, severity, category, message)
              VALUES ($1, $2, $3, 'table', 'warning', 'skipped-column', $4)
            `, [logId, targetDatabaseId, tableName, `Column '${sc.name}' skipped (Access type: ${sc.type}) — not importable`]);
          }
        } catch (issueErr) {
          console.error('Error creating import issues for skipped columns:', issueErr);
        }
      }

      // 14. Create issues for calculated column warnings
      if (logId && calculatedWarnings.length > 0) {
        try {
          for (const warning of calculatedWarnings) {
            await pool.query(`
              INSERT INTO shared.import_issues
                (import_log_id, database_id, object_name, object_type, severity, category, message)
              VALUES ($1, $2, $3, 'table', 'warning', 'calculated-column', $4)
            `, [logId, targetDatabaseId, tableName, warning]);
          }
        } catch (issueErr) {
          console.error('Error creating import issues for calculated columns:', issueErr);
        }
      }

      res.json({
        success: true,
        tableName: pgTableName,
        fieldCount: fields.length,
        rowCount: rows.length,
        skippedColumns: skippedNames,
        calculatedColumns: calculatedCols.map(c => c.originalName),
        calculatedWarnings
      });
    } catch (err) {
      console.error(`Error importing table "${tableName}":`, err);
      logError(pool, 'POST /api/access-import/import-table', 'Failed to import table', err, {
        details: { databasePath, tableName, targetDatabaseId }
      });
      await logImport('error', err.message);
      res.status(500).json({ error: err.message || 'Failed to import table' });
    }
  });

};
