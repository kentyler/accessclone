/**
 * Cross-object validation — schema-aware checks that verify
 * form/report definitions against the actual database schema.
 * Requires pool for database access.
 */

const { normalizeType, isReportBand } = require('./structural');

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
 * Get field binding from a control (checks both field and control-source).
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

module.exports = {
  getSchemaInfo, getControlField,
  validateFormCrossObject, validateComboBoxSql, validateReportCrossObject
};
