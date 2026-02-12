/**
 * Access Query → PostgreSQL Converter
 *
 * Three-layer conversion:
 * 1. Function translation lookup table (FUNCTION_MAP) — deterministic Access→PG function mapping
 * 2. Syntax translations — brackets, operators, literals, keywords
 * 3. Calculated column extraction — SELECT aliases → LANGUAGE SQL IMMUTABLE functions
 */

const { FORMAT_MAP, FUNCTION_MAP } = require('./access-function-map');

// ============================================================
// Name utilities
// ============================================================

function sanitizeName(name) {
  return name.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ============================================================
// Access parameter type → PG type
// ============================================================

function mapParamType(accessType) {
  switch (accessType) {
    case 'Boolean': return 'boolean';
    case 'Byte': case 'Integer': return 'integer';
    case 'Long': return 'bigint';
    case 'Currency': return 'numeric(19,4)';
    case 'Single': return 'real';
    case 'Double': return 'double precision';
    case 'Date': return 'date';
    case 'Memo': return 'text';
    case 'Text': default: return 'text';
  }
}

// ============================================================
// Argument parser — handles nested parens and quoted strings
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

// ============================================================
// Core function application engine
// ============================================================

function findCloseParen(sql, openIdx) {
  let depth = 1;
  let inString = false;
  let stringChar = null;

  for (let i = openIdx + 1; i < sql.length; i++) {
    const ch = sql[i];
    if (inString) {
      if (ch === stringChar) {
        if (i + 1 < sql.length && sql[i + 1] === stringChar) {
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

/**
 * Apply all function translations iteratively until stable.
 */
function applyFunctionTranslations(sql) {
  let changed = true;
  let iterations = 0;

  while (changed && iterations < 20) {
    changed = false;
    iterations++;

    for (const entry of FUNCTION_MAP) {
      entry.match.lastIndex = 0;
      let match;
      while ((match = entry.match.exec(sql)) !== null) {
        const fnStart = match.index;
        const parenIdx = sql.indexOf('(', fnStart + match[0].length - 1);
        if (parenIdx === -1) continue;

        const closeIdx = findCloseParen(sql, parenIdx);
        if (closeIdx === -1) continue;

        const argsStr = sql.substring(parenIdx + 1, closeIdx);
        const args = parseArguments(argsStr);
        const replacement = entry.transform(args);

        const newSql = sql.substring(0, fnStart) + replacement + sql.substring(closeIdx + 1);
        if (newSql !== sql) {
          sql = newSql;
          changed = true;
          entry.match.lastIndex = 0;
          break;
        }
      }
      if (changed) break;
    }
  }

  return sql;
}

// ============================================================
// TempVars extraction
// ============================================================

/**
 * Convert TempVars references to function parameters.
 * Returns { sql, params: [{name, pgName}] }
 */
function extractTempVars(sql) {
  const params = [];
  const seen = new Set();

  const addParam = (varName) => {
    const pgName = 'p_' + varName.toLowerCase().replace(/\s+/g, '_');
    if (!seen.has(pgName)) {
      seen.add(pgName);
      params.push({ name: varName, pgName });
    }
    return pgName;
  };

  // [TempVars]![varName]
  sql = sql.replace(/\[TempVars\]!\[(\w+)\]/gi, (_, v) => addParam(v));
  // TempVars("varName")
  sql = sql.replace(/TempVars\("(\w+)"\)/gi, (_, v) => addParam(v));
  // TempVars!varName
  sql = sql.replace(/TempVars!(\w+)/gi, (_, v) => addParam(v));

  return { sql, params };
}

// ============================================================
// Syntax translations
// ============================================================

function applySyntaxTranslations(sql) {
  // DISTINCTROW → DISTINCT
  sql = sql.replace(/\bDISTINCTROW\b/gi, 'DISTINCT');

  // TOP N → strip and append LIMIT at the end
  let topN = null;
  sql = sql.replace(/\b(SELECT\s+(?:DISTINCT\s+)?)(TOP\s+(\d+))\b/gi, (match, prefix, topClause, n) => {
    topN = parseInt(n);
    return prefix.trimEnd() + ' ';
  });

  // True/False → true/false
  sql = sql.replace(/\bTrue\b/gi, 'true');
  sql = sql.replace(/\bFalse\b/gi, 'false');

  // Date() → CURRENT_DATE, Now() → CURRENT_TIMESTAMP
  sql = sql.replace(/\bDate\s*\(\s*\)/gi, 'CURRENT_DATE');
  sql = sql.replace(/\bNow\s*\(\s*\)/gi, 'CURRENT_TIMESTAMP');
  sql = sql.replace(/\bTime\s*\(\s*\)/gi, 'CURRENT_TIME');

  // Access date literals: #mm/dd/yyyy# → 'yyyy-mm-dd'::date
  sql = sql.replace(/#(\d{1,2})\/(\d{1,2})\/(\d{4})#/g, (_, m, d, y) =>
    `'${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}'::date`);
  sql = sql.replace(/#(\d{4})-(\d{1,2})-(\d{1,2})#/g, (_, y, m, d) =>
    `'${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}'::date`);
  sql = sql.replace(/#(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}:\d{2}(?::\d{2})?)#/g, (_, m, d, y, t) =>
    `'${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')} ${t}'::timestamp`);

  // & (string concat) → ||
  sql = sql.replace(/\s*&\s*/g, ' || ');

  // Convert Access double-quoted string literals to single quotes BEFORE bracket removal.
  sql = sql.replace(/"([^"]*?)"/g, (match, inner) => {
    if (/^[a-zA-Z_]\w*$/.test(inner)) return `'${inner}'`;
    return `'${inner.replace(/'/g, "''")}'`;
  });

  // Like "*x*" → LIKE '%x%'
  sql = sql.replace(/\bLIKE\s+'([^']+)'/gi, (match, pattern) => {
    const pgPattern = pattern.replace(/\*/g, '%').replace(/\?/g, '_');
    return `LIKE '${pgPattern}'`;
  });

  // Remove square brackets → quoted identifiers (sanitized to match PG import names)
  sql = sql.replace(/\[([^\]]+)\]/g, (match, inner) => {
    if (inner.match(/^p_/)) return match;
    return `"${sanitizeName(inner)}"`;
  });

  // Access bang notation: Forms!FormName.ControlName → just field
  sql = sql.replace(/Forms!\[?[\w]+\]?\.?\[?(\w+)\]?/gi, (_, field) => `"${field}"`);

  // Append LIMIT if we found TOP N
  if (topN) {
    sql = sql.trimEnd().replace(/;$/, '') + ` LIMIT ${topN}`;
  }

  return sql;
}

// ============================================================
// Schema prefix helper
// ============================================================

function addSchemaPrefix(sql, schemaName) {
  const reserved = new Set([
    'select', 'where', 'set', 'values', 'as', 'on', 'and', 'or', 'not', 'in',
    'exists', 'null', 'true', 'false', 'inner', 'left', 'right', 'outer',
    'cross', 'full', 'group', 'order', 'having', 'limit', 'union', 'case',
    'when', 'then', 'else', 'end', 'between', 'like', 'is', 'distinct'
  ]);

  function prefixOne(tableName, hasAlias) {
    const sanitized = sanitizeName(tableName.replace(/"/g, ''));
    if (reserved.has(sanitized)) return tableName;
    // Add alias so that SELECT/WHERE refs like TableName.Column still resolve
    const prefix = `${schemaName}."${sanitized}"`;
    return hasAlias ? prefix : `${prefix} ${sanitized}`;
  }

  // Check if a word following a table name is a real alias (not a SQL keyword)
  function isRealAlias(aliasClause) {
    if (!aliasClause || !aliasClause.trim()) return false;
    const word = aliasClause.trim().replace(/^AS\s+/i, '').toLowerCase();
    return word.length > 0 && !reserved.has(word);
  }

  // Match table references after FROM, JOIN, INTO, UPDATE, TABLE keywords.
  // Allows optional leading parens for Access-style joins: FROM (TableA INNER JOIN TableB ...)
  sql = sql.replace(
    /\b(FROM|JOIN|INTO|UPDATE|TABLE)(\s+\(*\s*)("?[a-zA-Z_][\w]*"?)(\s+(?:AS\s+)?[a-zA-Z_]\w*)?/gi,
    (match, keyword, gap, tableName, aliasClause) => {
      const sanitized = sanitizeName(tableName.replace(/"/g, ''));
      if (reserved.has(sanitized)) return match;
      const hasAlias = isRealAlias(aliasClause);
      return `${keyword}${gap}${prefixOne(tableName, hasAlias)}${aliasClause || ''}`;
    }
  );

  // Handle comma-separated tables: ..., tableName [AS alias]
  // Only match commas that follow a schema-prefixed table (to avoid matching SELECT commas)
  sql = sql.replace(
    new RegExp(
      '(' + escapeRegex(schemaName) + '\\."\\w+"' +  // already-prefixed table
      '(?:\\s+\\w+)?' +                                // optional alias
      ')\\s*,\\s*' +                                   // comma
      '("?[a-zA-Z_][\\w]*"?)' +                       // next table name
      '(\\s+(?:AS\\s+)?[a-zA-Z_]\\w*)?',              // optional alias for next table
      'gi'
    ),
    (match, before, tableName, aliasClause) => {
      const sanitized = sanitizeName(tableName.replace(/"/g, ''));
      if (reserved.has(sanitized)) return match;
      const hasAlias = isRealAlias(aliasClause);
      return `${before}, ${prefixOne(tableName, hasAlias)}${aliasClause || ''}`;
    }
  );

  return sql;
}

// ============================================================
// Select-list parsing helpers
// ============================================================

function parseSelectList(selectList) {
  const items = [];
  let depth = 0;
  let current = '';
  let inString = false;
  let stringChar = null;

  for (let i = 0; i < selectList.length; i++) {
    const ch = selectList[i];
    if (inString) {
      current += ch;
      if (ch === stringChar) {
        if (i + 1 < selectList.length && selectList[i + 1] === stringChar) {
          current += selectList[i + 1];
          i++;
        } else {
          inString = false;
        }
      }
    } else if (ch === "'" || ch === '"') {
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
      items.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }

  if (current.trim()) items.push(current.trim());
  return items;
}

/** Find the main FROM clause index (not inside parentheses). Returns -1 if not found. */
function findFromClause(sql, startIdx) {
  let depth = 0;
  let inString = false;
  let stringChar = null;

  for (let i = startIdx; i < sql.length; i++) {
    const ch = sql[i];
    if (inString) {
      if (ch === stringChar && (i + 1 >= sql.length || sql[i + 1] !== stringChar)) inString = false;
      else if (ch === stringChar) i++;
    } else if (ch === "'" || ch === '"') {
      inString = true;
      stringChar = ch;
    } else if (ch === '(') { depth++; }
    else if (ch === ')') { depth--; }
    else if (depth === 0 && /\bFROM\b/i.test(sql.substring(i, i + 5))) {
      return i;
    }
  }
  return -1;
}

// ============================================================
// Calculated column extraction
// ============================================================

function extractCalculatedColumns(sql, schemaName, queryName) {
  // Pass through — calculated column expressions (e.g. [Price] * [Qty] AS Total)
  // stay inline in the view/function. PG resolves column types from the underlying
  // tables, which avoids the type-mismatch and phantom-table bugs that the old
  // function-extraction approach caused.
  return { modifiedSql: sql, extractedFunctions: [] };
}

// ============================================================
// Return column extraction (for RETURNS TABLE)
// ============================================================

function extractReturnColumns(sql) {
  const selectMatch = sql.match(/^\s*SELECT\s+(DISTINCT\s+)?/i);
  if (!selectMatch) return [];

  const afterSelect = selectMatch.index + selectMatch[0].length;
  const fromIdx = findFromClause(sql, afterSelect);
  if (fromIdx === -1) return [];

  const items = parseSelectList(sql.substring(afterSelect, fromIdx).trim());
  const cols = [];

  for (const item of items) {
    const asMatch = item.match(/\bAS\s+("?[\w][\w\s]*"?)\s*$/i);
    if (asMatch) { cols.push(`"${sanitizeName(asMatch[1].replace(/"/g, '').trim())}" text`); continue; }

    const qualifiedQuoted = item.match(/\.\s*"([^"]+)"\s*$/);
    if (qualifiedQuoted) { cols.push(`"${sanitizeName(qualifiedQuoted[1])}" text`); continue; }

    const qualifiedBare = item.match(/\.\s*(\w+)\s*$/);
    if (qualifiedBare) { cols.push(`"${sanitizeName(qualifiedBare[1])}" text`); continue; }

    const quotedCol = item.match(/^"([^"]+)"$/);
    if (quotedCol) { cols.push(`"${sanitizeName(quotedCol[1])}" text`); continue; }

    const bareCol = item.match(/^(\w+)$/);
    if (bareCol) { cols.push(`"${sanitizeName(bareCol[1])}" text`); continue; }

    return []; // unrecognized → fall back to SETOF record
  }

  return cols;
}

// ============================================================
// Custom aggregate helpers
// ============================================================

function needsCustomAggregates(sql) {
  return /\bfirst_agg\s*\(/i.test(sql) || /\blast_agg\s*\(/i.test(sql);
}

function getAggregateStatements(schemaName) {
  return [
    `DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'first_agg_sfunc' AND pronamespace = '${schemaName}'::regnamespace) THEN
    CREATE FUNCTION ${schemaName}.first_agg_sfunc(anyelement, anyelement) RETURNS anyelement AS 'SELECT COALESCE($1, $2)' LANGUAGE SQL IMMUTABLE STRICT;
    CREATE AGGREGATE ${schemaName}.first_agg(anyelement) (SFUNC = ${schemaName}.first_agg_sfunc, STYPE = anyelement);
  END IF;
END $$`,
    `DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'last_agg_sfunc' AND pronamespace = '${schemaName}'::regnamespace) THEN
    CREATE FUNCTION ${schemaName}.last_agg_sfunc(anyelement, anyelement) RETURNS anyelement AS 'SELECT $2' LANGUAGE SQL IMMUTABLE STRICT;
    CREATE AGGREGATE ${schemaName}.last_agg(anyelement) (SFUNC = ${schemaName}.last_agg_sfunc, STYPE = anyelement);
  END IF;
END $$`
  ];
}

// ============================================================
// DDL builders — one per query type
// ============================================================

function buildSelectView(sql, schemaName, pgName, queryName) {
  const statements = [];
  const calcResult = extractCalculatedColumns(sql, schemaName, queryName);
  sql = calcResult.modifiedSql;

  for (const fn of calcResult.extractedFunctions) {
    statements.push(fn.sql);
  }
  statements.push(`CREATE OR REPLACE VIEW ${schemaName}."${pgName}" AS\n${sql}`);

  return { statements, extractedFunctions: calcResult.extractedFunctions };
}

function buildParameterizedSelect(sql, schemaName, pgName, queryName, uniqueParams) {
  const statements = [];
  const paramList = uniqueParams.map(p => `${p.pgName} ${p.pgType}`).join(', ');

  const calcResult = extractCalculatedColumns(sql, schemaName, queryName);
  sql = calcResult.modifiedSql;

  for (const fn of calcResult.extractedFunctions) {
    statements.push(fn.sql);
  }

  const returnCols = extractReturnColumns(sql);
  const returnsClause = returnCols.length > 0
    ? `RETURNS TABLE(${returnCols.join(', ')})`
    : 'RETURNS SETOF record';

  statements.push(
    `CREATE OR REPLACE FUNCTION ${schemaName}."${pgName}"(${paramList})\n` +
    `${returnsClause} AS $$\n${sql}\n$$ LANGUAGE SQL STABLE`
  );

  const warnings = returnCols.length === 0
    ? ['Could not parse SELECT columns — using RETURNS SETOF record, manual definition needed']
    : [];

  return { statements, extractedFunctions: calcResult.extractedFunctions, warnings };
}

function buildPlpgsqlFunction(sql, schemaName, pgName, uniqueParams) {
  const paramList = uniqueParams.map(p => `${p.pgName} ${p.pgType}`).join(', ');
  const paramSig = paramList ? `(${paramList})` : '()';

  return [
    `CREATE OR REPLACE FUNCTION ${schemaName}."${pgName}"${paramSig}\n` +
    `RETURNS integer AS $$\n` +
    `DECLARE _count integer;\n` +
    `BEGIN\n` +
    `  ${sql};\n` +
    `  GET DIAGNOSTICS _count = ROW_COUNT;\n` +
    `  RETURN _count;\n` +
    `END;\n` +
    `$$ LANGUAGE plpgsql VOLATILE`
  ];
}

function buildMakeTableFunction(sql, schemaName, pgName, uniqueParams, originalSql) {
  // Match INTO [schema.]table — schema prefix may already be applied
  const intoMatch = sql.match(/\bINTO\s+(?:[\w]+\.)?"?([\w]+)"?\s+/i);
  if (!intoMatch) {
    return {
      statements: [`-- MakeTable query could not be converted:\n-- ${originalSql}`],
      warnings: ['MakeTable query: could not parse INTO target table'],
      pgObjectType: 'none'
    };
  }

  const targetTable = sanitizeName(intoMatch[1].replace(/"/g, ''));
  const selectWithoutInto = sql.replace(/\bINTO\s+(?:[\w]+\.)?"?[\w]+"?\s+/i, '');
  const paramList = uniqueParams.map(p => `${p.pgName} ${p.pgType}`).join(', ');
  const paramSig = paramList ? `(${paramList})` : '()';

  return {
    statements: [
      `CREATE OR REPLACE FUNCTION ${schemaName}."${pgName}"${paramSig}\n` +
      `RETURNS integer AS $$\n` +
      `DECLARE _count integer;\n` +
      `BEGIN\n` +
      `  DROP TABLE IF EXISTS ${schemaName}."${targetTable}";\n` +
      `  CREATE TABLE ${schemaName}."${targetTable}" AS\n` +
      `  ${selectWithoutInto};\n` +
      `  GET DIAGNOSTICS _count = ROW_COUNT;\n` +
      `  RETURN _count;\n` +
      `END;\n` +
      `$$ LANGUAGE plpgsql VOLATILE`
    ],
    warnings: [],
    pgObjectType: 'function'
  };
}

// ============================================================
// Parameter resolution
// ============================================================

function resolveParams(parameters, tempVarParams, columnTypes, sql) {
  // Build type lookup from DAO-declared parameters
  const daoTypeMap = new Map();
  for (const p of parameters) {
    const tvMatch = p.name.match(/\[?TempVars\]?[!.]\[?(\w+)\]?/i);
    if (tvMatch) {
      daoTypeMap.set('p_' + tvMatch[1].toLowerCase().replace(/\s+/g, '_'), mapParamType(p.type));
    } else {
      daoTypeMap.set('p_' + sanitizeName(p.name), mapParamType(p.type));
    }
  }

  // Combine declared (non-TempVar) params with extracted TempVars
  const allParams = [
    ...parameters
      .filter(p => !/TempVars/i.test(p.name))
      .map(p => ({ name: p.name, pgName: 'p_' + sanitizeName(p.name), pgType: mapParamType(p.type) })),
    ...tempVarParams.map(p => ({
      name: p.name, pgName: p.pgName, pgType: daoTypeMap.get(p.pgName) || 'text'
    }))
  ];

  // Deduplicate by pgName
  const paramMap = new Map();
  for (const p of allParams) {
    if (!paramMap.has(p.pgName)) paramMap.set(p.pgName, p);
  }
  const uniqueParams = [...paramMap.values()];

  // Resolve unknown types using column type map from schema
  if (columnTypes && Object.keys(columnTypes).length > 0) {
    for (const param of uniqueParams) {
      if (param.pgType !== 'text') continue;

      const paramRegex = new RegExp(
        '([\\w]+(?:\\.[\\w]+)?)\\s*\\)\\s*=\\s*' + escapeRegex(param.pgName) + '\\b' +
        '|([\\w]+(?:\\.[\\w]+)?)\\s*=\\s*' + escapeRegex(param.pgName) + '\\b' +
        '|' + escapeRegex(param.pgName) + '\\s*=\\s*([\\w]+(?:\\.[\\w]+)?)',
        'i'
      );
      const compMatch = sql.match(paramRegex);
      if (compMatch) {
        const colRef = (compMatch[1] || compMatch[2] || compMatch[3] || '').toLowerCase();
        const resolvedType = columnTypes[colRef] || columnTypes[colRef.split('.').pop()];
        if (resolvedType) param.pgType = resolvedType;
      }
    }
  }

  return uniqueParams;
}

// ============================================================
// Main conversion entry point
// ============================================================

/**
 * Convert an Access query to PostgreSQL statements.
 *
 * @param {Object} queryData - { queryName, queryType, queryTypeCode, sql, parameters }
 * @param {string} schemaName - Target PostgreSQL schema
 * @param {Object} [columnTypes] - Optional map of column name → PG data type
 * @returns {Object} { statements[], pgObjectName, pgObjectType, warnings[], extractedFunctions[] }
 */
function convertAccessQuery(queryData, schemaName, columnTypes) {
  const { queryName, queryType, queryTypeCode, sql: originalSql, parameters = [] } = queryData;
  const warnings = [];
  const pgName = sanitizeName(queryName);

  if (!originalSql || !originalSql.trim()) {
    return { statements: [], pgObjectName: pgName, pgObjectType: 'none',
      warnings: ['Empty SQL — nothing to convert'], extractedFunctions: [] };
  }

  let sql = originalSql.trim().replace(/;\s*$/, '');

  // Step 1: Extract TempVars
  const tempVarResult = extractTempVars(sql);
  sql = tempVarResult.sql;

  // Resolve parameters and types
  const uniqueParams = resolveParams(parameters, tempVarResult.params, columnTypes, sql);

  // Strip PARAMETERS declaration
  sql = sql.replace(/^PARAMETERS\s+[^;]+;\s*/i, '');

  // Step 2: Function translations
  try { sql = applyFunctionTranslations(sql); }
  catch (err) { warnings.push(`Function translation error: ${err.message}`); }

  // Step 3: Syntax translations
  try { sql = applySyntaxTranslations(sql); }
  catch (err) { warnings.push(`Syntax translation error: ${err.message}`); }

  // Step 4: Schema prefix
  sql = addSchemaPrefix(sql, schemaName);

  // Custom aggregates
  const statements = [];
  if (needsCustomAggregates(sql)) {
    statements.push(...getAggregateStatements(schemaName));
  }

  // Step 5: Build DDL based on query type
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
    // MakeTable before generic SELECT — both start with SELECT
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

  return { statements, pgObjectName: pgName, pgObjectType, warnings, extractedFunctions };
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

module.exports = { convertAccessQuery, convertAccessExpression, sanitizeName };
