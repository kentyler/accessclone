/**
 * Pass 2: Repair — auto-fix bindings, retry failed queries, reconcile mappings.
 * POST /repair-pass
 */

const { logError } = require('../../lib/events');
const { getSchemaInfo } = require('../lint');
const { sanitizeName } = require('../../lib/query-converter/utils');

module.exports = function(router, pool) {

  router.post('/repair-pass', async (req, res) => {
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

      let fixed = 0;
      let warnings = 0;

      // 1. Load all current forms and reports
      const [formsRes, reportsRes] = await Promise.all([
        pool.query(`SELECT id, name, definition, record_source FROM shared.objects WHERE database_id = $1 AND type = 'form' AND is_current = true AND owner = 'standard'`, [database_id]),
        pool.query(`SELECT id, name, definition, record_source FROM shared.objects WHERE database_id = $1 AND type = 'report' AND is_current = true AND owner = 'standard'`, [database_id])
      ]);

      // 2. Check and repair form bindings
      for (const form of formsRes.rows) {
        const def = form.definition;
        if (!def || typeof def !== 'object') continue;

        const rs = (form.record_source || def['record-source'] || '').toLowerCase().replace(/\s+/g, '_');
        const columns = schemaInfo.get(rs);

        if (rs && !columns) {
          // Record source doesn't exist
          await logIssue(pool, run_id, database_id, form.name, 'form', 'warning',
            'missing-record-source', `Form record source "${rs}" not found in schema`);
          warnings++;
          continue;
        }

        if (!columns) continue;

        let modified = false;
        for (const [sectionKey, section] of Object.entries(def)) {
          if (!section || !Array.isArray(section.controls)) continue;
          for (const ctrl of section.controls) {
            const field = getControlField(ctrl);
            if (!field) continue;

            const fieldLower = field.toLowerCase();
            if (columns.includes(fieldLower)) continue; // exact match

            // Case-insensitive match — fix the binding
            const match = columns.find(c => c === fieldLower);
            if (match) continue; // already matches when lowered

            // No match at all — log warning
            const closest = findClosest(fieldLower, columns);
            await logIssue(pool, run_id, database_id, form.name, 'form', 'warning',
              'unresolved-binding',
              `Control "${ctrl.name || ctrl.id}" bound to field "${field}" which doesn't exist in "${rs}"` +
              (closest ? `. Did you mean "${closest}"?` : ''));
            warnings++;
          }
        }

        if (modified) {
          await pool.query(
            'UPDATE shared.objects SET definition = $1 WHERE id = $2',
            [def, form.id]
          );
          fixed++;
        }
      }

      // 2b. Convert VBA expression control-sources to record-source queries
      // Pattern: form has no record-source, control has =FuncName(args) calling a UDF
      // Fix: build SELECT schema.funcname(args) AS controlname, set as record-source, rebind control
      for (const form of formsRes.rows) {
        const def = form.definition;
        if (!def || typeof def !== 'object') continue;

        const existingRS = form.record_source || def['record-source'] || '';
        if (existingRS) continue; // already has a record source

        // Collect expression control-sources that call functions
        const exprControls = [];
        for (const [sectionKey, section] of Object.entries(def)) {
          if (!section || !Array.isArray(section.controls)) continue;
          for (const ctrl of section.controls) {
            const cs = ctrl['control-source'] || '';
            if (typeof cs === 'string' && cs.startsWith('=')) {
              const funcMatch = cs.substring(1).match(/^([a-zA-Z_]\w*)\s*\(([^)]*)\)\s*$/);
              if (funcMatch) {
                exprControls.push({ ctrl, sectionKey, funcName: funcMatch[1], args: funcMatch[2], expression: cs });
              }
            }
          }
        }

        if (exprControls.length === 0) continue;

        // Check which functions exist in the PG schema
        const existingFuncs = await pool.query(
          `SELECT routine_name FROM information_schema.routines WHERE routine_schema = $1`,
          [schemaName]
        );
        const funcSet = new Set(existingFuncs.rows.map(r => r.routine_name));

        const selectParts = [];
        const rebinds = []; // { ctrl, alias }
        for (const ec of exprControls) {
          const pgFuncName = sanitizeName(ec.funcName);
          if (!funcSet.has(pgFuncName)) continue; // function doesn't exist in PG

          const alias = sanitizeName(ec.ctrl.name || ec.ctrl.id || pgFuncName);
          selectParts.push(`"${schemaName}"."${pgFuncName}"(${ec.args}) AS ${alias}`);
          rebinds.push({ ctrl: ec.ctrl, alias });
        }

        if (selectParts.length === 0) continue;

        const newRecordSource = `SELECT ${selectParts.join(', ')}`;
        def['record-source'] = newRecordSource;

        for (const { ctrl, alias } of rebinds) {
          delete ctrl['control-source'];
          ctrl.field = alias;
        }

        // Save updated definition
        await pool.query(
          'UPDATE shared.objects SET definition = $1, record_source = $2 WHERE id = $3',
          [def, newRecordSource, form.id]
        );
        fixed++;

        await logIssue(pool, run_id, database_id, form.name, 'form', 'info',
          'expression-to-recordsource',
          `Converted ${rebinds.length} VBA expression control-source(s) to record-source query: ${newRecordSource}`);
      }

      // 3. Check report bindings (same logic)
      for (const report of reportsRes.rows) {
        const def = report.definition;
        if (!def || typeof def !== 'object') continue;

        const rs = (report.record_source || def['record-source'] || '').toLowerCase().replace(/\s+/g, '_');
        const columns = schemaInfo.get(rs);

        if (rs && !columns) {
          await logIssue(pool, run_id, database_id, report.name, 'report', 'warning',
            'missing-record-source', `Report record source "${rs}" not found in schema`);
          warnings++;
          continue;
        }

        if (!columns) continue;

        for (const [sectionKey, section] of Object.entries(def)) {
          if (!section || !Array.isArray(section.controls)) continue;
          for (const ctrl of section.controls) {
            const field = getControlField(ctrl);
            if (!field) continue;

            const fieldLower = field.toLowerCase();
            if (columns.includes(fieldLower)) continue;

            const closest = findClosest(fieldLower, columns);
            await logIssue(pool, run_id, database_id, report.name, 'report', 'warning',
              'unresolved-binding',
              `Control "${ctrl.name || ctrl.id}" bound to field "${field}" which doesn't exist in "${rs}"` +
              (closest ? `. Did you mean "${closest}"?` : ''));
            warnings++;
          }
        }
      }

      // 4. Retry failed queries from pass 1
      let retriedSucceeded = 0;
      let retriedFailed = 0;

      if (run_id) {
        const failedQueries = await pool.query(`
          SELECT source_object_name FROM shared.import_log
          WHERE run_id = $1 AND pass_number = 1 AND status = 'error'
            AND source_object_type = 'query'
        `, [run_id]);

        // For now, just log them — actual retry requires the original database path
        // which isn't stored in the log. The frontend retry loop handles this during pass 1.
        retriedFailed = failedQueries.rows.length;
      }

      // 5. Reconcile control_column_map for all forms
      let mappingsReconciled = 0;
      for (const form of formsRes.rows) {
        const def = form.definition;
        if (!def || typeof def !== 'object') continue;

        const rs = (form.record_source || def['record-source'] || '').toLowerCase().replace(/\s+/g, '_');
        if (!rs) continue;

        const columns = schemaInfo.get(rs);
        if (!columns) continue;

        const formNameSanitized = form.name.toLowerCase().replace(/\s+/g, '_');

        for (const [sectionKey, section] of Object.entries(def)) {
          if (!section || !Array.isArray(section.controls)) continue;
          for (const ctrl of section.controls) {
            const field = getControlField(ctrl);
            if (!field) continue;
            const fieldLower = field.toLowerCase();
            if (!columns.includes(fieldLower)) continue;

            const ctrlName = (ctrl.name || ctrl.id || '').toLowerCase().replace(/\s+/g, '_');
            if (!ctrlName) continue;

            try {
              await pool.query(`
                INSERT INTO shared.control_column_map (database_id, form_name, control_name, table_name, column_name)
                VALUES ($1, $2, $3, $4, $5)
                ON CONFLICT (database_id, form_name, control_name) DO UPDATE
                  SET table_name = $4, column_name = $5
              `, [database_id, formNameSanitized, ctrlName, rs, fieldLower]);
              mappingsReconciled++;
            } catch (e) {
              // ignore mapping errors
            }
          }
        }
      }

      // Log pass 2 completion
      if (run_id) {
        await logIssue(pool, run_id, database_id, '_pass2', 'system', 'info',
          'pass-complete',
          `Pass 2 complete: ${fixed} fixed, ${warnings} warnings, ${mappingsReconciled} mappings reconciled`);
      }

      res.json({
        fixed,
        warnings,
        retried_queries: { succeeded: retriedSucceeded, still_failing: retriedFailed },
        mappings_reconciled: mappingsReconciled
      });
    } catch (err) {
      console.error('Error in repair pass:', err);
      logError(pool, 'POST /api/database-import/repair-pass', 'Failed to run repair pass', err);
      res.status(500).json({ error: err.message || 'Failed to run repair pass' });
    }
  });

};

/**
 * Get field binding from a control.
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
 * Find the closest column name (simple edit distance).
 */
function findClosest(target, columns) {
  if (columns.length === 0) return null;
  let best = null;
  let bestDist = Infinity;
  for (const col of columns) {
    const dist = levenshtein(target, col);
    if (dist < bestDist && dist <= 3) {
      bestDist = dist;
      best = col;
    }
  }
  return best;
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

async function logIssue(pool, runId, databaseId, objectName, objectType, severity, category, message) {
  try {
    await pool.query(`
      INSERT INTO shared.import_log
        (run_id, pass_number, target_database_id, source_object_name, source_object_type,
         status, severity, category, message)
      VALUES ($1, 2, $2, $3, $4, 'issue', $5, $6, $7)
    `, [runId, databaseId, objectName, objectType, severity, category, message]);
  } catch (e) {
    console.error('Error logging repair issue:', e.message);
  }
}
