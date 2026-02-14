/**
 * Query Design Parser
 *
 * Parses PostgreSQL view definitions (SELECT statements) into structured
 * metadata for rendering a visual Query Design View (QBE grid).
 *
 * Handles: simple SELECTs, JOINs, WHERE, ORDER BY, GROUP BY,
 * quoted identifiers, schema-prefixed names, aliases.
 *
 * Returns parseable:false for CTEs (WITH), UNIONs, multiple statements.
 */

/**
 * Main entry point. Parses a SQL SELECT statement into structured design data.
 * @param {string} sql - The SQL view definition
 * @returns {object} { parseable, tables, joins, fields, where, groupBy, orderBy }
 */
function parseQueryDesign(sql) {
  if (!sql || typeof sql !== 'string') {
    return { parseable: false, sql: sql || '' };
  }

  const trimmed = sql.trim().replace(/;$/, '').trim();

  // Bail on CTEs, UNIONs, multiple statements
  if (/^\s*WITH\b/i.test(trimmed)) {
    return { parseable: false, sql };
  }
  // Check for UNION/INTERSECT/EXCEPT outside of parentheses
  if (hasTopLevelSetOp(trimmed)) {
    return { parseable: false, sql };
  }
  if (!(/^\s*SELECT\b/i.test(trimmed))) {
    return { parseable: false, sql };
  }

  try {
    // Split the SQL into clauses
    const selectClause = extractSelectClause(trimmed);
    const fromClause = extractFromClause(trimmed);
    const whereText = extractWhereClause(trimmed);
    const groupByList = extractGroupBy(trimmed);
    const orderByList = extractOrderBy(trimmed);

    // Parse FROM clause into tables and joins
    const { tables, joins } = extractTablesAndJoins(fromClause);

    // Build alias-to-table lookup
    const aliasMap = {};
    for (const t of tables) {
      if (t.alias) aliasMap[t.alias.toLowerCase()] = t.name;
      aliasMap[t.name.toLowerCase()] = t.name;
    }

    // Parse SELECT list into fields
    const fields = extractSelectFields(selectClause, aliasMap);

    // Mark sort directions from ORDER BY
    for (const ob of orderByList) {
      const matchField = fields.find(f => {
        const exprLower = ob.expression.toLowerCase();
        if (f.alias && f.alias.toLowerCase() === exprLower) return true;
        if (f.expression.toLowerCase() === exprLower) return true;
        // Match unqualified name to qualified
        const dotIdx = f.expression.lastIndexOf('.');
        if (dotIdx >= 0) {
          const colPart = f.expression.substring(dotIdx + 1).toLowerCase().replace(/"/g, '');
          if (colPart === exprLower.replace(/"/g, '')) return true;
        }
        return false;
      });
      if (matchField) {
        matchField.sort = ob.direction;
      }
    }

    return {
      parseable: true,
      sql,
      tables,
      joins,
      fields,
      where: whereText || null,
      groupBy: groupByList.length > 0 ? groupByList : null,
      orderBy: orderByList.length > 0 ? orderByList : null
    };
  } catch (e) {
    return { parseable: false, sql };
  }
}

/**
 * Check for top-level UNION/INTERSECT/EXCEPT (not inside parentheses).
 */
function hasTopLevelSetOp(sql) {
  let depth = 0;
  const upper = sql.toUpperCase();
  for (let i = 0; i < upper.length; i++) {
    if (upper[i] === '(') depth++;
    else if (upper[i] === ')') depth--;
    else if (upper[i] === "'") {
      // Skip string literals
      i++;
      while (i < upper.length && upper[i] !== "'") i++;
    } else if (depth === 0) {
      if (upper.startsWith('UNION', i) && /\bUNION\b/.test(upper.substring(i, i + 6))) return true;
      if (upper.startsWith('INTERSECT', i) && /\bINTERSECT\b/.test(upper.substring(i, i + 10))) return true;
      if (upper.startsWith('EXCEPT', i) && /\bEXCEPT\b/.test(upper.substring(i, i + 7))) return true;
    }
  }
  return false;
}

/**
 * Extract the SELECT field list (between SELECT and FROM).
 */
function extractSelectClause(sql) {
  const upper = sql.toUpperCase();
  // Find SELECT keyword and skip DISTINCT/ALL
  let start = upper.indexOf('SELECT') + 6;
  const afterSelect = upper.substring(start).trimStart();
  if (afterSelect.startsWith('DISTINCT')) start = upper.indexOf('DISTINCT', start) + 8;
  else if (afterSelect.startsWith('ALL')) start = upper.indexOf('ALL', start) + 3;

  // Find the FROM at depth 0
  const fromIdx = findTopLevelKeyword(sql, 'FROM', start);
  if (fromIdx < 0) return sql.substring(start).trim();
  return sql.substring(start, fromIdx).trim();
}

/**
 * Extract the FROM clause (between FROM and WHERE/GROUP BY/ORDER BY/HAVING/LIMIT).
 */
function extractFromClause(sql) {
  const fromIdx = findTopLevelKeyword(sql, 'FROM', 0);
  if (fromIdx < 0) return '';
  const start = fromIdx + 4; // length of 'FROM'

  // Find the next top-level clause keyword
  let end = sql.length;
  for (const kw of ['WHERE', 'GROUP BY', 'HAVING', 'ORDER BY', 'LIMIT', 'OFFSET', 'FETCH']) {
    const idx = findTopLevelKeyword(sql, kw, start);
    if (idx >= 0 && idx < end) end = idx;
  }
  return sql.substring(start, end).trim();
}

/**
 * Extract WHERE clause text (between WHERE and GROUP BY/HAVING/ORDER BY/LIMIT).
 */
function extractWhereClause(sql) {
  const whereIdx = findTopLevelKeyword(sql, 'WHERE', 0);
  if (whereIdx < 0) return null;
  const start = whereIdx + 5; // length of 'WHERE'

  let end = sql.length;
  for (const kw of ['GROUP BY', 'HAVING', 'ORDER BY', 'LIMIT', 'OFFSET', 'FETCH']) {
    const idx = findTopLevelKeyword(sql, kw, start);
    if (idx >= 0 && idx < end) end = idx;
  }
  return sql.substring(start, end).trim() || null;
}

/**
 * Extract GROUP BY column list.
 */
function extractGroupBy(sql) {
  const gbIdx = findTopLevelKeyword(sql, 'GROUP BY', 0);
  if (gbIdx < 0) return [];
  const start = gbIdx + 8; // length of 'GROUP BY'

  let end = sql.length;
  for (const kw of ['HAVING', 'ORDER BY', 'LIMIT', 'OFFSET', 'FETCH']) {
    const idx = findTopLevelKeyword(sql, kw, start);
    if (idx >= 0 && idx < end) end = idx;
  }
  const text = sql.substring(start, end).trim();
  if (!text) return [];
  return splitTopLevel(text).map(s => s.trim()).filter(Boolean);
}

/**
 * Extract ORDER BY into [{expression, direction}].
 */
function extractOrderBy(sql) {
  const obIdx = findTopLevelKeyword(sql, 'ORDER BY', 0);
  if (obIdx < 0) return [];
  const start = obIdx + 8; // length of 'ORDER BY'

  let end = sql.length;
  for (const kw of ['LIMIT', 'OFFSET', 'FETCH']) {
    const idx = findTopLevelKeyword(sql, kw, start);
    if (idx >= 0 && idx < end) end = idx;
  }
  const text = sql.substring(start, end).trim();
  if (!text) return [];

  return splitTopLevel(text).map(part => {
    const trimmed = part.trim();
    // Check for ASC/DESC at the end
    const dirMatch = trimmed.match(/\s+(ASC|DESC)\s*$/i);
    if (dirMatch) {
      return {
        expression: trimmed.substring(0, dirMatch.index).trim(),
        direction: dirMatch[1].toUpperCase()
      };
    }
    return { expression: trimmed, direction: 'ASC' };
  }).filter(o => o.expression);
}

/**
 * Parse FROM clause into tables[] and joins[].
 */
function extractTablesAndJoins(fromClause) {
  if (!fromClause) return { tables: [], joins: [] };

  const tables = [];
  const joins = [];
  const seen = new Set();

  // Tokenize: split on JOIN keywords while preserving join type
  // Pattern: (LEFT|RIGHT|FULL|INNER|CROSS)?\s*(OUTER\s+)?JOIN
  const joinPattern = /\b((?:LEFT|RIGHT|FULL|INNER|CROSS)\s+(?:OUTER\s+)?JOIN|(?:LEFT|RIGHT|FULL|INNER|CROSS)\s+JOIN|JOIN)\b/gi;

  // First pass: find all JOIN keyword positions
  const joinMatches = [];
  let m;
  while ((m = joinPattern.exec(fromClause)) !== null) {
    joinMatches.push({ index: m.index, length: m[0].length, type: normalizeJoinType(m[1]) });
  }

  const parts = [];
  if (joinMatches.length === 0) {
    // No JOINs — entire FROM clause is comma-separated tables
    parts.push({ type: null, text: fromClause.trim() });
  } else {
    // Text before first JOIN is the FROM table(s)
    if (joinMatches[0].index > 0) {
      parts.push({ type: null, text: fromClause.substring(0, joinMatches[0].index).trim() });
    }
    // Each JOIN's text runs from after its keyword to the next JOIN keyword (or end)
    for (let i = 0; i < joinMatches.length; i++) {
      const start = joinMatches[i].index + joinMatches[i].length;
      const end = (i + 1 < joinMatches.length) ? joinMatches[i + 1].index : fromClause.length;
      parts.push({ type: joinMatches[i].type, text: fromClause.substring(start, end).trim() });
    }
  }

  for (const part of parts) {
    if (part.type === null) {
      // FROM tables (possibly comma-separated)
      const tableList = splitTopLevel(part.text);
      for (const tbl of tableList) {
        const parsed = parseTableRef(tbl.trim());
        if (parsed && !seen.has(parsed.name.toLowerCase())) {
          tables.push(parsed);
          seen.add(parsed.name.toLowerCase());
        }
      }
    } else {
      // JOIN clause: table ON condition
      const onIdx = findTopLevelKeyword(part.text, 'ON', 0);
      let tableText, onText;
      if (onIdx >= 0) {
        tableText = part.text.substring(0, onIdx).trim();
        onText = part.text.substring(onIdx + 2).trim();
      } else {
        tableText = part.text.trim();
        onText = null;
      }

      const parsed = parseTableRef(tableText);
      if (parsed && !seen.has(parsed.name.toLowerCase())) {
        tables.push(parsed);
        seen.add(parsed.name.toLowerCase());
      }

      // Parse ON condition into join columns
      if (onText && parsed) {
        const joinCols = parseJoinCondition(onText, tables);
        for (const jc of joinCols) {
          joins.push({
            type: part.type,
            leftTable: jc.leftTable,
            leftColumn: jc.leftColumn,
            rightTable: jc.rightTable,
            rightColumn: jc.rightColumn
          });
        }
      }
    }
  }

  return { tables, joins };
}

/**
 * Normalize a join type string.
 */
function normalizeJoinType(raw) {
  const upper = raw.toUpperCase().replace(/\s+/g, ' ').trim();
  if (upper === 'JOIN' || upper === 'INNER JOIN') return 'INNER JOIN';
  if (upper.includes('LEFT')) return 'LEFT JOIN';
  if (upper.includes('RIGHT')) return 'RIGHT JOIN';
  if (upper.includes('FULL')) return 'FULL JOIN';
  if (upper.includes('CROSS')) return 'CROSS JOIN';
  return upper;
}

/**
 * Parse a table reference like: schema."table_name" alias, or "table" AS t
 */
function parseTableRef(text) {
  if (!text) return null;
  // Skip subqueries
  if (text.trim().startsWith('(')) return null;

  // Remove ONLY keyword if present
  const cleaned = text.trim().replace(/^\bONLY\b\s*/i, '');

  // Pattern: optional_schema.table_name optional_alias
  // Quoted names can contain spaces, so use "([^"]+)" for quoted, [\w]+ for unquoted
  const match = cleaned.match(
    /^(?:("[\w]+"|\w+)\.)?("[^"]+"|[\w]+)(?:\s+(?:AS\s+)?("[^"]+"|[\w]+))?$/i
  );
  if (!match) return null;

  const schema = match[1] ? stripQuotes(match[1]) : null;
  const name = stripQuotes(match[2]);
  const alias = match[3] ? stripQuotes(match[3]) : null;

  return { name, alias: alias || null, schema: schema || null, columns: [] };
}

/**
 * Parse a JOIN ON condition into column pairs.
 * Handles: t1.col1 = t2.col2 AND t1.col3 = t2.col4
 */
function parseJoinCondition(onText, tables) {
  const results = [];
  // Build alias lookup
  const aliasMap = {};
  for (const t of tables) {
    if (t.alias) aliasMap[t.alias.toLowerCase()] = t.name;
    aliasMap[t.name.toLowerCase()] = t.name;
  }

  // Split on AND at top level
  const conditions = splitTopLevelOnKeyword(onText, 'AND');
  for (const cond of conditions) {
    const eqMatch = cond.match(
      /("?[\w]+"?)\.("?[\w]+"?)\s*=\s*("?[\w]+"?)\.("?[\w]+"?)/
    );
    if (eqMatch) {
      const leftQualifier = stripQuotes(eqMatch[1]);
      const leftCol = stripQuotes(eqMatch[2]);
      const rightQualifier = stripQuotes(eqMatch[3]);
      const rightCol = stripQuotes(eqMatch[4]);

      const leftTable = aliasMap[leftQualifier.toLowerCase()] || leftQualifier;
      const rightTable = aliasMap[rightQualifier.toLowerCase()] || rightQualifier;

      results.push({ leftTable, leftColumn: leftCol, rightTable, rightColumn: rightCol });
    }
  }
  return results;
}

/**
 * Parse SELECT field list into structured fields.
 */
function extractSelectFields(selectClause, aliasMap) {
  if (!selectClause) return [];

  // Handle SELECT *
  if (selectClause.trim() === '*') {
    return [{ expression: '*', table: null, alias: null, sort: null, show: true }];
  }

  const parts = splitTopLevel(selectClause);
  return parts.map(part => {
    const trimmed = part.trim();
    if (!trimmed) return null;

    // Check for alias: expr AS alias or expr alias (but not ending with a function call)
    let expression = trimmed;
    let alias = null;

    // Try explicit AS alias (quoted aliases can contain spaces)
    const asMatch = trimmed.match(/^(.+?)\s+AS\s+("[^"]+"|[\w]+)\s*$/i);
    if (asMatch) {
      expression = asMatch[1].trim();
      alias = stripQuotes(asMatch[2]);
    } else {
      // Try implicit alias: "expr identifier" where identifier is a simple name at the end
      // But don't match things like "func(x)" as having an alias
      const implicitMatch = trimmed.match(/^(.+?)\s+("[\w]+"|[a-zA-Z_]\w*)\s*$/);
      if (implicitMatch) {
        const candidateExpr = implicitMatch[1].trim();
        const candidateAlias = stripQuotes(implicitMatch[2]);
        // Only treat as alias if the expression part is complete
        // (balanced parens, not a keyword)
        if (isBalanced(candidateExpr) && !isKeyword(candidateAlias)) {
          expression = candidateExpr;
          alias = candidateAlias;
        }
      }
    }

    // Determine source table from expression
    let table = null;
    const dotMatch = expression.match(/^("?[\w]+"?)\.("?[\w]+"?)$/);
    if (dotMatch) {
      const qualifier = stripQuotes(dotMatch[1]);
      table = aliasMap[qualifier.toLowerCase()] || qualifier;
    }

    return {
      expression,
      table,
      alias: alias || null,
      sort: null,
      show: true
    };
  }).filter(Boolean);
}

// ============================================================
// Utility helpers
// ============================================================

/**
 * Find a keyword at top level (not inside parens or quotes).
 * Returns the index in sql, or -1 if not found.
 */
function findTopLevelKeyword(sql, keyword, startFrom) {
  const upper = sql.toUpperCase();
  const kwUpper = keyword.toUpperCase();
  const kwLen = kwUpper.length;
  let depth = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;

  for (let i = startFrom; i <= sql.length - kwLen; i++) {
    const ch = sql[i];
    if (inSingleQuote) {
      if (ch === "'" && sql[i + 1] !== "'") inSingleQuote = false;
      else if (ch === "'" && sql[i + 1] === "'") i++; // escaped quote
      continue;
    }
    if (inDoubleQuote) {
      if (ch === '"') inDoubleQuote = false;
      continue;
    }
    if (ch === "'") { inSingleQuote = true; continue; }
    if (ch === '"') { inDoubleQuote = true; continue; }
    if (ch === '(') { depth++; continue; }
    if (ch === ')') { depth--; continue; }

    if (depth === 0 && upper.substring(i, i + kwLen) === kwUpper) {
      // Ensure it's a word boundary
      const before = i > 0 ? sql[i - 1] : ' ';
      const after = i + kwLen < sql.length ? sql[i + kwLen] : ' ';
      if (/[\s\n\r(,;]/.test(before) || i === 0) {
        if (/[\s\n\r(,;)]/.test(after) || i + kwLen === sql.length) {
          return i;
        }
      }
    }
  }
  return -1;
}

/**
 * Split a string on top-level commas (not inside parens or quotes).
 */
function splitTopLevel(text) {
  const result = [];
  let depth = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let start = 0;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inSingleQuote) {
      if (ch === "'" && text[i + 1] !== "'") inSingleQuote = false;
      else if (ch === "'" && text[i + 1] === "'") i++;
      continue;
    }
    if (inDoubleQuote) {
      if (ch === '"') inDoubleQuote = false;
      continue;
    }
    if (ch === "'") { inSingleQuote = true; continue; }
    if (ch === '"') { inDoubleQuote = true; continue; }
    if (ch === '(') { depth++; continue; }
    if (ch === ')') { depth--; continue; }

    if (depth === 0 && ch === ',') {
      result.push(text.substring(start, i));
      start = i + 1;
    }
  }
  result.push(text.substring(start));
  return result;
}

/**
 * Split text on a top-level keyword (like AND).
 */
function splitTopLevelOnKeyword(text, keyword) {
  const results = [];
  let lastEnd = 0;
  const kwLen = keyword.length;

  let idx = findTopLevelKeyword(text, keyword, 0);
  while (idx >= 0) {
    results.push(text.substring(lastEnd, idx).trim());
    lastEnd = idx + kwLen;
    idx = findTopLevelKeyword(text, keyword, lastEnd);
  }
  results.push(text.substring(lastEnd).trim());
  return results.filter(Boolean);
}

function stripQuotes(name) {
  if (!name) return name;
  return name.replace(/^"(.*)"$/, '$1');
}

function isBalanced(text) {
  let depth = 0;
  for (const ch of text) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (depth < 0) return false;
  }
  return depth === 0;
}

const SQL_KEYWORDS = new Set([
  'select', 'from', 'where', 'join', 'on', 'and', 'or', 'not', 'in',
  'as', 'left', 'right', 'inner', 'outer', 'full', 'cross',
  'group', 'order', 'by', 'having', 'limit', 'offset', 'union',
  'case', 'when', 'then', 'else', 'end', 'between', 'like', 'is',
  'distinct', 'all', 'exists', 'null', 'true', 'false', 'asc', 'desc',
  'insert', 'update', 'delete', 'into', 'values', 'set', 'with'
]);

function isKeyword(word) {
  return SQL_KEYWORDS.has(word.toLowerCase());
}

module.exports = { parseQueryDesign };
