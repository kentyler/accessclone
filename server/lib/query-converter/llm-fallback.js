/**
 * LLM fallback for Access→PostgreSQL query conversion.
 * When the regex-based converter produces SQL that fails execution,
 * this module sends the original Access SQL + error context to Claude
 * for a corrected conversion.
 */

/**
 * Build a compact schema summary for the LLM context.
 * Format: "table_name: col1 type1, col2 type2, ..."
 */
async function buildSchemaContext(pool, schemaName) {
  const colResult = await pool.query(`
    SELECT table_name, column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = $1
    ORDER BY table_name, ordinal_position
  `, [schemaName]);

  const viewResult = await pool.query(`
    SELECT table_name FROM information_schema.views WHERE table_schema = $1
  `, [schemaName]);
  const viewNames = new Set(viewResult.rows.map(r => r.table_name));

  // Group columns by table
  const tables = {};
  for (const row of colResult.rows) {
    if (!tables[row.table_name]) tables[row.table_name] = [];
    tables[row.table_name].push(`${row.column_name} ${row.data_type}`);
  }

  const lines = [];
  for (const [tableName, cols] of Object.entries(tables)) {
    const suffix = viewNames.has(tableName) ? ' (view)' : '';
    lines.push(`${tableName}${suffix}: ${cols.join(', ')}`);
  }
  return lines.join('\n');
}

/**
 * Format control mapping for LLM context.
 * Format: "formName.controlName → tableName.columnName"
 */
function formatControlMapping(controlMapping) {
  const lines = [];
  for (const [key, val] of Object.entries(controlMapping)) {
    lines.push(`${key} → ${val.table}.${val.column}`);
  }
  return lines.length > 0 ? lines.join('\n') : '(none)';
}

/**
 * Convert an Access query to PostgreSQL using the LLM as fallback.
 *
 * @param {Object} opts
 * @param {string} opts.apiKey - Anthropic API key
 * @param {Object} opts.pool - pg Pool instance
 * @param {string} opts.schemaName - Target PG schema name
 * @param {string} opts.originalAccessSQL - Original Access SQL
 * @param {string} opts.failedPgSQL - The regex-converted SQL that failed
 * @param {string} opts.pgError - The PostgreSQL error message
 * @param {Object} opts.controlMapping - Form control → table.column mapping
 * @returns {{ statements: string[], pgObjectType: string, warnings: string[] }}
 */
async function convertQueryWithLLM({
  apiKey, pool, schemaName, originalAccessSQL,
  failedPgSQL, pgError, controlMapping
}) {
  const warnings = [];

  // Build schema context
  const schemaContext = await buildSchemaContext(pool, schemaName);
  const mappingContext = formatControlMapping(controlMapping || {});

  const systemPrompt = `You convert Microsoft Access SQL to PostgreSQL DDL statements.

TARGET SCHEMA: ${schemaName}
All table references must be schema-qualified (e.g. ${schemaName}.table_name).
Use lowercase identifiers. Replace spaces in names with underscores.

RULES:
- SELECT queries → CREATE OR REPLACE VIEW ${schemaName}.viewname AS SELECT ...
- Parameterized queries → CREATE OR REPLACE FUNCTION ${schemaName}.funcname(...) RETURNS TABLE(...) or RETURNS SETOF
- Use table aliases: FROM ${schemaName}.employees e — then reference e.column_name
- Access Nz(x) → COALESCE(x, 0) for numeric, COALESCE(x, '') for text
- Access IIf(cond, t, f) → CASE WHEN cond THEN t ELSE f END
- Access Date() → CURRENT_DATE, Now() → CURRENT_TIMESTAMP
- Access True/False → TRUE/FALSE
- Access & (string concat) → ||
- Access Mid(s,start,len) → SUBSTRING(s FROM start FOR len)
- Access Left(s,n) → LEFT(s, n), Right(s,n) → RIGHT(s, n)
- Access Len(s) → LENGTH(s), Trim(s) → TRIM(s)
- Access InStr(s,sub) → POSITION(sub IN s)
- Access Format(val, fmt) → TO_CHAR(val, fmt) with PG format codes
- Access HAVING without GROUP BY → use WHERE instead
- Access TOP N → LIMIT N
- Access DISTINCTROW → DISTINCT
- Access * in joins → list columns explicitly if needed
- PIVOT/TRANSFORM queries → use crosstab() from tablefunc extension or CASE aggregation

FORM/REPORT REFERENCES:
References like [Forms]![FormName]![ControlName] or [TempVars]![VarName] should be resolved using shared.form_control_state subqueries:
(SELECT value FROM shared.form_control_state WHERE session_id = current_setting('app.session_id') AND table_name = 'TABLE' AND column_name = 'COLUMN')

Control mapping (formName.controlName → tableName.columnName):
${mappingContext}

For unresolved form references, use NULL with a comment explaining what was unresolved.

DATABASE SCHEMA:
${schemaContext}

Return ONLY the SQL statement(s). No markdown code fences, no explanations, no comments outside the SQL.
If multiple statements are needed (e.g. helper function + view), separate them with semicolons.`;

  const userMessage = `Original Access SQL:
${originalAccessSQL}

Our automated converter produced this PostgreSQL SQL, which failed:
${failedPgSQL}

PostgreSQL error:
${pgError}

Fix the SQL and return a valid CREATE OR REPLACE VIEW or CREATE OR REPLACE FUNCTION statement.`;

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
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }]
    })
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    const errMsg = errorData.error?.message || `API request failed with status ${response.status}`;
    throw new Error(`LLM fallback API error: ${errMsg}`);
  }

  const data = await response.json();

  // Extract text content
  let sqlText = '';
  for (const block of data.content) {
    if (block.type === 'text') {
      sqlText += block.text;
    }
  }

  if (!sqlText.trim()) {
    throw new Error('LLM returned empty response');
  }

  // Strip markdown code fences if present
  sqlText = sqlText.replace(/^```(?:sql)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();

  // Split on semicolons (but not inside strings)
  const statements = sqlText
    .split(/;\s*(?=(?:CREATE|DROP|ALTER|SET)\b)/i)
    .map(s => s.trim())
    .filter(s => s.length > 0 && !s.startsWith('--'));

  // Detect object type
  let pgObjectType = 'view';
  for (const stmt of statements) {
    if (/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION/i.test(stmt)) {
      pgObjectType = 'function';
      break;
    }
  }

  warnings.push('LLM-assisted conversion: regex converter failed, Claude fixed the SQL');

  return { statements, pgObjectType, warnings };
}

module.exports = { convertQueryWithLLM };
