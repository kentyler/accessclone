const { evaluatePredicate, classifyPredicate, findControlInDefinition, getAllControls } = require('../lib/test-harness/predicate-evaluator');

// ============================================================
// Structure predicates
// ============================================================

describe('definition_has_section', () => {
  test('passes when section exists', () => {
    const ctx = { definition: { header: { controls: [] }, detail: { controls: [] } } };
    expect(evaluatePredicate({ type: 'definition_has_section', section: 'detail' }, ctx)).toBe(true);
  });

  test('fails when section missing', () => {
    const ctx = { definition: { detail: { controls: [] } } };
    expect(evaluatePredicate({ type: 'definition_has_section', section: 'footer' }, ctx)).toBe(false);
  });

  test('fails with no definition', () => {
    expect(evaluatePredicate({ type: 'definition_has_section', section: 'detail' }, {})).toBe(false);
  });
});

describe('definition_has_control', () => {
  test('finds control by name', () => {
    const ctx = { definition: { detail: { controls: [{ name: 'txtName', type: 'text-box' }] } } };
    expect(evaluatePredicate({ type: 'definition_has_control', control_name: 'txtName' }, ctx)).toBe(true);
  });

  test('case-insensitive match', () => {
    const ctx = { definition: { detail: { controls: [{ name: 'TxtName', type: 'text-box' }] } } };
    expect(evaluatePredicate({ type: 'definition_has_control', control_name: 'txtname' }, ctx)).toBe(true);
  });

  test('fails for missing control', () => {
    const ctx = { definition: { detail: { controls: [{ name: 'txtOther', type: 'text-box' }] } } };
    expect(evaluatePredicate({ type: 'definition_has_control', control_name: 'txtMissing' }, ctx)).toBe(false);
  });
});

describe('definition_has_subform', () => {
  test('passes for sub-form control', () => {
    const ctx = { definition: { detail: { controls: [{ name: 'sfrmDetails', type: 'sub-form' }] } } };
    expect(evaluatePredicate({ type: 'definition_has_subform', control_name: 'sfrmDetails' }, ctx)).toBe(true);
  });

  test('fails for non-subform control', () => {
    const ctx = { definition: { detail: { controls: [{ name: 'txtName', type: 'text-box' }] } } };
    expect(evaluatePredicate({ type: 'definition_has_subform', control_name: 'txtName' }, ctx)).toBe(false);
  });
});

describe('definition_has_record_source / no_record_source', () => {
  test('record source present', () => {
    const ctx = { definition: { 'record-source': 'employees' } };
    expect(evaluatePredicate({ type: 'definition_has_record_source' }, ctx)).toBe(true);
    expect(evaluatePredicate({ type: 'definition_has_no_record_source' }, ctx)).toBe(false);
  });

  test('no record source', () => {
    const ctx = { definition: {} };
    expect(evaluatePredicate({ type: 'definition_has_record_source' }, ctx)).toBe(false);
    expect(evaluatePredicate({ type: 'definition_has_no_record_source' }, ctx)).toBe(true);
  });
});

describe('has_band', () => {
  test('passes when report band exists', () => {
    const ctx = { definition: { 'report-header': { controls: [] }, detail: { controls: [] } } };
    expect(evaluatePredicate({ type: 'has_band', band: 'report-header' }, ctx)).toBe(true);
  });

  test('fails for missing band', () => {
    const ctx = { definition: { detail: { controls: [] } } };
    expect(evaluatePredicate({ type: 'has_band', band: 'report-footer' }, ctx)).toBe(false);
  });
});

describe('grouping_uses_field', () => {
  test('matches grouping field', () => {
    const ctx = { definition: { grouping: [{ field: 'CategoryID' }] } };
    expect(evaluatePredicate({ type: 'grouping_uses_field', field: 'CategoryID' }, ctx)).toBe(true);
  });

  test('fails for non-matching field', () => {
    const ctx = { definition: { grouping: [{ field: 'OrderDate' }] } };
    expect(evaluatePredicate({ type: 'grouping_uses_field', field: 'CategoryID' }, ctx)).toBe(false);
  });
});

// ============================================================
// Business predicates
// ============================================================

describe('entity_referenced', () => {
  test('passes when entity in schemaInfo', () => {
    const schemaInfo = new Map([['employees', ['id', 'name']]]);
    const ctx = { schemaInfo, definition: {} };
    expect(evaluatePredicate({ type: 'entity_referenced', entity: 'employees' }, ctx)).toBe(true);
  });

  test('passes when entity is record source', () => {
    const ctx = { schemaInfo: new Map(), definition: { 'record-source': 'orders' } };
    expect(evaluatePredicate({ type: 'entity_referenced', entity: 'orders' }, ctx)).toBe(true);
  });

  test('fails when entity not found', () => {
    const ctx = { schemaInfo: new Map(), definition: {} };
    expect(evaluatePredicate({ type: 'entity_referenced', entity: 'nonexistent' }, ctx)).toBe(false);
  });
});

describe('related_object_exists', () => {
  test('passes when object in map', () => {
    const objectsMap = new Map([['frmOrders', { type: 'form', name: 'frmOrders' }]]);
    expect(evaluatePredicate({ type: 'related_object_exists', object_name: 'frmOrders' }, { objectsMap })).toBe(true);
  });

  test('fails when object not in map', () => {
    const objectsMap = new Map();
    expect(evaluatePredicate({ type: 'related_object_exists', object_name: 'frmMissing' }, { objectsMap })).toBe(false);
  });
});

describe('category_matches_evidence', () => {
  test('data-entry needs record source', () => {
    const ctx = { definition: { 'record-source': 'employees' } };
    expect(evaluatePredicate({ type: 'category_matches_evidence', category: 'data-entry' }, ctx)).toBe(true);
  });

  test('data-entry fails without record source', () => {
    const ctx = { definition: {} };
    expect(evaluatePredicate({ type: 'category_matches_evidence', category: 'data-entry' }, ctx)).toBe(false);
  });

  test('switchboard needs buttons', () => {
    const ctx = { definition: { detail: { controls: [{ type: 'command-button', name: 'btnGo' }] } } };
    expect(evaluatePredicate({ type: 'category_matches_evidence', category: 'switchboard' }, ctx)).toBe(true);
  });
});

// ============================================================
// Schema predicates
// ============================================================

describe('table_has_column', () => {
  test('passes when column exists', () => {
    const schemaInfo = new Map([['employees', ['id', 'name', 'email']]]);
    expect(evaluatePredicate({ type: 'table_has_column', table: 'employees', column: 'name' }, { schemaInfo })).toBe(true);
  });

  test('fails when column missing', () => {
    const schemaInfo = new Map([['employees', ['id', 'name']]]);
    expect(evaluatePredicate({ type: 'table_has_column', table: 'employees', column: 'phone' }, { schemaInfo })).toBe(false);
  });

  test('fails when table missing', () => {
    const schemaInfo = new Map();
    expect(evaluatePredicate({ type: 'table_has_column', table: 'nonexistent', column: 'id' }, { schemaInfo })).toBe(false);
  });
});

describe('column_nullable', () => {
  test('matches nullable flag', () => {
    const columnDetails = new Map([['employees.id', { type: 'integer', nullable: false, default: null }]]);
    expect(evaluatePredicate({ type: 'column_nullable', table: 'employees', column: 'id', nullable: false }, { columnDetails })).toBe(true);
    expect(evaluatePredicate({ type: 'column_nullable', table: 'employees', column: 'id', nullable: true }, { columnDetails })).toBe(false);
  });
});

describe('column_has_fk', () => {
  test('passes when FK exists', () => {
    const foreignKeys = [{ table: 'orders', column: 'customer_id', references_table: 'customers', references_column: 'id' }];
    expect(evaluatePredicate({
      type: 'column_has_fk', table: 'orders', column: 'customer_id', references_table: 'customers'
    }, { foreignKeys })).toBe(true);
  });

  test('fails when FK not found', () => {
    const foreignKeys = [];
    expect(evaluatePredicate({
      type: 'column_has_fk', table: 'orders', column: 'customer_id', references_table: 'customers'
    }, { foreignKeys })).toBe(false);
  });
});

// ============================================================
// Gesture predicates
// ============================================================

describe('handler_calls_method', () => {
  test('detects method call in handler JS', () => {
    const handlers = { 'evt.btnSave_Click': { js: 'AC.saveRecord();' } };
    expect(evaluatePredicate({
      type: 'handler_calls_method', handler_key: 'evt.btnSave_Click', method: 'saveRecord'
    }, { handlers })).toBe(true);
  });

  test('fails when method not called', () => {
    const handlers = { 'evt.btnSave_Click': { js: 'AC.closeForm();' } };
    expect(evaluatePredicate({
      type: 'handler_calls_method', handler_key: 'evt.btnSave_Click', method: 'saveRecord'
    }, { handlers })).toBe(false);
  });
});

describe('macro_has_action', () => {
  test('detects action in SaveAsText format', () => {
    expect(evaluatePredicate(
      { type: 'macro_has_action', action: 'OpenForm' },
      { macroXml: 'Action =OpenForm\nArgument ="frmX"' }
    )).toBe(true);
  });

  test('detects action in XML format', () => {
    expect(evaluatePredicate(
      { type: 'macro_has_action', action: 'OpenForm' },
      { macroXml: '<Action Name="OpenForm"><Argument Name="Form Name">frmX</Argument></Action>' }
    )).toBe(true);
  });

  test('fails when action not present', () => {
    expect(evaluatePredicate(
      { type: 'macro_has_action', action: 'OpenReport' },
      { macroXml: 'Action =OpenForm\nArgument ="frmX"' }
    )).toBe(false);
  });
});

// ============================================================
// classifyPredicate
// ============================================================

describe('classifyPredicate', () => {
  test('boundary predicates', () => {
    expect(classifyPredicate({ type: 'definition_has_section' })).toBe('boundary');
    expect(classifyPredicate({ type: 'table_has_column' })).toBe('boundary');
    expect(classifyPredicate({ type: 'has_band' })).toBe('boundary');
  });

  test('transduction predicates', () => {
    expect(classifyPredicate({ type: 'handler_calls_method' })).toBe('transduction');
    expect(classifyPredicate({ type: 'macro_has_action' })).toBe('transduction');
  });

  test('resolution predicates', () => {
    expect(classifyPredicate({ type: 'entity_referenced' })).toBe('resolution');
    expect(classifyPredicate({ type: 'related_object_exists' })).toBe('resolution');
    expect(classifyPredicate({ type: 'column_has_fk' })).toBe('resolution');
  });

  test('trace predicates', () => {
    expect(classifyPredicate({ type: 'category_matches_evidence' })).toBe('trace');
    expect(classifyPredicate({ type: 'definition_property_equals' })).toBe('trace');
  });
});

// ============================================================
// Helpers
// ============================================================

describe('findControlInDefinition', () => {
  test('finds control across sections', () => {
    const def = {
      header: { controls: [{ name: 'lblTitle', type: 'label' }] },
      detail: { controls: [{ name: 'txtName', type: 'text-box' }] },
      footer: { controls: [{ name: 'btnSave', type: 'command-button' }] }
    };
    expect(findControlInDefinition(def, 'txtName')).toEqual({ name: 'txtName', type: 'text-box' });
    expect(findControlInDefinition(def, 'btnSave')).toEqual({ name: 'btnSave', type: 'command-button' });
    expect(findControlInDefinition(def, 'missing')).toBeNull();
  });
});

describe('getAllControls', () => {
  test('returns all controls from all sections', () => {
    const def = {
      header: { controls: [{ name: 'a' }] },
      detail: { controls: [{ name: 'b' }, { name: 'c' }] }
    };
    expect(getAllControls(def)).toHaveLength(3);
  });
});
