/**
 * Form & Report Linting API
 * Validates form/report definitions and returns errors/warnings
 * Includes cross-object validation against database schema
 */

const express = require('express');
const router = express.Router();
const { logError } = require('../lib/events');

// Validation rules
const VALID_CONTROL_TYPES = [
  'label', 'text-box', 'button', 'check-box', 'combo-box',
  'line', 'rectangle', 'image', 'list-box', 'option-group', 'option-button',
  'toggle-button', 'tab-control', 'subform', 'page'
];

const REQUIRED_FORM_FIELDS = ['id', 'name', 'record-source'];
const REQUIRED_CONTROL_FIELDS = ['type', 'x', 'y', 'width', 'height'];
const REQUIRED_REPORT_FIELDS = ['id', 'name', 'record-source'];

function normalizeType(type) {
  if (!type) return null;
  return type.toString().replace(/^:/, '');
}

function validateControl(control, sectionName, index, errors, formName) {
  const prefix = `${sectionName} > control[${index}]`;
  const type = normalizeType(control.type);

  // Check required fields
  for (const field of REQUIRED_CONTROL_FIELDS) {
    const key = field.replace('-', '_'); // Handle kebab vs snake case
    if (control[field] === undefined && control[key] === undefined) {
      errors.push({
        severity: 'error',
        location: prefix,
        message: `Missing required field '${field}'`,
        field: field
      });
    }
  }

  // Check type is valid
  if (type && !VALID_CONTROL_TYPES.includes(type)) {
    errors.push({
      severity: 'error',
      location: prefix,
      message: `Invalid control type '${type}'`,
      field: 'type',
      validValues: VALID_CONTROL_TYPES
    });
  }

  // Type-specific validation
  if (type === 'text-box' && !control.field) {
    errors.push({
      severity: 'warning',
      location: prefix,
      message: "text-box should have 'field' property for data binding",
      field: 'field',
      suggestion: 'Add a field property to bind this control to a database column'
    });
  }

  if (type === 'label' && !control.text) {
    errors.push({
      severity: 'warning',
      location: prefix,
      message: "label should have 'text' property",
      field: 'text'
    });
  }

  if (type === 'image' && !control.picture) {
    errors.push({
      severity: 'warning',
      location: prefix,
      message: "image should have 'picture' property for image source",
      field: 'picture'
    });
  }

  if (type === 'subform' && !control['source-form'] && !control.source_form) {
    errors.push({
      severity: 'warning',
      location: prefix,
      message: "subform should have 'source-form' property",
      field: 'source-form'
    });
  }

  if (type === 'option-group' && !control.options) {
    errors.push({
      severity: 'warning',
      location: prefix,
      message: "option-group should have 'options' property",
      field: 'options'
    });
  }

  if (type === 'tab-control' && !control.pages) {
    errors.push({
      severity: 'warning',
      location: prefix,
      message: "tab-control should have 'pages' property",
      field: 'pages'
    });
  }

  // Check numeric fields
  for (const field of ['x', 'y', 'width', 'height']) {
    const value = control[field];
    if (value !== undefined && typeof value !== 'number') {
      errors.push({
        severity: 'error',
        location: prefix,
        message: `'${field}' should be a number, got ${typeof value}`,
        field: field
      });
    }
  }

  // Check for non-positive dimensions
  if (control.width !== undefined && control.width <= 0) {
    errors.push({
      severity: 'error',
      location: prefix,
      message: "'width' should be positive",
      field: 'width'
    });
  }
  if (control.height !== undefined && control.height <= 0) {
    errors.push({
      severity: 'error',
      location: prefix,
      message: "'height' should be positive",
      field: 'height'
    });
  }
}

function validateSection(section, sectionName, errors, formName) {
  if (!section) return;

  if (typeof section !== 'object') {
    errors.push({
      severity: 'error',
      location: sectionName,
      message: 'Section should be an object'
    });
    return;
  }

  // Check height
  if (section.height === undefined) {
    errors.push({
      severity: 'error',
      location: sectionName,
      message: "Missing 'height' property",
      field: 'height'
    });
  } else if (typeof section.height !== 'number') {
    errors.push({
      severity: 'error',
      location: sectionName,
      message: "'height' should be a number",
      field: 'height'
    });
  } else if (section.height < 0) {
    errors.push({
      severity: 'error',
      location: sectionName,
      message: "'height' should not be negative",
      field: 'height'
    });
  }

  // Check controls
  if (section.controls === undefined) {
    errors.push({
      severity: 'error',
      location: sectionName,
      message: "Missing 'controls' array",
      field: 'controls'
    });
  } else if (!Array.isArray(section.controls)) {
    errors.push({
      severity: 'error',
      location: sectionName,
      message: "'controls' should be an array",
      field: 'controls'
    });
  } else {
    section.controls.forEach((ctrl, i) => {
      validateControl(ctrl, sectionName, i, errors, formName);
    });
  }
}

function validateForm(form) {
  const issues = [];
  const formName = form.name || 'Untitled';

  if (!form || typeof form !== 'object') {
    issues.push({
      severity: 'error',
      location: 'form',
      message: 'Form definition should be an object'
    });
    return issues;
  }

  // Check required top-level fields
  for (const field of REQUIRED_FORM_FIELDS) {
    const key = field.replace('-', '_');
    if (form[field] === undefined && form[key] === undefined) {
      issues.push({
        severity: 'error',
        location: 'form',
        message: `Missing required field '${field}'`,
        field: field
      });
    }
  }

  // Check for old flat controls structure
  if (form.controls && !form.detail) {
    issues.push({
      severity: 'error',
      location: 'form',
      message: "Uses old flat 'controls' structure - needs migration to sections",
      suggestion: 'Move controls into header/detail/footer sections'
    });
  }

  // Validate sections
  const hasSections = form.header || form.detail || form.footer;
  if (!hasSections && !form.controls) {
    issues.push({
      severity: 'warning',
      location: 'form',
      message: 'No sections or controls defined'
    });
  }

  if (hasSections) {
    validateSection(form.header, 'header', issues, formName);
    validateSection(form.detail, 'detail', issues, formName);
    validateSection(form.footer, 'footer', issues, formName);
  }

  return issues;
}

// ============================================================
// REPORT STRUCTURAL VALIDATION
// ============================================================

const STANDARD_REPORT_BANDS = [
  'report-header', 'page-header', 'detail', 'page-footer', 'report-footer'
];

function isReportBand(key) {
  if (STANDARD_REPORT_BANDS.includes(key)) return true;
  if (/^group-header-\d+$/.test(key)) return true;
  if (/^group-footer-\d+$/.test(key)) return true;
  return false;
}

function validateReport(report) {
  const issues = [];
  const reportName = report.name || 'Untitled';

  if (!report || typeof report !== 'object') {
    issues.push({
      severity: 'error',
      location: 'report',
      message: 'Report definition should be an object'
    });
    return issues;
  }

  // Check required top-level fields
  for (const field of REQUIRED_REPORT_FIELDS) {
    const key = field.replace('-', '_');
    if (report[field] === undefined && report[key] === undefined) {
      issues.push({
        severity: 'error',
        location: 'report',
        message: `Missing required field '${field}'`,
        field: field
      });
    }
  }

  // Find and validate all band sections
  let hasBands = false;
  for (const key of Object.keys(report)) {
    if (isReportBand(key)) {
      hasBands = true;
      validateSection(report[key], key, issues, reportName);
    }
  }

  if (!hasBands) {
    issues.push({
      severity: 'warning',
      location: 'report',
      message: 'No band sections defined (expected detail, report-header, etc.)'
    });
  }

  return issues;
}

// ============================================================
// CROSS-OBJECT VALIDATION (schema-aware)
// ============================================================

/**
 * Fetch schema info: Map<tableName, columnName[]> (all lowercased)
 * Includes both tables and views.
 */
async function getSchemaInfo(pool, schemaName) {
  const schema = new Map();

  // Get all tables and views
  const tablesResult = await pool.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = $1
      AND table_type IN ('BASE TABLE', 'VIEW')
    ORDER BY table_name
  `, [schemaName]);

  for (const row of tablesResult.rows) {
    const tableName = row.table_name.toLowerCase();
    const colsResult = await pool.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2
      ORDER BY ordinal_position
    `, [schemaName, row.table_name]);

    schema.set(tableName, colsResult.rows.map(r => r.column_name.toLowerCase()));
  }

  return schema;
}

/**
 * Get all field bindings from a control (checks both field and control-source).
 * Returns null for expression control-sources (starting with '=') since
 * those are computed values, not direct field references.
 */
function getControlField(control) {
  const cs = control['control-source'] || control.control_source;
  if (cs && typeof cs === 'string' && cs.startsWith('=')) {
    return null; // Expression — skip field validation
  }
  let field = cs || control.field || null;
  // Expressions can also end up in .field from older imports
  if (field && typeof field === 'string' && field.startsWith('=')) {
    return null;
  }
  // Strip Access table qualifier (e.g. "ingredient.ingredient" → "ingredient")
  if (field && typeof field === 'string' && field.includes('.')) {
    field = field.substring(field.indexOf('.') + 1);
  }
  return field;
}

/**
 * Cross-object validation for forms against database schema.
 * schemaInfo is a Map<tableName, columnName[]>.
 */
function validateFormCrossObject(form, schemaInfo) {
  const issues = [];
  const recordSource = (form['record-source'] || form.record_source || '').toLowerCase();

  if (!recordSource) return issues;

  // Check record-source exists as a table or view
  if (!schemaInfo.has(recordSource)) {
    const available = Array.from(schemaInfo.keys()).slice(0, 10);
    issues.push({
      severity: 'error',
      location: 'form',
      message: `Record source '${recordSource}' not found in database`,
      field: 'record-source',
      suggestion: `Available tables/views: ${available.join(', ')}${schemaInfo.size > 10 ? '...' : ''}`
    });
    return issues; // Can't check field bindings without a valid source
  }

  const columns = schemaInfo.get(recordSource);

  // Check field bindings in all sections
  for (const sectionName of ['header', 'detail', 'footer']) {
    const section = form[sectionName];
    if (!section || !Array.isArray(section.controls)) continue;

    section.controls.forEach((ctrl, i) => {
      const field = getControlField(ctrl);
      if (field && !columns.includes(field.toLowerCase())) {
        issues.push({
          severity: 'error',
          location: `${sectionName} > control[${i}]`,
          message: `Field '${field}' not found in '${recordSource}'`,
          field: 'field',
          suggestion: `Available columns: ${columns.join(', ')}`
        });
      }
    });
  }

  return issues;
}

/**
 * Validate combo-box row-source SQL using EXPLAIN (parse without executing).
 * Requires pool and schemaName for database access.
 */
async function validateComboBoxSql(form, pool, schemaName) {
  const issues = [];

  for (const sectionName of ['header', 'detail', 'footer']) {
    const section = form[sectionName];
    if (!section || !Array.isArray(section.controls)) continue;

    for (let i = 0; i < section.controls.length; i++) {
      const ctrl = section.controls[i];
      const type = normalizeType(ctrl.type);
      const rowSource = ctrl['row-source'] || ctrl.row_source;

      // Only validate SQL row-sources (strings that look like queries)
      if (type === 'combo-box' && typeof rowSource === 'string' && /^\s*SELECT/i.test(rowSource)) {
        try {
          await pool.query(`EXPLAIN ${rowSource}`);
        } catch (err) {
          issues.push({
            severity: 'error',
            location: `${sectionName} > control[${i}]`,
            message: `Invalid row-source SQL: ${err.message}`,
            field: 'row-source'
          });
        }
      }
    }
  }

  return issues;
}

/**
 * Cross-object validation for reports against database schema.
 * Same checks as forms but iterates all band sections.
 */
function validateReportCrossObject(report, schemaInfo) {
  const issues = [];
  const recordSource = (report['record-source'] || report.record_source || '').toLowerCase();

  if (!recordSource) return issues;

  // Check record-source exists
  if (!schemaInfo.has(recordSource)) {
    const available = Array.from(schemaInfo.keys()).slice(0, 10);
    issues.push({
      severity: 'error',
      location: 'report',
      message: `Record source '${recordSource}' not found in database`,
      field: 'record-source',
      suggestion: `Available tables/views: ${available.join(', ')}${schemaInfo.size > 10 ? '...' : ''}`
    });
    return issues;
  }

  const columns = schemaInfo.get(recordSource);

  // Check field bindings in all band sections
  for (const key of Object.keys(report)) {
    if (!isReportBand(key)) continue;
    const section = report[key];
    if (!section || !Array.isArray(section.controls)) continue;

    section.controls.forEach((ctrl, i) => {
      const field = getControlField(ctrl);
      if (field && !columns.includes(field.toLowerCase())) {
        issues.push({
          severity: 'error',
          location: `${key} > control[${i}]`,
          message: `Field '${field}' not found in '${recordSource}'`,
          field: 'field',
          suggestion: `Available columns: ${columns.join(', ')}`
        });
      }
    });
  }

  return issues;
}

// ============================================================
// ROUTER
// ============================================================

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
