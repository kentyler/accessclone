/**
 * System prompt context builders and helpers for LLM chat.
 */

/**
 * Summarize a form or report definition into compact text for the LLM.
 */
function summarizeDefinition(definition, objectType, objectName) {
  if (!definition) return '';

  const name = objectName || definition.name || definition.caption || '(unnamed)';
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
      pool.query(`SELECT DISTINCT name FROM shared.objects WHERE database_id = $1 AND type = 'form' AND is_current = true`, [databaseId]),
      pool.query(`SELECT DISTINCT name FROM shared.objects WHERE database_id = $1 AND type = 'report' AND is_current = true`, [databaseId]),
      pool.query(`SELECT DISTINCT name FROM shared.objects WHERE database_id = $1 AND type = 'module' AND is_current = true`, [databaseId]),
      pool.query(`SELECT DISTINCT name FROM shared.objects WHERE database_id = $1 AND type = 'macro' AND is_current = true`, [databaseId])
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
        `SELECT DISTINCT ON (name) name, record_source
         FROM shared.objects WHERE database_id = $1 AND type = 'form' AND is_current = true`,
        [databaseId]
      ),
      pool.query(
        `SELECT DISTINCT ON (name) name, record_source
         FROM shared.objects WHERE database_id = $1 AND type = 'report' AND is_current = true`,
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

/**
 * Check whether a module's mapped intents reference objects that exist in the graph.
 * Returns { satisfied: boolean, missing: [{type, name}] }.
 */
function checkIntentDependencies(mappedIntents, graphContext) {
  if (!mappedIntents || !graphContext) return { satisfied: true, missing: [] };

  const missing = [];
  const allTables = new Set([
    ...graphContext.tables.map(t => t.name.toLowerCase()),
    ...graphContext.views.map(v => v.name.toLowerCase())
  ]);
  const allForms = new Set(graphContext.forms.map(f => f.name.toLowerCase()));
  const allReports = new Set(graphContext.reports.map(r => r.name.toLowerCase()));

  function scan(intents) {
    for (const intent of (intents || [])) {
      // Forms
      if ((intent.type === 'open-form' || intent.type === 'open-form-filtered') && intent.form) {
        if (!allForms.has(intent.form.toLowerCase()))
          missing.push({ type: 'form', name: intent.form });
      }
      // Reports
      if (intent.type === 'open-report' && intent.report) {
        if (!allReports.has(intent.report.toLowerCase()))
          missing.push({ type: 'report', name: intent.report });
      }
      // Tables (DLookup, DCount, DSum, set-record-source)
      if (['dlookup', 'dcount', 'dsum'].includes(intent.type) && intent.table) {
        const normalized = intent.table.toLowerCase().replace(/\s+/g, '_');
        if (!allTables.has(normalized) && !allTables.has(intent.table.toLowerCase()))
          missing.push({ type: 'table', name: intent.table });
      }
      if (intent.type === 'set-record-source' && intent.record_source) {
        const normalized = intent.record_source.toLowerCase().replace(/\s+/g, '_');
        if (!allTables.has(normalized) && !allTables.has(intent.record_source.toLowerCase()))
          missing.push({ type: 'table', name: intent.record_source });
      }
      // Recurse
      if (intent.then) scan(intent.then);
      if (intent.else) scan(intent.else);
      if (intent.children) scan(intent.children);
    }
  }

  for (const proc of (mappedIntents?.procedures || [])) {
    scan(proc.intents);
  }

  // Deduplicate
  const unique = [...new Map(missing.map(m => [`${m.type}:${m.name}`, m])).values()];
  return { satisfied: unique.length === 0, missing: unique };
}

/**
 * Auto-resolve gap intents when referenced objects exist in the graph.
 * Returns { resolved_count, remaining_gaps }.
 */
function autoResolveGaps(mappedIntents, graphContext) {
  if (!mappedIntents || !graphContext) return { resolved_count: 0, remaining_gaps: 0 };

  const allTables = new Set([
    ...graphContext.tables.map(t => t.name.toLowerCase()),
    ...graphContext.views.map(v => v.name.toLowerCase())
  ]);
  const allForms = new Set(graphContext.forms.map(f => f.name.toLowerCase()));

  let resolvedCount = 0;
  let remainingGaps = 0;

  function tryResolve(intents) {
    for (const intent of (intents || [])) {
      if (intent.type === 'gap' && !intent.resolution) {
        let resolved = false;
        const reason = (intent.reason || '').toLowerCase();
        const vbaLine = (intent.vba_line || '').toLowerCase();

        // Check for DLookup/DCount/DSum referencing existing tables
        if (/dlookup|dcount|dsum/.test(reason) || /dlookup|dcount|dsum/.test(vbaLine)) {
          const tableMatch = (intent.vba_line || '').match(/["'](\w[\w\s]*?)["']/);
          if (tableMatch) {
            const tableName = tableMatch[1].toLowerCase().replace(/\s+/g, '_');
            if (allTables.has(tableName) || allTables.has(tableMatch[1].toLowerCase())) {
              intent.resolution = {
                answer: `Use API call to /api/data/${tableName}`,
                custom_notes: 'Auto-resolved: table exists in database',
                resolved_at: new Date().toISOString(),
                resolved_by: 'auto'
              };
              resolved = true;
            }
          }
        }

        // Check for form references
        if (!resolved && (/openform|doCmd\.openform/i.test(reason) || /openform|doCmd\.openform/i.test(vbaLine))) {
          const formMatch = (intent.vba_line || '').match(/["'](\w[\w\s]*?)["']/);
          if (formMatch && allForms.has(formMatch[1].toLowerCase())) {
            intent.resolution = {
              answer: 'Use state/open-object!',
              custom_notes: 'Auto-resolved: form exists in database',
              resolved_at: new Date().toISOString(),
              resolved_by: 'auto'
            };
            resolved = true;
          }
        }

        // Check for RunSQL referencing existing tables
        if (!resolved && (/runsql/i.test(reason) || /runsql/i.test(vbaLine))) {
          const tableMatch = (intent.vba_line || '').match(/(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+[[\]"']?(\w[\w\s]*?)[[\]"']?\s/i);
          if (tableMatch) {
            const tableName = tableMatch[1].toLowerCase().replace(/\s+/g, '_');
            if (allTables.has(tableName) || allTables.has(tableMatch[1].toLowerCase())) {
              intent.resolution = {
                answer: `Use API POST to /api/data/${tableName}`,
                custom_notes: 'Auto-resolved: table exists in database',
                resolved_at: new Date().toISOString(),
                resolved_by: 'auto'
              };
              resolved = true;
            }
          }
        }

        if (resolved) resolvedCount++;
        else remainingGaps++;
      }
      // Recurse
      if (intent.then) tryResolve(intent.then);
      if (intent.else) tryResolve(intent.else);
      if (intent.children) tryResolve(intent.children);
    }
  }

  for (const proc of (mappedIntents?.procedures || [])) {
    tryResolve(proc.intents);
  }

  return { resolved_count: resolvedCount, remaining_gaps: remainingGaps };
}

/**
 * Auto-resolve gap questions via LLM.
 * Sends gap questions in batches to Claude, returns array of { index, selected }.
 * Reusable by both the chat endpoint and import pipeline.
 */
async function autoResolveGapsLLM(gapQuestions, graphContext, apiKey) {
  if (!gapQuestions || gapQuestions.length === 0) return [];

  let inventoryText = '';
  if (graphContext) {
    inventoryText = formatGraphContext(graphContext);
  }

  const BATCH_SIZE = 80;
  const allSelections = [];

  for (let batchStart = 0; batchStart < gapQuestions.length; batchStart += BATCH_SIZE) {
    const batch = gapQuestions.slice(batchStart, batchStart + BATCH_SIZE);

    const gapLines = batch.map((gq, i) => {
      const globalIdx = batchStart + i;
      const opts = (gq.suggestions || []).map((s, j) => `  ${j + 1}. ${s}`).join('\n');
      return `[Gap ${globalIdx}] Module: ${gq.module || '?'}, Procedure: ${gq.procedure || '?'}
VBA: ${gq.vba_line || '(unknown)'}
Question: ${gq.question}
Options:
${opts}`;
    }).join('\n\n');

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        system: `You are an expert at converting Microsoft Access applications to modern web applications.

You are given a list of "gap questions" — decisions that need to be made during the conversion from VBA to a web app. For each gap, you must pick the best option from the numbered suggestions.

${inventoryText ? `Database inventory:\n${inventoryText}\n\n` : ''}Consider the database context and pick the option that best preserves the original Access application's behavior in a web environment. Prefer options that use existing framework functions, API endpoints, or table data over options that skip functionality.

Respond with ONLY a JSON array of objects, each with "index" (the gap number) and "selected" (the exact text of the chosen option). Example:
[{"index": 0, "selected": "Use API call to fetch data"}, {"index": 1, "selected": "Skip this functionality"}]

No explanation, no markdown fences — just the JSON array.`,
        messages: [{
          role: 'user',
          content: `Pick the best option for each gap question:\n\n${gapLines}`
        }]
      })
    });

    if (!response.ok) {
      const errorData = await response.json();
      console.error('Anthropic API error in auto-resolve:', errorData);
      throw new Error(errorData.error?.message || 'Auto-resolve API request failed');
    }

    const data = await response.json();
    const text = data.content?.find(c => c.type === 'text')?.text || '[]';

    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
    try {
      const parsed = JSON.parse(cleaned);
      if (Array.isArray(parsed)) {
        for (const sel of parsed) {
          const gq = gapQuestions[sel.index];
          if (gq && gq.suggestions?.includes(sel.selected)) {
            allSelections.push(sel);
          } else if (gq) {
            const match = gq.suggestions?.find(s =>
              s.toLowerCase().trim() === (sel.selected || '').toLowerCase().trim()
            );
            if (match) {
              allSelections.push({ index: sel.index, selected: match });
            }
          }
        }
      }
    } catch (parseErr) {
      console.error('Failed to parse auto-resolve response:', parseErr.message, text.substring(0, 200));
    }
  }

  return allSelections;
}

/**
 * Load extracted business intents for a form, report, or query.
 *
 * @param {Object} pool - PG pool
 * @param {'form'|'report'|'query'} objectType
 * @param {string} objectName
 * @param {string} databaseId
 * @returns {Promise<Object|null>} The intents JSONB or null
 */
async function loadObjectIntents(pool, objectType, objectName, databaseId) {
  try {
    let result;
    if (objectType === 'form' || objectType === 'report') {
      // Load from shared.intents via object lookup
      result = await pool.query(
        `SELECT i.content as intents FROM shared.intents i
         JOIN shared.objects o ON o.id = i.object_id
         WHERE o.database_id = $1 AND o.type = $2 AND o.name = $3 AND o.is_current = true
           AND i.intent_type = CASE WHEN $2 = 'module' THEN 'gesture' ELSE 'business' END
         ORDER BY i.created_at DESC LIMIT 1`,
        [databaseId, objectType, objectName]
      );
    } else if (objectType === 'query') {
      result = await pool.query(
        `SELECT intents FROM shared.view_metadata
         WHERE database_id = $1 AND view_name = $2 AND intents IS NOT NULL
         LIMIT 1`,
        [databaseId, objectName]
      );
    }
    return result?.rows[0]?.intents || null;
  } catch (err) {
    console.error(`Error loading intents for ${objectType} "${objectName}":`, err.message);
    return null;
  }
}

/**
 * Load extracted structure intents for a form.
 *
 * @param {Object} pool - PG pool
 * @param {string} formName
 * @param {string} databaseId
 * @returns {Promise<Object|null>} The structure intent JSONB or null
 */
async function loadStructureIntents(pool, formName, databaseId) {
  try {
    const result = await pool.query(
      `SELECT i.content as intents FROM shared.intents i
       JOIN shared.objects o ON o.id = i.object_id
       WHERE o.database_id = $1 AND o.type = 'form' AND o.name = $2 AND o.is_current = true
         AND i.intent_type = 'structure'
       ORDER BY i.created_at DESC LIMIT 1`,
      [databaseId, formName]
    );
    return result?.rows[0]?.intents || null;
  } catch (err) {
    console.error(`Error loading structure intents for form "${formName}":`, err.message);
    return null;
  }
}

/**
 * Format extracted intents into a compact text block for the LLM system prompt.
 */
function formatObjectIntents(intents) {
  if (!intents) return '';
  const parts = [];
  if (intents.purpose) parts.push(`Business purpose: ${intents.purpose}`);
  if (intents.category) parts.push(`Category: ${intents.category}`);
  if (intents.entities?.length) parts.push(`Entities: ${intents.entities.join(', ')}`);
  if (intents.data_flows?.length) {
    parts.push('Data flows:');
    for (const f of intents.data_flows) {
      parts.push(`  ${f.direction} ${f.target} — ${f.via}`);
    }
  }
  if (intents.workflows?.length) {
    parts.push('User workflows:');
    for (const w of intents.workflows) {
      parts.push(`  - ${w}`);
    }
  }
  if (intents.grouping_purpose) parts.push(`Grouping purpose: ${intents.grouping_purpose}`);
  if (intents.consumers?.length) {
    parts.push('Consumers:');
    for (const c of intents.consumers) {
      parts.push(`  ${c.type} "${c.name}" — ${c.usage}`);
    }
  }
  if (intents.gaps?.length) {
    parts.push('Known gaps:');
    for (const g of intents.gaps) {
      parts.push(`  [${g.severity}] ${g.finding}`);
    }
  }
  return parts.join('\n');
}

/**
 * Format structure intents into a compact text block for the LLM system prompt.
 * Gives the LLM awareness of this form's architectural pattern, subpatterns,
 * layout characteristics, and navigation relationships.
 */
function formatStructureIntents(structure) {
  if (!structure) return '';
  const parts = [];

  if (structure.pattern) {
    parts.push(`Pattern archetype: ${structure.pattern}${structure.confidence ? ` (confidence: ${structure.confidence})` : ''}`);
  }
  if (structure.evidence) parts.push(`Evidence: ${structure.evidence}`);

  if (structure.subpatterns?.length) {
    parts.push('Subpatterns:');
    for (const sp of structure.subpatterns) {
      const ctrls = sp.controls?.length ? ` [${sp.controls.join(', ')}]` : '';
      parts.push(`  ${sp.type}${ctrls} — ${sp.mechanism || ''}`);
    }
  }

  if (structure.layout) {
    const l = structure.layout;
    const layoutParts = [];
    if (l.style) layoutParts.push(l.style);
    if (l.continuous) layoutParts.push('continuous');
    if (l.estimated_density) layoutParts.push(l.estimated_density);
    if (layoutParts.length) parts.push(`Layout: ${layoutParts.join(', ')}`);
  }

  if (structure.navigation) {
    const nav = structure.navigation;
    if (nav.opens?.length) {
      parts.push('Opens:');
      for (const o of nav.opens) {
        parts.push(`  ${o.target_type} "${o.target_name}" via ${o.trigger} (${o.mechanism})`);
      }
    }
    if (nav.opened_from?.length) {
      parts.push(`Opened from: ${nav.opened_from.join(', ')}`);
    }
    if (nav.data_handoff && nav.data_handoff !== 'none') {
      parts.push(`Data handoff: ${nav.data_handoff}`);
    }
  }

  if (structure.record_interaction) {
    const ri = structure.record_interaction;
    const caps = [];
    if (ri.mode) caps.push(`mode=${ri.mode}`);
    if (ri.creates_records) caps.push('creates');
    if (ri.edits_records) caps.push('edits');
    if (ri.deletes_records) caps.push('deletes');
    if (ri.navigates_records) caps.push('navigates');
    if (caps.length) parts.push(`Record interaction: ${caps.join(', ')}`);
  }

  if (structure.similar_forms?.length) {
    parts.push(`Similar forms: ${structure.similar_forms.join(', ')}`);
  }

  return parts.join('\n');
}

module.exports = {
  summarizeDefinition, checkImportCompleteness, formatMissingList, buildAppInventory,
  buildGraphContext, formatGraphContext, checkIntentDependencies, autoResolveGaps,
  autoResolveGapsLLM, loadObjectIntents, loadStructureIntents, formatObjectIntents, formatStructureIntents
};
