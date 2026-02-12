/**
 * Access function translation engine for expressions.
 * Handles IIf, IsNull, Nz, Not, True/False, & → ||.
 */

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

/**
 * Apply surrounding Access function translations to a SQL expression.
 * Handles IIf, IsNull, Nz, Not, etc.
 */
function translateAccessFunctions(sql) {
  let changed = true;
  let iterations = 0;

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

    sql = sql.replace(/\bNot\s+/gi, 'NOT ');
    if (sql !== prev) { changed = true; continue; }

    sql = sql.replace(/\bTrue\b/gi, 'true').replace(/\bFalse\b/gi, 'false');
    if (sql !== prev) { changed = true; continue; }

    sql = sql.replace(/\s*&\s*/g, ' || ');
    if (sql !== prev) { changed = true; continue; }
  }

  return sql;
}

module.exports = { parseArguments, findCloseParen, translateAccessFunctions };
