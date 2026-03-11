/**
 * Main expression translation pipeline.
 * translateExpression, translateFormSelfRefs, processDefinitionExpressions,
 * buildFunctionDDL, getColumnTypes.
 */

const { sanitizeName, formStateSubquery, translateTempVars, translateFormRefs, resolveControlMapping } = require('../query-converter');
const { quoteIdent } = require('../access-types');
const { DOMAIN_FN_RE, hasDomainFunctions, translateDomainFunction } = require('./domain-functions');
const { parseArguments, findCloseParen, translateAccessFunctions } = require('./access-functions');

/**
 * Translate Form!controlName (self-reference within the current form) to
 * state table subquery using controlMapping when available.
 */
function translateFormSelfRefs(sql, formName, controlMapping) {
  if (!formName) return sql;

  function resolveCtrl(ctrl) {
    const cn = sanitizeName(ctrl);
    if (controlMapping) {
      const resolved = resolveControlMapping(controlMapping, formName, cn, true);
      if (resolved) return formStateSubquery(resolved.table, resolved.column);
    }
    return formStateSubquery(formName, cn);
  }

  sql = sql.replace(/\[Form\]!\[([^\]]+)\]/gi, (_, ctrl) => resolveCtrl(ctrl));
  sql = sql.replace(/\bForm!\[([^\]]+)\]/gi, (_, ctrl) => resolveCtrl(ctrl));
  sql = sql.replace(/\bForm!([\w]+)/gi, (_, ctrl) => resolveCtrl(ctrl));
  return sql;
}

/**
 * Translate an Access control-source expression containing domain functions
 * into a PostgreSQL function body.
 */
function translateExpression(expression, schemaName, columnTypes, formName, controlMapping) {
  let expr = expression.trim();
  if (expr.startsWith('=')) expr = expr.substring(1);

  // Phase 0: Translate Form!/Forms!/TempVars references
  expr = translateTempVars(expr);
  expr = translateFormSelfRefs(expr, formName, controlMapping);
  expr = translateFormRefs(expr, controlMapping);

  // Phase 0.5: Collapse subform references [subformCtrl].[Form].[controlName] → single param [subformCtrl_controlName]
  expr = expr.replace(/\[([^\]]+)\]\.(?:\[Form\]|Form)\.(?:\[([^\]]+)\]|(\w+))/gi, (_, subform, bracketCtrl, bareCtrl) => {
    const ctrl = bracketCtrl || bareCtrl;
    return `[${subform}_${ctrl}]`;
  });

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

  // Phase 2: Collect [field] references
  const fieldRefRe = /\[([^\]]+)\]/g;
  let m;
  const tempSql = sql;
  while ((m = fieldRefRe.exec(tempSql)) !== null) {
    paramRefs.add(m[1]);
  }

  // Phase 3: Replace [field] references with parameter names
  sql = sql.replace(/\[([^\]]+)\]/g, (_, fieldName) => {
    return 'p_' + sanitizeName(fieldName);
  });

  // Phase 4: Translate remaining Access functions
  sql = translateAccessFunctions(sql);

  // Phase 5: Build parameter list with types
  const colTypes = columnTypes instanceof Map ? columnTypes : new Map(Object.entries(columnTypes || {}));
  const params = [];
  for (const fieldName of paramRefs) {
    const pgName = 'p_' + sanitizeName(fieldName);
    const colName = sanitizeName(fieldName);
    let pgType = colTypes.get(colName) || colTypes.get(fieldName) || 'text';
    params.push({ name: fieldName, pgName, pgType });
  }

  // Phase 5.5: Upgrade text-typed params to numeric when used in arithmetic context
  for (const param of params) {
    if (param.pgType === 'text') {
      // If this param appears next to *, /, +, - operators, it's likely numeric
      const arithRe = new RegExp(`(?:[*\\/+\\-]\\s*${param.pgName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b|\\b${param.pgName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[*\\/+\\-])`);
      if (arithRe.test(sql)) {
        param.pgType = 'numeric';
      }
    }
  }

  // Phase 5.6: Fix COALESCE defaults for numeric params (Nz without 2nd arg defaults to '')
  for (const param of params) {
    if (/^(numeric|integer|bigint|smallint|real|double precision|decimal|money)$/.test(param.pgType)) {
      // Replace COALESCE(p_xxx, '') with COALESCE(p_xxx, 0) for numeric params
      sql = sql.replace(new RegExp(`COALESCE\\(${param.pgName},\\s*''\\)`, 'g'), `COALESCE(${param.pgName}, 0)`);
    }
  }

  // Phase 6: Determine return type heuristic
  let returnType = 'text';
  const sqlLower = sql.toLowerCase();
  if (/\bcount\s*\(/.test(sqlLower)) returnType = 'bigint';
  else if (/\bsum\s*\(/.test(sqlLower) || /\bavg\s*\(/.test(sqlLower)) returnType = 'numeric';
  else if (/\bmin\s*\(/.test(sqlLower) || /\bmax\s*\(/.test(sqlLower)) returnType = 'text';
  // Pure arithmetic expressions (*, /, +, - with parameters) default to numeric
  else if (/[*\/]/.test(sql) && params.length > 0) returnType = 'numeric';
  // All numeric-typed parameters suggest numeric result
  else if (params.length > 0 && params.every(p => /^(numeric|integer|bigint|smallint|real|double precision|decimal)$/.test(p.pgType))) returnType = 'numeric';

  return { sql, params, returnType };
}

/**
 * Build a complete CREATE OR REPLACE FUNCTION statement.
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
 */
async function processDefinitionExpressions(pool, definition, objectName, schemaName, objectType) {
  const functions = [];
  const warnings = [];
  const pgObjectName = sanitizeName(objectName);

  const recordSource = definition['record-source'] || definition['record_source'];
  let columnTypes = new Map();
  if (recordSource) {
    // Extract base table/view name — may be a simple name or SQL like "SELECT ... FROM (tableName) sub"
    let baseTable = sanitizeName(recordSource);
    if (/^\s*SELECT\b/i.test(recordSource)) {
      const fromMatch = recordSource.match(/\bFROM\s+\(?(\w+)\)?/i);
      if (fromMatch) baseTable = sanitizeName(fromMatch[1]);
    }
    try {
      columnTypes = await getColumnTypes(pool, schemaName, baseTable);
    } catch (e) {
      warnings.push(`Could not load column types for ${recordSource}: ${e.message}`);
    }
  }

  const sections = [];
  if (objectType === 'form') {
    for (const sectionKey of ['header', 'detail', 'footer']) {
      if (definition[sectionKey]) {
        sections.push({ key: sectionKey, section: definition[sectionKey] });
      }
    }
  } else {
    for (const [key, value] of Object.entries(definition)) {
      if (value && typeof value === 'object' && Array.isArray(value.controls)) {
        sections.push({ key, section: value });
      }
    }
  }

  for (const { key: sectionKey, section } of sections) {
    const controls = section.controls || [];
    for (let i = 0; i < controls.length; i++) {
      const ctrl = controls[i];
      const controlSource = ctrl['control-source'] || ctrl['field'];
      if (!controlSource || typeof controlSource !== 'string') continue;
      if (!controlSource.startsWith('=')) continue;

      // Skip URL literals (e.g. ="https://...") — not computable expressions
      const exprBody = controlSource.slice(1).trim();
      if (/^"https?:\/\//i.test(exprBody)) {
        warnings.push(`Control ${ctrl.name || ctrl.id}: URL control-source skipped (not a computable expression)`);
        continue;
      }

      const ctrlName = sanitizeName(ctrl.name || ctrl.id || `ctrl${i}`);
      const functionName = `${pgObjectName}_calc_${ctrlName}`;

      try {
        const { sql, params, returnType } = translateExpression(controlSource, schemaName, columnTypes, pgObjectName);
        const ddl = buildFunctionDDL(functionName, schemaName, sql, params, returnType);

        await pool.query(ddl);
        functions.push(functionName);

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
  translateFormSelfRefs, translateExpression, buildFunctionDDL,
  getColumnTypes, processDefinitionExpressions
};
