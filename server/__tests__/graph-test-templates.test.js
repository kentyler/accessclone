const { generateGraphAssertions } = require('../lib/test-harness/graph-test-templates');
const { evaluatePredicate } = require('../lib/test-harness/predicate-evaluator');

// ============================================================
// Mock pool helper
// ============================================================

function createMockPool(nodes, edges) {
  return {
    query: jest.fn(async (sql) => {
      // Check edges first — its SQL also JOINs _nodes
      if (sql.includes('shared._edges')) {
        return { rows: edges };
      }
      if (sql.includes('shared._nodes')) {
        return { rows: nodes };
      }
      return { rows: [] };
    })
  };
}

// ============================================================
// Table node assertions
// ============================================================

describe('generateGraphAssertions — tables', () => {
  test('generates table_has_column from contains edge', async () => {
    const tableId = 'table-1';
    const colId = 'col-1';
    const nodes = [
      { id: tableId, node_type: 'table', name: 'orders', metadata: { schema: 'nw' } },
      { id: colId, node_type: 'column', name: 'order_id', metadata: { table: 'orders', data_type: 'integer', nullable: false } }
    ];
    const edges = [
      { from_id: tableId, to_id: colId, rel_type: 'contains', metadata: {} }
    ];
    const pool = createMockPool(nodes, edges);
    const result = await generateGraphAssertions(pool, 'test_db');

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('orders');
    expect(result[0].type).toBe('table');
    expect(result[0].intent_type).toBe('graph');

    const preds = result[0].assertions.map(a => a.predicate.type);
    expect(preds).toContain('table_has_column');
    expect(preds).toContain('column_nullable');
  });

  test('generates column_has_default when default is present', async () => {
    const tableId = 'table-1';
    const colId = 'col-1';
    const nodes = [
      { id: tableId, node_type: 'table', name: 'products', metadata: {} },
      { id: colId, node_type: 'column', name: 'price', metadata: { table: 'products', default: '0.00' } }
    ];
    const edges = [
      { from_id: tableId, to_id: colId, rel_type: 'contains', metadata: {} }
    ];
    const pool = createMockPool(nodes, edges);
    const result = await generateGraphAssertions(pool, 'test_db');

    const assertions = result[0].assertions;
    expect(assertions.some(a => a.predicate.type === 'column_has_default')).toBe(true);
  });

  test('generates column_has_fk from references edge', async () => {
    const tableId = 'table-1';
    const colId = 'col-1';
    const refTableId = 'table-2';
    const nodes = [
      { id: tableId, node_type: 'table', name: 'orders', metadata: {} },
      { id: colId, node_type: 'column', name: 'customer_id', metadata: { table: 'orders' } },
      { id: refTableId, node_type: 'table', name: 'customers', metadata: {} }
    ];
    const edges = [
      { from_id: tableId, to_id: colId, rel_type: 'contains', metadata: {} },
      { from_id: colId, to_id: refTableId, rel_type: 'references', metadata: {} }
    ];
    const pool = createMockPool(nodes, edges);
    const result = await generateGraphAssertions(pool, 'test_db');

    // orders table
    const ordersObj = result.find(o => o.name === 'orders');
    expect(ordersObj).toBeDefined();
    const fkPred = ordersObj.assertions.find(a => a.predicate.type === 'column_has_fk');
    expect(fkPred).toBeDefined();
    expect(fkPred.predicate.references_table).toBe('customers');
  });

  test('skips column_nullable when nullable is undefined', async () => {
    const tableId = 'table-1';
    const colId = 'col-1';
    const nodes = [
      { id: tableId, node_type: 'table', name: 'items', metadata: {} },
      { id: colId, node_type: 'column', name: 'name', metadata: { table: 'items' } }
    ];
    const edges = [
      { from_id: tableId, to_id: colId, rel_type: 'contains', metadata: {} }
    ];
    const pool = createMockPool(nodes, edges);
    const result = await generateGraphAssertions(pool, 'test_db');

    const assertions = result[0].assertions;
    expect(assertions.some(a => a.predicate.type === 'column_nullable')).toBe(false);
    expect(assertions.some(a => a.predicate.type === 'table_has_column')).toBe(true);
  });
});

// ============================================================
// Form/Report node assertions
// ============================================================

describe('generateGraphAssertions — forms/reports', () => {
  test('generates form_record_source_matches from bound_to edge', async () => {
    const formId = 'form-1';
    const tableId = 'table-1';
    const nodes = [
      { id: formId, node_type: 'form', name: 'OrderForm', metadata: { record_source: 'orders', control_count: 2 } },
      { id: tableId, node_type: 'table', name: 'orders', metadata: {} }
    ];
    const edges = [
      { from_id: formId, to_id: tableId, rel_type: 'bound_to', metadata: {} }
    ];
    const pool = createMockPool(nodes, edges);
    const result = await generateGraphAssertions(pool, 'test_db');

    const formObj = result.find(o => o.name === 'OrderForm');
    expect(formObj).toBeDefined();
    expect(formObj.type).toBe('form');
    const rsPred = formObj.assertions.find(a => a.predicate.type === 'form_record_source_matches');
    expect(rsPred).toBeDefined();
    expect(rsPred.predicate.table).toBe('orders');
  });

  test('generates definition_has_control + control_field_matches from contains+bound_to', async () => {
    const formId = 'form-1';
    const ctrlId = 'ctrl-1';
    const colId = 'col-1';
    const nodes = [
      { id: formId, node_type: 'form', name: 'OrderForm', metadata: {} },
      { id: ctrlId, node_type: 'control', name: 'txtOrderID', metadata: { form: 'OrderForm', control_type: 'text-box', binding: 'order_id' } },
      { id: colId, node_type: 'column', name: 'order_id', metadata: { table: 'orders' } }
    ];
    const edges = [
      { from_id: formId, to_id: ctrlId, rel_type: 'contains', metadata: {} },
      { from_id: ctrlId, to_id: colId, rel_type: 'bound_to', metadata: {} }
    ];
    const pool = createMockPool(nodes, edges);
    const result = await generateGraphAssertions(pool, 'test_db');

    const formObj = result.find(o => o.name === 'OrderForm');
    const preds = formObj.assertions.map(a => a.predicate.type);
    expect(preds).toContain('definition_has_control');
    expect(preds).toContain('control_field_matches');

    const bindPred = formObj.assertions.find(a => a.predicate.type === 'control_field_matches');
    expect(bindPred.predicate.column).toBe('order_id');
    expect(bindPred.predicate.control_name).toBe('txtOrderID');
  });

  test('report node (metadata.object_type=report) produces type=report', async () => {
    const reportId = 'report-1';
    const ctrlId = 'ctrl-1';
    const nodes = [
      { id: reportId, node_type: 'form', name: 'SalesReport', metadata: { object_type: 'report', record_source: 'sales' } },
      { id: ctrlId, node_type: 'control', name: 'txtTotal', metadata: { form: 'SalesReport', binding: 'total' } }
    ];
    const edges = [
      { from_id: reportId, to_id: ctrlId, rel_type: 'contains', metadata: {} }
    ];
    const pool = createMockPool(nodes, edges);
    const result = await generateGraphAssertions(pool, 'test_db');

    const reportObj = result.find(o => o.name === 'SalesReport');
    expect(reportObj).toBeDefined();
    expect(reportObj.type).toBe('report');
    expect(reportObj.intent_type).toBe('graph');
  });

  test('form with no edges produces no assertions', async () => {
    const formId = 'form-1';
    const nodes = [
      { id: formId, node_type: 'form', name: 'EmptyForm', metadata: {} }
    ];
    const edges = [];
    const pool = createMockPool(nodes, edges);
    const result = await generateGraphAssertions(pool, 'test_db');

    // No assertions for this form (no bound_to, no controls)
    const formObj = result.find(o => o.name === 'EmptyForm');
    expect(formObj).toBeUndefined();
  });
});

// ============================================================
// Query node assertions
// ============================================================

describe('generateGraphAssertions — queries', () => {
  test('generates query_references_table from references edge', async () => {
    const queryId = 'query-1';
    const tableId = 'table-1';
    const nodes = [
      { id: queryId, node_type: 'query', name: 'order_details_view', metadata: { pgObjectType: 'view' } },
      { id: tableId, node_type: 'table', name: 'order_details', metadata: {} }
    ];
    const edges = [
      { from_id: queryId, to_id: tableId, rel_type: 'references', metadata: {} }
    ];
    const pool = createMockPool(nodes, edges);
    const result = await generateGraphAssertions(pool, 'test_db');

    const queryObj = result.find(o => o.name === 'order_details_view');
    expect(queryObj).toBeDefined();
    expect(queryObj.type).toBe('query');
    const refPred = queryObj.assertions.find(a => a.predicate.type === 'query_references_table');
    expect(refPred.predicate.table).toBe('order_details');
  });

  test('generates query_object_type from metadata', async () => {
    const queryId = 'query-1';
    const nodes = [
      { id: queryId, node_type: 'query', name: 'get_total', metadata: { pgObjectType: 'function' } }
    ];
    const edges = [];
    const pool = createMockPool(nodes, edges);
    const result = await generateGraphAssertions(pool, 'test_db');

    const queryObj = result.find(o => o.name === 'get_total');
    expect(queryObj).toBeDefined();
    const typePred = queryObj.assertions.find(a => a.predicate.type === 'query_object_type');
    expect(typePred.predicate.expected_type).toBe('function');
  });

  test('query with no edges and no pgObjectType returns empty', async () => {
    const queryId = 'query-1';
    const nodes = [
      { id: queryId, node_type: 'query', name: 'bare_query', metadata: {} }
    ];
    const edges = [];
    const pool = createMockPool(nodes, edges);
    const result = await generateGraphAssertions(pool, 'test_db');

    const queryObj = result.find(o => o.name === 'bare_query');
    expect(queryObj).toBeUndefined();
  });
});

// ============================================================
// Module node assertions
// ============================================================

describe('generateGraphAssertions — modules', () => {
  test('generates module_has_vba + module_handler_count', async () => {
    const modId = 'mod-1';
    const nodes = [
      { id: modId, node_type: 'module', name: 'Module_Utils', metadata: { has_vba: true, handler_count: 5 } }
    ];
    const edges = [];
    const pool = createMockPool(nodes, edges);
    const result = await generateGraphAssertions(pool, 'test_db');

    const modObj = result.find(o => o.name === 'Module_Utils');
    expect(modObj).toBeDefined();
    expect(modObj.type).toBe('module');
    expect(modObj.intent_type).toBe('graph');

    const vbaPred = modObj.assertions.find(a => a.predicate.type === 'module_has_vba');
    expect(vbaPred.predicate.expected).toBe(true);

    const countPred = modObj.assertions.find(a => a.predicate.type === 'module_handler_count');
    expect(countPred.predicate.expected_count).toBe(5);
  });

  test('module with handler_count=0 still generates assertion', async () => {
    const modId = 'mod-1';
    const nodes = [
      { id: modId, node_type: 'module', name: 'EmptyModule', metadata: { has_vba: false, handler_count: 0 } }
    ];
    const edges = [];
    const pool = createMockPool(nodes, edges);
    const result = await generateGraphAssertions(pool, 'test_db');

    const modObj = result.find(o => o.name === 'EmptyModule');
    expect(modObj).toBeDefined();
    const vbaPred = modObj.assertions.find(a => a.predicate.type === 'module_has_vba');
    expect(vbaPred.predicate.expected).toBe(false);
  });
});

// ============================================================
// Macro node assertions
// ============================================================

describe('generateGraphAssertions — macros', () => {
  test('generates macro_has_xml', async () => {
    const macId = 'mac-1';
    const nodes = [
      { id: macId, node_type: 'macro', name: 'AutoExec', metadata: { has_xml: true } }
    ];
    const edges = [];
    const pool = createMockPool(nodes, edges);
    const result = await generateGraphAssertions(pool, 'test_db');

    const macObj = result.find(o => o.name === 'AutoExec');
    expect(macObj).toBeDefined();
    expect(macObj.type).toBe('macro');
    expect(macObj.intent_type).toBe('graph');

    const xmlPred = macObj.assertions.find(a => a.predicate.type === 'macro_has_xml');
    expect(xmlPred.predicate.expected).toBe(true);
  });

  test('macro with has_xml=false', async () => {
    const macId = 'mac-1';
    const nodes = [
      { id: macId, node_type: 'macro', name: 'EmptyMacro', metadata: { has_xml: false } }
    ];
    const edges = [];
    const pool = createMockPool(nodes, edges);
    const result = await generateGraphAssertions(pool, 'test_db');

    const macObj = result.find(o => o.name === 'EmptyMacro');
    expect(macObj).toBeDefined();
    const xmlPred = macObj.assertions.find(a => a.predicate.type === 'macro_has_xml');
    expect(xmlPred.predicate.expected).toBe(false);
  });
});

// ============================================================
// Edge cases
// ============================================================

describe('generateGraphAssertions — edge cases', () => {
  test('empty graph returns empty array', async () => {
    const pool = createMockPool([], []);
    const result = await generateGraphAssertions(pool, 'test_db');
    expect(result).toEqual([]);
  });

  test('string metadata is parsed', async () => {
    const modId = 'mod-1';
    const nodes = [
      { id: modId, node_type: 'module', name: 'Mod1', metadata: JSON.stringify({ has_vba: true, handler_count: 3 }) }
    ];
    const edges = [];
    const pool = createMockPool(nodes, edges);
    const result = await generateGraphAssertions(pool, 'test_db');

    const modObj = result.find(o => o.name === 'Mod1');
    expect(modObj).toBeDefined();
    expect(modObj.assertions).toHaveLength(2);
  });

  test('all assertion ids are unique', async () => {
    const nodes = [
      { id: 't1', node_type: 'table', name: 'users', metadata: {} },
      { id: 'c1', node_type: 'column', name: 'id', metadata: { table: 'users', nullable: false } },
      { id: 'c2', node_type: 'column', name: 'name', metadata: { table: 'users', nullable: true } },
      { id: 'f1', node_type: 'form', name: 'UserForm', metadata: {} },
      { id: 'ct1', node_type: 'control', name: 'txtId', metadata: { form: 'UserForm', binding: 'id' } },
      { id: 'q1', node_type: 'query', name: 'user_view', metadata: { pgObjectType: 'view' } },
      { id: 'm1', node_type: 'module', name: 'Mod1', metadata: { has_vba: true, handler_count: 1 } },
      { id: 'mc1', node_type: 'macro', name: 'Mac1', metadata: { has_xml: true } }
    ];
    const edges = [
      { from_id: 't1', to_id: 'c1', rel_type: 'contains', metadata: {} },
      { from_id: 't1', to_id: 'c2', rel_type: 'contains', metadata: {} },
      { from_id: 'f1', to_id: 'ct1', rel_type: 'contains', metadata: {} },
      { from_id: 'ct1', to_id: 'c1', rel_type: 'bound_to', metadata: {} },
      { from_id: 'q1', to_id: 't1', rel_type: 'references', metadata: {} }
    ];
    const pool = createMockPool(nodes, edges);
    const result = await generateGraphAssertions(pool, 'test_db');

    const allIds = result.flatMap(o => o.assertions.map(a => a.id));
    const uniqueIds = new Set(allIds);
    expect(uniqueIds.size).toBe(allIds.length);
  });
});

// ============================================================
// Predicate evaluation — graph predicates
// ============================================================

describe('evaluatePredicate — graph predicates', () => {
  test('form_record_source_matches passes on match', () => {
    const context = { definition: { 'record-source': 'Orders' } };
    expect(evaluatePredicate({ type: 'form_record_source_matches', table: 'orders' }, context)).toBe(true);
  });

  test('form_record_source_matches fails on mismatch', () => {
    const context = { definition: { 'record-source': 'Products' } };
    expect(evaluatePredicate({ type: 'form_record_source_matches', table: 'orders' }, context)).toBe(false);
  });

  test('control_field_matches passes when binding matches', () => {
    const context = {
      definition: {
        detail: { controls: [{ name: 'txtName', field: 'customer_name' }] }
      }
    };
    expect(evaluatePredicate({ type: 'control_field_matches', control_name: 'txtName', column: 'customer_name' }, context)).toBe(true);
  });

  test('control_field_matches fails when binding differs', () => {
    const context = {
      definition: {
        detail: { controls: [{ name: 'txtName', field: 'company_name' }] }
      }
    };
    expect(evaluatePredicate({ type: 'control_field_matches', control_name: 'txtName', column: 'customer_name' }, context)).toBe(false);
  });

  test('query_references_table passes when dep includes table', () => {
    const context = { queryDependencies: ['orders', 'customers'] };
    expect(evaluatePredicate({ type: 'query_references_table', table: 'orders' }, context)).toBe(true);
  });

  test('query_references_table returns true when no dependency data', () => {
    const context = { queryDependencies: null };
    expect(evaluatePredicate({ type: 'query_references_table', table: 'orders' }, context)).toBe(true);
  });

  test('query_object_type passes on match', () => {
    const context = { queryType: 'view' };
    expect(evaluatePredicate({ type: 'query_object_type', expected_type: 'view' }, context)).toBe(true);
  });

  test('query_object_type fails on mismatch', () => {
    const context = { queryType: 'function' };
    expect(evaluatePredicate({ type: 'query_object_type', expected_type: 'view' }, context)).toBe(false);
  });

  test('module_has_vba passes when definition has vba_source', () => {
    const context = { definition: { vba_source: 'Sub Test()\nEnd Sub' } };
    expect(evaluatePredicate({ type: 'module_has_vba', expected: true }, context)).toBe(true);
  });

  test('module_has_vba fails when definition lacks vba_source', () => {
    const context = { definition: {} };
    expect(evaluatePredicate({ type: 'module_has_vba', expected: true }, context)).toBe(false);
  });

  test('module_handler_count passes on exact match', () => {
    const context = { definition: { js_handlers: [{ key: 'a' }, { key: 'b' }] } };
    expect(evaluatePredicate({ type: 'module_handler_count', expected_count: 2 }, context)).toBe(true);
  });

  test('module_handler_count fails on mismatch', () => {
    const context = { definition: { js_handlers: [{ key: 'a' }] } };
    expect(evaluatePredicate({ type: 'module_handler_count', expected_count: 5 }, context)).toBe(false);
  });

  test('macro_has_xml passes when definition has macro_xml', () => {
    const context = { definition: { macro_xml: '<xml>data</xml>' } };
    expect(evaluatePredicate({ type: 'macro_has_xml', expected: true }, context)).toBe(true);
  });

  test('macro_has_xml handles wrapped value', () => {
    const context = { definition: { macro_xml: { value: '<xml>data</xml>' } } };
    expect(evaluatePredicate({ type: 'macro_has_xml', expected: true }, context)).toBe(true);
  });

  test('macro_has_xml false when no xml', () => {
    const context = { definition: {} };
    expect(evaluatePredicate({ type: 'macro_has_xml', expected: false }, context)).toBe(true);
  });
});
