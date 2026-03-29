/**
 * POST /resolve-expressions — Translate VBA user-defined functions referenced in
 * form/report control-source expressions from NULL stubs to real PG implementations,
 * then re-run processDefinitionExpressions so computed functions use the real UDFs.
 */

const { logError } = require('../../lib/events');
const { translateVbaFunctions } = require('../../lib/vba-function-translator');
const { processDefinitionExpressions } = require('../../lib/expression-converter/pipeline');
const { sanitizeName } = require('../../lib/query-converter/utils');

// Functions that are NOT user-defined — don't try to translate these.
// Combines PG builtins + Access domain functions + Access expression functions.
const KNOWN_FUNCTIONS = new Set([
  // Domain aggregate functions (translated by domain-functions.js)
  'dlookup', 'dcount', 'dsum', 'davg', 'dmin', 'dmax', 'dfirst', 'dlast',
  // Access expression functions (translated by access-functions.js)
  'iif', 'nz', 'isnull', 'format', 'left', 'right', 'mid', 'len', 'trim',
  'ltrim', 'rtrim', 'ucase', 'lcase', 'instr', 'space', 'string', 'str',
  'val', 'int', 'fix', 'abs', 'sgn', 'round', 'datepart', 'dateserial',
  'dateadd', 'datediff', 'year', 'month', 'day', 'hour', 'minute', 'second',
  'date', 'now', 'time', 'cstr', 'cint', 'clng', 'cdbl', 'csng', 'cbool',
  'cdate', 'ccur', 'cbyte', 'cdec', 'replace', 'switch', 'choose',
  // PG builtins (from syntax.js PG_BUILTINS — subset most likely to appear in expressions)
  'count', 'sum', 'avg', 'min', 'max', 'length', 'substring', 'upper', 'lower',
  'position', 'coalesce', 'nullif', 'floor', 'trunc', 'ceil', 'ceiling',
  'to_char', 'to_date', 'to_number', 'extract', 'greatest', 'least',
  'concat', 'replace', 'reverse', 'ascii', 'chr',
]);

/**
 * Parse an expression string to find function calls that aren't in the known set.
 * Returns array of lowercase function names.
 */
function findUserDefinedFunctions(expression) {
  if (!expression || !expression.startsWith('=')) return [];
  const expr = expression.substring(1);

  const funcCalls = new Set();
  // Match word followed by ( — simple but effective for expression-level parsing
  const funcPattern = /\b([a-zA-Z_]\w*)\s*\(/g;
  let match;
  while ((match = funcPattern.exec(expr)) !== null) {
    const name = match[1].toLowerCase();
    if (!KNOWN_FUNCTIONS.has(name)) {
      funcCalls.add(name);
    }
  }
  return Array.from(funcCalls);
}

module.exports = function(router, pool, secrets) {
  router.post('/resolve-expressions', async (req, res) => {
    req.setTimeout(300000); // 5 minutes — LLM calls for each function
    const { database_id, function_names } = req.body;

    if (!database_id) {
      return res.status(400).json({ error: 'database_id is required' });
    }

    const apiKey = secrets?.anthropic?.api_key || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.json({ skipped: true, message: 'No API key configured' });
    }

    try {
      // Get schema name
      const dbResult = await pool.query(
        'SELECT schema_name FROM shared.databases WHERE database_id = $1',
        [database_id]
      );
      if (dbResult.rows.length === 0) {
        return res.status(404).json({ error: 'Database not found' });
      }
      const schemaName = dbResult.rows[0].schema_name;

      // Step 1: Scan forms and reports for expression control sources with UDF calls
      let udfNames;
      if (function_names && function_names.length > 0) {
        udfNames = function_names.map(n => n.toLowerCase());
      } else {
        udfNames = await scanForUDFCalls(pool, database_id);
      }

      if (udfNames.length === 0) {
        return res.json({ skipped: true, message: 'No user-defined function calls found in expressions' });
      }

      console.log(`[resolve-expressions] Found UDF calls: ${udfNames.join(', ')}`);

      // Step 2: Translate VBA functions to real PG implementations
      const translateResult = await translateVbaFunctions(pool, database_id, schemaName, apiKey, udfNames);
      console.log(`[resolve-expressions] Translated: ${translateResult.translated.length}, Failed: ${translateResult.failed.length}`);

      // Step 3: Re-run processDefinitionExpressions for affected forms/reports
      let formsUpdated = 0;
      let reportsUpdated = 0;

      if (translateResult.translated.length > 0) {
        // Re-process forms
        const formsResult = await pool.query(
          `SELECT name, definition FROM shared.objects
           WHERE database_id = $1 AND type = 'form' AND is_current = true AND definition IS NOT NULL`,
          [database_id]
        );
        for (const form of formsResult.rows) {
          const def = typeof form.definition === 'string' ? JSON.parse(form.definition) : form.definition;
          if (!hasExpressionControls(def, 'form')) continue;

          try {
            const { definition: updated, functions, warnings } = await processDefinitionExpressions(
              pool, def, form.name, schemaName, 'form'
            );
            if (functions.length > 0) {
              await pool.query(
                `UPDATE shared.objects SET definition = $1
                 WHERE type = 'form' AND name = $2 AND database_id = $3 AND is_current = true`,
                [JSON.stringify(updated), form.name, database_id]
              );
              formsUpdated++;
              console.log(`[resolve-expressions] Updated form ${form.name}: ${functions.length} computed functions`);
            }
          } catch (err) {
            console.error(`[resolve-expressions] Failed to update form ${form.name}:`, err.message);
          }
        }

        // Re-process reports
        const reportsResult = await pool.query(
          `SELECT name, definition FROM shared.objects
           WHERE database_id = $1 AND type = 'report' AND is_current = true AND definition IS NOT NULL`,
          [database_id]
        );
        for (const report of reportsResult.rows) {
          const def = typeof report.definition === 'string' ? JSON.parse(report.definition) : report.definition;
          if (!hasExpressionControls(def, 'report')) continue;

          try {
            const { definition: updated, functions, warnings } = await processDefinitionExpressions(
              pool, def, report.name, schemaName, 'report'
            );
            if (functions.length > 0) {
              await pool.query(
                `UPDATE shared.objects SET definition = $1
                 WHERE type = 'report' AND name = $2 AND database_id = $3 AND is_current = true`,
                [JSON.stringify(updated), report.name, database_id]
              );
              reportsUpdated++;
              console.log(`[resolve-expressions] Updated report ${report.name}: ${functions.length} computed functions`);
            }
          } catch (err) {
            console.error(`[resolve-expressions] Failed to update report ${report.name}:`, err.message);
          }
        }
      }

      res.json({
        translated: translateResult.translated,
        failed: translateResult.failed,
        formsUpdated,
        reportsUpdated
      });
    } catch (err) {
      console.error('Error in resolve-expressions:', err);
      logError(pool, 'POST /api/database-import/resolve-expressions', 'Expression resolution failed', err, { databaseId: database_id });
      res.status(500).json({ error: err.message });
    }
  });
};

/**
 * Scan all forms and reports for expression control sources, extract UDF calls.
 */
async function scanForUDFCalls(pool, databaseId) {
  const allUDFs = new Set();

  const formsResult = await pool.query(
    `SELECT definition FROM shared.objects
     WHERE database_id = $1 AND type = 'form' AND is_current = true AND definition IS NOT NULL`,
    [databaseId]
  );
  for (const row of formsResult.rows) {
    const def = typeof row.definition === 'string' ? JSON.parse(row.definition) : row.definition;
    scanDefinitionForUDFs(def, 'form', allUDFs);
  }

  const reportsResult = await pool.query(
    `SELECT definition FROM shared.objects
     WHERE database_id = $1 AND type = 'report' AND is_current = true AND definition IS NOT NULL`,
    [databaseId]
  );
  for (const row of reportsResult.rows) {
    const def = typeof row.definition === 'string' ? JSON.parse(row.definition) : row.definition;
    scanDefinitionForUDFs(def, 'report', allUDFs);
  }

  return Array.from(allUDFs);
}

function scanDefinitionForUDFs(definition, objectType, udfSet) {
  const sections = [];
  if (objectType === 'form') {
    for (const key of ['header', 'detail', 'footer']) {
      if (definition[key]?.controls) sections.push(definition[key]);
    }
  } else {
    for (const [key, value] of Object.entries(definition)) {
      if (value && typeof value === 'object' && Array.isArray(value.controls)) {
        sections.push(value);
      }
    }
  }

  for (const section of sections) {
    for (const ctrl of section.controls || []) {
      const cs = ctrl['control-source'] || ctrl['field'];
      if (cs && typeof cs === 'string' && cs.startsWith('=')) {
        const udfs = findUserDefinedFunctions(cs);
        for (const name of udfs) udfSet.add(name);
      }
    }
  }
}

function hasExpressionControls(definition, objectType) {
  const sections = [];
  if (objectType === 'form') {
    for (const key of ['header', 'detail', 'footer']) {
      if (definition[key]?.controls) sections.push(definition[key]);
    }
  } else {
    for (const [key, value] of Object.entries(definition)) {
      if (value && typeof value === 'object' && Array.isArray(value.controls)) {
        sections.push(value);
      }
    }
  }

  for (const section of sections) {
    for (const ctrl of section.controls || []) {
      const cs = ctrl['control-source'] || ctrl['field'];
      if (cs && typeof cs === 'string' && cs.startsWith('=')) return true;
    }
  }
  return false;
}
