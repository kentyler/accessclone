/**
 * Domain function translation — DLookUp, DCount, DSum, etc.
 * Translates Access domain functions to PostgreSQL subqueries.
 * Also handles criteria string parsing and & concatenation splitting.
 */

const { sanitizeName } = require('../query-converter');
const { quoteIdent } = require('../access-types');

// Domain functions that require database access
const DOMAIN_FN_RE = /\b(DLookUp|DCount|DSum|DAvg|DFirst|DLast|DMin|DMax)\s*\(/i;

/**
 * Check if an expression contains domain functions that need server-side evaluation.
 */
function hasDomainFunctions(expression) {
  if (!expression || typeof expression !== 'string') return false;
  return DOMAIN_FN_RE.test(expression);
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

/**
 * Translate an Access criteria string to a PostgreSQL WHERE clause.
 */
function translateCriteria(criteria, schemaName, paramRefs) {
  if (!criteria) return 'true';

  let c = criteria.trim();
  if ((c.startsWith('"') && c.endsWith('"')) || (c.startsWith("'") && c.endsWith("'"))) {
    c = c.slice(1, -1);
  }

  const parts = splitOnConcat(c);
  let sql = '';

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
        (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
      let fragment = trimmed.slice(1, -1);
      fragment = fragment.replace(/\[([^\]]+)\]/g, (_, col) => {
        return quoteIdent(sanitizeName(col));
      });
      fragment = fragment.replace(/\bTrue\b/gi, 'true').replace(/\bFalse\b/gi, 'false');
      sql += fragment;
    } else if (/^\[([^\]]+)\]$/.test(trimmed)) {
      const fieldName = trimmed.match(/^\[([^\]]+)\]$/)[1];
      const pgParam = 'p_' + sanitizeName(fieldName);
      paramRefs.add(fieldName);
      sql += pgParam;
    } else {
      let fragment = trimmed;
      fragment = fragment.replace(/\[([^\]]+)\]/g, (_, name) => {
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
 * Translate a single domain function call to a PostgreSQL subquery.
 */
function translateDomainFunction(fnName, args, schemaName, paramRefs) {
  const fn = fnName.toLowerCase();

  let fieldExpr = (args[0] || '*').trim();
  if ((fieldExpr.startsWith('"') && fieldExpr.endsWith('"')) ||
      (fieldExpr.startsWith("'") && fieldExpr.endsWith("'"))) {
    fieldExpr = fieldExpr.slice(1, -1);
  }
  const pgField = sanitizeName(fieldExpr);

  let domain = (args[1] || '').trim();
  if ((domain.startsWith('"') && domain.endsWith('"')) ||
      (domain.startsWith("'") && domain.endsWith("'"))) {
    domain = domain.slice(1, -1);
  }
  const pgTable = sanitizeName(domain);
  const qualifiedTable = `${quoteIdent(schemaName)}.${quoteIdent(pgTable)}`;

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

module.exports = {
  DOMAIN_FN_RE, hasDomainFunctions, splitOnConcat, translateCriteria, translateDomainFunction
};
