/**
 * VBA Function Translator
 *
 * Uses LLM to translate VBA function bodies into real PostgreSQL implementations,
 * replacing the NULL-returning stubs created by vba-stub-generator.js.
 */

const { buildSchemaContext } = require('./query-converter/llm-fallback');
const { parseVbaDeclarations, buildStubDDL, collectEnumNames } = require('./vba-stub-generator');

/**
 * Extract a VBA function body by name from module source.
 * Returns the full text from "Function <name>..." to "End Function", or null.
 */
function extractFunctionBody(vbaSource, functionName) {
  if (!vbaSource || !functionName) return null;
  const regex = new RegExp(
    `^((?:Public|Private)\\s+)?(?:Static\\s+)?Function\\s+${functionName}\\b[^\\r\\n]*[\\s\\S]*?End\\s+Function`,
    'gim'
  );
  const match = regex.exec(vbaSource);
  return match ? match[0].trim() : null;
}

/**
 * Find which module contains a given function name.
 * Returns { moduleName, vbaSource, functionBody } or null.
 */
function findFunctionInModules(modules, functionName) {
  const lowerName = functionName.toLowerCase();
  for (const mod of modules) {
    const body = extractFunctionBody(mod.vba_source, functionName);
    if (body) {
      return { moduleName: mod.name, vbaSource: mod.vba_source, functionBody: body };
    }
    // Also try case-insensitive search by re-parsing declarations
    const decls = parseVbaDeclarations(mod.vba_source);
    for (const decl of decls) {
      if (decl.name.toLowerCase() === lowerName) {
        const exactBody = extractFunctionBody(mod.vba_source, decl.name);
        if (exactBody) {
          return { moduleName: mod.name, vbaSource: mod.vba_source, functionBody: exactBody };
        }
      }
    }
  }
  return null;
}

/**
 * Get the existing stub DDL (signature) for a function from the database.
 * Returns a CREATE OR REPLACE FUNCTION string showing the current signature.
 */
async function getExistingStubSignature(pool, schemaName, functionName) {
  const result = await pool.query(`
    SELECT r.routine_name,
           COALESCE(r.data_type, 'text') AS return_type,
           STRING_AGG(
             COALESCE(p.parameter_name, 'p' || p.ordinal_position) || ' ' || p.data_type,
             ', ' ORDER BY p.ordinal_position
           ) AS params
    FROM information_schema.routines r
    LEFT JOIN information_schema.parameters p
      ON p.specific_schema = r.specific_schema AND p.specific_name = r.specific_name
    WHERE r.routine_schema = $1 AND r.routine_name = $2
    GROUP BY r.routine_name, r.data_type
  `, [schemaName, functionName.toLowerCase()]);

  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  const params = row.params || '';
  return `CREATE OR REPLACE FUNCTION "${schemaName}"."${row.routine_name}"(${params}) RETURNS ${row.return_type}`;
}

/**
 * Translate VBA functions into real PostgreSQL implementations using LLM.
 *
 * @param {Pool} pool - PostgreSQL connection pool
 * @param {string} databaseId - Database identifier
 * @param {string} schemaName - Target PG schema
 * @param {string} apiKey - Anthropic API key
 * @param {string[]} functionNames - Functions to translate
 * @returns {{ translated: string[], failed: Array<{name: string, error: string}> }}
 */
async function translateVbaFunctions(pool, databaseId, schemaName, apiKey, functionNames) {
  const translated = [];
  const failed = [];

  if (!functionNames || functionNames.length === 0) return { translated, failed };

  // Load all current VBA modules
  const modulesResult = await pool.query(
    `SELECT name, definition->>'vba_source' as vba_source FROM shared.objects
     WHERE database_id = $1 AND type = 'module' AND is_current = true AND definition->>'vba_source' IS NOT NULL`,
    [databaseId]
  );
  const modules = modulesResult.rows;
  if (modules.length === 0) return { translated, failed };

  // Build schema context once
  const schemaContext = await buildSchemaContext(pool, schemaName);

  for (const funcName of functionNames) {
    try {
      // Find the VBA source
      const found = findFunctionInModules(modules, funcName);
      if (!found) {
        failed.push({ name: funcName, error: 'Function not found in any VBA module' });
        continue;
      }

      // Get the existing stub signature
      const stubSignature = await getExistingStubSignature(pool, schemaName, funcName);
      if (!stubSignature) {
        failed.push({ name: funcName, error: 'No existing stub function in PG schema' });
        continue;
      }

      console.log(`[vba-func-translate] Translating: ${funcName} (from ${found.moduleName})`);

      // Call LLM
      const systemPrompt = `You translate Access VBA functions to PostgreSQL.
Target schema: ${schemaName}. All table references must be schema-qualified.

Rules:
- DLookup("expr","domain","criteria") → (SELECT expr FROM ${schemaName}.domain WHERE criteria LIMIT 1)
- String concat & → ||
- IIf(c,t,f) → CASE WHEN c THEN t ELSE f END
- Nz(x) → COALESCE(x,'')
- Nz(x,y) → COALESCE(x,y)
- VBA string functions: Mid → SUBSTRING, Left → LEFT, Right → RIGHT, Len → LENGTH, Trim → TRIM
- Return ONLY a CREATE OR REPLACE FUNCTION statement, no markdown fences, no explanation
- Preserve the exact function signature (name, parameter types, return type) from the existing stub
- Use $$ delimiters for the function body
- Use LANGUAGE sql for simple single-expression functions, LANGUAGE plpgsql for procedural logic`;

      const userMessage = `Existing stub signature:
${stubSignature}

VBA function:
${found.functionBody}

Database schema:
${schemaContext}

Translate this VBA function to a real PostgreSQL implementation.`;

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
          system: systemPrompt,
          messages: [{ role: 'user', content: userMessage }]
        }),
        signal: AbortSignal.timeout(60000)
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error?.message || `API ${response.status}`);
      }

      const data = await response.json();
      let sqlText = '';
      for (const block of data.content) {
        if (block.type === 'text') sqlText += block.text;
      }
      if (!sqlText.trim()) throw new Error('LLM returned empty response');

      // Strip markdown fences if present
      sqlText = sqlText.replace(/^```(?:sql)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();

      // Execute in a savepoint so failure keeps the stub
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const sp = `translate_${funcName.toLowerCase().replace(/\W/g, '_')}`;
        await client.query(`SAVEPOINT ${sp}`);
        try {
          await client.query(sqlText);
          await client.query(`RELEASE SAVEPOINT ${sp}`);
          await client.query('COMMIT');
          translated.push(funcName);
          console.log(`[vba-func-translate] Success: ${funcName}`);
        } catch (execErr) {
          await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
          await client.query('COMMIT');
          throw new Error(`DDL execution failed: ${execErr.message}`);
        }
      } finally {
        client.release();
      }
    } catch (err) {
      console.error(`[vba-func-translate] Failed: ${funcName}:`, err.message);
      failed.push({ name: funcName, error: err.message });
    }
  }

  return { translated, failed };
}

module.exports = { extractFunctionBody, findFunctionInModules, translateVbaFunctions };
