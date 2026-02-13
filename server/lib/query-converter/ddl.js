/**
 * DDL builders — parse SELECT lists, build views/functions, resolve parameters.
 */

const { sanitizeName, escapeRegex, mapParamType } = require('./utils');

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
  // Pass through — calculated column expressions stay inline in the view/function.
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

  // Combine declared params with extracted TempVars.
  // Filter out: TempVars, form/report/parent refs (resolved to subqueries),
  // and Table.Column refs (Access exports these as params but they're column references).
  const formRefPattern = /\b(TempVars|Parent|Form|Forms|Report|Reports)\b/i;
  const isDottedRef = (name) => name.replace(/[\[\]]/g, '').includes('.');
  const allParams = [
    ...parameters
      .filter(p => !formRefPattern.test(p.name))
      .filter(p => !isDottedRef(p.name))
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

module.exports = {
  parseSelectList, findFromClause,
  extractCalculatedColumns, extractReturnColumns,
  needsCustomAggregates, getAggregateStatements,
  buildSelectView, buildParameterizedSelect, buildPlpgsqlFunction, buildMakeTableFunction,
  resolveParams
};
