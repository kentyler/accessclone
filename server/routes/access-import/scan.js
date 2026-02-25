/**
 * Scan and database info routes.
 * GET /scan — Scan for Access databases
 * GET /database — Get details about a specific Access database
 */

const path = require('path');
const fs = require('fs').promises;
const { logError } = require('../../lib/events');
const { DEFAULT_SCAN_LOCATIONS, runPowerShell, scanDirectory } = require('./helpers');

module.exports = function(router, pool) {

  /**
   * GET /api/access-import/browse
   * Browse a directory — returns subdirectories and .accdb/.mdb files.
   * ?dir=<path>  (defaults to %USERPROFILE% or C:\Users)
   */
  router.get('/browse', async (req, res) => {
    try {
      const dir = req.query.dir
        || process.env.USERPROFILE
        || process.env.HOME
        || 'C:\\Users';

      const resolved = path.resolve(dir);
      const parent = path.dirname(resolved);

      const entries = await fs.readdir(resolved, { withFileTypes: true });
      const directories = [];
      const files = [];

      for (const entry of entries) {
        const name = entry.name;
        // Skip hidden/system directories
        if (name.startsWith('.') || name.startsWith('$')) continue;

        if (entry.isDirectory()) {
          directories.push(name);
        } else if (entry.isFile()) {
          const lower = name.toLowerCase();
          if (lower.endsWith('.accdb') || lower.endsWith('.mdb')) {
            const fullPath = path.join(resolved, name);
            try {
              const stats = await fs.stat(fullPath);
              files.push({
                name,
                path: fullPath,
                size: stats.size,
                modified: stats.mtime
              });
            } catch { /* skip inaccessible files */ }
          }
        }
      }

      directories.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
      files.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

      res.json({ current: resolved, parent, directories, files });
    } catch (err) {
      console.error('Error browsing directory:', err.message);
      logError(pool, 'GET /api/access-import/browse', 'Failed to browse directory', err, { details: { dir: req.query.dir } });
      res.status(400).json({ error: `Cannot browse directory: ${err.message}` });
    }
  });

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
   * If path is an .mdb file, silently converts to .accdb first.
   * AutoExec macros are disabled before any COM automation.
   */
  router.get('/database', async (req, res) => {
    try {
      let dbPath = req.query.path;

      if (!dbPath) {
        return res.status(400).json({ error: 'Database path required' });
      }

      // Check file exists
      try {
        await fs.access(dbPath);
      } catch {
        return res.status(404).json({ error: 'Database file not found' });
      }

      const scriptsDir = path.join(__dirname, '..', '..', '..', 'scripts', 'access');
      let convertedFrom = null;

      // If .mdb, convert to .accdb first (handles AutoExec internally)
      if (dbPath.toLowerCase().endsWith('.mdb')) {
        try {
          const convertScript = path.join(scriptsDir, 'convert_mdb.ps1');
          const convertOutput = await runPowerShell(convertScript, ['-DatabasePath', dbPath]);
          const convertResult = JSON.parse(convertOutput);
          if (convertResult.success) {
            console.log(`Converted .mdb to .accdb: ${convertResult.outputPath}`);
            convertedFrom = dbPath;
            dbPath = convertResult.outputPath;
          } else {
            console.error(`Failed to convert .mdb: ${convertResult.error}`);
            // Fall through and try to list the .mdb directly
          }
        } catch (err) {
          console.error('Error converting .mdb:', err.message);
          // Fall through and try to list the .mdb directly
        }
      }

      // Disable AutoExec before listing (safe for both .mdb and .accdb)
      let autoExecDisabled = false;
      try {
        const disableScript = path.join(scriptsDir, 'disable_autoexec.ps1');
        const disableOutput = await runPowerShell(disableScript, ['-DatabasePath', dbPath]);
        const disableResult = JSON.parse(disableOutput);
        autoExecDisabled = disableResult.found === true;
        if (autoExecDisabled) {
          console.log(`Disabled AutoExec macro in ${dbPath}`);
        }
      } catch (err) {
        console.error('Error disabling AutoExec:', err.message);
        // Non-fatal — proceed with listing
      }

      // Detect Access version
      let accessVersion = null;
      try {
        const detectScript = path.join(scriptsDir, 'detect_version.ps1');
        const detectOutput = await runPowerShell(detectScript, ['-DatabasePath', dbPath]);
        const detectResult = JSON.parse(detectOutput);
        if (!detectResult.error) {
          accessVersion = detectResult;
        }
      } catch (err) {
        console.error('Error detecting Access version:', err.message);
        // Non-fatal — proceed without version info
      }

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

      // Get relationships
      let relationships = [];
      try {
        const relScript = path.join(scriptsDir, 'list_relationships.ps1');
        const relOutput = await runPowerShell(relScript, ['-DatabasePath', dbPath]);
        relationships = relOutput ? JSON.parse(relOutput) : [];
        if (!Array.isArray(relationships)) relationships = [relationships]; // Handle single item
      } catch (err) {
        console.error('Error listing relationships:', err.message);
      }

      // Restore AutoExec after listing
      if (autoExecDisabled) {
        try {
          const disableScript = path.join(scriptsDir, 'disable_autoexec.ps1');
          await runPowerShell(disableScript, ['-DatabasePath', dbPath, '-Restore']);
          console.log(`Restored AutoExec macro in ${dbPath}`);
        } catch (err) {
          console.error('Error restoring AutoExec:', err.message);
        }
      }

      const response = {
        path: dbPath,
        name: path.basename(dbPath),
        forms: forms,
        reports: reports,
        tables: tables,
        queries: queries,
        modules: modules,
        macros: macros,
        relationships: relationships
      };

      // Let the frontend know this was converted from .mdb
      if (convertedFrom) {
        response.convertedFrom = convertedFrom;
      }

      // Include detected Access version info
      if (accessVersion) {
        response.accessVersion = accessVersion;
      }

      res.json(response);
    } catch (err) {
      console.error('Error getting database details:', err);
      logError(pool, 'GET /api/access-import/database', 'Failed to get database details', err, { details: { path: req.query.path } });
      res.status(500).json({ error: 'Failed to get database details' });
    }
  });

};
