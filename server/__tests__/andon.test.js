const { computeHeterogeneity } = require('../lib/test-harness/locked-test-runner');
const { generateGestureAssertions } = require('../lib/test-harness/generate-locked-tests');
const { generateStructureAssertions } = require('../lib/test-harness/structure-test-templates');
const { generateBusinessAssertions } = require('../lib/test-harness/business-test-templates');
const { generateSchemaAssertions } = require('../lib/test-harness/schema-test-templates');

// ============================================================
// Heterogeneity computation
// ============================================================

describe('computeHeterogeneity', () => {
  test('returns 0 for no failures', () => {
    expect(computeHeterogeneity({ boundary: 0, transduction: 0, resolution: 0, trace: 0 })).toBe(0);
  });

  test('returns 0 for single-category failures', () => {
    expect(computeHeterogeneity({ boundary: 5, transduction: 0, resolution: 0, trace: 0 })).toBe(0);
  });

  test('returns 1.0 for uniform distribution across all 4 categories', () => {
    const result = computeHeterogeneity({ boundary: 3, transduction: 3, resolution: 3, trace: 3 });
    expect(result).toBeCloseTo(1.0, 5);
  });

  test('returns moderate value for partial distribution', () => {
    const result = computeHeterogeneity({ boundary: 5, transduction: 5, resolution: 0, trace: 0 });
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThan(1);
    expect(result).toBeCloseTo(0.5, 5); // 2 equal categories out of 4 → entropy/log2(4)
  });

  test('returns higher value for more spread out failures', () => {
    const twoCategory = computeHeterogeneity({ boundary: 10, transduction: 10, resolution: 0, trace: 0 });
    const threeCategory = computeHeterogeneity({ boundary: 10, transduction: 10, resolution: 10, trace: 0 });
    expect(threeCategory).toBeGreaterThan(twoCategory);
  });
});

// ============================================================
// Test template generators
// ============================================================

describe('generateGestureAssertions', () => {
  test('generates handler_no_throw + intent-based assertions', () => {
    const gestureData = {
      procedures: [{
        procedure: 'btnSave_Click',
        intents: [
          { type: 'save-record', params: {} },
          { type: 'close-current', params: {} }
        ]
      }]
    };

    const assertions = generateGestureAssertions('module', 'Form_frmTest', gestureData);
    expect(assertions.length).toBeGreaterThanOrEqual(2);

    // Should have a no-throw assertion
    const noThrow = assertions.find(a => a.predicate.type === 'handler_no_throw');
    expect(noThrow).toBeDefined();
    expect(noThrow.predicate.handler_key).toBe('evt.btnSave_Click');

    // Should have method call assertions
    const methodCalls = assertions.filter(a =>
      a.predicate.type === 'handler_calls_method' || a.predicate.type === 'handler_calls_with_args'
    );
    expect(methodCalls.length).toBeGreaterThan(0);
  });

  test('returns empty for no procedures', () => {
    expect(generateGestureAssertions('module', 'Empty', { procedures: [] })).toEqual([]);
  });
});

describe('generateStructureAssertions', () => {
  test('generates section assertions for forms', () => {
    const intent = {
      pattern: 'data-entry',
      layout: { sections_used: ['header', 'detail', 'footer'] },
      record_interaction: { mode: 'single-record' },
      subpatterns: []
    };

    const assertions = generateStructureAssertions('form', 'frmTest', intent);
    expect(assertions.length).toBeGreaterThanOrEqual(3);

    const sectionAssertions = assertions.filter(a => a.predicate.type === 'definition_has_section');
    expect(sectionAssertions).toHaveLength(3);
  });

  test('generates band assertions for reports', () => {
    const intent = {
      pattern: 'tabular-list',
      layout: {
        bands_used: ['page-header', 'detail', 'page-footer'],
        grouping_fields: ['CategoryID']
      },
      navigation: { subreports: [] }
    };

    const assertions = generateStructureAssertions('report', 'rptTest', intent);
    const bandAssertions = assertions.filter(a => a.predicate.type === 'has_band');
    expect(bandAssertions).toHaveLength(3);

    const groupAssertions = assertions.filter(a => a.predicate.type === 'grouping_uses_field');
    expect(groupAssertions).toHaveLength(1);
  });

  test('generates record source assertion', () => {
    const intent = {
      pattern: 'data-entry',
      layout: { sections_used: ['detail'] },
      record_interaction: { mode: 'single-record' },
      subpatterns: []
    };

    const assertions = generateStructureAssertions('form', 'frmTest', intent);
    const rsAssertion = assertions.find(a => a.predicate.type === 'definition_has_record_source');
    expect(rsAssertion).toBeDefined();
  });

  test('generates unbound assertion', () => {
    const intent = {
      pattern: 'switchboard',
      layout: { sections_used: ['detail'] },
      record_interaction: { mode: 'unbound' },
      subpatterns: []
    };

    const assertions = generateStructureAssertions('form', 'frmNav', intent);
    const noRsAssertion = assertions.find(a => a.predicate.type === 'definition_has_no_record_source');
    expect(noRsAssertion).toBeDefined();
  });
});

describe('generateBusinessAssertions', () => {
  test('generates entity reference assertions', () => {
    const intent = {
      category: 'data-entry',
      entities: ['employees', 'departments'],
      data_flows: [{ direction: 'both', target: 'employees', via: 'record-source' }],
      workflows: ['Add new employee']
    };

    const assertions = generateBusinessAssertions('form', 'frmEmployees', intent);
    const entityAssertions = assertions.filter(a => a.predicate.type === 'entity_referenced');
    // entities (2) + data_flows (1)
    expect(entityAssertions.length).toBeGreaterThanOrEqual(2);
  });

  test('generates category assertion', () => {
    const intent = { category: 'search', entities: [] };
    const assertions = generateBusinessAssertions('form', 'frmSearch', intent);
    const catAssertion = assertions.find(a => a.predicate.type === 'category_matches_evidence');
    expect(catAssertion).toBeDefined();
    expect(catAssertion.predicate.category).toBe('search');
  });
});

describe('generateSchemaAssertions', () => {
  test('generates column + nullable assertions', () => {
    const snapshot = {
      columns: [
        { name: 'id', type: 'integer', nullable: false, default: "nextval('seq')" },
        { name: 'name', type: 'character varying', nullable: true, default: null }
      ],
      foreignKeys: [{ column: 'dept_id', references_table: 'departments', references_column: 'id' }],
      checkConstraints: []
    };

    const assertions = generateSchemaAssertions('employees', snapshot);

    // 2 columns × 2 (has_column + nullable) + 1 default + 1 FK = 6
    const colAssertions = assertions.filter(a => a.predicate.type === 'table_has_column');
    expect(colAssertions).toHaveLength(2);

    const nullableAssertions = assertions.filter(a => a.predicate.type === 'column_nullable');
    expect(nullableAssertions).toHaveLength(2);

    const fkAssertions = assertions.filter(a => a.predicate.type === 'column_has_fk');
    expect(fkAssertions).toHaveLength(1);
    expect(fkAssertions[0].predicate.references_table).toBe('departments');

    const defaultAssertions = assertions.filter(a => a.predicate.type === 'column_has_default');
    expect(defaultAssertions).toHaveLength(1);
  });

  test('returns empty for null snapshot', () => {
    expect(generateSchemaAssertions('table', null)).toEqual([]);
  });
});
