/**
 * Lint router — form, report, and database-wide validation endpoints.
 */

const express = require('express');
const router = express.Router();
const { logError } = require('../../lib/events');
const { validateForm, validateReport, normalizeType, validateControl, isReportBand } = require('./structural');
const { getSchemaInfo, validateFormCrossObject, validateComboBoxSql, validateReportCrossObject } = require('./cross-object');

function createRouter(pool, secrets) {
  /**
   * POST /api/lint/form
   * Validate a form definition (structural + cross-object)
   */
  router.post('/form', async (req, res) => {
    const { form } = req.body;

    if (!form) {
      return res.status(400).json({ error: 'form is required' });
    }

    const issues = validateForm(form);

    // Cross-object validation (schema-aware)
    try {
      const schemaName = req.schemaName || 'public';
      const schemaInfo = await getSchemaInfo(pool, schemaName);
      const crossIssues = validateFormCrossObject(form, schemaInfo);
      issues.push(...crossIssues);

      // Validate combo-box SQL
      const sqlIssues = await validateComboBoxSql(form, pool, schemaName);
      issues.push(...sqlIssues);
    } catch (err) {
      // Cross-object validation failed - don't block the save
      console.warn('Cross-object validation failed:', err.message);
    }

    const errors = issues.filter(i => i.severity === 'error');
    const warnings = issues.filter(i => i.severity === 'warning');

    res.json({
      valid: errors.length === 0,
      errors: errors,
      warnings: warnings,
      summary: errors.length === 0
        ? 'Form is valid'
        : `${errors.length} error(s), ${warnings.length} warning(s)`
    });
  });

  /**
   * POST /api/lint/report
   * Validate a report definition (structural + cross-object)
   */
  router.post('/report', async (req, res) => {
    const { report } = req.body;

    if (!report) {
      return res.status(400).json({ error: 'report is required' });
    }

    const issues = validateReport(report);

    // Cross-object validation (schema-aware)
    try {
      const schemaName = req.schemaName || 'public';
      const schemaInfo = await getSchemaInfo(pool, schemaName);
      const crossIssues = validateReportCrossObject(report, schemaInfo);
      issues.push(...crossIssues);
    } catch (err) {
      console.warn('Cross-object validation failed:', err.message);
    }

    const errors = issues.filter(i => i.severity === 'error');
    const warnings = issues.filter(i => i.severity === 'warning');

    res.json({
      valid: errors.length === 0,
      errors: errors,
      warnings: warnings,
      summary: errors.length === 0
        ? 'Report is valid'
        : `${errors.length} error(s), ${warnings.length} warning(s)`
    });
  });

  /**
   * POST /api/lint/validate
   * Validate all forms and reports in the current database
   */
  router.post('/validate', async (req, res) => {
    try {
      const databaseId = req.headers['x-database-id'];
      if (!databaseId) {
        return res.status(400).json({ error: 'X-Database-ID header is required' });
      }

      const schemaName = req.schemaName || 'public';
      const schemaInfo = await getSchemaInfo(pool, schemaName);

      // Load all current forms
      const formsResult = await pool.query(
        `SELECT name, definition FROM shared.forms
         WHERE database_id = $1 AND is_current = true`,
        [databaseId]
      );

      // Load all current reports
      const reportsResult = await pool.query(
        `SELECT name, definition FROM shared.reports
         WHERE database_id = $1 AND is_current = true`,
        [databaseId]
      );

      const formResults = [];
      for (const row of formsResult.rows) {
        let def;
        try {
          def = typeof row.definition === 'string' ? JSON.parse(row.definition) : row.definition;
        } catch { continue; } // Skip unparseable

        const issues = validateForm(def);
        const crossIssues = validateFormCrossObject(def, schemaInfo);
        issues.push(...crossIssues);

        const errors = issues.filter(i => i.severity === 'error');
        const warnings = issues.filter(i => i.severity === 'warning');
        formResults.push({
          name: row.name,
          valid: errors.length === 0,
          errors,
          warnings
        });
      }

      const reportResults = [];
      for (const row of reportsResult.rows) {
        let def;
        try {
          def = typeof row.definition === 'string' ? JSON.parse(row.definition) : row.definition;
        } catch { continue; } // Skip EDN or unparseable

        const issues = validateReport(def);
        const crossIssues = validateReportCrossObject(def, schemaInfo);
        issues.push(...crossIssues);

        const errors = issues.filter(i => i.severity === 'error');
        const warnings = issues.filter(i => i.severity === 'warning');
        reportResults.push({
          name: row.name,
          valid: errors.length === 0,
          errors,
          warnings
        });
      }

      const totalErrors = formResults.reduce((s, f) => s + f.errors.length, 0)
        + reportResults.reduce((s, r) => s + r.errors.length, 0);
      const totalWarnings = formResults.reduce((s, f) => s + f.warnings.length, 0)
        + reportResults.reduce((s, r) => s + r.warnings.length, 0);

      res.json({
        forms: formResults,
        reports: reportResults,
        summary: {
          formsChecked: formResults.length,
          reportsChecked: reportResults.length,
          totalErrors,
          totalWarnings,
          valid: totalErrors === 0
        }
      });
    } catch (err) {
      console.error('Database-wide validation failed:', err);
      logError(pool, 'POST /api/lint/validate', 'Database-wide validation failed', err, { databaseId: req.databaseId });
      res.status(500).json({ error: 'Validation failed' });
    }
  });

  return router;
}

module.exports = createRouter;
module.exports.validateForm = validateForm;
module.exports.validateControl = validateControl;
module.exports.normalizeType = normalizeType;
module.exports.validateReport = validateReport;
module.exports.validateFormCrossObject = validateFormCrossObject;
module.exports.validateReportCrossObject = validateReportCrossObject;
module.exports.getSchemaInfo = getSchemaInfo;
module.exports.isReportBand = isReportBand;
