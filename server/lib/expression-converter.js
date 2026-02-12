/**
 * Expression Converter — translates Access control-source expressions
 * containing domain functions (DLookUp, DCount, DSum, etc.) into
 * PostgreSQL LANGUAGE SQL STABLE functions.
 *
 * Simple expressions (IIf, math, string ops) are handled client-side.
 * This module only processes expressions that require database access.
 */

const { sanitizeName, formStateSubquery, translateTempVars, translateFormRefs } = require('./query-converter');
const { quoteIdent } = require('./access-types');

// Domain functions that require database access
const DOMAIN_FN_RE = /\b(DLookUp|DCount|DSum|DAvg|DFirst|DLast|DMin|DMax)\s*\(/i;

/**
 * Check if an expression contains domain functions that need server-side evaluation.
 * @param {string} expression - Access expression (with or without leading =)
 * @returns {boolean}
 */
function hasDomainFunctions(expression) {
  if (!expression || typeof expression !== 'string') return false;
  return DOMAIN_FN_RE.test(expression);
}

// ============================================================
// Argument parser (handles nested parens and quoted strings)
// ============================================================

function parseArguments(argsStr) {
  const args = [];
  let depth = 0;
  let current = '';
  let inString = false;
  let stringChar = null;

  for (let i = 0; i < argsStr.length; i++) {
    const ch = argsStr[i];
    if (inString) {
      current += ch;
      if (ch === stringChar) {
        if (i + 1 < argsStr.length && argsStr[i + 1] === stringChar) {
          current += argsStr[i + 1];
          i++;
        } else {
          inString = false;
          stringChar = null;
        }
      }
    } else if (ch === '"' || ch === "'") {
      inString = true;
      stringChar = ch;
      current += ch;
    } else if (ch === '(') {
      depth++;
      current += ch;
    } else if (ch === ')') {
      depth--;
      current += ch;
    } else if (ch === ',' && depth === 0) {
      args.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }

  if (current.trim()) {
    args.push(current.trim());
  }
  return args;
}

function findCloseParen(str, openIdx) {
  let depth = 1;
  let inString = false;
  let stringChar = null;

  for (let i = openIdx + 1; i < str.length; i++) {
    const ch = str[i];
    if (inString) {
      if (ch === stringChar) {
        if (i + 1 < str.length && str[i + 1] === stringChar) {
          i++;
        } else {
          inString = false;
        }
      }
    } else if (ch === '"' || ch === "'") {
      inString = true;
      stringChar = ch;
    } else if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// ============================================================
// Criteria string translator
// ============================================================

/**
 * Translate an Access criteria string to a PostgreSQL WHERE clause.
 * Access criteria look like: "[id]=" & [id]
 * - Quoted portions are SQL fragments (column references)
 * - Unquoted [field] references become function parameters
 *
 * @param {string} criteria - Raw Access criteria string (the third DLookUp arg)
 * @param {string} schemaName - Target schema
 * @param {Set} paramRefs - Set to collect [field] references found
 * @returns {string} PostgreSQL WHERE clause fragment
 */
function translateCriteria(criteria, schemaName, paramRefs) {
  if (!criteria) return 'true';

  // Strip surrounding quotes if the whole thing is a quoted string
  let c = criteria.trim();
  if ((c.startsWith('"') && c.endsWith('"')) || (c.startsWith("'") && c.endsWith("'"))) {
    c = c.slice(1, -1);
  }

  // Split on & (Access string concatenation) — the criteria is built by
  // concatenating string literals and field references:
  //   "[id]=" & [id]  →  parts: ['"[id]="', '[id]']
  // More complex:
  //   "[category]=" & [category] & " AND [active]=True"

  // Strategy: scan for [fieldName] references outside of quoted strings.
  // Inside quoted strings, [colName] refers to the target table column.
  // Outside quoted strings, [fieldName] refers to the form's record field (→ parameter).
  //
  // We process the & concatenation to produce a single SQL expression.

  const parts = splitOnConcat(c);
  let sql = '';

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
        (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
      // Quoted string literal — contains SQL fragment with [column] refs
      let fragment = trimmed.slice(1, -1);
      // Convert [colName] to quoted identifier
      fragment = fragment.replace(/\[([^\]]+)\]/g, (_, col) => {
        return quoteIdent(sanitizeName(col));
      });
      // Convert Access True/False to PostgreSQL
      fragment = fragment.replace(/\bTrue\b/gi, 'true').replace(/\bFalse\b/gi, 'false');
      sql += fragment;
    } else if (/^\[([^\]]+)\]$/.test(trimmed)) {
      // Bare [fieldName] reference — becomes a function parameter
      const fieldName = trimmed.match(/^\[([^\]]+)\]$/)[1];
      const pgParam = 'p_' + sanitizeName(fieldName);
      paramRefs.add(fieldName);
      sql += pgParam;
    } else {
      // Other literal (number, keyword) — pass through
      let fragment = trimmed;
      fragment = fragment.replace(/\[([^\]]+)\]/g, (_, name) => {
        // Could be either a column or parameter reference depending on context
        // If it appears outside quotes after &, treat as parameter
        paramRefs.add(name);
        return 'p_' + sanitizeName(name);
      });
      fragment = fragment.replace(/\bTrue\b/gi, 'true').replace(/\bFalse\b/gi, 'false');
      sql += fragment;
    }
  }

  return sql || 'true';
}

/**
 * Split a string on & (Access concatenation operator),
 * respecting quoted strings.
 */
function splitOnConcat(str) {
  const parts = [];
  let current = '';
  let inString = false;
  let stringChar = null;

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (inString) {
      current += ch;
      if (ch === stringChar) {
        if (i + 1 < str.length && str[i + 1] === stringChar) {
          current += str[i + 1];
          i++;
        } else {
          inString = false;
          stringChar = null;
        }
      }
    } else if (ch === '"' || ch === "'") {
      inString = true;
      stringChar = ch;
      current += ch;
    } else if (ch === '&') {
      parts.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

// ============================================================
// Domain function translator
// ============================================================

/**
 * Translate a single domain function call to a PostgreSQL subquery.
 * @param {string} fnName - Function name (DLookUp, DCount, etc.)
 * @param {string[]} args - Parsed arguments [expr, domain, criteria?]
 * @param {string} schemaName - Target schema name
 * @param {Set} paramRefs - Collects field references that become function params
 * @returns {string} PostgreSQL subquery expression
 */
function translateDomainFunction(fnName, args, schemaName, paramRefs) {
  const fn = fnName.toLowerCase();

  // First arg: field/expression — strip quotes
  let fieldExpr = (args[0] || '*').trim();
  if ((fieldExpr.startsWith('"') && fieldExpr.endsWith('"')) ||
      (fieldExpr.startsWith("'") && fieldExpr.endsWith("'"))) {
    fieldExpr = fieldExpr.slice(1, -1);
  }
  // Sanitize the field name
  const pgField = sanitizeName(fieldExpr);

  // Second arg: domain (table/query name) — strip quotes
  let domain = (args[1] || '').trim();
  if ((domain.startsWith('"') && domain.endsWith('"')) ||
      (domain.startsWith("'") && domain.endsWith("'"))) {
    domain = domain.slice(1, -1);
  }
  const pgTable = sanitizeName(domain);
  const qualifiedTable = `${quoteIdent(schemaName)}.${quoteIdent(pgTable)}`;

  // Third arg: criteria (optional)
  let whereClause = 'true';
  if (args[2]) {
    whereClause = translateCriteria(args[2], schemaName, paramRefs);
  }

  switch (fn) {
    case 'dlookup':
    case 'dfirst':
      return `(SELECT ${quoteIdent(pgField)} FROM ${qualifiedTable} WHERE ${whereClause} LIMIT 1)`;
    case 'dlast':
      return `(SELECT ${quoteIdent(pgField)} FROM ${qualifiedTable} WHERE ${whereClause} ORDER BY ctid DESC LIMIT 1)`;
    case 'dcount':
      return `(SELECT COUNT(${fieldExpr === '*' ? '*' : quoteIdent(pgField)}) FROM ${qualifiedTable} WHERE ${whereClause})`;
    case 'dsum':
      return `(SELECT COALESCE(SUM(${quoteIdent(pgField)}), 0) FROM ${qualifiedTable} WHERE ${whereClause})`;
    case 'davg':
      return `(SELECT AVG(${quoteIdent(pgField)}) FROM ${qualifiedTable} WHERE ${whereClause})`;
    case 'dmin':
      return `(SELECT MIN(${quoteIdent(pgField)}) FROM ${qualifiedTable} WHERE ${whereClause})`;
    case 'dmax':
      return `(SELECT MAX(${quoteIdent(pgField)}) FROM ${qualifiedTable} WHERE ${whereClause})`;
    default:
      return `NULL /* unknown domain function: ${fnName} */`;
  }
}

// ============================================================
// Access expression → SQL translator
// ============================================================

/**
 * Apply surrounding Access function translations to a SQL expression.
 * Handles IIf, IsNull, Nz, Not, etc.
 */
function translateAccessFunctions(sql) {
  let changed = true;
  let iterations = 0;

  // Function-call translations: find match, extract args, replace
  const fnTranslations = [
    {
      pattern: /\bIIf\s*\(/gi,
      transform(args) {
        if (args.length < 3) return null;
        return `CASE WHEN ${args[0]} THEN ${args[1]} ELSE ${args[2]} END`;
      }
    },
    {
      pattern: /\bNz\s*\(/gi,
      transform(args) {
        return args.length >= 2
          ? `COALESCE(${args[0]}, ${args[1]})`
          : `COALESCE(${args[0]}, '')`;
      }
    },
    {
      pattern: /\bIsNull\s*\(/gi,
      transform(args) {
        return `(${args[0]} IS NULL)`;
      }
    }
  ];

  while (changed && iterations < 20) {
    changed = false;
    iterations++;
    const prev = sql;

    // Try each function-call translation
    for (const { pattern, transform } of fnTranslations) {
      pattern.lastIndex = 0;
      const match = pattern.exec(sql);
      if (match) {
        const start = match.index;
        const parenIdx = sql.indexOf('(', start + match[0].length - 1);
        if (parenIdx !== -1) {
          const closeIdx = findCloseParen(sql, parenIdx);
          if (closeIdx !== -1) {
            const argsStr = sql.substring(parenIdx + 1, closeIdx);
            const args = parseArguments(argsStr);
            const replacement = transform(args);
            if (replacement !== null) {
              sql = sql.substring(0, start) + replacement + sql.substring(closeIdx + 1);
              changed = true;
              break;
            }
          }
        }
      }
    }
    if (changed) continue;

    // Simple keyword/operator replacements
    sql = sql.replace(/\bNot\s+/gi, 'NOT ');
    if (sql !== prev) { changed = true; continue; }

    sql = sql.replace(/\bTrue\b/gi, 'true').replace(/\bFalse\b/gi, 'false');
    if (sql !== prev) { changed = true; continue; }

    sql = sql.replace(/\s*&\s*/g, ' || ');
    if (sql !== prev) { changed = true; continue; }
  }

  return sql;
}

// ============================================================
// Main translation pipeline
// ============================================================

/**
 * Translate Form!controlName (self-reference within the current form) to
 * Forms!formName!controlName so it maps to the same state table subquery.
 * Must run BEFORE translateFormRefs to avoid double-matching.
 *
 * @param {string} sql - Expression text
 * @param {string} formName - Sanitized current form name
 * @returns {string}
 */
function translateFormSelfRefs(sql, formName) {
  if (!formName) return sql;
  // [Form]![controlName]
  sql = sql.replace(/\[Form\]!\[([^\]]+)\]/gi, (_, ctrl) =>
    formStateSubquery(formName, sanitizeName(ctrl)));
  // Form![controlName]
  sql = sql.replace(/\bForm!\[([^\]]+)\]/gi, (_, ctrl) =>
    formStateSubquery(formName, sanitizeName(ctrl)));
  // Form!controlName (bare)
  sql = sql.replace(/\bForm!([\w]+)/gi, (_, ctrl) =>
    formStateSubquery(formName, sanitizeName(ctrl)));
  return sql;
}

/**
 * Translate an Access control-source expression containing domain functions
 * into a PostgreSQL function body.
 *
 * @param {string} expression - Access expression (e.g. "=IIf(Not IsNull([id]),DLookUp(...))")
 * @param {string} schemaName - Target database schema
 * @param {Map|Object} columnTypes - Map of columnName → pgType for the record source table
 * @param {string} [formName] - Sanitized current form name (for Form!x self-references)
 * @returns {{ sql: string, params: Array<{name: string, pgName: string, pgType: string}>, returnType: string }}
 */
function translateExpression(expression, schemaName, columnTypes, formName) {
  // Strip leading =
  let expr = expression.trim();
  if (expr.startsWith('=')) expr = expr.substring(1);

  // Phase 0: Translate Form!/Forms!/TempVars references to state table subqueries
  // Must run BEFORE [field] collection so they don't become function parameters
  expr = translateTempVars(expr);
  expr = translateFormSelfRefs(expr, formName);
  expr = translateFormRefs(expr);

  // Collect field references that become function parameters
  const paramRefs = new Set();

  // Phase 1: Find and translate domain function calls
  let sql = expr;
  let found = true;
  let iterations = 0;

  while (found && iterations < 20) {
    found = false;
    iterations++;

    const domainMatch = DOMAIN_FN_RE.exec(sql);
    if (domainMatch) {
      const fnName = domainMatch[1];
      const start = domainMatch.index;
      const parenIdx = sql.indexOf('(', start + domainMatch[0].length - 1);
      if (parenIdx !== -1) {
        const closeIdx = findCloseParen(sql, parenIdx);
        if (closeIdx !== -1) {
          const argsStr = sql.substring(parenIdx + 1, closeIdx);
          const args = parseArguments(argsStr);
          const subquery = translateDomainFunction(fnName, args, schemaName, paramRefs);
          sql = sql.substring(0, start) + subquery + sql.substring(closeIdx + 1);
          found = true;
          DOMAIN_FN_RE.lastIndex = 0;
        }
      }
    }
  }

  // Phase 2: Collect [field] references from the outer expression (non-domain parts)
  // These are references to the form's record source fields
  const fieldRefRe = /\[([^\]]+)\]/g;
  let m;
  // We need to scan the SQL for remaining [field] refs that aren't inside subqueries
  const tempSql = sql;
  while ((m = fieldRefRe.exec(tempSql)) !== null) {
    paramRefs.add(m[1]);
  }

  // Phase 3: Replace [field] references with parameter names in the outer expression
  sql = sql.replace(/\[([^\]]+)\]/g, (_, fieldName) => {
    return 'p_' + sanitizeName(fieldName);
  });

  // Phase 4: Translate remaining Access functions (IIf, IsNull, Nz, Not, etc.)
  sql = translateAccessFunctions(sql);

  // Phase 5: Build parameter list with types
  const colTypes = columnTypes instanceof Map ? columnTypes : new Map(Object.entries(columnTypes || {}));
  const params = [];
  for (const fieldName of paramRefs) {
    const pgName = 'p_' + sanitizeName(fieldName);
    const colName = sanitizeName(fieldName);
    // Look up type from column types map
    let pgType = colTypes.get(colName) || colTypes.get(fieldName) || 'text';
    params.push({ name: fieldName, pgName, pgType });
  }

  // Phase 6: Determine return type heuristic
  let returnType = 'text';
  const sqlLower = sql.toLowerCase();
  if (/\bcount\s*\(/.test(sqlLower)) returnType = 'bigint';
  else if (/\bsum\s*\(/.test(sqlLower) || /\bavg\s*\(/.test(sqlLower)) returnType = 'numeric';
  else if (/\bmin\s*\(/.test(sqlLower) || /\bmax\s*\(/.test(sqlLower)) returnType = 'text';
  // If the expression is a simple DLookUp without aggregates, try to infer from the looked-up field
  // For now, default to text (safe cast)

  return { sql, params, returnType };
}

/**
 * Build a complete CREATE OR REPLACE FUNCTION statement.
 *
 * @param {string} functionName - Sanitized function name (e.g. "ingredient_calc_text5")
 * @param {string} schemaName - Target schema
 * @param {string} sqlBody - Translated SQL expression
 * @param {Array<{pgName: string, pgType: string}>} params - Function parameters
 * @param {string} returnType - PostgreSQL return type
 * @returns {string} Full CREATE FUNCTION DDL
 */
function buildFunctionDDL(functionName, schemaName, sqlBody, params, returnType) {
  const qualifiedName = `${quoteIdent(schemaName)}.${quoteIdent(functionName)}`;
  const paramList = params.map(p => `${p.pgName} ${p.pgType}`).join(', ');

  return `CREATE OR REPLACE FUNCTION ${qualifiedName}(${paramList})
RETURNS ${returnType} AS $$
  SELECT ${sqlBody};
$$ LANGUAGE SQL STABLE`;
}

/**
 * Get column types for a table from information_schema.
 * @param {object} pool - Database connection pool
 * @param {string} schemaName - Schema name
 * @param {string} tableName - Table/view name
 * @returns {Promise<Map<string, string>>} Map of column_name → data_type
 */
async function getColumnTypes(pool, schemaName, tableName) {
  const result = await pool.query(`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = $1 AND table_name = $2
  `, [schemaName, tableName]);

  const types = new Map();
  for (const row of result.rows) {
    types.set(row.column_name.toLowerCase(), row.data_type);
  }
  return types;
}

/**
 * Process all controls in a form/report definition, creating PG functions
 * for domain-function expressions and annotating the controls.
 *
 * @param {object} pool - Database connection pool
 * @param {object} definition - Parsed form/report definition
 * @param {string} objectName - Form/report name (sanitized)
 * @param {string} schemaName - Database schema
 * @param {string} objectType - 'form' or 'report'
 * @returns {Promise<{definition: object, functions: string[], warnings: string[]}>}
 */
async function processDefinitionExpressions(pool, definition, objectName, schemaName, objectType) {
  const functions = [];
  const warnings = [];
  const pgObjectName = sanitizeName(objectName);

  // Get the record source and its column types
  const recordSource = definition['record-source'] || definition['record_source'];
  let columnTypes = new Map();
  if (recordSource) {
    try {
      columnTypes = await getColumnTypes(pool, schemaName, sanitizeName(recordSource));
    } catch (e) {
      warnings.push(`Could not load column types for ${recordSource}: ${e.message}`);
    }
  }

  // Collect all sections to scan
  const sections = [];
  if (objectType === 'form') {
    for (const sectionKey of ['header', 'detail', 'footer']) {
      if (definition[sectionKey]) {
        sections.push({ key: sectionKey, section: definition[sectionKey] });
      }
    }
  } else {
    // Reports have banded sections
    for (const [key, value] of Object.entries(definition)) {
      if (value && typeof value === 'object' && Array.isArray(value.controls)) {
        sections.push({ key, section: value });
      }
    }
  }

  // Process each control in each section
  for (const { key: sectionKey, section } of sections) {
    const controls = section.controls || [];
    for (let i = 0; i < controls.length; i++) {
      const ctrl = controls[i];
      const controlSource = ctrl['control-source'] || ctrl['field'];
      if (!controlSource || typeof controlSource !== 'string') continue;
      if (!controlSource.startsWith('=')) continue;
      if (!hasDomainFunctions(controlSource)) continue;

      // This control has a domain function expression — translate it
      const ctrlName = sanitizeName(ctrl.name || ctrl.id || `ctrl${i}`);
      const functionName = `${pgObjectName}_calc_${ctrlName}`;

      try {
        const { sql, params, returnType } = translateExpression(controlSource, schemaName, columnTypes, pgObjectName);
        const ddl = buildFunctionDDL(functionName, schemaName, sql, params, returnType);

        // Create the function in the database
        await pool.query(ddl);
        functions.push(functionName);

        // Annotate the control with computed function metadata
        controls[i] = {
          ...ctrl,
          'computed-function': functionName,
          'computed-params': params.map(p => sanitizeName(p.name)),
          'computed-alias': `_calc_${ctrlName}`
        };

        console.log(`Created computed function: ${schemaName}.${functionName}`);
      } catch (err) {
        warnings.push(`Failed to create function ${functionName} for control ${ctrl.name}: ${err.message}`);
        console.error(`Error creating computed function ${functionName}:`, err.message);
      }
    }
  }

  return { definition, functions, warnings };
}

module.exports = {
  hasDomainFunctions,
  translateExpression,
  buildFunctionDDL,
  getColumnTypes,
  processDefinitionExpressions,
  // Exported for testing
  translateCriteria,
  translateDomainFunction,
  translateAccessFunctions,
  translateFormSelfRefs,
  sanitizeName
};
