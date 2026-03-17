/**
 * Pass 3: Validation — structural + cross-object lint, subform checks, combo-box SQL checks.
 * POST /validation-pass
 */

const { logError } = require('../../lib/events');
const { validateForm, validateReport, validateFormCrossObject, validateReportCrossObject, getSchemaInfo } = require('../lint');
const { translateFormRefs, translateTempVars } = require('../../lib/query-converter');

module.exports = function(router, pool) {

  router.post('/validation-pass', async (req, res) => {
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

      // Load all current forms and reports
      const [formsRes, reportsRes] = await Promise.all([
        pool.query(`SELECT name, definition FROM shared.forms WHERE database_id = $1 AND is_current = true AND owner = 'standard'`, [database_id]),
        pool.query(`SELECT name, definition FROM shared.reports WHERE database_id = $1 AND is_current = true AND owner = 'standard'`, [database_id])
      ]);

      let formsValid = 0;
      let formsWithIssues = 0;
      let reportsValid = 0;
      let reportsWithIssues = 0;
      const findings = [];

      // Validate forms
      for (const form of formsRes.rows) {
        const def = form.definition;
        if (!def) continue;

        const issues = validateForm(def);
        issues.push(...validateFormCrossObject(def, schemaInfo));

        // Check subform source-objects reference existing forms
        for (const [key, section] of Object.entries(def)) {
          if (!section || !Array.isArray(section.controls)) continue;
          for (const ctrl of section.controls) {
            const type = (ctrl.type || '').toString().toLowerCase().replace(/_/g, '-');
            if (type === 'sub-form' || type === 'subform') {
              const sourceObj = ctrl['source-object'] || ctrl.source_object;
              if (sourceObj) {
                const subformName = sourceObj.toLowerCase();
                const exists = formsRes.rows.some(f => f.name.toLowerCase() === subformName);
                if (!exists) {
                  issues.push({
                    severity: 'warning',
                    message: `Subform control "${ctrl.name || ctrl.id}" references "${sourceObj}" which doesn't exist`,
                    location: `${key}.controls`
                  });
                }
              }
            }

            // Check combo-box row-source SQL is valid
            if (type === 'combo-box' || type === 'list-box') {
              const rowSource = ctrl['row-source'] || ctrl.row_source;
              if (rowSource && typeof rowSource === 'string' && /^\s*SELECT/i.test(rowSource)) {
                try {
                  // Translate Access-style references before EXPLAIN
                  let sql = translateTempVars(rowSource);
                  sql = translateFormRefs(sql);
                  sql = sql.replace(/\[([^\]]+)\]/g, '$1');
                  await pool.query(`SET search_path TO "${schemaName}", shared, public`);
                  await pool.query(`EXPLAIN ${sql.replace(/;$/, '')}`);
                } catch (sqlErr) {
                  issues.push({
                    severity: 'warning',
                    message: `${type} "${ctrl.name || ctrl.id}" row-source SQL is invalid: ${sqlErr.message}`,
                    location: `${key}.controls`
                  });
                }
              }
            }
          }
        }

        if (issues.length > 0) {
          formsWithIssues++;
          for (const issue of issues) {
            findings.push({
              object_type: 'form',
              object_name: form.name,
              severity: issue.severity,
              message: issue.message,
              suggestion: issue.suggestion || null
            });
          }
        } else {
          formsValid++;
        }
      }

      // Validate reports
      for (const report of reportsRes.rows) {
        const def = report.definition;
        if (!def) continue;

        const issues = validateReport(def);
        issues.push(...validateReportCrossObject(def, schemaInfo));

        if (issues.length > 0) {
          reportsWithIssues++;
          for (const issue of issues) {
            findings.push({
              object_type: 'report',
              object_name: report.name,
              severity: issue.severity,
              message: issue.message,
              suggestion: issue.suggestion || null
            });
          }
        } else {
          reportsValid++;
        }
      }

      // Check control_column_map completeness
      const mappingRes = await pool.query(
        'SELECT form_name, control_name FROM shared.control_column_map WHERE database_id = $1',
        [database_id]
      );
      const mappedControls = new Set(mappingRes.rows.map(r => `${r.form_name}.${r.control_name}`));

      for (const form of formsRes.rows) {
        const def = form.definition;
        if (!def) continue;
        const rs = def['record-source'] || '';
        if (!rs) continue;

        const formNameSanitized = form.name.toLowerCase().replace(/\s+/g, '_');

        for (const [key, section] of Object.entries(def)) {
          if (!section || !Array.isArray(section.controls)) continue;
          for (const ctrl of section.controls) {
            if (ctrl.tag === 'state') {
              const ctrlName = (ctrl.name || ctrl.id || '').toLowerCase().replace(/\s+/g, '_');
              if (ctrlName && !mappedControls.has(`${formNameSanitized}.${ctrlName}`)) {
                findings.push({
                  object_type: 'form',
                  object_name: form.name,
                  severity: 'warning',
                  message: `State-tagged control "${ctrlName}" not in control_column_map`
                });
              }
            }
          }
        }
      }

      // Log findings to import_log
      if (run_id) {
        for (const f of findings) {
          try {
            await pool.query(`
              INSERT INTO shared.import_log
                (run_id, pass_number, target_database_id, source_object_name, source_object_type,
                 status, severity, category, message, action)
              VALUES ($1, 3, $2, $3, $4, 'issue', $5, 'validation', $6, 'validated')
            `, [run_id, database_id, f.object_name, f.object_type, f.severity, f.message]);
          } catch (e) {
            // ignore logging errors
          }
        }

        // Log completion
        try {
          await pool.query(`
            INSERT INTO shared.import_log
              (run_id, pass_number, target_database_id, source_object_name, source_object_type,
               status, severity, category, message, action)
            VALUES ($1, 3, $2, '_pass3', 'system', 'issue', 'info', 'pass-complete',
                    $3, 'validated')
          `, [run_id, database_id,
              `Pass 3 complete: ${formsValid + reportsValid} valid, ${formsWithIssues + reportsWithIssues} with issues, ${findings.length} findings`]);
        } catch (e) {
          // ignore
        }
      }

      res.json({
        forms_valid: formsValid,
        forms_with_issues: formsWithIssues,
        reports_valid: reportsValid,
        reports_with_issues: reportsWithIssues,
        findings
      });
    } catch (err) {
      console.error('Error in validation pass:', err);
      logError(pool, 'POST /api/database-import/validation-pass', 'Failed to run validation pass', err);
      res.status(500).json({ error: err.message || 'Failed to run validation pass' });
    }
  });

};
