/**
 * Form state subquery builders and form/TempVar reference translators.
 */

const { sanitizeName } = require('./utils');

/**
 * Build a subquery that reads a value from the form_control_state table.
 * Keyed by (session, table_name, column_name) — no form identity needed.
 */
function formStateSubquery(tableName, columnName) {
  return `(SELECT value FROM shared.form_control_state ` +
    `WHERE session_id = current_setting('app.session_id', true) ` +
    `AND table_name = '${tableName}' ` +
    `AND column_name = '${columnName}')`;
}

/**
 * Replace TempVars references with subqueries against form_control_state.
 * TempVars use the reserved table_name '_tempvars'.
 */
function translateTempVars(sql) {
  // [TempVars]![varName]
  sql = sql.replace(/\[TempVars\]!\[(\w+)\]/gi, (_, v) =>
    formStateSubquery('_tempvars', v.toLowerCase()));
  // TempVars("varName")
  sql = sql.replace(/TempVars\("(\w+)"\)/gi, (_, v) =>
    formStateSubquery('_tempvars', v.toLowerCase()));
  // TempVars!varName
  sql = sql.replace(/TempVars!(\w+)/gi, (_, v) =>
    formStateSubquery('_tempvars', v.toLowerCase()));

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
 * Replace form references with subqueries against form_control_state.
 * Uses controlMapping to resolve form+control → table+column.
 * Must run BEFORE bracket removal and double-quote conversion.
 */
function translateFormRefs(sql, controlMapping, referencedEntries, warnings) {
  function resolve3part(form, ctrl) {
    const fn = sanitizeName(form);
    const cn = sanitizeName(ctrl);
    const resolved = resolveControlMapping(controlMapping, fn, cn, true);
    if (resolved) {
      if (referencedEntries) referencedEntries.push({ tableName: resolved.table, columnName: resolved.column });
      return formStateSubquery(resolved.table, resolved.column);
    }
    // Fallback: use form name as table, control as column
    if (warnings) warnings.push(`Unresolved form ref: Forms!${form}!${ctrl}`);
    return formStateSubquery(fn, cn);
  }

  function resolve2part(ctrl) {
    const cn = sanitizeName(ctrl);
    const resolved = resolveControlMapping(controlMapping, null, cn, false);
    if (resolved) {
      if (referencedEntries) referencedEntries.push({ tableName: resolved.table, columnName: resolved.column });
      return formStateSubquery(resolved.table, resolved.column);
    }
    // Unresolved: emit NULL with comment
    if (warnings) warnings.push(`Unresolved form ref: Form!${ctrl}`);
    return `NULL /* UNRESOLVED: Form!${ctrl} */`;
  }

  // --- 3-part: [Forms]![formName]![controlName] (explicit form name) ---
  sql = sql.replace(/\[Forms\]!\[([^\]]+)\]!\[([^\]]+)\]/gi, (_, form, ctrl) => resolve3part(form, ctrl));
  sql = sql.replace(/Forms!\[([^\]]+)\]!\[([^\]]+)\]/gi, (_, form, ctrl) => resolve3part(form, ctrl));
  sql = sql.replace(/Forms!([\w]+)!([\w]+)/gi, (_, form, ctrl) => resolve3part(form, ctrl));
  sql = sql.replace(/Forms!([\w]+)\.([\w]+)/gi, (_, form, ctrl) => resolve3part(form, ctrl));

  // --- 2-part: [Form]![controlName] ---
  sql = sql.replace(/\[Form\]!\[([^\]]+)\]/gi, (_, ctrl) => resolve2part(ctrl));
  sql = sql.replace(/\bForm!\[([^\]]+)\]/gi, (_, ctrl) => resolve2part(ctrl));
  sql = sql.replace(/\bForm!([\w]+)/gi, (_, ctrl) => resolve2part(ctrl));

  // --- 2-part: [Parent]![controlName] ---
  sql = sql.replace(/\[Parent\]!\[([^\]]+)\]/gi, (_, ctrl) => resolve2part(ctrl));
  sql = sql.replace(/\bParent!\[([^\]]+)\]/gi, (_, ctrl) => resolve2part(ctrl));
  sql = sql.replace(/\bParent!([\w]+)/gi, (_, ctrl) => resolve2part(ctrl));

  return sql;
}

module.exports = { formStateSubquery, resolveControlMapping, translateTempVars, translateFormRefs };
