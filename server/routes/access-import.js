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
const { convertAccessQuery, convertAccessExpression, sanitizeName } = require('../lib/query-converter');
const { resolveType, quoteIdent } = require('../lib/access-types');

/**
 * Create an import logger closure for a specific import operation.
 */
function makeLogImport(pool, sourcePath, objectName, objectType, targetDatabaseId) {
  return async function logImport(status, errorMessage = null, details = null) {
    try {
      const result = await pool.query(`
        INSERT INTO shared.import_log
          (source_path, source_object_name, source_object_type, target_database_id, status, error_message, details)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id
      `, [sourcePath, objectName, objectType, targetDatabaseId || '_none', status, errorMessage, details ? JSON.stringify(details) : null]);
      return result.rows[0]?.id || null;
    } catch (logErr) {
      console.error('Error writing to import_log:', logErr);
      return null;
    }
  };
}

// Default scan locations — use the current user's Desktop and Documents
const userProfile = process.env.USERPROFILE || process.env.HOME || '';
const DEFAULT_SCAN_LOCATIONS = userProfile ? [
  path.join(userProfile, 'Desktop'),
  path.join(userProfile, 'Documents')
] : [];

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

    // Use setEncoding to avoid garbling UTF-8 chars split across chunks
    ps.stdout.setEncoding('utf8');
    ps.stderr.setEncoding('utf8');

    ps.stdout.on('data', (data) => {
      stdout += data;
    });

    ps.stderr.on('data', (data) => {
      stderr += data;
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

      // Get macros
      let macros = [];
      try {
        const macrosScript = path.join(scriptsDir, 'list_macros.ps1');
        const macrosOutput = await runPowerShell(macrosScript, ['-DatabasePath', dbPath]);
        macros = macrosOutput ? JSON.parse(macrosOutput) : [];
        if (!Array.isArray(macros)) macros = [macros]; // Handle single item
      } catch (err) {
        console.error('Error listing macros:', err.message);
      }

      res.json({
        path: dbPath,
        name: path.basename(dbPath),
        forms: forms,
        reports: reports,
        tables: tables,
        queries: queries,
        modules: modules,
        macros: macros
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

    const logImport = makeLogImport(pool, databasePath, formName, 'form', targetDatabaseId);

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
      const formLogId = await logImport('success', null, { controls: formData.controls ? formData.controls.length : 0 });

      // Return raw JSON to frontend for conversion
      res.json({
        success: true,
        formData: formData,
        import_log_id: formLogId
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

    const logImport = makeLogImport(pool, databasePath, reportName, 'report', targetDatabaseId);

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
      const reportLogId = await logImport('success', null, { sections: sectionCount });

      // Return raw JSON to frontend for conversion
      res.json({
        success: true,
        reportData: reportData,
        import_log_id: reportLogId
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

    const logImport = makeLogImport(pool, databasePath, moduleName, 'module', targetDatabaseId);

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
      const moduleLogId = await logImport('success', null, { lineCount: moduleData.lineCount || 0 });

      // Create issue for untranslated VBA
      if (moduleLogId && targetDatabaseId) {
        try {
          await pool.query(`
            INSERT INTO shared.import_issues
              (import_log_id, database_id, object_name, object_type, severity, category, message)
            VALUES ($1, $2, $3, 'module', 'warning', 'untranslated-vba', $4)
          `, [moduleLogId, targetDatabaseId, moduleName, 'VBA module needs translation to ClojureScript']);
        } catch (issueErr) {
          console.error('Error creating import issue for module:', issueErr);
        }
      }

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
   * POST /api/access-import/export-forms-batch
   * Export multiple forms from Access in a single COM session
   */
  router.post('/export-forms-batch', async (req, res) => {
    const { databasePath, objectNames, targetDatabaseId } = req.body;

    try {
      if (!databasePath || !objectNames || !Array.isArray(objectNames) || objectNames.length === 0) {
        return res.status(400).json({ error: 'databasePath and objectNames[] required' });
      }

      const scriptsDir = path.join(__dirname, '..', '..', 'scripts', 'access');
      const exportScript = path.join(scriptsDir, 'export_forms_batch.ps1');

      const jsonOutput = await runPowerShell(exportScript, [
        '-DatabasePath', databasePath,
        '-FormNames', objectNames.join(',')
      ]);

      const cleanOutput = jsonOutput.replace(/^\uFEFF/, '').trim();
      const jsonStart = cleanOutput.indexOf('{');
      if (jsonStart === -1) {
        throw new Error('No JSON object found in PowerShell output');
      }
      const batchData = JSON.parse(cleanOutput.substring(jsonStart));

      // Log each successful export
      for (const [formName, formData] of Object.entries(batchData.objects || {})) {
        const logImport = makeLogImport(pool, databasePath, formName, 'form', targetDatabaseId);
        await logImport('success', null, { controls: formData.controls ? formData.controls.length : 0 });
      }

      // Log each error
      for (const err of (batchData.errors || [])) {
        const logImport = makeLogImport(pool, databasePath, err.name, 'form', targetDatabaseId);
        await logImport('error', err.error);
      }

      res.json({
        success: true,
        objects: batchData.objects || {},
        errors: batchData.errors || []
      });
    } catch (err) {
      console.error('Error in batch form export:', err);
      logError(pool, 'POST /api/access-import/export-forms-batch', 'Failed to batch export forms', err, {
        details: { databasePath, objectNames, targetDatabaseId }
      });
      res.status(500).json({ error: err.message || 'Failed to batch export forms' });
    }
  });

  /**
   * POST /api/access-import/export-reports-batch
   * Export multiple reports from Access in a single COM session
   */
  router.post('/export-reports-batch', async (req, res) => {
    const { databasePath, objectNames, targetDatabaseId } = req.body;

    try {
      if (!databasePath || !objectNames || !Array.isArray(objectNames) || objectNames.length === 0) {
        return res.status(400).json({ error: 'databasePath and objectNames[] required' });
      }

      const scriptsDir = path.join(__dirname, '..', '..', 'scripts', 'access');
      const exportScript = path.join(scriptsDir, 'export_reports_batch.ps1');

      const jsonOutput = await runPowerShell(exportScript, [
        '-DatabasePath', databasePath,
        '-ReportNames', objectNames.join(',')
      ]);

      const cleanOutput = jsonOutput.replace(/^\uFEFF/, '').trim();
      const jsonStart = cleanOutput.indexOf('{');
      if (jsonStart === -1) {
        throw new Error('No JSON object found in PowerShell output');
      }
      const batchData = JSON.parse(cleanOutput.substring(jsonStart));

      for (const [reportName, reportData] of Object.entries(batchData.objects || {})) {
        const logImport = makeLogImport(pool, databasePath, reportName, 'report', targetDatabaseId);
        const sectionCount = reportData.sections ? reportData.sections.length : 0;
        await logImport('success', null, { sections: sectionCount });
      }

      for (const err of (batchData.errors || [])) {
        const logImport = makeLogImport(pool, databasePath, err.name, 'report', targetDatabaseId);
        await logImport('error', err.error);
      }

      res.json({
        success: true,
        objects: batchData.objects || {},
        errors: batchData.errors || []
      });
    } catch (err) {
      console.error('Error in batch report export:', err);
      logError(pool, 'POST /api/access-import/export-reports-batch', 'Failed to batch export reports', err, {
        details: { databasePath, objectNames, targetDatabaseId }
      });
      res.status(500).json({ error: err.message || 'Failed to batch export reports' });
    }
  });

  /**
   * POST /api/access-import/export-modules-batch
   * Export multiple VBA modules from Access in a single COM session
   */
  router.post('/export-modules-batch', async (req, res) => {
    const { databasePath, objectNames, targetDatabaseId } = req.body;

    try {
      if (!databasePath || !objectNames || !Array.isArray(objectNames) || objectNames.length === 0) {
        return res.status(400).json({ error: 'databasePath and objectNames[] required' });
      }

      const scriptsDir = path.join(__dirname, '..', '..', 'scripts', 'access');
      const exportScript = path.join(scriptsDir, 'export_modules_batch.ps1');

      const jsonOutput = await runPowerShell(exportScript, [
        '-DatabasePath', databasePath,
        '-ModuleNames', objectNames.join(',')
      ]);

      const cleanOutput = jsonOutput.replace(/^\uFEFF/, '').trim();
      const jsonStart = cleanOutput.indexOf('{');
      if (jsonStart === -1) {
        throw new Error('No JSON object found in PowerShell output');
      }
      const batchData = JSON.parse(cleanOutput.substring(jsonStart));

      for (const [moduleName, moduleData] of Object.entries(batchData.objects || {})) {
        const logImport = makeLogImport(pool, databasePath, moduleName, 'module', targetDatabaseId);
        const moduleLogId = await logImport('success', null, { lineCount: moduleData.lineCount || 0 });

        // Create issue for untranslated VBA
        if (moduleLogId && targetDatabaseId) {
          try {
            await pool.query(`
              INSERT INTO shared.import_issues
                (import_log_id, database_id, object_name, object_type, severity, category, message)
              VALUES ($1, $2, $3, 'module', 'warning', 'untranslated-vba', $4)
            `, [moduleLogId, targetDatabaseId, moduleName, 'VBA module needs translation to ClojureScript']);
          } catch (issueErr) {
            console.error('Error creating import issue for module:', issueErr);
          }
        }
      }

      for (const err of (batchData.errors || [])) {
        const logImport = makeLogImport(pool, databasePath, err.name, 'module', targetDatabaseId);
        await logImport('error', err.error);
      }

      res.json({
        success: true,
        objects: batchData.objects || {},
        errors: batchData.errors || []
      });
    } catch (err) {
      console.error('Error in batch module export:', err);
      logError(pool, 'POST /api/access-import/export-modules-batch', 'Failed to batch export modules', err, {
        details: { databasePath, objectNames, targetDatabaseId }
      });
      res.status(500).json({ error: err.message || 'Failed to batch export modules' });
    }
  });

  /**
   * POST /api/access-import/export-macros-batch
   * Export multiple macros from Access in a single COM session
   */
  router.post('/export-macros-batch', async (req, res) => {
    const { databasePath, objectNames, targetDatabaseId } = req.body;

    try {
      if (!databasePath || !objectNames || !Array.isArray(objectNames) || objectNames.length === 0) {
        return res.status(400).json({ error: 'databasePath and objectNames[] required' });
      }

      const scriptsDir = path.join(__dirname, '..', '..', 'scripts', 'access');
      const exportScript = path.join(scriptsDir, 'export_macros_batch.ps1');

      const jsonOutput = await runPowerShell(exportScript, [
        '-DatabasePath', databasePath,
        '-MacroNames', objectNames.join(',')
      ]);

      const cleanOutput = jsonOutput.replace(/^\uFEFF/, '').trim();
      const jsonStart = cleanOutput.indexOf('{');
      if (jsonStart === -1) {
        throw new Error('No JSON object found in PowerShell output');
      }
      const batchData = JSON.parse(cleanOutput.substring(jsonStart));

      for (const [macroName, macroData] of Object.entries(batchData.objects || {})) {
        const logImport = makeLogImport(pool, databasePath, macroName, 'macro', targetDatabaseId);
        const macroLogId = await logImport('success', null, { hasDefinition: !!macroData.definition });

        // Create issue for untranslated macro
        if (macroLogId && targetDatabaseId) {
          try {
            await pool.query(`
              INSERT INTO shared.import_issues
                (import_log_id, database_id, object_name, object_type, severity, category, message)
              VALUES ($1, $2, $3, 'macro', 'warning', 'untranslated-macro', $4)
            `, [macroLogId, targetDatabaseId, macroName, 'Access macro needs translation to ClojureScript']);
          } catch (issueErr) {
            console.error('Error creating import issue for macro:', issueErr);
          }
        }
      }

      for (const err of (batchData.errors || [])) {
        const logImport = makeLogImport(pool, databasePath, err.name, 'macro', targetDatabaseId);
        await logImport('error', err.error);
      }

      res.json({
        success: true,
        objects: batchData.objects || {},
        errors: batchData.errors || []
      });
    } catch (err) {
      console.error('Error in batch macro export:', err);
      logError(pool, 'POST /api/access-import/export-macros-batch', 'Failed to batch export macros', err, {
        details: { databasePath, objectNames, targetDatabaseId }
      });
      res.status(500).json({ error: err.message || 'Failed to batch export macros' });
    }
  });

  /**
   * POST /api/access-import/export-macro
   * Export a macro from Access (raw XML definition)
   * The frontend saves the XML via /api/macros
   */
  router.post('/export-macro', async (req, res) => {
    const { databasePath, macroName, targetDatabaseId } = req.body;

    const logImport = makeLogImport(pool, databasePath, macroName, 'macro', targetDatabaseId);

    try {
      if (!databasePath || !macroName) {
        await logImport('error', 'databasePath and macroName required');
        return res.status(400).json({ error: 'databasePath and macroName required' });
      }

      const scriptsDir = path.join(__dirname, '..', '..', 'scripts', 'access');
      const exportScript = path.join(scriptsDir, 'export_macro.ps1');

      // Run PowerShell - it outputs JSON to stdout
      const jsonOutput = await runPowerShell(exportScript, [
        '-DatabasePath', databasePath,
        '-MacroName', macroName
      ]);

      // Remove BOM if present, then extract JSON object from output
      const cleanOutput = jsonOutput.replace(/^\uFEFF/, '').trim();
      const jsonStart = cleanOutput.indexOf('{');
      if (jsonStart === -1) {
        throw new Error('No JSON object found in PowerShell output');
      }
      const macroData = JSON.parse(cleanOutput.substring(jsonStart));

      // Log success
      const macroLogId = await logImport('success', null, { hasDefinition: !!macroData.definition });

      // Create issue for untranslated macro
      if (macroLogId && targetDatabaseId) {
        try {
          await pool.query(`
            INSERT INTO shared.import_issues
              (import_log_id, database_id, object_name, object_type, severity, category, message)
            VALUES ($1, $2, $3, 'macro', 'warning', 'untranslated-macro', $4)
          `, [macroLogId, targetDatabaseId, macroName, 'Access macro needs translation to ClojureScript']);
        } catch (issueErr) {
          console.error('Error creating import issue for macro:', issueErr);
        }
      }

      // Return raw JSON to frontend
      res.json({
        success: true,
        macroData: macroData
      });
    } catch (err) {
      console.error('Error exporting macro:', err);
      logError(pool, 'POST /api/access-import/export-macro', 'Failed to export macro', err, { details: { databasePath, macroName, targetDatabaseId } });
      await logImport('error', err.message);
      res.status(500).json({ error: err.message || 'Failed to export macro' });
    }
  });

  /**
   * POST /api/access-import/import-table
   * Import a table from Access: extract structure + data via PowerShell,
   * create PostgreSQL table, insert rows, create indexes — all server-side.
   */
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
          case 18: {
            // Calculated — use resultType for the PG type
            const rt = field.resultType || 10;
            return mapAccessType({ ...field, type: rt, isAutoNumber: false });
          }
          default: return { type: 'Short Text', maxLength: 255 };
        }
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
        // Exclude generated (calculated) columns — PG computes their values
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

        // 9. Create non-PK indexes (prefix with table name to avoid cross-table collisions)
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

  /**
   * POST /api/access-import/import-query
   * Import a query from Access: extract SQL via PowerShell,
   * convert to PostgreSQL view or function, execute DDL.
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
      const scriptsDir = path.join(__dirname, '..', '..', 'scripts', 'access');
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
   * PUT /api/access-import/source-discovery
   * Upsert the discovery inventory for a target database
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
   * Compare discovery inventory vs actual imported objects
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

      // Helper: check if a source name matches any actual name (case-insensitive + sanitized)
      function isImported(sourceName, actualSet) {
        const lower = sourceName.toLowerCase();
        const sanitized = lower.replace(/\s+/g, '_');
        return actualSet.has(lower) || actualSet.has(sanitized);
      }

      const missing = {};
      let missingCount = 0;
      let totalSource = 0;

      // Check tables
      const srcTables = discovery.tables || [];
      totalSource += srcTables.length;
      const missingTables = srcTables.filter(n => !isImported(n, actualTables));
      if (missingTables.length > 0) { missing.tables = missingTables; missingCount += missingTables.length; }

      // Check queries — can be imported as views OR routines
      const srcQueries = discovery.queries || [];
      totalSource += srcQueries.length;
      const actualQueriesSet = new Set([...actualViews, ...actualRoutines]);
      const missingQueries = srcQueries.filter(n => !isImported(n, actualQueriesSet));
      if (missingQueries.length > 0) { missing.queries = missingQueries; missingCount += missingQueries.length; }

      // Check forms
      const srcForms = discovery.forms || [];
      totalSource += srcForms.length;
      const missingForms = srcForms.filter(n => !isImported(n, actualForms));
      if (missingForms.length > 0) { missing.forms = missingForms; missingCount += missingForms.length; }

      // Check reports
      const srcReports = discovery.reports || [];
      totalSource += srcReports.length;
      const missingReports = srcReports.filter(n => !isImported(n, actualReports));
      if (missingReports.length > 0) { missing.reports = missingReports; missingCount += missingReports.length; }

      // Check modules
      const srcModules = discovery.modules || [];
      totalSource += srcModules.length;
      const missingModulesList = srcModules.filter(n => !isImported(n, actualModules));
      if (missingModulesList.length > 0) { missing.modules = missingModulesList; missingCount += missingModulesList.length; }

      // Check macros
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
   * Get import history, optionally filtered by source path
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
      // Parse open_issue_count to integer
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

  /**
   * POST /api/access-import/tag-state-controls
   * Auto-tag controls that are referenced by converted queries.
   * Sets tag="state" on controls whose (table, column) appear in referencedEntries.
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

  return router;
};
