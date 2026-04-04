/**
 * Generate Locked Tests — unified generator producing JSON assertions from intents.
 * All assertion types are JSON predicates that evaluate without LLM.
 */

const { generateStructureAssertions } = require('./structure-test-templates');
const { generateBusinessAssertions } = require('./business-test-templates');
const { generateSchemaAssertions } = require('./schema-test-templates');
const { generateContractAssertions } = require('./contract-test-templates');
const { getIntentTemplate } = require('./intent-templates');
const { flattenIntents } = require('../../graph/populate');

/**
 * Generate locked test assertions for all objects in a database.
 *
 * @param {Pool} pool
 * @param {string} databaseId
 * @returns {Promise<{objects: Array<{name: string, type: string, intent_type: string, assertions: Array}>}>}
 */
async function generateLockedTests(pool, databaseId) {
  const objects = [];

  // Load all intents for this database
  const intentsResult = await pool.query(`
    SELECT i.id, i.object_id, i.intent_type, i.content, i.generated_by,
           o.name, o.type as object_type
    FROM shared.intents i
    JOIN shared.objects o ON i.object_id = o.id
    WHERE o.database_id = $1 AND o.is_current = true
    ORDER BY o.type, o.name, i.intent_type
  `, [databaseId]);

  for (const row of intentsResult.rows) {
    const content = typeof row.content === 'string' ? JSON.parse(row.content) : row.content;
    let assertions = [];

    switch (row.intent_type) {
      case 'gesture':
        assertions = generateGestureAssertions(row.object_type, row.name, content);
        break;
      case 'structure':
        assertions = generateStructureAssertions(row.object_type, row.name, content);
        break;
      case 'business':
        assertions = generateBusinessAssertions(row.object_type, row.name, content);
        break;
      case 'schema':
        assertions = generateSchemaAssertions(row.name, content);
        break;
    }

    if (assertions.length > 0) {
      objects.push({
        name: row.name,
        type: row.object_type,
        intent_type: row.intent_type,
        assertions
      });
    }
  }

  // Generate contract assertions from route/function graph nodes
  try {
    const contractObjects = await generateContractAssertions(pool);
    objects.push(...contractObjects);
  } catch (err) {
    console.warn('Contract assertion generation failed (non-fatal):', err.message);
  }

  // Generate graph-sourced conformance assertions
  try {
    const { generateGraphAssertions } = require('./graph-test-templates');
    const graphObjects = await generateGraphAssertions(pool, databaseId);
    objects.push(...graphObjects);
  } catch (err) {
    console.warn('Graph assertion generation failed (non-fatal):', err.message);
  }

  return { objects };
}

/**
 * Generate gesture predicate assertions from gesture intents.
 * Uses existing intent-templates.js for mapping.
 */
function generateGestureAssertions(objectType, objectName, gestureData) {
  const assertions = [];
  const prefix = `${objectType}:${objectName}:gesture`;
  let idx = 0;

  // Macros use macro_has_action predicates, modules use handler predicates
  if (objectType === 'macro') {
    return generateMacroGestureAssertions(objectName, gestureData, prefix);
  }

  const procedures = gestureData.procedures || (Array.isArray(gestureData) ? gestureData : []);

  for (const proc of procedures) {
    const procName = proc.procedure || proc.name;
    const intents = proc.intents || [];
    const flat = flattenIntents(intents);

    // Determine handler key
    const handlerKey = proc.handler_key || `evt.${procName}`;

    // Handler no-throw assertion
    assertions.push({
      id: `${prefix}:${idx++}`,
      description: `Handler for "${procName}" executes without throwing`,
      predicate: { type: 'handler_no_throw', handler_key: handlerKey }
    });

    // Per-intent assertions from templates
    for (const intent of flat) {
      const template = getIntentTemplate(intent);
      if (!template) continue;

      for (const assertion of template.assertions) {
        if (assertion.type === 'calledWith') {
          assertions.push({
            id: `${prefix}:${idx++}`,
            description: `${procName}: ${template.description}`,
            predicate: {
              type: 'handler_calls_with_args',
              handler_key: handlerKey,
              method: assertion.method,
              args: assertion.args || []
            }
          });
        } else if (assertion.type === 'called') {
          assertions.push({
            id: `${prefix}:${idx++}`,
            description: `${procName}: ${template.description}`,
            predicate: {
              type: 'handler_calls_method',
              handler_key: handlerKey,
              method: assertion.method
            }
          });
        }
      }
    }
  }

  return assertions;
}

/**
 * Generate macro-specific gesture assertions using macro_has_action predicates.
 * Macros don't have JS handlers — they have macro_xml text.
 */
function generateMacroGestureAssertions(macroName, gestureData, prefix) {
  const assertions = [];
  let idx = 0;

  // Map intent types back to Access action names for macro_has_action checks
  const INTENT_TO_ACTION = {
    'open-form': 'OpenForm',
    'open-form-filtered': 'OpenForm',
    'open-report': 'OpenReport',
    'close-form': 'Close',
    'close-current': 'Close',
    'set-tempvar': 'SetTempVar',
    'run-sql': 'RunSQL',
    'show-message': 'MsgBox',
    'set-control-value': 'SetValue',
    'gap': null, // skip
    'requery': 'Requery',
    'goto-record': 'GoToRecord',
    'new-record': 'GoToRecord',
    'set-filter': 'ApplyFilter',
    'save-record': 'Save',
    'branch': null // structural, skip
  };

  const procedures = gestureData.procedures || (Array.isArray(gestureData) ? gestureData : []);
  const seenActions = new Set();

  for (const proc of procedures) {
    const intents = proc.intents || [];
    const flat = flattenIntents(intents);

    for (const intent of flat) {
      const action = INTENT_TO_ACTION[intent.type];
      if (!action || seenActions.has(action)) continue;
      seenActions.add(action);

      assertions.push({
        id: `${prefix}:${idx++}`,
        description: `Macro contains ${action} action`,
        predicate: { type: 'macro_has_action', action }
      });
    }
  }

  return assertions;
}

module.exports = { generateLockedTests, generateGestureAssertions };
