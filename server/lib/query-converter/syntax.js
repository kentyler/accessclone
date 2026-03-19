/**
 * Syntax translations — brackets, operators, literals, keywords, schema prefix.
 */

const { sanitizeName, escapeRegex } = require('./utils');
const { translateTempVars, translateFormRefs } = require('./form-state');

function applySyntaxTranslations(sql, controlMapping, referencedEntries, warnings, stateRefs) {
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

  // TempVars and Form references → cross-join aliases (ssN.value) when stateRefs provided,
  // or inline subqueries (expression context) when stateRefs is omitted.
  // Must run BEFORE double-quote conversion and bracket removal.
  sql = translateTempVars(sql, stateRefs);
  sql = translateFormRefs(sql, controlMapping, referencedEntries, warnings, stateRefs);

  // Cast columns compared with session_state refs to ::text.
  // The state value column is text; PG won't implicitly cast integer=text.
  sql = sql.replace(
    /([\w."]+(?:\.[\w."]+)?)\s*(\)*\s*(?:<>|[<>!]?=|[<>])\s*)(ss\d+\.value)\b/g,
    '$1::text$2$3'
  );

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

  // Division by zero protection: wrap simple identifier denominators in NULLIF so runtime
  // errors become NULL instead of crashing the query. Design decision: blanket policy is
  // better than asking users to manually fix every Access query that divides two columns,
  // since Access itself degrades to #DIV/0! rather than hard-erroring.
  //
  // Scope: only wraps bare identifiers (col or table.col). Complex denominators
  // (parenthesized expressions, subqueries) are left alone — they're rare and the LLM
  // fallback handles them if they produce a runtime error.
  //
  // String literals are masked first to avoid matching / inside 'a/b' values.
  sql = withStringLiteralsMasked(sql, s =>
    s.replace(/\/\s*(?!NULLIF\s*\()("?[\w][\w."]*"?)/g, '/ NULLIF($1, 0)')
  );

  // Append LIMIT if we found TOP N
  if (topN) {
    sql = sql.trimEnd().replace(/;$/, '') + ` LIMIT ${topN}`;
  }

  return sql;
}

/**
 * Mask single-quoted string literals, apply fn, then restore them.
 * Prevents regex transforms from matching content inside string values.
 */
function withStringLiteralsMasked(sql, fn) {
  const stash = [];
  const masked = sql.replace(/'(?:[^']|'')*'/g, match => {
    stash.push(match);
    return `\x00S${stash.length - 1}\x00`;
  });
  return fn(masked).replace(/\x00S(\d+)\x00/g, (_, i) => stash[parseInt(i)]);
}

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
  sql = sql.replace(
    /\b(FROM|JOIN|INTO|UPDATE|TABLE)(\s+\(*\s*)("?[a-zA-Z_][\w]*"?)(\.[a-zA-Z_][\w."]*)?(\s+(?:AS\s+)?[a-zA-Z_]\w*)?/gi,
    (match, keyword, gap, tableName, qualifiedPart, aliasClause, offset) => {
      // Skip FROM inside EXTRACT(field FROM expr), SUBSTRING(str FROM pos), TRIM(... FROM ...)
      if (/^from$/i.test(keyword)) {
        const before = sql.substring(Math.max(0, offset - 60), offset);
        if (/\bEXTRACT\s*\(\s*\w+\s+$/i.test(before)) return match;
        if (/\b(?:SUBSTRING|OVERLAY|TRIM)\s*\([^)]*$/i.test(before)) return match;
      }
      // Already schema-qualified (has .something after the name) — leave it alone
      if (qualifiedPart) return match;
      const sanitized = sanitizeName(tableName.replace(/"/g, ''));
      if (reserved.has(sanitized)) return match;
      const hasAlias = isRealAlias(aliasClause);
      return `${keyword}${gap}${prefixOne(tableName, hasAlias)}${aliasClause || ''}`;
    }
  );

  // Handle comma-separated tables
  sql = sql.replace(
    new RegExp(
      '(' + escapeRegex(schemaName) + '\\."\\w+"' +
      '(?:\\s+\\w+)?' +
      ')\\s*,\\s*' +
      '("?[a-zA-Z_][\\w]*"?)' +
      '(\\s+(?:AS\\s+)?[a-zA-Z_]\\w*)?',
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

// PostgreSQL built-in / standard SQL functions that must NOT be schema-prefixed.
// Includes functions emitted by our FUNCTION_MAP translations + standard SQL.
const PG_BUILTINS = new Set([
  // Standard SQL aggregates
  'count', 'sum', 'avg', 'min', 'max', 'array_agg', 'string_agg', 'bool_and', 'bool_or',
  // String
  'length', 'substring', 'left', 'right', 'upper', 'lower', 'trim', 'ltrim', 'rtrim',
  'position', 'replace', 'reverse', 'repeat', 'ascii', 'chr', 'initcap', 'concat',
  'concat_ws', 'overlay', 'translate', 'encode', 'decode', 'md5', 'format',
  'regexp_replace', 'regexp_match', 'regexp_matches', 'split_part', 'btrim',
  // Numeric
  'floor', 'trunc', 'abs', 'round', 'sign', 'sqrt', 'ln', 'exp', 'ceil', 'ceiling',
  'mod', 'power', 'random', 'log', 'pi', 'degrees', 'radians', 'div', 'greatest', 'least',
  // Date/Time
  'extract', 'make_date', 'make_time', 'make_timestamp', 'make_interval',
  'date_part', 'date_trunc', 'age',
  'to_char', 'to_date', 'to_timestamp', 'to_number',
  'now', 'clock_timestamp', 'statement_timestamp', 'timeofday',
  // Type/cast/null
  'coalesce', 'nullif', 'cast',
  // Conditional
  'case',
  // JSON
  'json_agg', 'jsonb_agg', 'json_build_object', 'jsonb_build_object',
  'json_extract_path', 'json_extract_path_text', 'row_to_json', 'to_json', 'to_jsonb',
  'jsonb_set', 'jsonb_insert', 'jsonb_pretty',
  // Window
  'row_number', 'rank', 'dense_rank', 'lag', 'lead', 'first_value', 'last_value', 'ntile',
  'percent_rank', 'cume_dist', 'nth_value',
  // Array
  'array_length', 'unnest', 'array_to_string', 'array_cat', 'array_append', 'array_remove',
  // PG specific
  'current_setting', 'set_config', 'pg_typeof', 'generate_series', 'exists',
  // Our custom aggregates
  'first_agg', 'last_agg',
]);

/**
 * Schema-prefix user-defined function calls.
 * Any function call not recognized as a PG builtin or SQL keyword gets
 * the target schema prefix so VBA stub/translated functions resolve.
 */
function addSchemaFunctionPrefix(sql, schemaName) {
  const SQL_KEYWORDS = new Set([
    'select', 'from', 'where', 'set', 'values', 'as', 'on', 'and', 'or', 'not', 'in',
    'join', 'inner', 'left', 'right', 'outer', 'cross', 'full', 'having',
    'group', 'order', 'by', 'union', 'except', 'intersect',
    'insert', 'update', 'delete', 'into', 'table', 'view', 'function',
    'create', 'alter', 'drop', 'replace',
    'begin', 'end', 'return', 'returns', 'declare', 'if', 'then', 'else',
    'when', 'between', 'like', 'ilike', 'similar', 'is', 'null',
    'true', 'false', 'distinct', 'all', 'any', 'some', 'over', 'partition',
    'limit', 'offset', 'fetch', 'for', 'with', 'recursive',
    'interval', 'language', 'stable', 'immutable', 'volatile',
    'security', 'definer', 'invoker',
  ]);

  // Match function calls: word followed by (
  // Negative lookbehind prevents double-qualifying "schema"."func"( patterns
  return sql.replace(
    /(?<![."\w])([a-zA-Z_]\w*)\s*\(/g,
    (match, funcName) => {
      const lower = funcName.toLowerCase();
      if (PG_BUILTINS.has(lower)) return match;
      if (SQL_KEYWORDS.has(lower)) return match;
      return `"${schemaName}"."${lower}"(`;
    }
  );
}

module.exports = { applySyntaxTranslations, addSchemaPrefix, addSchemaFunctionPrefix };
