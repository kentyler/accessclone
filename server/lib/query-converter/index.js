/**
 * Access Query → PostgreSQL Converter
 *
 * Three-layer conversion:
 * 1. Function translation lookup table (FUNCTION_MAP) — deterministic Access→PG function mapping
 * 2. Syntax translations — brackets, operators, literals, keywords
 * 3. Calculated column extraction — SELECT aliases → LANGUAGE SQL IMMUTABLE functions
 */

const { sanitizeName } = require('./utils');
const { formStateSubquery, resolveControlMapping, translateTempVars, translateFormRefs, buildStateFromWhere } = require('./form-state');
const { applyFunctionTranslations } = require('./functions');
const { applySyntaxTranslations, addSchemaPrefix, addSchemaFunctionPrefix } = require('./syntax');
const {
  needsCustomAggregates, getAggregateStatements,
  buildSelectView, buildParameterizedSelect, buildPlpgsqlFunction, buildMakeTableFunction,
  resolveParams
} = require('./ddl');

/**
 * Inject cross-join FROM and WHERE additions for session_state refs into SQL.
 * Handles SELECT, UPDATE, DELETE, and INSERT...SELECT statements.
 */
function injectStateJoins(sql, stateRefs) {
  const { fromAdditions, whereAdditions } = buildStateFromWhere(stateRefs);
  if (!fromAdditions) return sql;

  // Find the insertion point for FROM additions: before WHERE/GROUP BY/ORDER BY/HAVING/LIMIT
  // We need to find the end of the FROM clause (including JOINs)
  const fromInsertRegex = /\b(WHERE|GROUP\s+BY|ORDER\s+BY|HAVING|LIMIT)\b/i;
  const fromMatch = fromInsertRegex.exec(sql);

  if (fromMatch) {
    // Insert FROM additions before the first clause keyword
    const insertPos = fromMatch.index;
    const before = sql.substring(0, insertPos).trimEnd();
    const after = sql.substring(insertPos);

    if (/\bWHERE\b/i.test(after)) {
      // WHERE exists — inject FROM additions before WHERE, prepend state conditions to WHERE
      sql = before + fromAdditions + ' ' +
        after.replace(/\bWHERE\b/i, `WHERE ${whereAdditions} AND`);
    } else {
      // No WHERE — inject FROM additions + new WHERE clause before GROUP BY/ORDER BY/etc.
      sql = before + fromAdditions + ` WHERE ${whereAdditions} ` + after;
    }
  } else {
    // No WHERE/GROUP BY/ORDER BY/HAVING/LIMIT — append FROM additions + WHERE
    sql = sql.trimEnd() + fromAdditions + ` WHERE ${whereAdditions}`;
  }

  return sql;
}

/**
 * Convert an Access query to PostgreSQL statements.
 *
 * @param {Object} queryData - { queryName, queryType, queryTypeCode, sql, parameters }
 * @param {string} schemaName - Target PostgreSQL schema
 * @param {Object} [columnTypes] - Optional map of column name → PG data type
 * @param {Object} [controlMapping] - {"formname.controlname": {table, column}, ...}
 * @returns {Object} { statements[], pgObjectName, pgObjectType, warnings[], extractedFunctions[], referencedStateEntries[] }
 */
function convertAccessQuery(queryData, schemaName, columnTypes, controlMapping) {
  const { queryName, queryType, queryTypeCode, sql: originalSql, parameters = [] } = queryData;
  const warnings = [];
  const pgName = sanitizeName(queryName);

  if (!originalSql || !originalSql.trim()) {
    return { statements: [], pgObjectName: pgName, pgObjectType: 'none',
      warnings: ['Empty SQL — nothing to convert'], extractedFunctions: [] };
  }

  let sql = originalSql.trim().replace(/;\s*$/, '');

  // Strip PARAMETERS declaration before any translation
  sql = sql.replace(/^PARAMETERS\s+[^;]+;\s*/i, '');

  // Resolve DAO-declared parameters (excluding TempVar declarations, which become subqueries)
  const uniqueParams = resolveParams(parameters, [], columnTypes, sql);

  // Track which state table entries are referenced by form refs
  const referencedStateEntries = [];
  // Collect cross-join metadata for session_state refs
  const stateRefs = [];

  // Step 2: Function translations
  try { sql = applyFunctionTranslations(sql); }
  catch (err) { warnings.push(`Function translation error: ${err.message}`); }

  // Step 3: Syntax translations (threads controlMapping for form ref resolution)
  try { sql = applySyntaxTranslations(sql, controlMapping, referencedStateEntries, warnings, stateRefs); }
  catch (err) { warnings.push(`Syntax translation error: ${err.message}`); }

  // Step 4: Schema prefix (tables in FROM/JOIN, then user-defined function calls)
  // Must run BEFORE state join injection so shared.session_state isn't double-prefixed
  sql = addSchemaPrefix(sql, schemaName);
  sql = addSchemaFunctionPrefix(sql, schemaName);

  // Step 5: Inject cross-join FROM/WHERE for session_state refs
  if (stateRefs.length > 0) {
    sql = injectStateJoins(sql, stateRefs);
  }

  // Custom aggregates
  const statements = [];
  if (needsCustomAggregates(sql)) {
    statements.push(...getAggregateStatements(schemaName));
  }

  // Step 6: Build DDL based on query type
  const hasParams = uniqueParams.length > 0;
  const isSelect = /^\s*SELECT\b/i.test(sql);
  const isUpdate = queryTypeCode === 48 || /^\s*UPDATE\b/i.test(sql);
  const isDelete = queryTypeCode === 32 || /^\s*DELETE\b/i.test(sql);
  const isInsert = queryTypeCode === 64 || /^\s*INSERT\b/i.test(sql);
  const isMakeTable = queryTypeCode === 80;
  const isCrosstab = queryTypeCode === 16;
  const isUnion = queryTypeCode === 128;

  let pgObjectType;
  let extractedFunctions = [];

  if (isMakeTable) {
    const result = buildMakeTableFunction(sql, schemaName, pgName, uniqueParams, originalSql);
    pgObjectType = result.pgObjectType || 'function';
    statements.push(...result.statements);
    warnings.push(...result.warnings);

  } else if (isCrosstab) {
    pgObjectType = 'view';
    warnings.push('Crosstab queries require the tablefunc extension and manual column definitions');
    statements.push(`-- Crosstab query — requires manual conversion:\n-- ${sql.replace(/\n/g, '\n-- ')}`);

  } else if (isUpdate || isDelete || isInsert) {
    pgObjectType = 'function';
    statements.push(...buildPlpgsqlFunction(sql, schemaName, pgName, uniqueParams));

  } else if (isSelect && hasParams) {
    pgObjectType = 'function';
    const result = buildParameterizedSelect(sql, schemaName, pgName, queryName, uniqueParams);
    statements.push(...result.statements);
    extractedFunctions = result.extractedFunctions;
    warnings.push(...(result.warnings || []));

  } else if (isSelect && !hasParams) {
    pgObjectType = 'view';
    const result = buildSelectView(sql, schemaName, pgName, queryName);
    statements.push(...result.statements);
    extractedFunctions = result.extractedFunctions;

  } else if (isUnion) {
    pgObjectType = 'view';
    statements.push(`CREATE OR REPLACE VIEW ${schemaName}."${pgName}" AS\n${sql}`);

  } else {
    pgObjectType = 'none';
    warnings.push(`Unsupported query type: ${queryType} (code ${queryTypeCode})`);
    statements.push(`-- Unsupported query type "${queryType}" (code ${queryTypeCode}):\n-- ${originalSql.replace(/\n/g, '\n-- ')}`);
  }

  return { statements, pgObjectName: pgName, pgObjectType, warnings, extractedFunctions, referencedStateEntries };
}

/**
 * Convert a standalone Access expression (e.g. from a calculated column)
 * to PostgreSQL syntax. Applies function + syntax translations without
 * schema-prefix or DDL logic.
 */
function convertAccessExpression(expr) {
  let result = expr;
  result = applyFunctionTranslations(result);
  result = applySyntaxTranslations(result);
  return result;
}

module.exports = {
  convertAccessQuery, convertAccessExpression, sanitizeName,
  formStateSubquery, resolveControlMapping, translateTempVars, translateFormRefs, buildStateFromWhere
};
