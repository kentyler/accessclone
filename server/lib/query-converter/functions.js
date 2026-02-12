/**
 * Access→PostgreSQL function translation engine.
 * Applies the FUNCTION_MAP lookup table iteratively until stable.
 */

const { FUNCTION_MAP } = require('../access-function-map');
const { parseArguments, findCloseParen } = require('./utils');

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

module.exports = { applyFunctionTranslations };
