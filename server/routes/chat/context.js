/**
 * System prompt context builders and helpers for LLM chat.
 */

/**
 * Summarize a form or report definition into compact text for the LLM.
 */
function summarizeDefinition(definition, objectType) {
  if (!definition) return '';

  const name = definition.name || definition.caption || '(unnamed)';
  const recordSource = definition['record-source'] || definition.recordSource || '';
  const lines = [];

  lines.push(`${objectType === 'report' ? 'Report' : 'Form'} "${name}"${recordSource ? ` (record-source: ${recordSource})` : ''}`);

  // Form-level / report-level properties of interest
  if (objectType === 'form') {
    const dv = definition['default-view'] || definition.defaultView;
    if (dv) lines.push(`  Default view: ${dv}`);
    if (definition.filter) lines.push(`  Filter: ${definition.filter}`);
    if (definition['order-by']) lines.push(`  Order by: ${definition['order-by']}`);
    if (Number(definition.popup) === 1) lines.push(`  Popup: yes`);
    if (Number(definition.modal) === 1) lines.push(`  Modal: yes`);
  } else {
    if (definition.filter) lines.push(`  Filter: ${definition.filter}`);
    if (definition['order-by']) lines.push(`  Order by: ${definition['order-by']}`);
    const grouping = definition.grouping;
    if (Array.isArray(grouping) && grouping.length > 0) {
      lines.push(`  Grouping:`);
      grouping.forEach((g, i) => {
        const parts = [`field="${g.field || '?'}"`];
        if (g['sort-order'] || g.sortOrder) parts.push(`sort=${g['sort-order'] || g.sortOrder}`);
        if (g['group-on'] && g['group-on'] !== 'Each Value') parts.push(`group-on=${g['group-on']}`);
        lines.push(`    Level ${i}: ${parts.join(', ')}`);
      });
    }
  }

  // Determine which sections/bands to iterate
  const sectionKeys = objectType === 'form'
    ? ['header', 'detail', 'footer']
    : Object.keys(definition).filter(k =>
        ['report-header', 'page-header', 'detail', 'page-footer', 'report-footer'].includes(k) ||
        k.startsWith('group-header-') || k.startsWith('group-footer-')
      ).sort((a, b) => {
        const order = { 'report-header': 0, 'page-header': 1, 'detail': 50, 'page-footer': 90, 'report-footer': 99 };
        const rank = (k) => {
          if (order[k] !== undefined) return order[k];
          if (k.startsWith('group-header-')) return 10 + parseInt(k.split('-')[2]) || 0;
          if (k.startsWith('group-footer-')) return 60 + parseInt(k.split('-')[2]) || 0;
          return 50;
        };
        return rank(a) - rank(b);
      });

  const sectionLabel = objectType === 'form' ? 'Sections' : 'Bands';
  lines.push(`${sectionLabel}:`);

  for (const key of sectionKeys) {
    const section = definition[key];
    if (!section || typeof section !== 'object') continue;

    const height = section.height;
    const controls = section.controls || [];
    const vis = section.visible === 0 ? ' [hidden]' : '';
    lines.push(`  ${key} (height: ${height || '?'})${vis}:`);

    if (controls.length === 0) {
      lines.push(`    (no controls)`);
    } else {
      for (const ctrl of controls) {
        const type = ctrl.type || '?';
        const parts = [];
        const binding = ctrl['control-source'] || ctrl.controlSource || ctrl.field;
        if (binding) parts.push(`field="${binding}"`);
        if ((type === 'label' || type === 'button') && ctrl.caption) {
          parts.push(`"${ctrl.caption}"`);
        }
        if (ctrl.name && ctrl.name !== binding) parts.push(`name="${ctrl.name}"`);
        if (ctrl.x != null && ctrl.y != null) parts.push(`at (${ctrl.x}, ${ctrl.y})`);
        if (ctrl.width != null && ctrl.height != null) parts.push(`size ${ctrl.width}x${ctrl.height}`);
        if (type === 'subform' && ctrl['source-form-name']) {
          parts.push(`source="${ctrl['source-form-name']}"`);
        }
        if ((type === 'combo-box' || type === 'list-box') && ctrl['row-source']) {
          const rs = ctrl['row-source'];
          parts.push(`row-source="${rs.length > 60 ? rs.substring(0, 57) + '...' : rs}"`);
        }
        lines.push(`    - ${type} ${parts.join(' ')}`);
      }
    }
  }

  return lines.join('\n');
}

/**
 * Check import completeness for a database.
 */
async function checkImportCompleteness(pool, databaseId) {
  try {
    const discResult = await pool.query(
      'SELECT discovery FROM shared.source_discovery WHERE database_id = $1',
      [databaseId]
    );
    if (discResult.rows.length === 0) return { has_discovery: false, complete: true };

    const discovery = discResult.rows[0].discovery;
    const dbResult = await pool.query(
      'SELECT schema_name FROM shared.databases WHERE database_id = $1',
      [databaseId]
    );
    if (dbResult.rows.length === 0) return null;
    const schemaName = dbResult.rows[0].schema_name;

    const [tablesRes, viewsRes, routinesRes, formsRes, reportsRes, modulesRes, macrosRes] = await Promise.all([
      pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE'`, [schemaName]),
      pool.query(`SELECT table_name FROM information_schema.views WHERE table_schema = $1`, [schemaName]),
      pool.query(`SELECT routine_name FROM information_schema.routines WHERE routine_schema = $1`, [schemaName]),
      pool.query(`SELECT DISTINCT name FROM shared.forms WHERE database_id = $1 AND is_current = true`, [databaseId]),
      pool.query(`SELECT DISTINCT name FROM shared.reports WHERE database_id = $1 AND is_current = true`, [databaseId]),
      pool.query(`SELECT DISTINCT name FROM shared.modules WHERE database_id = $1 AND is_current = true`, [databaseId]),
      pool.query(`SELECT DISTINCT name FROM shared.macros WHERE database_id = $1 AND is_current = true`, [databaseId])
    ]);

    const actualTables = new Set(tablesRes.rows.map(r => r.table_name.toLowerCase()));
    const actualViews = new Set(viewsRes.rows.map(r => r.table_name.toLowerCase()));
    const actualRoutines = new Set(routinesRes.rows.map(r => r.routine_name.toLowerCase()));
    const actualForms = new Set(formsRes.rows.map(r => r.name.toLowerCase()));
    const actualReports = new Set(reportsRes.rows.map(r => r.name.toLowerCase()));
    const actualModules = new Set(modulesRes.rows.map(r => r.name.toLowerCase()));
    const actualMacros = new Set(macrosRes.rows.map(r => r.name.toLowerCase()));

    function isImported(name, set) {
      const lower = name.toLowerCase();
      return set.has(lower) || set.has(lower.replace(/\s+/g, '_'));
    }

    const missing = {};
    let missingCount = 0;
    for (const [type, srcList, actualSet] of [
      ['tables', discovery.tables || [], actualTables],
      ['queries', discovery.queries || [], new Set([...actualViews, ...actualRoutines])],
      ['forms', discovery.forms || [], actualForms],
      ['reports', discovery.reports || [], actualReports],
      ['modules', discovery.modules || [], actualModules],
      ['macros', discovery.macros || [], actualMacros]
    ]) {
      const m = srcList.filter(n => !isImported(n, actualSet));
      if (m.length > 0) { missing[type] = m; missingCount += m.length; }
    }

    return { has_discovery: true, complete: missingCount === 0, missing, missing_count: missingCount };
  } catch (err) {
    console.error('Error checking import completeness:', err.message);
    return null;
  }
}

/**
 * Format missing objects into a human-readable string for the LLM.
 */
function formatMissingList(missing) {
  const parts = [];
  for (const [type, names] of Object.entries(missing)) {
    if (names.length > 0) parts.push(`  ${type}: ${names.join(', ')}`);
  }
  return parts.join('\n');
}

/**
 * Build an app inventory string from client-provided object names.
 */
function buildAppInventory(app_objects) {
  if (!app_objects) return '';
  const parts = [];
  if (app_objects.tables?.length)  parts.push(`Tables: ${app_objects.tables.join(', ')}`);
  if (app_objects.queries?.length) parts.push(`Queries: ${app_objects.queries.join(', ')}`);
  if (app_objects.forms?.length)   parts.push(`Forms: ${app_objects.forms.join(', ')}`);
  if (app_objects.reports?.length) parts.push(`Reports: ${app_objects.reports.join(', ')}`);
  if (app_objects.modules?.length) parts.push(`Modules: ${app_objects.modules.join(', ')}`);
  if (app_objects.macros?.length)  parts.push(`Macros: ${app_objects.macros.join(', ')}`);
  if (parts.length > 0) {
    return '\n\nDatabase objects available in this application:\n' + parts.join('\n');
  }
  return '';
}

/**
 * Build a graph context of all database objects for context-aware code generation.
 * Returns { tables: [{name, columns}], views: [...], forms: [{name, record_source}], reports: [...] }
 */
async function buildGraphContext(pool, databaseId) {
  try {
    const dbResult = await pool.query(
      'SELECT schema_name FROM shared.databases WHERE database_id = $1',
      [databaseId]
    );
    if (dbResult.rows.length === 0) return null;
    const schemaName = dbResult.rows[0].schema_name;

    const [tablesRes, viewsRes, columnsRes, formsRes, reportsRes] = await Promise.all([
      pool.query(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE'`,
        [schemaName]
      ),
      pool.query(
        `SELECT table_name FROM information_schema.views WHERE table_schema = $1`,
        [schemaName]
      ),
      pool.query(
        `SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = $1 ORDER BY table_name, ordinal_position`,
        [schemaName]
      ),
      pool.query(
        `SELECT DISTINCT ON (name) name, definition->>'record-source' as record_source
         FROM shared.forms WHERE database_id = $1 AND is_current = true`,
        [databaseId]
      ),
      pool.query(
        `SELECT DISTINCT ON (name) name, definition->>'record-source' as record_source
         FROM shared.reports WHERE database_id = $1 AND is_current = true`,
        [databaseId]
      )
    ]);

    // Group columns by table
    const columnsByTable = {};
    for (const row of columnsRes.rows) {
      if (!columnsByTable[row.table_name]) columnsByTable[row.table_name] = [];
      columnsByTable[row.table_name].push({ name: row.column_name, type: row.data_type });
    }

    const tableNames = new Set(tablesRes.rows.map(r => r.table_name));
    const viewNames = new Set(viewsRes.rows.map(r => r.table_name));

    return {
      tables: tablesRes.rows.map(r => ({
        name: r.table_name,
        columns: columnsByTable[r.table_name] || []
      })),
      views: viewsRes.rows.map(r => ({
        name: r.table_name,
        columns: columnsByTable[r.table_name] || []
      })),
      forms: formsRes.rows.map(r => ({
        name: r.name,
        record_source: r.record_source
      })),
      reports: reportsRes.rows.map(r => ({
        name: r.name,
        record_source: r.record_source
      }))
    };
  } catch (err) {
    console.error('Error building graph context:', err.message);
    return null;
  }
}

/**
 * Format graph context into a compact text block for the LLM system prompt.
 */
function formatGraphContext(graphContext) {
  if (!graphContext) return '';
  const parts = [];

  if (graphContext.tables?.length) {
    parts.push('Tables:');
    for (const t of graphContext.tables) {
      const cols = t.columns.map(c => `${c.name} (${c.type})`).join(', ');
      parts.push(`  ${t.name}: ${cols}`);
    }
  }
  if (graphContext.views?.length) {
    parts.push('Views:');
    for (const v of graphContext.views) {
      const cols = v.columns.map(c => `${c.name} (${c.type})`).join(', ');
      parts.push(`  ${v.name}: ${cols}`);
    }
  }
  if (graphContext.forms?.length) {
    parts.push('Forms:');
    for (const f of graphContext.forms) {
      parts.push(`  ${f.name}${f.record_source ? ` (record-source: ${f.record_source})` : ''}`);
    }
  }
  if (graphContext.reports?.length) {
    parts.push('Reports:');
    for (const r of graphContext.reports) {
      parts.push(`  ${r.name}${r.record_source ? ` (record-source: ${r.record_source})` : ''}`);
    }
  }

  return parts.join('\n');
}

module.exports = {
  summarizeDefinition, checkImportCompleteness, formatMissingList, buildAppInventory,
  buildGraphContext, formatGraphContext
};
