/**
 * Control-Event Mapping
 * Populates shared.control_event_map from form/report definitions.
 * Maps (database_id, object_name, control_name, event) → (handler_type, handler_ref, module_name)
 * so handler resolution can look up event wiring without brittle VBA name parsing.
 */

const { sanitizeName } = require('./query-converter');

// VBA event suffixes for [Event Procedure] → procedure name derivation
const eventSuffixMap = {
  'on-click': 'Click',
  'on-dblclick': 'DblClick',
  'on-change': 'Change',
  'on-enter': 'Enter',
  'on-exit': 'Exit',
  'before-update': 'BeforeUpdate',
  'after-update': 'AfterUpdate',
  'on-gotfocus': 'GotFocus',
  'on-lostfocus': 'LostFocus',
  'on-load': 'Load',
  'on-open': 'Open',
  'on-close': 'Close',
  'on-current': 'Current',
  'before-insert': 'BeforeInsert',
  'after-insert': 'AfterInsert',
  'on-delete': 'Delete',
  'on-format': 'Format',
  'on-print': 'Print',
  'on-retreat': 'Retreat',
  'on-activate': 'Activate',
  'on-deactivate': 'Deactivate',
  'on-no-data': 'NoData',
  'on-page': 'Page',
  'on-error': 'Error',
};

// Boolean flag → kebab event key mapping (for old definitions without .events map)
const boolFlagMap = {
  'has-click-event': 'on-click',
  'has-dblclick-event': 'on-dblclick',
  'has-change-event': 'on-change',
  'has-enter-event': 'on-enter',
  'has-exit-event': 'on-exit',
  'has-before-update-event': 'before-update',
  'has-after-update-event': 'after-update',
  'has-gotfocus-event': 'on-gotfocus',
  'has-lostfocus-event': 'on-lostfocus',
  'has-load-event': 'on-load',
  'has-open-event': 'on-open',
  'has-close-event': 'on-close',
  'has-current-event': 'on-current',
  'has-before-insert-event': 'before-insert',
  'has-after-insert-event': 'after-insert',
  'has-delete-event': 'on-delete',
  'has-format-event': 'on-format',
  'has-print-event': 'on-print',
  'has-retreat-event': 'on-retreat',
  'has-activate-event': 'on-activate',
  'has-deactivate-event': 'on-deactivate',
  'has-no-data-event': 'on-no-data',
  'has-page-event': 'on-page',
  'has-error-event': 'on-error',
};

/**
 * Classify a raw event property value into handler type, ref, and module name.
 *
 * @param {string} rawValue - The Access event property value ("[Event Procedure]", "=FnName()", "MacroName")
 * @param {string} controlName - Control name (or "_form"/"_report" for object-level)
 * @param {string} eventKey - Kebab-case event key (e.g. "on-click")
 * @param {string} objectName - Form/report name
 * @param {string} objectType - "form" or "report"
 * @returns {{handler_type: string, handler_ref: string, module_name: string|null}|null}
 */
function classifyHandler(rawValue, controlName, eventKey, objectName, objectType) {
  if (!rawValue || typeof rawValue !== 'string') return null;
  const trimmed = rawValue.trim();
  if (!trimmed) return null;

  if (trimmed === '[Event Procedure]') {
    // Derive procedure name: ControlName_VBASuffix
    // For form/report-level events, the VBA convention uses "Form" or "Report" as the prefix
    const vbaSuffix = eventSuffixMap[eventKey];
    if (!vbaSuffix) return null;

    let procPrefix;
    if (controlName === '_form') {
      procPrefix = 'Form';
    } else if (controlName === '_report') {
      procPrefix = 'Report';
    } else {
      procPrefix = controlName;
    }

    const moduleName = objectType === 'form'
      ? `Form_${objectName}`
      : `Report_${objectName}`;

    return {
      handler_type: 'event-procedure',
      handler_ref: `${procPrefix}_${vbaSuffix}`,
      module_name: moduleName,
    };
  }

  if (trimmed.startsWith('=')) {
    // Expression: =FunctionName() or =FunctionName(args)
    const match = trimmed.match(/^=\s*(\w+)\s*\(/);
    const fnName = match ? match[1] : trimmed.slice(1);
    return {
      handler_type: 'expression',
      handler_ref: fnName,
      module_name: null,
    };
  }

  // Bare string → macro name
  return {
    handler_type: 'macro',
    handler_ref: trimmed,
    module_name: null,
  };
}

/**
 * Extract events from a definition object's .events map or boolean flags.
 * Returns array of {controlName, eventKey, rawValue}.
 */
function extractEventsFromObject(obj, controlName) {
  const results = [];

  // Prefer .events map (new format from updated PowerShell scripts)
  if (obj.events && typeof obj.events === 'object') {
    for (const [eventKey, rawValue] of Object.entries(obj.events)) {
      if (rawValue) {
        results.push({ controlName, eventKey, rawValue });
      }
    }
  }

  // Also check boolean flags (old format / backward compat)
  // Only add if not already covered by .events map
  const coveredEvents = new Set(results.map(r => r.eventKey));
  for (const [flag, eventKey] of Object.entries(boolFlagMap)) {
    if (coveredEvents.has(eventKey)) continue;
    if (obj[flag]) {
      results.push({ controlName, eventKey, rawValue: '[Event Procedure]' });
    }
  }

  return results;
}

/**
 * Populate shared.control_event_map for a form or report.
 *
 * @param {object} pool - PostgreSQL connection pool
 * @param {string} databaseId - Target database ID
 * @param {string} objectName - Form or report name
 * @param {object|string} definitionJson - Definition (JSON string or object)
 * @param {string} objectType - "form" or "report"
 */
async function populateControlEventMap(pool, databaseId, objectName, definitionJson, objectType) {
  let definition;
  try {
    definition = typeof definitionJson === 'string' ? JSON.parse(definitionJson) : definitionJson;
  } catch (e) {
    return; // can't parse — skip silently
  }

  const entries = [];
  const objKey = objectType === 'form' ? '_form' : '_report';

  // Object-level events
  const objEvents = extractEventsFromObject(definition, objKey);
  for (const { controlName, eventKey, rawValue } of objEvents) {
    const classified = classifyHandler(rawValue, controlName, eventKey, objectName, objectType);
    if (classified) {
      entries.push({ controlName, eventKey, ...classified });
    }
  }

  // Section-level events (reports have banded sections with events)
  for (const [key, section] of Object.entries(definition)) {
    if (!section || typeof section !== 'object') continue;

    // Check if this section itself has events (report sections)
    if (section.controls !== undefined || section['has-format-event'] || section['has-print-event'] || section['has-retreat-event'] || section.events) {
      const sectionEvents = extractEventsFromObject(section, `_section_${key}`);
      for (const { controlName, eventKey, rawValue } of sectionEvents) {
        const classified = classifyHandler(rawValue, controlName, eventKey, objectName, objectType);
        if (classified) {
          entries.push({ controlName, eventKey, ...classified });
        }
      }
    }

    // Control-level events
    if (Array.isArray(section.controls)) {
      for (const ctrl of section.controls) {
        const ctrlName = ctrl.name || ctrl.id || '';
        if (!ctrlName) continue;
        const ctrlEvents = extractEventsFromObject(ctrl, ctrlName);
        for (const { controlName, eventKey, rawValue } of ctrlEvents) {
          const classified = classifyHandler(rawValue, controlName, eventKey, objectName, objectType);
          if (classified) {
            entries.push({ controlName, eventKey, ...classified });
          }
        }
      }
    }
  }

  // Delete existing mappings, then insert new ones
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'DELETE FROM shared.control_event_map WHERE database_id = $1 AND object_name = $2',
      [databaseId, objectName]
    );

    if (entries.length > 0) {
      const values = [];
      const rows = [];
      let idx = 1;
      for (const entry of entries) {
        rows.push(`($${idx}, $${idx + 1}, $${idx + 2}, $${idx + 3}, $${idx + 4}, $${idx + 5}, $${idx + 6}, $${idx + 7})`);
        values.push(
          databaseId, objectName, objectType, entry.controlName,
          entry.eventKey, entry.handler_type, entry.handler_ref, entry.module_name
        );
        idx += 8;
      }

      await client.query(
        `INSERT INTO shared.control_event_map
           (database_id, object_name, object_type, control_name, event, handler_type, handler_ref, module_name)
         VALUES ${rows.join(', ')}
         ON CONFLICT (database_id, object_name, control_name, event) DO UPDATE
         SET handler_type = EXCLUDED.handler_type,
             handler_ref = EXCLUDED.handler_ref,
             module_name = EXCLUDED.module_name,
             object_type = EXCLUDED.object_type`,
        values
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { classifyHandler, populateControlEventMap, extractEventsFromObject, boolFlagMap, eventSuffixMap };
