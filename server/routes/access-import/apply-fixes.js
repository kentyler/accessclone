/**
 * Apply assessment fixes during import.
 * POST /apply-fixes — Attempt each fix individually, log results to shared.import_log.
 */

const { logError } = require('../../lib/events');

module.exports = function(router, pool) {

  router.post('/apply-fixes', async (req, res) => {
    try {
      const databaseId = req.headers['x-database-id'];
      if (!databaseId) {
        return res.status(400).json({ error: 'X-Database-ID header required' });
      }

      const { skipEmptyTables, relationships, installTablefunc, reservedWords } = req.body;
      const results = [];

      // 1. Log skipped empty tables
      if (skipEmptyTables && Array.isArray(skipEmptyTables)) {
        for (const tableName of skipEmptyTables) {
          try {
            await pool.query(`
              INSERT INTO shared.import_log
                (target_database_id, source_object_name, source_object_type, status, severity, category, message)
              VALUES ($1, $2, 'table', 'issue', 'info', 'empty-table-skipped', $3)
            `, [databaseId, tableName, `Empty table "${tableName}" skipped during import`]);
            results.push({ fix: 'skip-empty', object: tableName, status: 'ok' });
          } catch (err) {
            results.push({ fix: 'skip-empty', object: tableName, status: 'error', error: err.message });
          }
        }
      }

      // 2. Create foreign keys from Access relationships
      if (relationships && Array.isArray(relationships)) {
        for (const rel of relationships) {
          const { primaryTable, foreignTable, fields } = rel;
          if (!primaryTable || !foreignTable || !fields || !fields.length) continue;

          const fkName = `fk_${foreignTable}_${primaryTable}`.toLowerCase().replace(/[^a-z0-9_]/g, '_');
          const foreignCols = fields.map(f => `"${f.foreign}"`).join(', ');
          const primaryCols = fields.map(f => `"${f.primary}"`).join(', ');
          const schema = databaseId;

          try {
            await pool.query(`
              ALTER TABLE "${schema}"."${foreignTable}"
              ADD CONSTRAINT "${fkName}"
              FOREIGN KEY (${foreignCols})
              REFERENCES "${schema}"."${primaryTable}" (${primaryCols})
            `);
            await pool.query(`
              INSERT INTO shared.import_log
                (target_database_id, source_object_name, source_object_type, status, severity, category, message)
              VALUES ($1, $2, 'table', 'issue', 'info', 'fk-created', $3)
            `, [databaseId, foreignTable, `FK ${fkName}: ${foreignTable}(${fields.map(f => f.foreign).join(', ')}) → ${primaryTable}(${fields.map(f => f.primary).join(', ')})`]);
            results.push({ fix: 'fk', object: fkName, status: 'ok' });
          } catch (err) {
            await pool.query(`
              INSERT INTO shared.import_log
                (target_database_id, source_object_name, source_object_type, status, severity, category, message)
              VALUES ($1, $2, 'table', 'issue', 'warning', 'fk-failed', $3)
            `, [databaseId, foreignTable, `FK ${fkName} failed: ${err.message}`]).catch(() => {});
            results.push({ fix: 'fk', object: fkName, status: 'error', error: err.message });
          }
        }
      }

      // 3. Install tablefunc extension (for crosstab queries)
      if (installTablefunc) {
        try {
          await pool.query('CREATE EXTENSION IF NOT EXISTS tablefunc');
          await pool.query(`
            INSERT INTO shared.import_log
              (target_database_id, source_object_name, source_object_type, status, severity, category, message)
            VALUES ($1, 'tablefunc', 'extension', 'issue', 'info', 'extension-installed', 'tablefunc extension installed for crosstab support')
          `, [databaseId]);
          results.push({ fix: 'tablefunc', status: 'ok' });
        } catch (err) {
          await pool.query(`
            INSERT INTO shared.import_log
              (target_database_id, source_object_name, source_object_type, status, severity, category, message)
            VALUES ($1, 'tablefunc', 'extension', 'issue', 'error', 'extension-failed', $2)
          `, [databaseId, `tablefunc install failed: ${err.message}`]).catch(() => {});
          results.push({ fix: 'tablefunc', status: 'error', error: err.message });
        }
      }

      // 4. Log reserved words (informational — identifiers are already quoted)
      if (reservedWords && Array.isArray(reservedWords)) {
        for (const rw of reservedWords) {
          try {
            await pool.query(`
              INSERT INTO shared.import_log
                (target_database_id, source_object_name, source_object_type, status, severity, category, message)
              VALUES ($1, $2, $3, 'issue', 'info', 'reserved-word-quoted', $4)
            `, [databaseId, rw.object, rw.objectType || 'table',
                `"${rw.object}" is a PostgreSQL reserved word — identifiers are double-quoted automatically`]);
            results.push({ fix: 'reserved-word', object: rw.object, status: 'ok' });
          } catch (err) {
            results.push({ fix: 'reserved-word', object: rw.object, status: 'error', error: err.message });
          }
        }
      }

      res.json({ results });
    } catch (err) {
      console.error('Error applying fixes:', err);
      logError(pool, 'POST /api/access-import/apply-fixes', 'Failed to apply fixes', err);
      res.status(500).json({ error: 'Failed to apply fixes' });
    }
  });

};
