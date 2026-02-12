/**
 * Shared utilities for the query converter.
 */

function sanitizeName(name) {
  return name.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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

module.exports = { sanitizeName, escapeRegex, mapParamType, parseArguments, findCloseParen };
