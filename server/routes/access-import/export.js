/**
 * Export routes — single and batch export of forms, reports, modules, macros.
 */

const path = require('path');
const { logError } = require('../../lib/events');
const { makeLogImport, runPowerShell, parsePowerShellJson } = require('./helpers');

module.exports = function(router, pool) {

  /**
   * POST /api/access-import/export-form
   */
  router.post('/export-form', async (req, res) => {
    const { databasePath, formName, targetDatabaseId } = req.body;
    const logImport = makeLogImport(pool, databasePath, formName, 'form', targetDatabaseId);

    try {
      if (!databasePath || !formName) {
        await logImport('error', 'databasePath and formName required');
        return res.status(400).json({ error: 'databasePath and formName required' });
      }

      const scriptsDir = path.join(__dirname, '..', '..', '..', 'scripts', 'access');
      const exportScript = path.join(scriptsDir, 'export_form.ps1');

      const jsonOutput = await runPowerShell(exportScript, [
        '-DatabasePath', databasePath,
        '-FormName', formName
      ]);

      const formData = parsePowerShellJson(jsonOutput);
      const formLogId = await logImport('success', null, { controls: formData.controls ? formData.controls.length : 0 });

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
   */
  router.post('/export-report', async (req, res) => {
    const { databasePath, reportName, targetDatabaseId } = req.body;
    const logImport = makeLogImport(pool, databasePath, reportName, 'report', targetDatabaseId);

    try {
      if (!databasePath || !reportName) {
        await logImport('error', 'databasePath and reportName required');
        return res.status(400).json({ error: 'databasePath and reportName required' });
      }

      const scriptsDir = path.join(__dirname, '..', '..', '..', 'scripts', 'access');
      const exportScript = path.join(scriptsDir, 'export_report.ps1');

      const jsonOutput = await runPowerShell(exportScript, [
        '-DatabasePath', databasePath,
        '-ReportName', reportName
      ]);

      const reportData = parsePowerShellJson(jsonOutput);
      const sectionCount = reportData.sections ? reportData.sections.length : 0;
      const reportLogId = await logImport('success', null, { sections: sectionCount });

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
   */
  router.post('/export-module', async (req, res) => {
    const { databasePath, moduleName, targetDatabaseId } = req.body;
    const logImport = makeLogImport(pool, databasePath, moduleName, 'module', targetDatabaseId);

    try {
      if (!databasePath || !moduleName) {
        await logImport('error', 'databasePath and moduleName required');
        return res.status(400).json({ error: 'databasePath and moduleName required' });
      }

      const scriptsDir = path.join(__dirname, '..', '..', '..', 'scripts', 'access');
      const exportScript = path.join(scriptsDir, 'export_module.ps1');

      const jsonOutput = await runPowerShell(exportScript, [
        '-DatabasePath', databasePath,
        '-ModuleName', moduleName
      ]);

      const moduleData = parsePowerShellJson(jsonOutput);
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
   * POST /api/access-import/export-macro
   */
  router.post('/export-macro', async (req, res) => {
    const { databasePath, macroName, targetDatabaseId } = req.body;
    const logImport = makeLogImport(pool, databasePath, macroName, 'macro', targetDatabaseId);

    try {
      if (!databasePath || !macroName) {
        await logImport('error', 'databasePath and macroName required');
        return res.status(400).json({ error: 'databasePath and macroName required' });
      }

      const scriptsDir = path.join(__dirname, '..', '..', '..', 'scripts', 'access');
      const exportScript = path.join(scriptsDir, 'export_macro.ps1');

      const jsonOutput = await runPowerShell(exportScript, [
        '-DatabasePath', databasePath,
        '-MacroName', macroName
      ]);

      const macroData = parsePowerShellJson(jsonOutput);
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
   * POST /api/access-import/export-forms-batch
   */
  router.post('/export-forms-batch', async (req, res) => {
    const { databasePath, objectNames, targetDatabaseId } = req.body;

    try {
      if (!databasePath || !objectNames || !Array.isArray(objectNames) || objectNames.length === 0) {
        return res.status(400).json({ error: 'databasePath and objectNames[] required' });
      }

      const scriptsDir = path.join(__dirname, '..', '..', '..', 'scripts', 'access');
      const exportScript = path.join(scriptsDir, 'export_forms_batch.ps1');

      const jsonOutput = await runPowerShell(exportScript, [
        '-DatabasePath', databasePath,
        '-FormNames', objectNames.join(',')
      ]);

      const batchData = parsePowerShellJson(jsonOutput);

      for (const [formName, formData] of Object.entries(batchData.objects || {})) {
        const logImport = makeLogImport(pool, databasePath, formName, 'form', targetDatabaseId);
        await logImport('success', null, { controls: formData.controls ? formData.controls.length : 0 });
      }

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
   */
  router.post('/export-reports-batch', async (req, res) => {
    const { databasePath, objectNames, targetDatabaseId } = req.body;

    try {
      if (!databasePath || !objectNames || !Array.isArray(objectNames) || objectNames.length === 0) {
        return res.status(400).json({ error: 'databasePath and objectNames[] required' });
      }

      const scriptsDir = path.join(__dirname, '..', '..', '..', 'scripts', 'access');
      const exportScript = path.join(scriptsDir, 'export_reports_batch.ps1');

      const jsonOutput = await runPowerShell(exportScript, [
        '-DatabasePath', databasePath,
        '-ReportNames', objectNames.join(',')
      ]);

      const batchData = parsePowerShellJson(jsonOutput);

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
   */
  router.post('/export-modules-batch', async (req, res) => {
    const { databasePath, objectNames, targetDatabaseId } = req.body;

    try {
      if (!databasePath || !objectNames || !Array.isArray(objectNames) || objectNames.length === 0) {
        return res.status(400).json({ error: 'databasePath and objectNames[] required' });
      }

      const scriptsDir = path.join(__dirname, '..', '..', '..', 'scripts', 'access');
      const exportScript = path.join(scriptsDir, 'export_modules_batch.ps1');

      const jsonOutput = await runPowerShell(exportScript, [
        '-DatabasePath', databasePath,
        '-ModuleNames', objectNames.join(',')
      ]);

      const batchData = parsePowerShellJson(jsonOutput);

      for (const [moduleName, moduleData] of Object.entries(batchData.objects || {})) {
        const logImport = makeLogImport(pool, databasePath, moduleName, 'module', targetDatabaseId);
        const moduleLogId = await logImport('success', null, { lineCount: moduleData.lineCount || 0 });

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
   */
  router.post('/export-macros-batch', async (req, res) => {
    const { databasePath, objectNames, targetDatabaseId } = req.body;

    try {
      if (!databasePath || !objectNames || !Array.isArray(objectNames) || objectNames.length === 0) {
        return res.status(400).json({ error: 'databasePath and objectNames[] required' });
      }

      const scriptsDir = path.join(__dirname, '..', '..', '..', 'scripts', 'access');
      const exportScript = path.join(scriptsDir, 'export_macros_batch.ps1');

      const jsonOutput = await runPowerShell(exportScript, [
        '-DatabasePath', databasePath,
        '-MacroNames', objectNames.join(',')
      ]);

      const batchData = parsePowerShellJson(jsonOutput);

      for (const [macroName, macroData] of Object.entries(batchData.objects || {})) {
        const logImport = makeLogImport(pool, databasePath, macroName, 'macro', targetDatabaseId);
        const macroLogId = await logImport('success', null, { hasDefinition: !!macroData.definition });

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

};
