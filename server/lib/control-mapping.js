/**
 * Control-Column Mapping
 * Populates shared.control_column_map from form/report definitions.
 * Maps (database_id, form_name, control_name) → (table_name, column_name)
 * so the query converter can resolve [Forms]![frmX]![ctrlY] at conversion time.
 */

const { sanitizeName } = require('./query-converter');

/**
 * Populate the control_column_map for a form or report.
 *
 * For each control:
 *   - Bound (has :field) → table_name = record-source, column_name = field
 *   - Unbound (no :field, no :control-source or expression) → table_name = form name, column_name = control name
 *   - Expression controls (control-source starts with "=") → skipped
 *
 * @param {object} pool - PostgreSQL connection pool
 * @param {string} databaseId - Target database ID
 * @param {string} formOrReportName - Form or report name
 * @param {string} definitionJson - JSON string of the definition
 */
async function populateControlColumnMap(pool, databaseId, formOrReportName, definitionJson) {
  let definition;
  try {
    definition = typeof definitionJson === 'string' ? JSON.parse(definitionJson) : definitionJson;
  } catch (e) {
    return; // can't parse — skip silently
  }

  const formName = sanitizeName(formOrReportName);
  const recordSource = sanitizeName(
    definition['record-source'] || definition['record_source'] || ''
  );

  // Collect all controls across all sections
  const controls = [];

  // Forms have header/detail/footer; reports have banded sections
  for (const [key, section] of Object.entries(definition)) {
    if (section && typeof section === 'object' && Array.isArray(section.controls)) {
      controls.push(...section.controls);
    }
  }

  // Build mapping entries
  const entries = [];
  for (const ctrl of controls) {
    const ctrlName = sanitizeName(ctrl.name || ctrl.id || '');
    if (!ctrlName) continue;

    const field = ctrl.field;
    const controlSource = ctrl['control-source'];

    if (field) {
      // Bound control: maps to record-source table + field column
      const tableName = recordSource || formName;
      const columnName = sanitizeName(field);
      entries.push({ ctrlName, tableName, columnName });
    } else if (controlSource && typeof controlSource === 'string' && controlSource.startsWith('=')) {
      // Expression control — skip
      continue;
    } else {
      // Unbound control: use form name as pseudo-table, control name as column
      entries.push({ ctrlName, tableName: formName, columnName: ctrlName });
    }
  }

  if (entries.length === 0) {
    // Still delete old mappings for this form
    await pool.query(
      'DELETE FROM shared.control_column_map WHERE database_id = $1 AND form_name = $2',
      [databaseId, formName]
    );
    return;
  }

  // Delete existing mappings for this form, then insert new ones
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'DELETE FROM shared.control_column_map WHERE database_id = $1 AND form_name = $2',
      [databaseId, formName]
    );

    // Batch insert
    const values = [];
    const rows = [];
    let idx = 1;
    for (const entry of entries) {
      rows.push(`($${idx}, $${idx + 1}, $${idx + 2}, $${idx + 3}, $${idx + 4})`);
      values.push(databaseId, formName, entry.ctrlName, entry.tableName, entry.columnName);
      idx += 5;
    }

    await client.query(
      `INSERT INTO shared.control_column_map (database_id, form_name, control_name, table_name, column_name)
       VALUES ${rows.join(', ')}
       ON CONFLICT (database_id, form_name, control_name) DO UPDATE
       SET table_name = EXCLUDED.table_name, column_name = EXCLUDED.column_name`,
      values
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { populateControlColumnMap };
