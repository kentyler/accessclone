const {
  toClojureName,
  escapeCljs,
  generateIntentCljs,
  generateMechanical,
  generateNamespace,
  generateProcedure,
  generateEventHandlers,
  collectRequires
} = require('../lib/vba-wiring-generator');

// ============================================================
// toClojureName
// ============================================================

describe('toClojureName', () => {
  test('converts underscores to hyphens', () => {
    expect(toClojureName('btnSave_Click')).toBe('btn-save-click');
  });

  test('converts camelCase to kebab-case', () => {
    expect(toClojureName('CustomerID')).toBe('customer-id');
  });

  test('handles Form_Load', () => {
    expect(toClojureName('Form_Load')).toBe('form-load');
  });

  test('handles simple lowercase', () => {
    expect(toClojureName('save')).toBe('save');
  });
});

// ============================================================
// escapeCljs
// ============================================================

describe('escapeCljs', () => {
  test('escapes double quotes', () => {
    expect(escapeCljs('say "hello"')).toBe('say \\"hello\\"');
  });

  test('escapes backslashes', () => {
    expect(escapeCljs('path\\to\\file')).toBe('path\\\\to\\\\file');
  });

  test('handles null/empty', () => {
    expect(escapeCljs(null)).toBe('');
    expect(escapeCljs('')).toBe('');
  });
});

// ============================================================
// generateIntentCljs — individual templates
// ============================================================

describe('generateIntentCljs', () => {
  test('open-form', () => {
    const cljs = generateIntentCljs({ type: 'open-form', form: 'Orders' }, 2);
    expect(cljs).toContain('open-object!');
    expect(cljs).toContain(':forms');
    expect(cljs).toContain('"Orders"');
  });

  test('close-current', () => {
    const cljs = generateIntentCljs({ type: 'close-current' }, 2);
    expect(cljs).toContain('close-tab!');
    expect(cljs).toContain('active-tab');
  });

  test('save-record', () => {
    const cljs = generateIntentCljs({ type: 'save-record' }, 2);
    expect(cljs).toContain('save-current-record!');
  });

  test('delete-record', () => {
    const cljs = generateIntentCljs({ type: 'delete-record' }, 2);
    expect(cljs).toContain('delete-current-record!');
  });

  test('new-record', () => {
    const cljs = generateIntentCljs({ type: 'new-record' }, 2);
    expect(cljs).toContain(':new-record');
  });

  test('show-message', () => {
    const cljs = generateIntentCljs({ type: 'show-message', message: 'Done!' }, 2);
    expect(cljs).toContain('js/alert');
    expect(cljs).toContain('"Done!"');
  });

  test('validate-required', () => {
    const cljs = generateIntentCljs({
      type: 'validate-required',
      field: 'CompanyName',
      message: 'Company is required'
    }, 2);
    expect(cljs).toContain('nil?');
    expect(cljs).toContain(':company-name');
    expect(cljs).toContain('js/alert');
  });

  test('confirm-action with then and else', () => {
    const cljs = generateIntentCljs({
      type: 'confirm-action',
      message: 'Delete?',
      then: [{ type: 'delete-record' }],
      else: [{ type: 'show-message', message: 'Cancelled' }]
    }, 2);
    expect(cljs).toContain('js/confirm');
    expect(cljs).toContain('"Delete?"');
    expect(cljs).toContain('delete-current-record!');
    expect(cljs).toContain('Cancelled');
  });

  test('confirm-action without else', () => {
    const cljs = generateIntentCljs({
      type: 'confirm-action',
      message: 'Sure?',
      then: [{ type: 'save-record' }]
    }, 2);
    expect(cljs).toContain('when');
    expect(cljs).toContain('js/confirm');
  });

  test('branch with else', () => {
    const cljs = generateIntentCljs({
      type: 'branch',
      condition: '(> x 0)',
      then: [{ type: 'show-message', message: 'positive' }],
      else: [{ type: 'show-message', message: 'negative' }]
    }, 2);
    expect(cljs).toContain('(if (> x 0)');
    expect(cljs).toContain('positive');
    expect(cljs).toContain('negative');
  });

  test('branch without else uses when', () => {
    const cljs = generateIntentCljs({
      type: 'branch',
      condition: '(> x 0)',
      then: [{ type: 'show-message', message: 'positive' }]
    }, 2);
    expect(cljs).toContain('(when (> x 0)');
  });

  test('gap produces UNMAPPED comment', () => {
    const cljs = generateIntentCljs({
      type: 'gap',
      vba_line: 'Set rst = CurrentDb.OpenRecordset("q")',
      reason: 'DAO recordset'
    }, 2);
    expect(cljs).toContain(';; UNMAPPED:');
  });

  test('resolved gap produces GAP RESOLVED comment', () => {
    const cljs = generateIntentCljs({
      type: 'gap',
      vba_line: 'DoCmd.TransferSpreadsheet acExport, ...',
      reason: 'Excel export',
      resolution: {
        answer: 'Download as CSV file',
        custom_notes: 'Use existing /api/data endpoint',
        resolved_at: '2026-02-17T15:30:00Z',
        resolved_by: 'user'
      }
    }, 2);
    expect(cljs).toContain(';; GAP RESOLVED:');
    expect(cljs).toContain('User decision: Download as CSV file');
    expect(cljs).toContain('Notes: Use existing /api/data endpoint');
    expect(cljs).toContain('TODO: Implement');
  });

  test('resolved gap without custom_notes omits Notes line', () => {
    const cljs = generateIntentCljs({
      type: 'gap',
      vba_line: 'DoCmd.OutputTo ...',
      reason: 'PDF export',
      resolution: {
        answer: 'Skip this functionality',
        custom_notes: null,
        resolved_at: '2026-02-17T15:30:00Z',
        resolved_by: 'user'
      }
    }, 2);
    expect(cljs).toContain(';; GAP RESOLVED:');
    expect(cljs).toContain('User decision: Skip this functionality');
    expect(cljs).not.toContain('Notes:');
  });

  test('dlookup produces NEEDS LLM comment', () => {
    const cljs = generateIntentCljs({
      type: 'dlookup',
      field: 'CompanyName',
      table: 'Customers',
      criteria: 'CustomerID=1'
    }, 2);
    expect(cljs).toContain(';; NEEDS LLM:');
    expect(cljs).toContain('DLookup');
  });

  test('error-handler wraps in try/catch', () => {
    const cljs = generateIntentCljs({
      type: 'error-handler',
      label: 'ErrHandler',
      children: [{ type: 'save-record' }]
    }, 2);
    expect(cljs).toContain('(try');
    expect(cljs).toContain('(catch js/Error');
    expect(cljs).toContain('save-current-record!');
  });

  test('write-field', () => {
    const cljs = generateIntentCljs({
      type: 'write-field',
      field: 'OrderDate',
      value: '(js/Date.)'
    }, 2);
    expect(cljs).toContain('assoc-in');
    expect(cljs).toContain(':order-date');
  });

  test('set-tempvar', () => {
    const cljs = generateIntentCljs({
      type: 'set-tempvar',
      name: 'CurrentUser',
      value: '"admin"'
    }, 2);
    expect(cljs).toContain('sync-form-state!');
    expect(cljs).toContain('_tempvars');
    expect(cljs).toContain('CurrentUser');
  });
});

// ============================================================
// generateMechanical
// ============================================================

describe('generateMechanical', () => {
  test('generates complete module for simple procedures', () => {
    const mapped = {
      procedures: [
        {
          name: 'btnSave_Click',
          trigger: 'on-click',
          intents: [
            { type: 'save-record', classification: 'mechanical', mapping: { type: 'flow', target: 'save-current-record-flow' } }
          ],
          stats: { mechanical: 1, llm_fallback: 0, gap: 0, total: 1 }
        },
        {
          name: 'btnClose_Click',
          trigger: 'on-click',
          intents: [
            { type: 'close-current', classification: 'mechanical', mapping: { type: 'flow', target: 'close-current-tab-flow' } }
          ],
          stats: { mechanical: 1, llm_fallback: 0, gap: 0, total: 1 }
        }
      ],
      unmapped: [],
      warnings: []
    };

    const result = generateMechanical(mapped, 'TestModule');
    expect(result.cljs_source).toContain('(ns app.modules.test-module');
    expect(result.cljs_source).toContain('(defn btn-save-click');
    expect(result.cljs_source).toContain('(defn btn-close-click');
    expect(result.cljs_source).toContain('event-handlers');
    expect(result.fallback_procedures).toEqual([]);
  });

  test('identifies fallback procedures', () => {
    const mapped = {
      procedures: [{
        name: 'Form_Load',
        trigger: 'on-load',
        intents: [
          { type: 'dlookup', classification: 'llm-fallback', field: 'Name', table: 'T', criteria: 'id=1' }
        ],
        stats: { mechanical: 0, llm_fallback: 1, gap: 0, total: 1 }
      }],
      unmapped: [],
      warnings: []
    };

    const result = generateMechanical(mapped, 'MyModule');
    expect(result.fallback_procedures).toEqual(['Form_Load']);
    expect(result.cljs_source).toContain(';; NEEDS LLM:');
  });

  test('handles empty input', () => {
    const result = generateMechanical(null, 'Empty');
    expect(result.cljs_source).toBe('');
    expect(result.fallback_procedures).toEqual([]);
  });
});

// ============================================================
// generateNamespace
// ============================================================

describe('generateNamespace', () => {
  test('includes state-form when needed', () => {
    const ns = generateNamespace('Orders', { state: true, 'state-form': true, transforms: false });
    expect(ns).toContain('app.modules.orders');
    expect(ns).toContain('app.state-form');
    expect(ns).toContain('app.state');
  });

  test('includes transforms when needed', () => {
    const ns = generateNamespace('Orders', { state: true, 'state-form': false, transforms: true });
    expect(ns).toContain('app.transforms.core');
  });

  test('always includes state', () => {
    const ns = generateNamespace('Test', { state: false, 'state-form': false, transforms: false });
    expect(ns).toContain('app.state');
  });
});

// ============================================================
// generateEventHandlers
// ============================================================

describe('generateEventHandlers', () => {
  test('maps triggered procedures', () => {
    const procs = [
      { name: 'btnSave_Click', trigger: 'on-click', intents: [] },
      { name: 'Form_Load', trigger: 'on-load', intents: [] },
      { name: 'HelperFunction', trigger: null, intents: [] }
    ];
    const result = generateEventHandlers(procs);
    expect(result).toContain('"btnSave.on-click"');
    expect(result).toContain('"Form.on-load"');
    expect(result).not.toContain('HelperFunction');
  });

  test('returns empty string when no triggers', () => {
    const result = generateEventHandlers([{ name: 'Helper', trigger: null, intents: [] }]);
    expect(result).toBe('');
  });
});

// ============================================================
// collectRequires
// ============================================================

describe('collectRequires', () => {
  test('detects state needs from open-form', () => {
    const needs = collectRequires([{ intents: [{ type: 'open-form' }] }]);
    expect(needs.state).toBe(true);
  });

  test('detects state-form needs from save-record', () => {
    const needs = collectRequires([{ intents: [{ type: 'save-record' }] }]);
    expect(needs['state-form']).toBe(true);
  });

  test('detects transforms needs from update-control', () => {
    const needs = collectRequires([{ intents: [{ type: 'set-control-visible' }] }]);
    expect(needs.transforms).toBe(true);
  });

  test('scans nested children', () => {
    const needs = collectRequires([{
      intents: [{
        type: 'branch',
        then: [{ type: 'save-record' }],
        else: [{ type: 'open-form' }]
      }]
    }]);
    expect(needs['state-form']).toBe(true);
    expect(needs.state).toBe(true);
  });
});
