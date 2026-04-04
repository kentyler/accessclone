const { parseMacroIntents, parseMacroActions, actionToIntent, ACTION_TO_INTENT } = require('../lib/macro-intent-parser');

describe('parseMacroActions — SaveAsText format', () => {
  test('parses simple action lines', () => {
    const macro = `
Action =OpenForm
Argument ="frmCustomers"
Action =Close
`;
    const actions = parseMacroActions(macro);
    expect(actions).toHaveLength(2);
    expect(actions[0].action).toBe('OpenForm');
    expect(actions[0].arguments).toEqual(['frmCustomers']);
    expect(actions[1].action).toBe('Close');
  });

  test('parses condition lines', () => {
    const macro = `
Condition ="[OrderID] Is Not Null"
Action =OpenForm
Argument ="frmOrderDetails"
`;
    const actions = parseMacroActions(macro);
    expect(actions).toHaveLength(1);
    expect(actions[0].action).toBe('OpenForm');
    expect(actions[0].condition).toBe('[OrderID] Is Not Null');
    expect(actions[0].arguments).toEqual(['frmOrderDetails']);
  });

  test('parses multiple arguments', () => {
    const macro = `
Action =OpenForm
Argument ="frmOrders"
Argument ="acFormDS"
Argument =""
Argument ="[CustomerID] = 5"
`;
    const actions = parseMacroActions(macro);
    expect(actions).toHaveLength(1);
    expect(actions[0].arguments).toHaveLength(4);
    expect(actions[0].arguments[3]).toBe('[CustomerID] = 5');
  });

  test('returns empty for null/empty input', () => {
    expect(parseMacroActions(null)).toEqual([]);
    expect(parseMacroActions('')).toEqual([]);
    expect(parseMacroActions(42)).toEqual([]);
  });
});

describe('parseMacroActions — XML format', () => {
  test('parses Action elements', () => {
    const xml = `
<UserInterfaceMacro>
  <Statements>
    <Action Name="OpenForm">
      <Argument Name="Form Name">frmCustomers</Argument>
    </Action>
    <Action Name="MsgBox">
      <Argument Name="Message">Hello World</Argument>
    </Action>
  </Statements>
</UserInterfaceMacro>`;
    const actions = parseMacroActions(xml);
    expect(actions).toHaveLength(2);
    expect(actions[0].action).toBe('OpenForm');
    expect(actions[0].arguments).toEqual(['frmCustomers']);
    expect(actions[1].action).toBe('MsgBox');
    expect(actions[1].arguments).toEqual(['Hello World']);
  });
});

describe('actionToIntent', () => {
  test('maps OpenForm to open-form', () => {
    const intent = actionToIntent({ action: 'OpenForm', arguments: ['frmOrders'], condition: null });
    expect(intent.type).toBe('open-form');
    expect(intent.params.form_name).toBe('frmOrders');
    expect(intent.classification).toBe('mechanical');
  });

  test('maps OpenForm with filter to open-form-filtered', () => {
    const intent = actionToIntent({
      action: 'OpenForm',
      arguments: ['frmOrders', '', '', '[CustomerID] = 5'],
      condition: null
    });
    expect(intent.type).toBe('open-form-filtered');
    expect(intent.params.where_condition).toBe('[CustomerID] = 5');
  });

  test('maps OpenReport to open-report', () => {
    const intent = actionToIntent({ action: 'OpenReport', arguments: ['rptSales'], condition: null });
    expect(intent.type).toBe('open-report');
    expect(intent.params.report_name).toBe('rptSales');
  });

  test('maps Close with name to close-form', () => {
    const intent = actionToIntent({ action: 'Close', arguments: ['acForm', 'frmOrders'], condition: null });
    expect(intent.type).toBe('close-form');
    expect(intent.params.form_name).toBe('frmOrders');
  });

  test('maps Close without name to close-current', () => {
    const intent = actionToIntent({ action: 'Close', arguments: [''], condition: null });
    expect(intent.type).toBe('close-current');
  });

  test('maps SetTempVar', () => {
    const intent = actionToIntent({ action: 'SetTempVar', arguments: ['MyVar', '42'], condition: null });
    expect(intent.type).toBe('set-tempvar');
    expect(intent.params.var_name).toBe('MyVar');
  });

  test('maps RunSQL', () => {
    const intent = actionToIntent({ action: 'RunSQL', arguments: ['DELETE FROM temp'], condition: null });
    expect(intent.type).toBe('run-sql');
    expect(intent.params.sql).toBe('DELETE FROM temp');
  });

  test('maps RunCode to gap', () => {
    const intent = actionToIntent({ action: 'RunCode', arguments: ['DoStuff()'], condition: null });
    expect(intent.type).toBe('gap');
    expect(intent.classification).toBe('gap');
  });

  test('maps GoToRecord with New', () => {
    const intent = actionToIntent({ action: 'GoToRecord', arguments: ['', '', 'New'], condition: null });
    expect(intent.type).toBe('new-record');
  });

  test('maps unknown action to gap', () => {
    const intent = actionToIntent({ action: 'SomeWeirdAction', arguments: [], condition: null });
    expect(intent.type).toBe('gap');
    expect(intent.params.original_action).toBe('SomeWeirdAction');
  });
});

describe('parseMacroIntents', () => {
  test('produces procedure with intents from macro text', () => {
    const macro = `
Action =OpenForm
Argument ="frmCustomers"
Action =MsgBox
Argument ="Done!"
`;
    const result = parseMacroIntents('mcrOpenCustomers', macro);
    expect(result.procedures).toHaveLength(1);
    expect(result.procedures[0].procedure).toBe('mcrOpenCustomers');
    expect(result.procedures[0].trigger).toBe('macro');
    expect(result.procedures[0].intents).toHaveLength(2);
    expect(result.procedures[0].intents[0].type).toBe('open-form');
    expect(result.procedures[0].intents[1].type).toBe('show-message');
  });

  test('wraps conditional actions in branch intents', () => {
    const macro = `
Condition ="[Status] = 'Active'"
Action =OpenForm
Argument ="frmActiveOrders"
`;
    const result = parseMacroIntents('mcrCheck', macro);
    const intent = result.procedures[0].intents[0];
    expect(intent.type).toBe('branch');
    expect(intent.params.condition).toBe("[Status] = 'Active'");
    expect(intent.then).toHaveLength(1);
    expect(intent.then[0].type).toBe('open-form');
  });

  test('returns empty procedures for empty macro', () => {
    const result = parseMacroIntents('mcrEmpty', '');
    expect(result.procedures).toEqual([]);
  });
});

describe('ACTION_TO_INTENT coverage', () => {
  test('covers common Access macro actions', () => {
    const expected = ['OpenForm', 'OpenReport', 'Close', 'SetTempVar', 'RunSQL',
      'MsgBox', 'SetValue', 'RunCode', 'Requery', 'GoToRecord', 'ApplyFilter',
      'OpenQuery', 'Save', 'SetProperty'];
    for (const action of expected) {
      expect(ACTION_TO_INTENT[action]).toBeDefined();
    }
  });
});
