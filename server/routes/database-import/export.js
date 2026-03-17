/**
 * Export routes — single and batch export of forms, reports, modules, macros.
 */

const path = require('path');
const { logError } = require('../../lib/events');
const { makeLogImport, runPowerShell, parsePowerShellJson, withComLock } = require('./helpers');

module.exports = function(router, pool) {

  /**
   * POST /api/database-import/export-form
   */
  router.post('/export-form', async (req, res) => {
    const { databasePath, formName, targetDatabaseId } = req.body;
    const logImport = makeLogImport(pool, databasePath, formName, 'form', targetDatabaseId);

    try {
      if (!databasePath || !formName) {
        await logImport('error', 'databasePath and formName required');
        return res.status(400).json({ error: 'databasePath and formName required' });
      }

      const formData = await withComLock(async () => {
        const scriptsDir = path.join(__dirname, '..', '..', '..', 'scripts', 'access');
        const exportScript = path.join(scriptsDir, 'export_form.ps1');
        const jsonOutput = await runPowerShell(exportScript, [
          '-DatabasePath', databasePath,
          '-FormName', formName
        ]);
        return parsePowerShellJson(jsonOutput);
      });
      const formLogId = await logImport('success', null, { controls: formData.controls ? formData.controls.length : 0 });

      res.json({
        success: true,
        formData: formData,
        import_log_id: formLogId
      });
    } catch (err) {
      console.error('Error exporting form:', err);
      logError(pool, 'POST /api/database-import/export-form', 'Failed to export form', err, { details: { databasePath, formName, targetDatabaseId } });
      await logImport('error', err.message);
      res.status(500).json({ error: err.message || 'Failed to export form' });
    }
  });

  /**
   * POST /api/database-import/export-report
   */
  router.post('/export-report', async (req, res) => {
    const { databasePath, reportName, targetDatabaseId } = req.body;
    const logImport = makeLogImport(pool, databasePath, reportName, 'report', targetDatabaseId);

    try {
      if (!databasePath || !reportName) {
        await logImport('error', 'databasePath and reportName required');
        return res.status(400).json({ error: 'databasePath and reportName required' });
      }

      const reportData = await withComLock(async () => {
        const scriptsDir = path.join(__dirname, '..', '..', '..', 'scripts', 'access');
        const exportScript = path.join(scriptsDir, 'export_report.ps1');
        const jsonOutput = await runPowerShell(exportScript, [
          '-DatabasePath', databasePath,
          '-ReportName', reportName
        ]);
        return parsePowerShellJson(jsonOutput);
      });
      const sectionCount = reportData.sections ? reportData.sections.length : 0;
      const reportLogId = await logImport('success', null, { sections: sectionCount });

      res.json({
        success: true,
        reportData: reportData,
        import_log_id: reportLogId
      });
    } catch (err) {
      console.error('Error exporting report:', err);
      logError(pool, 'POST /api/database-import/export-report', 'Failed to export report', err, { details: { databasePath, reportName, targetDatabaseId } });
      await logImport('error', err.message);
      res.status(500).json({ error: err.message || 'Failed to export report' });
    }
  });

  /**
   * POST /api/database-import/export-module
   */
  router.post('/export-module', async (req, res) => {
    const { databasePath, moduleName, targetDatabaseId } = req.body;
    const logImport = makeLogImport(pool, databasePath, moduleName, 'module', targetDatabaseId);

    try {
      if (!databasePath || !moduleName) {
        await logImport('error', 'databasePath and moduleName required');
        return res.status(400).json({ error: 'databasePath and moduleName required' });
      }

      const moduleData = await withComLock(async () => {
        const scriptsDir = path.join(__dirname, '..', '..', '..', 'scripts', 'access');
        const exportScript = path.join(scriptsDir, 'export_module.ps1');
        const jsonOutput = await runPowerShell(exportScript, [
          '-DatabasePath', databasePath,
          '-ModuleName', moduleName
        ]);
        return parsePowerShellJson(jsonOutput);
      });
      const moduleLogId = await logImport('success', null, { lineCount: moduleData.lineCount || 0 });

      // Log issue for untranslated VBA
      if (targetDatabaseId) {
        try {
          await pool.query(`
            INSERT INTO shared.import_log
              (target_database_id, source_object_name, source_object_type, status, severity, category, message)
            VALUES ($1, $2, 'module', 'issue', 'warning', 'untranslated-vba', $3)
          `, [targetDatabaseId, moduleName, 'VBA module needs translation to ClojureScript']);
        } catch (issueErr) {
          console.error('Error logging module issue:', issueErr);
        }
      }

      res.json({
        success: true,
        moduleData: moduleData
      });
    } catch (err) {
      console.error('Error exporting module:', err);
      logError(pool, 'POST /api/database-import/export-module', 'Failed to export module', err, { details: { databasePath, moduleName, targetDatabaseId } });
      await logImport('error', err.message);
      res.status(500).json({ error: err.message || 'Failed to export module' });
    }
  });

  /**
   * POST /api/database-import/export-macro
   */
  router.post('/export-macro', async (req, res) => {
    const { databasePath, macroName, targetDatabaseId } = req.body;
    const logImport = makeLogImport(pool, databasePath, macroName, 'macro', targetDatabaseId);

    try {
      if (!databasePath || !macroName) {
        await logImport('error', 'databasePath and macroName required');
        return res.status(400).json({ error: 'databasePath and macroName required' });
      }

      const macroData = await withComLock(async () => {
        const scriptsDir = path.join(__dirname, '..', '..', '..', 'scripts', 'access');
        const exportScript = path.join(scriptsDir, 'export_macro.ps1');
        const jsonOutput = await runPowerShell(exportScript, [
          '-DatabasePath', databasePath,
          '-MacroName', macroName
        ]);
        return parsePowerShellJson(jsonOutput);
      });
      const macroLogId = await logImport('success', null, { hasDefinition: !!macroData.definition });

      // Log issue for untranslated macro
      if (targetDatabaseId) {
        try {
          await pool.query(`
            INSERT INTO shared.import_log
              (target_database_id, source_object_name, source_object_type, status, severity, category, message)
            VALUES ($1, $2, 'macro', 'issue', 'warning', 'untranslated-macro', $3)
          `, [targetDatabaseId, macroName, 'Access macro needs translation to ClojureScript']);
        } catch (issueErr) {
          console.error('Error logging macro issue:', issueErr);
        }
      }

      res.json({
        success: true,
        macroData: macroData
      });
    } catch (err) {
      console.error('Error exporting macro:', err);
      logError(pool, 'POST /api/database-import/export-macro', 'Failed to export macro', err, { details: { databasePath, macroName, targetDatabaseId } });
      await logImport('error', err.message);
      res.status(500).json({ error: err.message || 'Failed to export macro' });
    }
  });

  /**
   * POST /api/database-import/export-forms-batch
   */
  router.post('/export-forms-batch', async (req, res) => {
    const { databasePath, objectNames, targetDatabaseId } = req.body;

    try {
      if (!databasePath || !objectNames || !Array.isArray(objectNames) || objectNames.length === 0) {
        return res.status(400).json({ error: 'databasePath and objectNames[] required' });
      }

      const timeout = Math.max(60000, objectNames.length * 30000);
      const batchData = await withComLock(async () => {
        const scriptsDir = path.join(__dirname, '..', '..', '..', 'scripts', 'access');
        const exportScript = path.join(scriptsDir, 'export_forms_batch.ps1');
        const jsonOutput = await runPowerShell(exportScript, [
          '-DatabasePath', databasePath,
          '-FormNames', objectNames.join(',')
        ], { timeout });
        return parsePowerShellJson(jsonOutput);
      });

      // Only log export errors — success is logged after client-side save
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
      logError(pool, 'POST /api/database-import/export-forms-batch', 'Failed to batch export forms', err, {
        details: { databasePath, objectNames, targetDatabaseId }
      });
      res.status(500).json({ error: err.message || 'Failed to batch export forms' });
    }
  });

  /**
   * POST /api/database-import/export-reports-batch
   */
  router.post('/export-reports-batch', async (req, res) => {
    const { databasePath, objectNames, targetDatabaseId } = req.body;

    try {
      if (!databasePath || !objectNames || !Array.isArray(objectNames) || objectNames.length === 0) {
        return res.status(400).json({ error: 'databasePath and objectNames[] required' });
      }

      const timeout = Math.max(60000, objectNames.length * 30000);
      const batchData = await withComLock(async () => {
        const scriptsDir = path.join(__dirname, '..', '..', '..', 'scripts', 'access');
        const exportScript = path.join(scriptsDir, 'export_reports_batch.ps1');
        const jsonOutput = await runPowerShell(exportScript, [
          '-DatabasePath', databasePath,
          '-ReportNames', objectNames.join(',')
        ], { timeout });
        return parsePowerShellJson(jsonOutput);
      });

      // Only log export errors — success is logged after client-side save
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
      logError(pool, 'POST /api/database-import/export-reports-batch', 'Failed to batch export reports', err, {
        details: { databasePath, objectNames, targetDatabaseId }
      });
      res.status(500).json({ error: err.message || 'Failed to batch export reports' });
    }
  });

  /**
   * POST /api/database-import/export-modules-batch
   */
  router.post('/export-modules-batch', async (req, res) => {
    const { databasePath, objectNames, targetDatabaseId } = req.body;

    try {
      if (!databasePath || !objectNames || !Array.isArray(objectNames) || objectNames.length === 0) {
        return res.status(400).json({ error: 'databasePath and objectNames[] required' });
      }

      const timeout = Math.max(60000, objectNames.length * 30000);
      const batchData = await withComLock(async () => {
        const scriptsDir = path.join(__dirname, '..', '..', '..', 'scripts', 'access');
        const exportScript = path.join(scriptsDir, 'export_modules_batch.ps1');
        const jsonOutput = await runPowerShell(exportScript, [
          '-DatabasePath', databasePath,
          '-ModuleNames', objectNames.join(',')
        ], { timeout });
        return parsePowerShellJson(jsonOutput);
      });

      // Only log export errors — success is logged after client-side save (via individual fallback)
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
      logError(pool, 'POST /api/database-import/export-modules-batch', 'Failed to batch export modules', err, {
        details: { databasePath, objectNames, targetDatabaseId }
      });
      res.status(500).json({ error: err.message || 'Failed to batch export modules' });
    }
  });

  /**
   * POST /api/database-import/export-macros-batch
   */
  router.post('/export-macros-batch', async (req, res) => {
    const { databasePath, objectNames, targetDatabaseId } = req.body;

    try {
      if (!databasePath || !objectNames || !Array.isArray(objectNames) || objectNames.length === 0) {
        return res.status(400).json({ error: 'databasePath and objectNames[] required' });
      }

      // Macros are small — 10s each is generous; 60s minimum
      const timeout = Math.max(60000, objectNames.length * 10000);
      const batchData = await withComLock(async () => {
        const scriptsDir = path.join(__dirname, '..', '..', '..', 'scripts', 'access');
        const exportScript = path.join(scriptsDir, 'export_macros_batch.ps1');
        const jsonOutput = await runPowerShell(exportScript, [
          '-DatabasePath', databasePath,
          '-MacroNames', objectNames.join(',')
        ], { timeout });
        return parsePowerShellJson(jsonOutput);
      });

      // Only log export errors — success is logged after client-side save (via individual fallback)
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
      console.error('Error in batch macro export:', err.message);
      // Return empty result instead of 500 — frontend will retry individually
      res.json({
        success: true,
        objects: {},
        errors: [{ name: '_batch', error: err.message }]
      });
    }
  });

  /**
   * POST /api/database-import/fix-ptrsafe
   * Scan and fix VBA Declare statements missing PtrSafe keyword.
   * Run once before import to prevent compile error dialogs on 64-bit Access.
   * Body: { databasePath, dryRun? }
   */
  router.post('/fix-ptrsafe', async (req, res) => {
    const { databasePath, dryRun } = req.body;

    try {
      if (!databasePath) {
        return res.status(400).json({ error: 'databasePath required' });
      }

      const result = await withComLock(async () => {
        const scriptsDir = path.join(__dirname, '..', '..', '..', 'scripts', 'access');
        const fixScript = path.join(scriptsDir, 'fix_ptrsafe.ps1');
        const args = ['-DatabasePath', databasePath];
        if (dryRun) args.push('-DryRun');
        const jsonOutput = await runPowerShell(fixScript, args, { timeout: 120000 });
        return JSON.parse(jsonOutput);
      });

      console.log(`[PtrSafe] ${dryRun ? 'DRY RUN' : 'Fixed'}: ${result.declarationsFixed} declaration(s) in ${result.modulesFixed} module(s)`);
      res.json(result);
    } catch (err) {
      console.error('Error fixing PtrSafe:', err.message);
      logError(pool, 'POST /api/database-import/fix-ptrsafe', 'Failed to fix PtrSafe declarations', err, {
        details: { databasePath }
      });
      res.status(500).json({ error: err.message || 'Failed to fix PtrSafe declarations' });
    }
  });

};
