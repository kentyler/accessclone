/**
 * Form state cross-join builders and form/TempVar reference translators.
 *
 * Two modes:
 * 1. Cross-join mode (stateRefs provided): each ref becomes ssN.value,
 *    caller uses buildStateFromWhere() to inject FROM/WHERE.
 * 2. Subquery mode (stateRefs omitted): each ref becomes an inline scalar
 *    subquery against shared.form_control_state. Used by expression converter.
 */

const { sanitizeName } = require('./utils');

/**
 * Build an inline scalar subquery (legacy mode for expressions).
 */
function formStateSubquery(tableName, columnName) {
  return `(SELECT value FROM shared.form_control_state ` +
    `WHERE session_id = current_setting('app.session_id', true) ` +
    `AND table_name = '${tableName}' ` +
    `AND column_name = '${columnName}')`;
}

/**
 * Allocate a cross-join alias for a state reference.
 * Pushes metadata to stateRefs and returns the alias (e.g. "ss1").
 */
function allocStateRef(stateRefs, tableName, columnName) {
  const alias = `ss${stateRefs.length + 1}`;
  stateRefs.push({ alias, tableName, columnName });
  return alias;
}

/**
 * Build a state reference — either cross-join alias or inline subquery.
 */
function buildRef(stateRefs, tableName, columnName) {
  if (stateRefs) {
    const alias = allocStateRef(stateRefs, tableName, columnName);
    return `${alias}.value`;
  }
  return formStateSubquery(tableName, columnName);
}

/**
 * Replace TempVars references.
 * Pass stateRefs for cross-join mode, omit for subquery mode.
 */
function translateTempVars(sql, stateRefs) {
  // [TempVars]![varName]
  sql = sql.replace(/\[TempVars\]!\[(\w+)\]/gi, (_, v) =>
    buildRef(stateRefs, '_tempvars', v.toLowerCase()));
  // TempVars("varName")
  sql = sql.replace(/TempVars\("(\w+)"\)/gi, (_, v) =>
    buildRef(stateRefs, '_tempvars', v.toLowerCase()));
  // TempVars!varName
  sql = sql.replace(/TempVars!(\w+)/gi, (_, v) =>
    buildRef(stateRefs, '_tempvars', v.toLowerCase()));

  return sql;
}

/**
 * Resolve a form reference via controlMapping.
 * Returns { table, column } or null if not found.
 */
function resolveControlMapping(controlMapping, formName, ctrlName, formSpecific) {
  if (!controlMapping) return null;

  if (formSpecific && formName) {
    const key = `${formName}.${ctrlName}`;
    if (controlMapping[key]) return controlMapping[key];
  }

  // 2-part or fallback: search for any entry ending in .ctrlName
  for (const [key, val] of Object.entries(controlMapping)) {
    if (key.endsWith('.' + ctrlName)) return val;
  }
  return null;
}

/**
 * Replace form references.
 * Pass stateRefs for cross-join mode, omit for subquery mode.
 */
function translateFormRefs(sql, controlMapping, referencedEntries, warnings, stateRefs) {
  function resolve3part(form, ctrl) {
    const fn = sanitizeName(form);
    const cn = sanitizeName(ctrl);
    const resolved = resolveControlMapping(controlMapping, fn, cn, true);
    if (resolved) {
      if (referencedEntries) referencedEntries.push({ tableName: resolved.table, columnName: resolved.column });
      return buildRef(stateRefs, resolved.table, resolved.column);
    }
    // Fallback: use form name as table, control as column
    if (warnings) warnings.push(`Unresolved form ref: Forms!${form}!${ctrl}`);
    return buildRef(stateRefs, fn, cn);
  }

  function resolve2part(ctrl) {
    const cn = sanitizeName(ctrl);
    const resolved = resolveControlMapping(controlMapping, null, cn, false);
    if (resolved) {
      if (referencedEntries) referencedEntries.push({ tableName: resolved.table, columnName: resolved.column });
      return buildRef(stateRefs, resolved.table, resolved.column);
    }
    // Unresolved: emit NULL with comment
    if (warnings) warnings.push(`Unresolved form ref: Form!${ctrl}`);
    return `NULL /* UNRESOLVED: Form!${ctrl} */`;
  }

  // --- 3-part: [Forms]![formName]![controlName] (explicit form/report name) ---
  sql = sql.replace(/\[(?:Forms|Reports)\]!\[([^\]]+)\]!\[([^\]]+)\]/gi, (_, form, ctrl) => resolve3part(form, ctrl));
  sql = sql.replace(/(?:Forms|Reports)!\[([^\]]+)\]!\[([^\]]+)\]/gi, (_, form, ctrl) => resolve3part(form, ctrl));
  sql = sql.replace(/(?:Forms|Reports)!([\w]+)!([\w]+)/gi, (_, form, ctrl) => resolve3part(form, ctrl));
  sql = sql.replace(/(?:Forms|Reports)!([\w]+)\.([\w]+)/gi, (_, form, ctrl) => resolve3part(form, ctrl));

  // --- 2-part: [Form]![controlName] or [Report]![controlName] ---
  sql = sql.replace(/\[(?:Form|Report)\]!\[([^\]]+)\]/gi, (_, ctrl) => resolve2part(ctrl));
  sql = sql.replace(/\b(?:Form|Report)!\[([^\]]+)\]/gi, (_, ctrl) => resolve2part(ctrl));
  sql = sql.replace(/\b(?:Form|Report)!([\w]+)/gi, (_, ctrl) => resolve2part(ctrl));

  // --- [Parent] chains (1+ levels) ---
  sql = sql.replace(/(?:\[Parent\][.!])+\[([^\]]+)\]/gi, (_, ctrl) => resolve2part(ctrl));
  sql = sql.replace(/(?:\bParent[.!])+\[([^\]]+)\]/gi, (_, ctrl) => resolve2part(ctrl));
  sql = sql.replace(/(?:\bParent[.!])+([\w]+)/gi, (_, ctrl) => resolve2part(ctrl));

  return sql;
}

/**
 * Build FROM and WHERE additions from collected stateRefs.
 * Returns { fromAdditions: string, whereAdditions: string }.
 */
function buildStateFromWhere(stateRefs) {
  if (!stateRefs || stateRefs.length === 0) {
    return { fromAdditions: '', whereAdditions: '' };
  }

  const fromParts = stateRefs.map(ref => `shared.session_state ${ref.alias}`);
  const whereParts = stateRefs.map(ref =>
    `${ref.alias}.table_name = '${ref.tableName}' AND ${ref.alias}.column_name = '${ref.columnName}'`
  );

  return {
    fromAdditions: ', ' + fromParts.join(', '),
    whereAdditions: whereParts.join(' AND ')
  };
}

module.exports = { formStateSubquery, resolveControlMapping, translateTempVars, translateFormRefs, buildStateFromWhere };
