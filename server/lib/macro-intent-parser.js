/**
 * Macro Intent Parser — deterministic parser for Access macro SaveAsText format.
 * Converts macro_xml text into gesture-vocabulary intents (same 30-type vocabulary
 * used by vba-intent-mapper.js).
 *
 * No LLM involved — pure text parsing.
 */

/**
 * Map Access macro actions to intent vocabulary types.
 */
const ACTION_TO_INTENT = {
  'OpenForm':       'open-form',
  'OpenReport':     'open-report',
  'Close':          'close-form',
  'CloseWindow':    'close-current',
  'SetTempVar':     'set-tempvar',
  'RemoveTempVar':  'set-tempvar',
  'RunSQL':         'run-sql',
  'MsgBox':         'show-message',
  'SetValue':       'set-control-value',
  'RunCode':        'gap',
  'Requery':        'requery',
  'GoToRecord':     'goto-record',
  'GoToControl':    'set-control-value',
  'ApplyFilter':    'set-filter',
  'ShowAllRecords': 'set-filter',
  'RunCommand':     'run-sql',
  'OpenQuery':      'run-sql',
  'RunMacro':       'gap',
  'StopMacro':      'close-current',
  'StopAllMacros':  'close-current',
  'Beep':           'show-message',
  'SetWarnings':    'gap',
  'PrintOut':       'gap',
  'OutputTo':       'gap',
  'SendObject':     'gap',
  'TransferDatabase':  'gap',
  'TransferSpreadsheet': 'gap',
  'TransferText':   'gap',
  'Maximize':       'gap',
  'Minimize':       'gap',
  'Restore':        'gap',
  'MoveSize':       'gap',
  'SelectObject':   'gap',
  'Rename':         'gap',
  'DeleteObject':   'gap',
  'CopyObject':     'gap',
  'Save':           'save-record',
  'SetMenuItem':    'gap',
  'DoMenuItem':     'gap',
  'AddMenu':        'gap',
  'SetProperty':    'set-control-value',
  'FindRecord':     'gap',
  'FindNext':       'gap'
};

/**
 * Parse macro SaveAsText content into structured actions.
 * Format is lines like:
 *   Action =OpenForm
 *   Argument ="FormName"
 *   Condition ="[SomeField] Is Not Null"
 *
 * Also handles newer XML-style macros with <Action Name="OpenForm"> blocks.
 *
 * @param {string} macroText - Raw macro_xml / SaveAsText content
 * @returns {Array<{action: string, arguments: string[], condition: string|null}>}
 */
function parseMacroActions(macroText) {
  if (!macroText || typeof macroText !== 'string') return [];

  const actions = [];

  // Detect format: SaveAsText starts with "Version =" header lines,
  // pure XML macros start with "<?xml" or have <Action at the top level.
  // The _AXL comment in SaveAsText macros embeds XML — don't be tricked by it.
  const isSaveAsText = /^\s*Version\s*=/m.test(macroText);

  if (!isSaveAsText && (macroText.includes('<Action') || macroText.includes('<SubMacro'))) {
    return parseXmlMacro(macroText);
  }

  // SaveAsText line-based format
  const lines = macroText.split(/\r?\n/);
  let currentAction = null;
  let currentArgs = [];
  let currentCondition = null;

  for (const line of lines) {
    const trimmed = line.trim();

    // Condition line
    const condMatch = trimmed.match(/^Condition\s*=\s*(.+)$/i);
    if (condMatch) {
      currentCondition = stripQuotes(condMatch[1]);
      continue;
    }

    // Action line
    const actionMatch = trimmed.match(/^Action\s*=\s*(.+)$/i);
    if (actionMatch) {
      // Flush previous action
      if (currentAction) {
        actions.push({
          action: currentAction,
          arguments: currentArgs,
          condition: currentCondition
        });
        currentCondition = null;
      }
      currentAction = stripQuotes(actionMatch[1]);
      currentArgs = [];
      continue;
    }

    // Argument line
    const argMatch = trimmed.match(/^Argument\s*=\s*(.+)$/i);
    if (argMatch) {
      currentArgs.push(stripQuotes(argMatch[1]));
      continue;
    }
  }

  // Flush last action
  if (currentAction) {
    actions.push({
      action: currentAction,
      arguments: currentArgs,
      condition: currentCondition
    });
  }

  return actions;
}

/**
 * Parse XML-style macro format (Access 2010+).
 * @param {string} xml
 * @returns {Array<{action: string, arguments: string[], condition: string|null}>}
 */
function parseXmlMacro(xml) {
  const actions = [];

  // Match <Action Name="..."> blocks
  const actionRegex = /<Action\s+Name="([^"]+)"[^>]*>([\s\S]*?)<\/Action>/gi;
  let match;
  while ((match = actionRegex.exec(xml)) !== null) {
    const actionName = match[1];
    const body = match[2];

    // Extract arguments
    const args = [];
    const argRegex = /<Argument\s+Name="[^"]*">([^<]*)<\/Argument>/gi;
    let argMatch;
    while ((argMatch = argRegex.exec(body)) !== null) {
      args.push(argMatch[1]);
    }

    // Check for condition on enclosing <If>/<ConditionalBlock>
    let condition = null;
    const condIdx = xml.lastIndexOf('<Condition>', match.index);
    const condEndIdx = xml.lastIndexOf('</Condition>', match.index);
    if (condIdx !== -1 && condIdx > condEndIdx - 100) {
      const condContent = xml.substring(condIdx + 11, xml.indexOf('</Condition>', condIdx));
      if (condContent) condition = condContent.trim();
    }

    actions.push({ action: actionName, arguments: args, condition });
  }

  return actions;
}

/**
 * Strip surrounding quotes from a value.
 * @param {string} val
 * @returns {string}
 */
function stripQuotes(val) {
  if (!val) return '';
  val = val.trim();
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    return val.slice(1, -1);
  }
  return val;
}

/**
 * Convert a parsed macro action to an intent.
 * @param {{action: string, arguments: string[], condition: string|null}} parsed
 * @returns {{type: string, params: Object, classification: string}}
 */
function actionToIntent(parsed) {
  const intentType = ACTION_TO_INTENT[parsed.action] || 'gap';
  const params = {};
  let classification = intentType === 'gap' ? 'gap' : 'mechanical';

  switch (parsed.action) {
    case 'OpenForm': {
      const formName = parsed.arguments[0] || null;
      params.form_name = formName;
      if (parsed.arguments.length > 3 && parsed.arguments[3]) {
        params.where_condition = parsed.arguments[3];
        return { type: 'open-form-filtered', params, classification };
      }
      break;
    }
    case 'OpenReport': {
      params.report_name = parsed.arguments[0] || null;
      if (parsed.arguments.length > 3 && parsed.arguments[3]) {
        params.where_condition = parsed.arguments[3];
      }
      break;
    }
    case 'Close': {
      const objType = parsed.arguments[0] || '';
      const objName = parsed.arguments[1] || null;
      if (objName) {
        params.form_name = objName;
      } else {
        return { type: 'close-current', params, classification };
      }
      break;
    }
    case 'SetTempVar':
    case 'RemoveTempVar': {
      params.var_name = parsed.arguments[0] || null;
      params.value = parsed.arguments[1] || null;
      break;
    }
    case 'RunSQL': {
      params.sql = parsed.arguments[0] || null;
      break;
    }
    case 'MsgBox': {
      params.message = parsed.arguments[0] || null;
      break;
    }
    case 'SetValue': {
      params.item = parsed.arguments[0] || null;
      params.expression = parsed.arguments[1] || null;
      break;
    }
    case 'RunCode': {
      params.function_name = parsed.arguments[0] || null;
      classification = 'gap';
      break;
    }
    case 'GoToRecord': {
      const recordArg = parsed.arguments[2] || parsed.arguments[0] || '';
      if (/new/i.test(recordArg)) {
        return { type: 'new-record', params: { direction: 'new' }, classification };
      }
      params.direction = recordArg.toLowerCase() || 'next';
      break;
    }
    case 'ApplyFilter': {
      params.filter = parsed.arguments[1] || parsed.arguments[0] || null;
      return { type: 'set-filter', params, classification };
    }
    case 'OpenQuery': {
      params.query_name = parsed.arguments[0] || null;
      break;
    }
    case 'RunMacro': {
      params.macro_name = parsed.arguments[0] || null;
      classification = 'gap';
      break;
    }
    case 'Requery': {
      params.control = parsed.arguments[0] || null;
      break;
    }
    case 'SetProperty': {
      params.control_name = parsed.arguments[0] || null;
      params.property = parsed.arguments[1] || null;
      params.value = parsed.arguments[2] || null;
      break;
    }
    case 'Save': {
      break;
    }
    default: {
      if (intentType === 'gap') {
        params.original_action = parsed.action;
        params.reason = `Unmappable macro action: ${parsed.action}`;
      }
    }
  }

  return { type: intentType, params, classification };
}

/**
 * Parse macro_xml text and produce structured intents.
 *
 * @param {string} macroName - Name of the macro
 * @param {string} macroText - Raw macro_xml / SaveAsText content
 * @returns {{ procedures: Array<{procedure: string, trigger: string, intents: Array}> }}
 */
function parseMacroIntents(macroName, macroText) {
  const actions = parseMacroActions(macroText);
  if (actions.length === 0) {
    return { procedures: [] };
  }

  const intents = [];
  let conditionStack = null;

  for (const action of actions) {
    const intent = actionToIntent(action);

    if (action.condition) {
      // Wrap in a branch intent
      const branchIntent = {
        type: 'branch',
        params: { condition: action.condition },
        classification: 'mechanical',
        then: [intent]
      };
      intents.push(branchIntent);
    } else {
      intents.push(intent);
    }
  }

  return {
    procedures: [{
      procedure: macroName,
      trigger: 'macro',
      intents
    }]
  };
}

module.exports = {
  parseMacroIntents,
  parseMacroActions,
  actionToIntent,
  ACTION_TO_INTENT
};
