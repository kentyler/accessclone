/**
 * Access Import routes
 * Handles scanning for and importing Microsoft Access databases
 */

const express = require('express');
const router = express.Router();
const { logError } = require('../lib/events');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs').promises;
const { clearSchemaCache } = require('./data');

// Default scan locations
const DEFAULT_SCAN_LOCATIONS = [
  'C:\\Users\\Ken\\Desktop',
  'C:\\Users\\Ken\\Documents'
];

/**
 * Run a PowerShell script and return the output
 */
async function runPowerShell(scriptPath, args = []) {
  return new Promise((resolve, reject) => {
    const psArgs = [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath,
      ...args
    ];

    const ps = spawn('powershell.exe', psArgs);
    let stdout = '';
    let stderr = '';

    ps.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    ps.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    ps.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(stderr || `PowerShell exited with code ${code}`));
      }
    });

    ps.on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Recursively scan a directory for .accdb files
 */
async function scanDirectory(dirPath, results = []) {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);

      if (entry.isDirectory()) {
        // Skip system and hidden directories
        if (!entry.name.startsWith('.') &&
            !entry.name.startsWith('$') &&
            entry.name !== 'node_modules' &&
            entry.name !== 'AppData') {
          try {
            await scanDirectory(fullPath, results);
          } catch (err) {
            // Skip directories we can't access
          }
        }
      } else if (entry.name.toLowerCase().endsWith('.accdb') ||
                 entry.name.toLowerCase().endsWith('.mdb')) {
        try {
          const stats = await fs.stat(fullPath);
          results.push({
            path: fullPath,
            name: entry.name,
            size: stats.size,
            modified: stats.mtime
          });
        } catch (err) {
          // Skip files we can't stat
        }
      }
    }
  } catch (err) {
    // Skip directories we can't read
  }

  return results;
}

module.exports = function(pool) {

  /**
   * GET /api/access-import/scan
   * Scan for Access databases in default or specified locations
   */
  router.get('/scan', async (req, res) => {
    try {
      const locations = req.query.locations
        ? req.query.locations.split(',')
        : DEFAULT_SCAN_LOCATIONS;

      const allFiles = [];

      for (const location of locations) {
        const trimmed = location.trim();
        const lower = trimmed.toLowerCase();
        if (lower.endsWith('.accdb') || lower.endsWith('.mdb')) {
          // Direct file path — stat it instead of recursing
          console.log(`Checking Access file: ${trimmed}`);
          try {
            const stats = await fs.stat(trimmed);
            allFiles.push({
              path: trimmed,
              name: path.basename(trimmed),
              size: stats.size,
              modified: stats.mtime
            });
          } catch (err) {
            // File doesn't exist or can't be accessed — skip
          }
        } else {
          console.log(`Scanning ${trimmed} for Access databases...`);
          const files = await scanDirectory(trimmed);
          allFiles.push(...files);
        }
      }

      // Sort by modified date, newest first
      allFiles.sort((a, b) => new Date(b.modified) - new Date(a.modified));

      console.log(`Found ${allFiles.length} Access databases`);
      res.json({
        databases: allFiles,
        locations: locations
      });
    } catch (err) {
      console.error('Error scanning for Access databases:', err);
      logError(pool, 'GET /api/access-import/scan', 'Failed to scan for Access databases', err);
      res.status(500).json({ error: 'Failed to scan for databases' });
    }
  });

  /**
   * GET /api/access-import/database/:path
   * Get details about a specific Access database (tables, forms, reports)
   */
  router.get('/database', async (req, res) => {
    try {
      const dbPath = req.query.path;

      if (!dbPath) {
        return res.status(400).json({ error: 'Database path required' });
      }

      // Check file exists
      try {
        await fs.access(dbPath);
      } catch {
        return res.status(404).json({ error: 'Database file not found' });
      }

      const scriptsDir = path.join(__dirname, '..', '..', 'scripts', 'access');

      // Get forms
      let forms = [];
      try {
        const formsScript = path.join(scriptsDir, 'list_forms.ps1');
        const formsOutput = await runPowerShell(formsScript, ['-DatabasePath', dbPath]);
        forms = formsOutput ? JSON.parse(formsOutput) : [];
        if (!Array.isArray(forms)) forms = [forms]; // Handle single item
      } catch (err) {
        console.error('Error listing forms:', err.message);
      }

      // Get reports
      let reports = [];
      try {
        const reportsScript = path.join(scriptsDir, 'list_reports.ps1');
        const reportsOutput = await runPowerShell(reportsScript, ['-DatabasePath', dbPath]);
        reports = reportsOutput ? JSON.parse(reportsOutput) : [];
        if (!Array.isArray(reports)) reports = [reports]; // Handle single item
      } catch (err) {
        console.error('Error listing reports:', err.message);
      }

      // Get tables
      let tables = [];
      try {
        const tablesScript = path.join(scriptsDir, 'list_tables.ps1');
        const tablesOutput = await runPowerShell(tablesScript, ['-DatabasePath', dbPath]);
        tables = tablesOutput ? JSON.parse(tablesOutput) : [];
        if (!Array.isArray(tables)) tables = [tables]; // Handle single item
      } catch (err) {
        console.error('Error listing tables:', err.message);
      }

      // Get queries
      let queries = [];
      try {
        const queriesScript = path.join(scriptsDir, 'list_queries.ps1');
        const queriesOutput = await runPowerShell(queriesScript, ['-DatabasePath', dbPath]);
        queries = queriesOutput ? JSON.parse(queriesOutput) : [];
        if (!Array.isArray(queries)) queries = [queries]; // Handle single item
      } catch (err) {
        console.error('Error listing queries:', err.message);
      }

      // Get modules
      let modules = [];
      try {
        const modulesScript = path.join(scriptsDir, 'list_modules.ps1');
        const modulesOutput = await runPowerShell(modulesScript, ['-DatabasePath', dbPath]);
        modules = modulesOutput ? JSON.parse(modulesOutput) : [];
        if (!Array.isArray(modules)) modules = [modules]; // Handle single item
      } catch (err) {
        console.error('Error listing modules:', err.message);
      }

      res.json({
        path: dbPath,
        name: path.basename(dbPath),
        forms: forms,
        reports: reports,
        tables: tables,
        queries: queries,
        modules: modules
      });
    } catch (err) {
      console.error('Error getting database details:', err);
      logError(pool, 'GET /api/access-import/database', 'Failed to get database details', err, { details: { path: req.query.path } });
      res.status(500).json({ error: 'Failed to get database details' });
    }
  });

  /**
   * POST /api/access-import/export-form
   * Export a form from Access as JSON (raw metadata)
   * The frontend converts JSON -> form definition and saves via /api/forms
   */
  router.post('/export-form', async (req, res) => {
    const { databasePath, formName, targetDatabaseId } = req.body;

    // Helper to log import attempt
    async function logImport(status, errorMessage = null, details = null) {
      try {
        await pool.query(`
          INSERT INTO shared.import_log
            (source_path, source_object_name, source_object_type, target_database_id, status, error_message, details)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [databasePath, formName, 'form', targetDatabaseId || '_none', status, errorMessage, details ? JSON.stringify(details) : null]);
      } catch (logErr) {
        console.error('Error writing to import_log:', logErr);
      }
    }

    try {
      if (!databasePath || !formName) {
        await logImport('error', 'databasePath and formName required');
        return res.status(400).json({ error: 'databasePath and formName required' });
      }

      const scriptsDir = path.join(__dirname, '..', '..', 'scripts', 'access');
      const exportScript = path.join(scriptsDir, 'export_form.ps1');

      // Run PowerShell - it outputs JSON to stdout
      const jsonOutput = await runPowerShell(exportScript, [
        '-DatabasePath', databasePath,
        '-FormName', formName
      ]);

      // Remove BOM if present, then extract JSON object from output
      // (Write-Host output from PowerShell may precede the JSON)
      const cleanOutput = jsonOutput.replace(/^\uFEFF/, '').trim();
      const jsonStart = cleanOutput.indexOf('{');
      if (jsonStart === -1) {
        throw new Error('No JSON object found in PowerShell output');
      }
      const formData = JSON.parse(cleanOutput.substring(jsonStart));

      // Log success
      await logImport('success', null, { controls: formData.controls ? formData.controls.length : 0 });

      // Return raw JSON to frontend for conversion
      res.json({
        success: true,
        formData: formData
      });
    } catch (err) {
      console.error('Error exporting form:', err);
      logError(pool, 'POST /api/access-import/export-form', 'Failed to export form', err, { details: { databasePath, formName, targetDatabaseId } });
      await logImport('error', err.message);
      res.status(500).json({ error: err.message || 'Failed to export form' });
    }
  });

  /**
   * POST /api/access-import/export-report
   * Export a report from Access as JSON (raw metadata)
   * The frontend converts JSON -> report definition and saves via /api/reports
   */
  router.post('/export-report', async (req, res) => {
    const { databasePath, reportName, targetDatabaseId } = req.body;

    // Helper to log import attempt
    async function logImport(status, errorMessage = null, details = null) {
      try {
        await pool.query(`
          INSERT INTO shared.import_log
            (source_path, source_object_name, source_object_type, target_database_id, status, error_message, details)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [databasePath, reportName, 'report', targetDatabaseId || '_none', status, errorMessage, details ? JSON.stringify(details) : null]);
      } catch (logErr) {
        console.error('Error writing to import_log:', logErr);
      }
    }

    try {
      if (!databasePath || !reportName) {
        await logImport('error', 'databasePath and reportName required');
        return res.status(400).json({ error: 'databasePath and reportName required' });
      }

      const scriptsDir = path.join(__dirname, '..', '..', 'scripts', 'access');
      const exportScript = path.join(scriptsDir, 'export_report.ps1');

      // Run PowerShell - it outputs JSON to stdout
      const jsonOutput = await runPowerShell(exportScript, [
        '-DatabasePath', databasePath,
        '-ReportName', reportName
      ]);

      // Remove BOM if present, then extract JSON object from output
      // (Write-Host output from PowerShell may precede the JSON)
      const cleanOutput = jsonOutput.replace(/^\uFEFF/, '').trim();
      const jsonStart = cleanOutput.indexOf('{');
      if (jsonStart === -1) {
        throw new Error('No JSON object found in PowerShell output');
      }
      const reportData = JSON.parse(cleanOutput.substring(jsonStart));

      // Log success
      const sectionCount = reportData.sections ? reportData.sections.length : 0;
      await logImport('success', null, { sections: sectionCount });

      // Return raw JSON to frontend for conversion
      res.json({
        success: true,
        reportData: reportData
      });
    } catch (err) {
      console.error('Error exporting report:', err);
      logError(pool, 'POST /api/access-import/export-report', 'Failed to export report', err, { details: { databasePath, reportName, targetDatabaseId } });
      await logImport('error', err.message);
      res.status(500).json({ error: err.message || 'Failed to export report' });
    }
  });

  /**
   * POST /api/access-import/export-module
   * Export a VBA module from Access (raw source code)
   * The frontend saves the source via /api/modules
   */
  router.post('/export-module', async (req, res) => {
    const { databasePath, moduleName, targetDatabaseId } = req.body;

    // Helper to log import attempt
    async function logImport(status, errorMessage = null, details = null) {
      try {
        await pool.query(`
          INSERT INTO shared.import_log
            (source_path, source_object_name, source_object_type, target_database_id, status, error_message, details)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [databasePath, moduleName, 'module', targetDatabaseId || '_none', status, errorMessage, details ? JSON.stringify(details) : null]);
      } catch (logErr) {
        console.error('Error writing to import_log:', logErr);
      }
    }

    try {
      if (!databasePath || !moduleName) {
        await logImport('error', 'databasePath and moduleName required');
        return res.status(400).json({ error: 'databasePath and moduleName required' });
      }

      const scriptsDir = path.join(__dirname, '..', '..', 'scripts', 'access');
      const exportScript = path.join(scriptsDir, 'export_module.ps1');

      // Run PowerShell - it outputs JSON to stdout
      const jsonOutput = await runPowerShell(exportScript, [
        '-DatabasePath', databasePath,
        '-ModuleName', moduleName
      ]);

      // Remove BOM if present, then extract JSON object from output
      const cleanOutput = jsonOutput.replace(/^\uFEFF/, '').trim();
      const jsonStart = cleanOutput.indexOf('{');
      if (jsonStart === -1) {
        throw new Error('No JSON object found in PowerShell output');
      }
      const moduleData = JSON.parse(cleanOutput.substring(jsonStart));

      // Log success
      await logImport('success', null, { lineCount: moduleData.lineCount || 0 });

      // Return raw JSON to frontend
      res.json({
        success: true,
        moduleData: moduleData
      });
    } catch (err) {
      console.error('Error exporting module:', err);
      logError(pool, 'POST /api/access-import/export-module', 'Failed to export module', err, { details: { databasePath, moduleName, targetDatabaseId } });
      await logImport('error', err.message);
      res.status(500).json({ error: err.message || 'Failed to export module' });
    }
  });

  /**
   * POST /api/access-import/import-table
   * Import a table from Access: extract structure + data via PowerShell,
   * create PostgreSQL table, insert rows, create indexes — all server-side.
   */
  router.post('/import-table', async (req, res) => {
    const { databasePath, tableName, targetDatabaseId } = req.body;

    async function logImport(status, errorMessage = null, details = null) {
      try {
        await pool.query(`
          INSERT INTO shared.import_log
            (source_path, source_object_name, source_object_type, target_database_id, status, error_message, details)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [databasePath, tableName, 'table', targetDatabaseId || '_none', status, errorMessage, details ? JSON.stringify(details) : null]);
      } catch (logErr) {
        console.error('Error writing to import_log:', logErr);
      }
    }

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
      const scriptsDir = path.join(__dirname, '..', '..', 'scripts', 'access');
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
      const tableData = JSON.parse(cleanOutput.substring(jsonStart));

      const fields = tableData.fields || [];
      const indexes = tableData.indexes || [];
      const rows = tableData.rows || [];

      if (fields.length === 0) {
        await logImport('error', 'No importable fields found in table');
        return res.status(400).json({ error: 'No importable fields found in table' });
      }

      // 3. Map Access type codes to resolveType-compatible format
      function mapAccessType(field) {
        const code = field.type;
        const isAutoNum = field.isAutoNumber;
        switch (code) {
          case 1:  return { type: 'Yes/No' };
          case 2:  return { type: 'Number', fieldSize: 'Byte' };
          case 3:  return { type: 'Number', fieldSize: 'Integer' };
          case 4:  return isAutoNum
                     ? { type: 'AutoNumber' }
                     : { type: 'Number', fieldSize: 'Long Integer' };
          case 5:  return { type: 'Currency' };
          case 6:  return { type: 'Number', fieldSize: 'Single' };
          case 7:  return { type: 'Number', fieldSize: 'Double' };
          case 8:  return { type: 'Date/Time' };
          case 10: return { type: 'Short Text', maxLength: field.size || 255 };
          case 12: return { type: 'Long Text' };
          case 15: return { type: 'Short Text', maxLength: 38 };
          case 16: return { type: 'Number', fieldSize: 'Long Integer' };
          default: return { type: 'Short Text', maxLength: 255 };
        }
      }

      function resolveType(f) {
        const t = (f.type || '').trim();
        switch (t) {
          case 'Short Text':
            return `character varying(${f.maxLength || 255})`;
          case 'Long Text':
            return 'text';
          case 'Number': {
            const fs = (f.fieldSize || 'Long Integer').trim();
            switch (fs) {
              case 'Byte':         return 'smallint';
              case 'Integer':      return 'smallint';
              case 'Long Integer': return 'integer';
              case 'Single':       return 'real';
              case 'Double':       return 'double precision';
              case 'Decimal':      return `numeric(${f.precision || 18},${f.scale || 0})`;
              default:             return 'integer';
            }
          }
          case 'Yes/No':
            return 'boolean';
          case 'Date/Time':
            return 'timestamp without time zone';
          case 'Currency':
            return 'numeric(19,4)';
          case 'AutoNumber':
            return 'integer';
          default:
            return t || 'text';
        }
      }

      function quoteIdent(name) {
        return '"' + name.replace(/"/g, '""') + '"';
      }

      // Sanitize name: lowercase, spaces → underscores, strip non-alphanumeric
      function sanitizeName(name) {
        return name.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
      }

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
          defaultValue: f.defaultValue
        };
      });

      // Find primary key fields from indexes
      const pkIndex = indexes.find(idx => idx.primary);
      const pkFieldNames = pkIndex ? pkIndex.fields.map(f => sanitizeName(f)) : [];

      // 4. Check table doesn't already exist
      const existsResult = await pool.query(
        `SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2`,
        [schemaName, pgTableName]
      );
      if (existsResult.rows.length > 0) {
        await logImport('error', `Table "${pgTableName}" already exists in target database`);
        return res.status(409).json({ error: `Table "${pgTableName}" already exists in target database` });
      }

      // 5. BEGIN transaction
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // 6. CREATE TABLE
        const colDefs = columnInfo.map(col => {
          let def = `${quoteIdent(col.pgName)} `;
          if (col.isAutoNumber) {
            def += 'integer GENERATED BY DEFAULT AS IDENTITY';
          } else {
            def += col.pgType;
          }
          if (col.required && !col.isAutoNumber) {
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
        const hasIdentity = columnInfo.some(c => c.isAutoNumber);
        const BATCH_SIZE = 500;

        for (let i = 0; i < rows.length; i += BATCH_SIZE) {
          const batch = rows.slice(i, i + BATCH_SIZE);
          if (batch.length === 0) continue;

          const valueClauses = [];
          const params = [];
          let paramIdx = 1;

          for (const row of batch) {
            const placeholders = [];
            for (const col of columnInfo) {
              const val = row[col.originalName];
              placeholders.push(`$${paramIdx++}`);
              params.push(val === undefined ? null : val);
            }
            valueClauses.push(`(${placeholders.join(', ')})`);
          }

          const colNames = columnInfo.map(c => quoteIdent(c.pgName)).join(', ');
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
          const idxName = sanitizeName(idx.name);
          const uniqueStr = idx.unique ? 'UNIQUE ' : '';
          const createIdxSQL = `CREATE ${uniqueStr}INDEX ${quoteIdent(idxName)} ON ${quoteIdent(schemaName)}.${quoteIdent(pgTableName)} (${idxColNames})`;
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
      await logImport('success', null, {
        fieldCount: fields.length,
        rowCount: rows.length,
        skippedColumns: skippedNames.length > 0 ? skippedNames : undefined
      });

      res.json({
        success: true,
        tableName: pgTableName,
        fieldCount: fields.length,
        rowCount: rows.length,
        skippedColumns: skippedNames
      });
    } catch (err) {
      console.error('Error importing table:', err);
      logError(pool, 'POST /api/access-import/import-table', 'Failed to import table', err, {
        details: { databasePath, tableName, targetDatabaseId }
      });
      await logImport('error', err.message);
      res.status(500).json({ error: err.message || 'Failed to import table' });
    }
  });

  /**
   * GET /api/access-import/history
   * Get import history, optionally filtered by source path
   */
  router.get('/history', async (req, res) => {
    try {
      const { source_path, limit = 100 } = req.query;

      let query, params;
      if (source_path) {
        query = `
          SELECT id, created_at, source_path, source_object_name, source_object_type,
                 target_database_id, status, error_message
          FROM shared.import_log
          WHERE source_path = $1
          ORDER BY created_at DESC
          LIMIT $2
        `;
        params = [source_path, parseInt(limit)];
      } else {
        query = `
          SELECT id, created_at, source_path, source_object_name, source_object_type,
                 target_database_id, status, error_message
          FROM shared.import_log
          ORDER BY created_at DESC
          LIMIT $1
        `;
        params = [parseInt(limit)];
      }

      const result = await pool.query(query, params);
      res.json({ history: result.rows });
    } catch (err) {
      console.error('Error fetching import history:', err);
      logError(pool, 'GET /api/access-import/history', 'Failed to fetch import history', err);
      res.status(500).json({ error: 'Failed to fetch import history' });
    }
  });

  return router;
};
