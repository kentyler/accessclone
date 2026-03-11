/**
 * Pass 4: Auto-Fix — LLM-powered pass that reads issues from passes 2-3,
 * attempts to fix them (deterministic + LLM), validates results, and logs outcomes.
 * POST /autofix-pass
 */

const { logError } = require('../../lib/events');
const { getSchemaInfo, validateFormCrossObject, validateReportCrossObject } = require('../lint');
const { validateForm, validateReport } = require('../lint');

module.exports = function(router, pool, secrets) {

  router.post('/autofix-pass', async (req, res) => {
    try {
      const { run_id, database_id } = req.body;
      if (!database_id) {
        return res.status(400).json({ error: 'database_id is required' });
      }

      // Look up schema
      const dbResult = await pool.query(
        'SELECT schema_name FROM shared.databases WHERE database_id = $1',
        [database_id]
      );
      if (dbResult.rows.length === 0) {
        return res.status(404).json({ error: 'Database not found' });
      }
      const schemaName = dbResult.rows[0].schema_name;
      const schemaInfo = await getSchemaInfo(pool, schemaName);

      // Build a flat list of all table names for record-source inference
      const allTables = [...schemaInfo.keys()];

      // Load issues from passes 2-3
      let issues = [];
      if (run_id) {
        const issueRes = await pool.query(`
          SELECT id, source_object_name, source_object_type, severity, category, message, suggestion
          FROM shared.import_log
          WHERE run_id = $1 AND pass_number IN (2, 3)
            AND severity IN ('warning', 'error')
            AND (resolved IS NULL OR resolved = false)
        `, [run_id]);
        issues = issueRes.rows;
      }

      if (issues.length === 0) {
        await logPassCompletion(pool, run_id, database_id, 0, 0, 0);
        return res.json({ fixed: 0, skipped: 0, failed: 0, results: [] });
      }

      // Filter to actionable issues
      const actionable = issues.filter(isActionable);

      // Load current form and report definitions
      const [formsRes, reportsRes] = await Promise.all([
        pool.query(`SELECT id, name, definition, record_source, database_id FROM shared.forms WHERE database_id = $1 AND is_current = true AND owner = 'standard'`, [database_id]),
        pool.query(`SELECT id, name, definition, record_source, database_id FROM shared.reports WHERE database_id = $1 AND is_current = true AND owner = 'standard'`, [database_id])
      ]);

      const formsByName = new Map();
      for (const f of formsRes.rows) formsByName.set(f.name.toLowerCase(), f);
      const reportsByName = new Map();
      for (const r of reportsRes.rows) reportsByName.set(r.name.toLowerCase(), r);

      // Group actionable issues by object
      const byObject = new Map();
      for (const issue of actionable) {
        const key = `${issue.source_object_type}::${issue.source_object_name}`;
        if (!byObject.has(key)) byObject.set(key, []);
        byObject.get(key).push(issue);
      }

      const apiKey = secrets?.anthropic?.api_key || process.env.ANTHROPIC_API_KEY;

      let totalFixed = 0;
      let totalSkipped = 0;
      let totalFailed = 0;
      const results = [];

      // ---- Per-object fix loop ----
      for (const [key, objectIssues] of byObject) {
        const [objectType, objectName] = key.split('::');

        try {
          let row, definition;
          if (objectType === 'form') {
            row = formsByName.get(objectName.toLowerCase());
          } else if (objectType === 'report') {
            row = reportsByName.get(objectName.toLowerCase());
          }

          if (!row || !row.definition) {
            totalSkipped += objectIssues.length;
            continue;
          }

          definition = JSON.parse(JSON.stringify(row.definition)); // deep clone

          // Attempt deterministic fixes first
          const deterministicResult = applyDeterministicFixes(definition, objectIssues, schemaInfo, objectType);

          // Attempt LLM fixes for remaining issues (if API key available)
          let llmResult = { changes: [], modified: false };
          const remainingIssues = objectIssues.filter(i => !deterministicResult.resolvedIds.has(i.id));

          if (remainingIssues.length > 0 && apiKey) {
            try {
              const patch = await requestLLMFix(objectType, objectName, definition, remainingIssues, schemaInfo, apiKey);
              if (patch && !patch.skip_reason) {
                llmResult = await applyPatch(definition, patch, schemaInfo, pool, schemaName);
              } else if (patch?.skip_reason) {
                totalSkipped += remainingIssues.length;
              }
            } catch (llmErr) {
              console.error(`LLM fix error for ${objectType} ${objectName}:`, llmErr.message);
              totalFailed += remainingIssues.length;
            }
          } else if (remainingIssues.length > 0) {
            totalSkipped += remainingIssues.length;
          }

          const allChanges = [...deterministicResult.changes, ...llmResult.changes];

          if (deterministicResult.modified || llmResult.modified) {
            // Save patched definition
            await savePatchedDefinition(pool, objectType, objectName, database_id, definition, allChanges, run_id);

            // Re-validate
            const revalResult = await revalidateObject(objectType, definition, schemaInfo);

            // Mark resolved issues
            const resolvedIds = [...deterministicResult.resolvedIds];
            if (llmResult.modified) {
              // Mark LLM-fixed issues as resolved if re-validation passes
              for (const issue of remainingIssues) {
                // Check if the specific issue is no longer present
                const stillPresent = revalResult.issues.some(ri =>
                  ri.message && issue.message && ri.message.includes(getIssueControlName(issue))
                );
                if (!stillPresent) {
                  resolvedIds.push(issue.id);
                }
              }
            }

            // Update resolved status in import_log
            if (resolvedIds.length > 0 && run_id) {
              await pool.query(`
                UPDATE shared.import_log
                SET resolved = true, resolved_at = NOW()
                WHERE id = ANY($1)
              `, [resolvedIds]);
            }

            totalFixed += resolvedIds.length;
            totalFailed += (objectIssues.length - resolvedIds.length - totalSkipped);

            // Log fix to import_log
            await logFix(pool, run_id, database_id, objectName, objectType, allChanges);

            results.push({
              objectType,
              objectName,
              changes: allChanges,
              validated: revalResult.issues.length === 0
            });
          } else {
            totalSkipped += objectIssues.length - deterministicResult.resolvedIds.size;
          }
        } catch (objErr) {
          console.error(`Error fixing ${objectType} ${objectName}:`, objErr.message);
          totalFailed += objectIssues.length;
        }
      }

      // ---- Deterministic sweep: record-source inference ----
      // Forms with no record-source where all bound fields match exactly one table
      for (const form of formsRes.rows) {
        const def = form.definition;
        if (!def) continue;
        const rs = (form.record_source || def['record-source'] || '').trim();
        if (rs) continue; // already has one

        const boundFields = extractBoundFields(def);
        if (boundFields.length === 0) continue;

        const matchingTable = findUniqueTableMatch(boundFields, schemaInfo);
        if (matchingTable) {
          // Apply the fix
          const patchedDef = JSON.parse(JSON.stringify(def));
          patchedDef['record-source'] = matchingTable;

          await savePatchedDefinition(pool, 'form', form.name, database_id, patchedDef,
            [{ type: 'record-source-set', value: matchingTable, reason: 'All bound fields match this table' }], run_id);

          totalFixed++;
          results.push({
            objectType: 'form',
            objectName: form.name,
            changes: [{ type: 'record-source-set', value: matchingTable }],
            validated: true
          });
        }
      }

      // Log pass completion
      await logPassCompletion(pool, run_id, database_id, totalFixed, totalSkipped, totalFailed);

      res.json({ fixed: totalFixed, skipped: totalSkipped, failed: totalFailed, results });
    } catch (err) {
      console.error('Error in autofix pass:', err);
      logError(pool, 'POST /api/access-import/autofix-pass', 'Failed to run autofix pass', err);
      res.status(500).json({ error: err.message || 'Failed to run autofix pass' });
    }
  });

};


// ============================================================
// Helper functions
// ============================================================

/**
 * Filter to actionable issues — skip noise from pass 2/3 findings.
 */
function isActionable(issue) {
  const cat = issue.category || '';
  const msg = (issue.message || '').toLowerCase();

  // Unresolved bindings with Levenshtein suggestion
  if (cat === 'unresolved-binding' && msg.includes('did you mean')) return true;

  // Missing record source
  if (cat === 'missing-record-source') return true;

  // Validation findings about field bindings or SQL
  if (cat === 'validation') {
    if (msg.includes('row-source sql is invalid')) return true;
    if (msg.includes("doesn't exist")) return true;
    if (msg.includes('not found in schema')) return true;
  }

  return false;
}

/**
 * Extract the control name referenced in an issue message.
 */
function getIssueControlName(issue) {
  const match = (issue.message || '').match(/Control "([^"]+)"/i);
  return match ? match[1] : '';
}

/**
 * Apply deterministic fixes (no LLM needed).
 */
function applyDeterministicFixes(definition, issues, schemaInfo, objectType) {
  const changes = [];
  const resolvedIds = new Set();
  let modified = false;

  for (const issue of issues) {
    // Fix unresolved bindings with Levenshtein suggestion
    if (issue.category === 'unresolved-binding' && issue.message) {
      const didYouMean = issue.message.match(/Did you mean "([^"]+)"\?/);
      const controlMatch = issue.message.match(/Control "([^"]+)" bound to field "([^"]+)"/);

      if (didYouMean && controlMatch) {
        const suggestedField = didYouMean[1];
        const controlName = controlMatch[1];
        const oldField = controlMatch[2];

        // Extract record source to verify the suggestion
        const rs = extractRecordSource(definition, objectType);
        const columns = rs ? schemaInfo.get(rs.toLowerCase()) : null;

        if (columns && columns.includes(suggestedField.toLowerCase())) {
          // Apply the rename in the definition
          const applied = renameFieldInDefinition(definition, controlName, oldField, suggestedField);
          if (applied) {
            changes.push({ type: 'field-rename', control: controlName, from: oldField, to: suggestedField });
            resolvedIds.add(issue.id);
            modified = true;
          }
        }
      }
    }
  }

  return { changes, resolvedIds, modified };
}

/**
 * Extract record source from a form or report definition.
 */
function extractRecordSource(definition, objectType) {
  return definition['record-source'] || definition.record_source || '';
}

/**
 * Rename a field binding in a definition for a specific control.
 */
function renameFieldInDefinition(definition, controlName, oldField, newField) {
  for (const [sectionKey, section] of Object.entries(definition)) {
    if (!section || !Array.isArray(section.controls)) continue;
    for (const ctrl of section.controls) {
      if ((ctrl.name || ctrl.id || '') === controlName) {
        if (ctrl.field && ctrl.field.toLowerCase() === oldField.toLowerCase()) {
          ctrl.field = newField;
          return true;
        }
        if (ctrl['control-source'] && ctrl['control-source'].toLowerCase() === oldField.toLowerCase()) {
          ctrl['control-source'] = newField;
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Extract all bound field names from a form definition.
 */
function extractBoundFields(definition) {
  const fields = [];
  for (const [key, section] of Object.entries(definition)) {
    if (!section || !Array.isArray(section.controls)) continue;
    for (const ctrl of section.controls) {
      const field = getControlField(ctrl);
      if (field) fields.push(field.toLowerCase());
    }
  }
  return fields;
}

/**
 * Get field binding from a control (same as repair-pass).
 */
function getControlField(control) {
  const cs = control['control-source'] || control.control_source;
  if (cs && typeof cs === 'string' && cs.startsWith('=')) return null;
  let field = cs || control.field || null;
  if (field && typeof field === 'string' && field.startsWith('=')) return null;
  if (field && typeof field === 'string' && field.includes('.')) {
    field = field.substring(field.indexOf('.') + 1);
  }
  return field;
}

/**
 * Find the unique table that contains ALL bound fields.
 * Returns table name if exactly one table matches, null otherwise.
 */
function findUniqueTableMatch(boundFields, schemaInfo) {
  if (boundFields.length === 0) return null;

  const matches = [];
  for (const [tableName, columns] of schemaInfo) {
    const allMatch = boundFields.every(f => columns.includes(f));
    if (allMatch) matches.push(tableName);
  }

  return matches.length === 1 ? matches[0] : null;
}

/**
 * Request LLM fix for an object's issues.
 */
async function requestLLMFix(objectType, objectName, definition, issues, schemaInfo, apiKey) {
  // Build compact definition (truncate if >30 controls per section)
  const compactDef = {};
  for (const [key, section] of Object.entries(definition)) {
    if (!section || typeof section !== 'object') {
      compactDef[key] = section;
      continue;
    }
    if (Array.isArray(section.controls) && section.controls.length > 30) {
      compactDef[key] = {
        ...section,
        controls: section.controls.slice(0, 30),
        _truncated: `${section.controls.length} total controls`
      };
    } else {
      compactDef[key] = section;
    }
  }

  // Build available tables/columns summary
  const schemaSummary = [];
  for (const [tableName, columns] of schemaInfo) {
    schemaSummary.push(`${tableName}: ${columns.join(', ')}`);
  }

  const issueDescriptions = issues.map(i =>
    `[${i.category}] ${i.message}`
  ).join('\n');

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2048,
      system: `You are fixing issues in a ${objectType} definition that was imported from MS Access to PostgreSQL. You can ONLY fix field binding renames, record-source assignments, and combo-box/list-box row-source SQL rewrites. You cannot restructure forms, add controls, or make schema changes.

Respond with ONLY a JSON object (no markdown, no explanation):
{
  "field_renames": [{"control_name": "...", "old_field": "...", "new_field": "..."}],
  "record_source_fix": null or "table_name",
  "combo_box_sql_fixes": [{"control_name": "...", "new_sql": "SELECT ..."}],
  "skip_reason": null or "reason why these issues can't be auto-fixed"
}

IMPORTANT: All SQL in combo_box_sql_fixes must be valid PostgreSQL syntax:
- NO square brackets [TableName] — use bare lowercase identifiers instead
- Use PostgreSQL functions (not Access functions like IIf, Nz, etc.)
- Use single quotes for strings, double quotes only for identifiers with special characters
- Table/column names should be lowercase with underscores
- PostgreSQL has no DUAL table — use "SELECT value" not "SELECT value FROM dual"

If you cannot confidently fix any issues, set skip_reason and leave the arrays empty.`,
      messages: [{
        role: 'user',
        content: `${objectType} "${objectName}" has these issues:\n${issueDescriptions}\n\nCurrent definition:\n${JSON.stringify(compactDef, null, 2)}\n\nAvailable tables and columns:\n${schemaSummary.slice(0, 50).join('\n')}\n\nFix what you can. Only use columns that exist in the schema above.`
      }]
    })
  });

  if (!response.ok) {
    throw new Error(`Anthropic API error: ${response.status}`);
  }

  const data = await response.json();
  const text = data.content?.[0]?.text || '{}';

  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch (e) {
    console.error('Failed to parse LLM fix response:', e.message);
  }

  return null;
}

/**
 * Apply an LLM-generated patch to a definition with validation.
 */
async function applyPatch(definition, patch, schemaInfo, pool, schemaName) {
  const changes = [];
  let modified = false;

  // Apply field renames
  if (Array.isArray(patch.field_renames)) {
    for (const rename of patch.field_renames) {
      // Verify new_field exists in schema
      const rs = extractRecordSource(definition);
      const columns = rs ? schemaInfo.get(rs.toLowerCase()) : null;

      if (columns && columns.includes(rename.new_field.toLowerCase())) {
        const applied = renameFieldInDefinition(definition, rename.control_name, rename.old_field, rename.new_field);
        if (applied) {
          changes.push({ type: 'field-rename', control: rename.control_name, from: rename.old_field, to: rename.new_field, source: 'llm' });
          modified = true;
        }
      }
    }
  }

  // Apply record source fix
  if (patch.record_source_fix) {
    const tableLower = patch.record_source_fix.toLowerCase();
    if (schemaInfo.has(tableLower)) {
      definition['record-source'] = patch.record_source_fix;
      changes.push({ type: 'record-source-set', value: patch.record_source_fix, source: 'llm' });
      modified = true;
    }
  }

  // Apply combo box SQL fixes (verified with EXPLAIN)
  if (Array.isArray(patch.combo_box_sql_fixes)) {
    for (const sqlFix of patch.combo_box_sql_fixes) {
      // Sanitize: strip Access [brackets] → lowercase identifiers (LLM sometimes returns Access syntax)
      let sql = sqlFix.new_sql.replace(/;$/, '');
      sql = sql.replace(/\[([^\]]+)\]/g, (_, inner) => inner.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, ''));
      // Remove "FROM dual" (Oracle/MySQL convention, not valid in PostgreSQL)
      sql = sql.replace(/\s+FROM\s+dual\b/gi, '');
      // Verify SQL with EXPLAIN
      try {
        await pool.query(`SET search_path TO "${schemaName}", shared, public`);
        await pool.query(`EXPLAIN ${sql}`);

        // Find and update the control with the sanitized SQL
        const applied = updateControlRowSource(definition, sqlFix.control_name, sql);
        if (applied) {
          changes.push({ type: 'combo-box-sql-fix', control: sqlFix.control_name, source: 'llm' });
          modified = true;
        }
      } catch (sqlErr) {
        console.warn(`LLM SQL fix for "${sqlFix.control_name}" failed EXPLAIN:`, sqlErr.message);
      }
    }
  }

  return { changes, modified };
}

/**
 * Update a combo-box/list-box control's row-source SQL in a definition.
 */
function updateControlRowSource(definition, controlName, newSql) {
  for (const [sectionKey, section] of Object.entries(definition)) {
    if (!section || !Array.isArray(section.controls)) continue;
    for (const ctrl of section.controls) {
      if ((ctrl.name || ctrl.id || '') === controlName) {
        if (ctrl['row-source'] !== undefined || ctrl.row_source !== undefined) {
          ctrl['row-source'] = newSql;
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Save a patched definition as a new version (append-only).
 */
async function savePatchedDefinition(pool, objectType, objectName, databaseId, definition, changes, runId) {
  const table = objectType === 'form' ? 'shared.forms' : 'shared.reports';

  // Mark old standard version as not current (autofix only touches standard versions)
  await pool.query(
    `UPDATE ${table} SET is_current = false WHERE database_id = $1 AND name = $2 AND owner = 'standard' AND is_current = true`,
    [databaseId, objectName]
  );

  // Get next version number
  const vResult = await pool.query(
    `SELECT COALESCE(MAX(version), 0) as max_version FROM ${table} WHERE database_id = $1 AND name = $2`,
    [databaseId, objectName]
  );
  const newVersion = vResult.rows[0].max_version + 1;

  // Insert new version (standard owner, modified_by = 'autofix')
  const rs = definition['record-source'] || '';
  await pool.query(
    `INSERT INTO ${table} (database_id, name, definition, record_source, version, is_current, owner, modified_by)
     VALUES ($1, $2, $3, $4, $5, true, 'standard', 'autofix')`,
    [databaseId, objectName, definition, rs, newVersion]
  );
}

/**
 * Re-validate an object after patching.
 */
function revalidateObject(objectType, definition, schemaInfo) {
  let issues;
  if (objectType === 'form') {
    issues = validateForm(definition);
    issues.push(...validateFormCrossObject(definition, schemaInfo));
  } else {
    issues = validateReport(definition);
    issues.push(...validateReportCrossObject(definition, schemaInfo));
  }
  return { issues };
}

/**
 * Log a fix entry to import_log.
 */
async function logFix(pool, runId, databaseId, objectName, objectType, changes) {
  if (!runId) return;
  try {
    const changesSummary = changes.map(c => {
      if (c.type === 'field-rename') return `Renamed "${c.from}" → "${c.to}" on ${c.control}`;
      if (c.type === 'record-source-set') return `Set record-source to "${c.value}"`;
      if (c.type === 'combo-box-sql-fix') return `Fixed SQL on ${c.control}`;
      return c.type;
    }).join('; ');

    await pool.query(`
      INSERT INTO shared.import_log
        (run_id, pass_number, target_database_id, source_object_name, source_object_type,
         status, severity, category, message, action)
      VALUES ($1, 4, $2, $3, $4, 'issue', 'info', 'auto-fix', $5, 'fixed')
    `, [runId, databaseId, objectName, objectType, changesSummary]);
  } catch (e) {
    console.error('Error logging fix:', e.message);
  }
}

/**
 * Log pass completion summary.
 */
async function logPassCompletion(pool, runId, databaseId, fixed, skipped, failed) {
  if (!runId) return;
  try {
    await pool.query(`
      INSERT INTO shared.import_log
        (run_id, pass_number, target_database_id, source_object_name, source_object_type,
         status, severity, category, message, action)
      VALUES ($1, 4, $2, '_pass4', 'system', 'issue', 'info', 'pass-complete',
              $3, 'auto-fix')
    `, [runId, databaseId,
        `Pass 4 complete: ${fixed} fixed, ${skipped} skipped, ${failed} failed`]);
  } catch (e) {
    console.error('Error logging pass completion:', e.message);
  }
}
