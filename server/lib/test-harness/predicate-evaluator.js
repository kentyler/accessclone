/**
 * Predicate Evaluator — deterministic evaluation of test predicates.
 * Pure switch on predicate.type. No LLM.
 *
 * Context is built before evaluation and contains:
 * - definition: parsed form/report definition JSON
 * - schemaInfo: Map<table_name, column_names[]> from information_schema
 * - objectsMap: Map<name, {type, name}> from shared.objects
 * - handlers: Object of JS handler entries (from module definition)
 * - macroXml: string (raw macro text)
 * - structureIntent: the stored structure intent (for pattern checks)
 */

/**
 * Evaluate a single predicate against context.
 *
 * @param {Object} predicate - { type, ...params }
 * @param {Object} context
 * @returns {boolean}
 */
function evaluatePredicate(predicate, context) {
  switch (predicate.type) {
    // ---- Gesture predicates (modules + macros) ----

    case 'handler_calls_method': {
      const { handlers } = context;
      if (!handlers) return false;
      const handler = findHandler(handlers, predicate.handler_key);
      if (!handler || !handler.js) return false;
      const method = predicate.method;
      return handler.js.includes(`AC.${method}(`) || handler.js.includes(`AC.${method} (`);
    }

    case 'handler_calls_with_args': {
      const { handlers } = context;
      if (!handlers) return false;
      const handler = findHandler(handlers, predicate.handler_key);
      if (!handler || !handler.js) return false;
      const argsStr = (predicate.args || []).map(a => JSON.stringify(a)).join(', ');
      return handler.js.includes(`AC.${predicate.method}(${argsStr}`);
    }

    case 'handler_no_throw': {
      const { handlers } = context;
      if (!handlers) return false;
      const handler = findHandler(handlers, predicate.handler_key);
      if (!handler || !handler.js) return false;
      try {
        const { createMockAC, executeWithMockAC } = require('./mock-ac');
        const { ac } = createMockAC();
        // Synchronous eval — if it throws, predicate fails
        new Function('AC', 'window', 'alert', handler.js)(ac, { AC: ac }, ac.alert);
        return true;
      } catch {
        return false;
      }
    }

    case 'macro_has_action': {
      let xml = context.macroXml;
      if (!xml) return false;
      // Unwrap {value: "..."} wrapper if present
      if (typeof xml === 'object' && xml.value) xml = xml.value;
      if (typeof xml !== 'string') return false;
      const action = predicate.action;
      // Check SaveAsText formats (quoted and unquoted) and XML format
      return xml.includes(`Action ="${action}"`) ||
             xml.includes(`Action =${action}`) ||
             xml.includes(`Action="${action}"`) ||
             xml.includes(`Name="${action}"`);
    }

    // ---- Structure predicates (forms + reports) ----

    case 'definition_has_section': {
      const { definition } = context;
      if (!definition) return false;
      return !!definition[predicate.section];
    }

    case 'definition_has_control': {
      const { definition } = context;
      if (!definition) return false;
      return findControlInDefinition(definition, predicate.control_name) !== null;
    }

    case 'definition_has_subform': {
      const { definition } = context;
      if (!definition) return false;
      const ctrl = findControlInDefinition(definition, predicate.control_name);
      if (!ctrl) return false;
      const t = (ctrl.type || '').toString().toLowerCase();
      return t === 'sub-form' || t === 'subform' || t === 'sub-report' || t === 'subreport';
    }

    case 'definition_has_record_source': {
      const { definition } = context;
      if (!definition) return false;
      return !!(definition['record-source'] || definition.record_source);
    }

    case 'definition_has_no_record_source': {
      const { definition } = context;
      if (!definition) return false;
      return !(definition['record-source'] || definition.record_source);
    }

    case 'definition_property_equals': {
      const { definition, structureIntent } = context;
      if (predicate.property === '__pattern') {
        // Special: check against stored structure intent
        return structureIntent?.pattern === predicate.value;
      }
      if (!definition) return false;
      const val = definition[predicate.property];
      return val === predicate.value || String(val) === String(predicate.value);
    }

    case 'has_band': {
      const { definition } = context;
      if (!definition) return false;
      // Reports use band names as keys: report-header, page-header, group-header-0, detail, etc.
      return !!definition[predicate.band];
    }

    case 'grouping_uses_field': {
      const { definition } = context;
      if (!definition) return false;
      const grouping = definition.grouping || [];
      return grouping.some(g => g.field === predicate.field || g['group-field'] === predicate.field);
    }

    // ---- Business predicates (forms + reports) ----

    case 'entity_referenced': {
      const { definition, schemaInfo } = context;
      const entity = (predicate.entity || '').toLowerCase();
      // Check if entity exists as a table/view in schema
      if (schemaInfo && schemaInfo.has(entity)) return true;
      // Also check if the record source references it
      if (definition) {
        const rs = (definition['record-source'] || definition.record_source || '').toLowerCase();
        if (rs === entity) return true;
        if (rs.includes(entity)) return true;
      }
      // Check combo-box row-sources
      if (definition) {
        const controls = getAllControls(definition);
        for (const ctrl of controls) {
          const rowSource = (ctrl['row-source'] || ctrl.row_source || '').toLowerCase();
          if (rowSource.includes(entity)) return true;
        }
      }
      return false;
    }

    case 'related_object_exists': {
      const { objectsMap } = context;
      if (!objectsMap) return false;
      const name = predicate.object_name;
      const type = predicate.object_type;
      if (type) {
        return objectsMap.has(`${type}:${name}`) || objectsMap.has(name);
      }
      return objectsMap.has(name);
    }

    case 'category_matches_evidence': {
      // Heuristic: check if the claimed category has supporting structural evidence
      const { definition } = context;
      if (!definition) return true; // can't disprove
      const category = predicate.category;
      const rs = definition['record-source'] || definition.record_source;
      const controls = getAllControls(definition);
      const hasButtons = controls.some(c => (c.type || '').toString().includes('button'));
      const hasSubforms = controls.some(c => {
        const t = (c.type || '').toString().toLowerCase();
        return t === 'sub-form' || t === 'subform';
      });

      switch (category) {
        case 'data-entry': return !!rs;
        case 'search': case 'search-dashboard': return controls.length > 0;
        case 'navigation': case 'switchboard': return hasButtons;
        case 'dialog': case 'lookup-dialog': return controls.length > 0;
        case 'listing': case 'tabular-list': return !!rs;
        case 'summary': case 'grouped-summary': return !!rs;
        case 'detail': return !!rs;
        case 'label': return !!rs;
        case 'letter': case 'form-letter': return !!rs;
        case 'invoice': case 'invoice-report': return !!rs;
        case 'settings': return true;
        case 'reporting': case 'report-launcher': return true;
        default: return true;
      }
    }

    // ---- Schema predicates (tables) ----

    case 'table_has_column': {
      const { schemaInfo } = context;
      if (!schemaInfo) return false;
      const columns = schemaInfo.get(predicate.table);
      if (!columns) return false;
      // schemaInfo values are arrays of column names
      if (Array.isArray(columns)) {
        return columns.includes(predicate.column);
      }
      return false;
    }

    case 'column_nullable': {
      // Requires detailed schema — check via context.columnDetails
      const { columnDetails } = context;
      if (!columnDetails) return true; // can't evaluate without detail
      const key = `${predicate.table}.${predicate.column}`;
      const detail = columnDetails.get(key);
      if (!detail) return false;
      return detail.nullable === predicate.nullable;
    }

    case 'column_has_fk': {
      const { foreignKeys } = context;
      if (!foreignKeys) return true; // can't evaluate without FK data
      return foreignKeys.some(fk =>
        fk.table === predicate.table &&
        fk.column === predicate.column &&
        fk.references_table === predicate.references_table
      );
    }

    case 'column_has_default': {
      const { columnDetails } = context;
      if (!columnDetails) return true; // can't evaluate without detail
      const key = `${predicate.table}.${predicate.column}`;
      const detail = columnDetails.get(key);
      if (!detail) return false;
      return detail.default !== null && detail.default !== undefined;
    }

    // ---- Graph conformance predicates ----

    case 'form_record_source_matches': {
      const { definition } = context;
      if (!definition) return false;
      const rs = (definition['record-source'] || definition.record_source || '').toLowerCase();
      return rs === (predicate.table || '').toLowerCase();
    }

    case 'control_field_matches': {
      const { definition } = context;
      if (!definition) return false;
      const ctrl = findControlInDefinition(definition, predicate.control_name);
      if (!ctrl) return false;
      const binding = (ctrl['control-source'] || ctrl.control_source || ctrl.field || '').toLowerCase();
      return binding === (predicate.column || '').toLowerCase();
    }

    case 'query_references_table': {
      const { queryDependencies } = context;
      if (!queryDependencies) return true; // can't evaluate without dependency data
      return queryDependencies.some(dep => dep.toLowerCase() === (predicate.table || '').toLowerCase());
    }

    case 'query_object_type': {
      const { queryType } = context;
      if (!queryType) return true; // can't evaluate without type data
      return queryType === predicate.expected_type;
    }

    case 'module_has_vba': {
      const { definition } = context;
      if (!definition) return false;
      return !!definition.vba_source === predicate.expected;
    }

    case 'module_handler_count': {
      const { definition } = context;
      if (!definition) return false;
      const handlers = definition.js_handlers || [];
      const count = Array.isArray(handlers) ? handlers.length : Object.keys(handlers).length;
      return count === predicate.expected_count;
    }

    case 'macro_has_xml': {
      const { definition } = context;
      if (!definition) return false;
      let xml = definition.macro_xml;
      if (typeof xml === 'object' && xml && xml.value) xml = xml.value;
      return !!xml === predicate.expected;
    }

    // ---- Contract predicates (routes + functions) ----

    case 'route_accepts_fields': {
      const { routeMap } = context;
      if (!routeMap) return true; // can't evaluate without route context
      const routeMeta = routeMap.get(predicate.route);
      if (!routeMeta) return false;
      const bodyFields = routeMeta.fields?.body || [];
      const expected = predicate.fields || [];
      return expected.every(f => bodyFields.includes(f));
    }

    case 'function_sends_fields': {
      const { functionMap } = context;
      if (!functionMap) return true; // can't evaluate without function context
      const fnMeta = functionMap.get(predicate.function);
      if (!fnMeta) return false;
      const sentFields = fnMeta.fields || [];
      const expected = predicate.fields || [];
      return expected.every(f => sentFields.includes(f));
    }

    case 'contract_fields_match': {
      const { routeMap, functionMap } = context;
      if (!routeMap || !functionMap) return true; // can't evaluate without context
      const fnMeta = functionMap.get(predicate.function);
      const routeMeta = routeMap.get(predicate.route);
      if (!fnMeta || !routeMeta) return false;
      const sentFields = fnMeta.fields || [];
      const acceptedFields = routeMeta.fields?.body || [];
      // All fields sent by function must be accepted by route
      return sentFields.every(f => acceptedFields.includes(f));
    }

    default:
      // Unknown predicate type — pass by default (conservative)
      return true;
  }
}

/**
 * Find a handler by key in the handlers object.
 * Handlers may be stored as an array-like object {0: {...}, 1: {...}} or
 * keyed by handler name. Each handler has a .key field (e.g. "evt.Form_Load").
 */
function findHandler(handlers, handlerKey) {
  if (!handlers || !handlerKey) return null;
  // Direct key lookup
  if (handlers[handlerKey]) return handlers[handlerKey];
  // Search by .key field (array-like storage)
  for (const k of Object.keys(handlers)) {
    const h = handlers[k];
    if (h && h.key === handlerKey) return h;
  }
  // Try alternate prefix: evt. ↔ fn.
  const altKey = handlerKey.startsWith('evt.') ? 'fn.' + handlerKey.slice(4) :
                 handlerKey.startsWith('fn.') ? 'evt.' + handlerKey.slice(3) : null;
  if (altKey) {
    for (const k of Object.keys(handlers)) {
      const h = handlers[k];
      if (h && h.key === altKey) return h;
    }
  }
  // Try matching just the procedure name (after the prefix)
  const procName = handlerKey.includes('.') ? handlerKey.split('.').pop() : handlerKey;
  for (const k of Object.keys(handlers)) {
    const h = handlers[k];
    if (h && h.procedure === procName) return h;
  }
  return null;
}

/**
 * Find a control by name across all sections of a definition.
 */
function findControlInDefinition(definition, controlName) {
  if (!controlName) return null;
  const lower = controlName.toLowerCase();

  for (const key of Object.keys(definition)) {
    const section = definition[key];
    if (section && Array.isArray(section.controls)) {
      for (const ctrl of section.controls) {
        if ((ctrl.name || '').toLowerCase() === lower) return ctrl;
      }
    }
  }
  return null;
}

/**
 * Get all controls from all sections of a definition.
 */
function getAllControls(definition) {
  const controls = [];
  for (const key of Object.keys(definition)) {
    const section = definition[key];
    if (section && Array.isArray(section.controls)) {
      controls.push(...section.controls);
    }
  }
  return controls;
}

/**
 * Classify a predicate into a primitive category for heterogeneity computation.
 *
 * Categories:
 * - boundary: structural existence (has_section, has_control, has_column, has_band)
 * - transduction: behavioral mapping (handler_calls, macro_has_action)
 * - resolution: reference integrity (entity_referenced, object_exists, column_has_fk)
 * - trace: semantic consistency (category_matches, property_equals, pattern match)
 */
function classifyPredicate(predicate) {
  switch (predicate.type) {
    case 'definition_has_section':
    case 'definition_has_control':
    case 'definition_has_subform':
    case 'definition_has_record_source':
    case 'definition_has_no_record_source':
    case 'has_band':
    case 'table_has_column':
    case 'column_nullable':
    case 'column_has_default':
      return 'boundary';

    case 'handler_calls_method':
    case 'handler_calls_with_args':
    case 'handler_no_throw':
    case 'macro_has_action':
      return 'transduction';

    case 'entity_referenced':
    case 'related_object_exists':
    case 'column_has_fk':
    case 'grouping_uses_field':
    case 'contract_fields_match':
    case 'form_record_source_matches':
    case 'control_field_matches':
    case 'query_references_table':
      return 'resolution';

    case 'category_matches_evidence':
    case 'definition_property_equals':
      return 'trace';

    case 'route_accepts_fields':
    case 'function_sends_fields':
    case 'query_object_type':
    case 'module_has_vba':
    case 'module_handler_count':
    case 'macro_has_xml':
      return 'boundary';

    default:
      return 'boundary';
  }
}

module.exports = {
  evaluatePredicate,
  classifyPredicate,
  findHandler,
  findControlInDefinition,
  getAllControls
};
