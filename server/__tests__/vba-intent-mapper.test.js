const {
  INTENT_VOCABULARY,
  MECHANICAL_INTENTS,
  LLM_FALLBACK_INTENTS,
  classifyIntent,
  mapSingleIntent,
  mapIntentsToTransforms,
  countClassifications,
  assignGapIds
} = require('../lib/vba-intent-mapper');

// ============================================================
// classifyIntent
// ============================================================

describe('classifyIntent', () => {
  test('mechanical intents classified correctly', () => {
    expect(classifyIntent({ type: 'open-form' })).toBe('mechanical');
    expect(classifyIntent({ type: 'save-record' })).toBe('mechanical');
    expect(classifyIntent({ type: 'show-message' })).toBe('mechanical');
    expect(classifyIntent({ type: 'validate-required' })).toBe('mechanical');
    expect(classifyIntent({ type: 'set-control-visible' })).toBe('mechanical');
    expect(classifyIntent({ type: 'write-field' })).toBe('mechanical');
  });

  test('llm-fallback intents classified correctly', () => {
    expect(classifyIntent({ type: 'dlookup' })).toBe('llm-fallback');
    expect(classifyIntent({ type: 'dcount' })).toBe('llm-fallback');
    expect(classifyIntent({ type: 'dsum' })).toBe('llm-fallback');
    expect(classifyIntent({ type: 'run-sql' })).toBe('llm-fallback');
    expect(classifyIntent({ type: 'loop' })).toBe('llm-fallback');
  });

  test('gap intents classified correctly', () => {
    expect(classifyIntent({ type: 'gap' })).toBe('gap');
    expect(classifyIntent({ type: 'totally-unknown' })).toBe('gap');
    expect(classifyIntent(null)).toBe('gap');
    expect(classifyIntent({})).toBe('gap');
  });

  test('branch with mechanical children is mechanical', () => {
    expect(classifyIntent({
      type: 'branch',
      then: [{ type: 'show-message' }],
      else: [{ type: 'open-form' }]
    })).toBe('mechanical');
  });

  test('branch with llm-fallback child is llm-fallback', () => {
    expect(classifyIntent({
      type: 'branch',
      then: [{ type: 'show-message' }, { type: 'dlookup' }]
    })).toBe('llm-fallback');
  });

  test('branch with gap child is gap', () => {
    expect(classifyIntent({
      type: 'branch',
      then: [{ type: 'show-message' }, { type: 'gap' }]
    })).toBe('gap');
  });

  test('empty branch is mechanical', () => {
    expect(classifyIntent({ type: 'branch', then: [], else: [] })).toBe('mechanical');
  });

  test('error-handler with children classifies by children', () => {
    expect(classifyIntent({
      type: 'error-handler',
      children: [{ type: 'save-record' }]
    })).toBe('mechanical');
  });
});

// ============================================================
// mapSingleIntent
// ============================================================

describe('mapSingleIntent', () => {
  test('maps known intent to its target', () => {
    const result = mapSingleIntent({ type: 'open-form', form: 'Orders' });
    expect(result.classification).toBe('mechanical');
    expect(result.mapping.type).toBe('flow');
    expect(result.mapping.target).toBe('open-object-flow');
    expect(result.form).toBe('Orders');
  });

  test('maps transform intent', () => {
    const result = mapSingleIntent({ type: 'new-record' });
    expect(result.mapping.type).toBe('transform');
    expect(result.mapping.target).toBe('new-record');
  });

  test('maps unknown intent as gap with warning', () => {
    const result = mapSingleIntent({ type: 'some-future-intent' });
    expect(result.classification).toBe('gap');
    expect(result.mapping).toBeNull();
    expect(result.warning).toContain('Unknown intent type');
  });

  test('recursively maps branch children', () => {
    const result = mapSingleIntent({
      type: 'branch',
      condition: 'x > 0',
      then: [{ type: 'show-message', message: 'positive' }],
      else: [{ type: 'show-message', message: 'non-positive' }]
    });
    expect(result.then).toHaveLength(1);
    expect(result.then[0].mapping.target).toBe('js/alert');
    expect(result.else).toHaveLength(1);
    expect(result.else[0].mapping.target).toBe('js/alert');
  });

  test('recursively maps loop children', () => {
    const result = mapSingleIntent({
      type: 'loop',
      children: [{ type: 'save-record' }]
    });
    expect(result.children).toHaveLength(1);
    expect(result.children[0].mapping.target).toBe('save-current-record-flow');
  });
});

// ============================================================
// mapIntentsToTransforms
// ============================================================

describe('mapIntentsToTransforms', () => {
  test('maps a simple procedure', () => {
    const intentResult = {
      procedures: [{
        name: 'btnSave_Click',
        trigger: 'on-click',
        intents: [
          { type: 'validate-required', field: 'CompanyName', message: 'Company is required' },
          { type: 'save-record' }
        ]
      }],
      gaps: []
    };

    const result = mapIntentsToTransforms(intentResult);
    expect(result.procedures).toHaveLength(1);
    expect(result.procedures[0].intents).toHaveLength(2);
    expect(result.procedures[0].stats.mechanical).toBe(2);
    expect(result.procedures[0].stats.gap).toBe(0);
    expect(result.unmapped).toHaveLength(0);
  });

  test('collects unmapped gaps', () => {
    const intentResult = {
      procedures: [{
        name: 'ComplexHandler',
        trigger: 'on-click',
        intents: [
          { type: 'show-message', message: 'Starting...' },
          { type: 'gap', vba_line: 'Set rst = CurrentDb.OpenRecordset(...)', reason: 'DAO recordset manipulation' }
        ]
      }],
      gaps: []
    };

    const result = mapIntentsToTransforms(intentResult);
    expect(result.unmapped).toHaveLength(1);
    expect(result.unmapped[0].procedure).toBe('ComplexHandler');
    expect(result.unmapped[0].gaps).toHaveLength(1);
    expect(result.unmapped[0].gaps[0].reason).toBe('DAO recordset manipulation');
  });

  test('includes module-level gaps', () => {
    const intentResult = {
      procedures: [],
      gaps: [{ procedure: '(module-level)', vba_line: 'Dim db As DAO.Database', reason: 'Module-level variable' }]
    };

    const result = mapIntentsToTransforms(intentResult);
    expect(result.unmapped).toHaveLength(1);
  });

  test('handles null/empty input', () => {
    expect(mapIntentsToTransforms(null).procedures).toEqual([]);
    expect(mapIntentsToTransforms({}).warnings).toHaveLength(1);
  });

  test('stats aggregate correctly across nested intents', () => {
    const intentResult = {
      procedures: [{
        name: 'Form_Load',
        trigger: 'on-load',
        intents: [
          {
            type: 'branch',
            condition: 'IsNull(Me.OrderID)',
            then: [
              { type: 'show-message', message: 'No order' },
              { type: 'close-current' }
            ],
            else: [
              { type: 'dlookup', field: 'CustomerName', table: 'Customers', criteria: 'CustomerID = Me.CustomerID' }
            ]
          }
        ]
      }],
      gaps: []
    };

    const result = mapIntentsToTransforms(intentResult);
    const stats = result.procedures[0].stats;
    // branch itself is llm-fallback (has dlookup child in else)
    // then: show-message (mechanical) + close-current (mechanical)
    // else: dlookup (llm-fallback)
    expect(stats.total).toBeGreaterThan(0);
    expect(stats.llm_fallback).toBeGreaterThanOrEqual(1);
  });
});

// ============================================================
// countClassifications
// ============================================================

describe('countClassifications', () => {
  test('counts flat list', () => {
    const intents = [
      { classification: 'mechanical' },
      { classification: 'mechanical' },
      { classification: 'llm-fallback' },
      { classification: 'gap' }
    ];
    const stats = countClassifications(intents);
    expect(stats).toEqual({ mechanical: 2, llm_fallback: 1, gap: 1, total: 4 });
  });

  test('counts nested children', () => {
    const intents = [
      {
        classification: 'mechanical',
        then: [{ classification: 'mechanical' }],
        else: [{ classification: 'llm-fallback' }]
      }
    ];
    const stats = countClassifications(intents);
    expect(stats.mechanical).toBe(2);
    expect(stats.llm_fallback).toBe(1);
    expect(stats.total).toBe(3);
  });

  test('empty list returns zeros', () => {
    expect(countClassifications([])).toEqual({ mechanical: 0, llm_fallback: 0, gap: 0, total: 0 });
  });
});

// ============================================================
// INTENT_VOCABULARY coverage
// ============================================================

describe('INTENT_VOCABULARY', () => {
  test('all mechanical intents are in vocabulary', () => {
    for (const type of MECHANICAL_INTENTS) {
      expect(INTENT_VOCABULARY[type]).toBeDefined();
    }
  });

  test('all llm-fallback intents are in vocabulary', () => {
    for (const type of LLM_FALLBACK_INTENTS) {
      expect(INTENT_VOCABULARY[type]).toBeDefined();
    }
  });

  test('vocabulary has expected count', () => {
    expect(Object.keys(INTENT_VOCABULARY).length).toBe(30);
  });
});

// ============================================================
// assignGapIds
// ============================================================

describe('assignGapIds', () => {
  test('assigns sequential gap_id to flat list', () => {
    const intents = [
      { type: 'show-message', classification: 'mechanical' },
      { type: 'gap', classification: 'gap', vba_line: 'line1', reason: 'r1' },
      { type: 'save-record', classification: 'mechanical' },
      { type: 'gap', classification: 'gap', vba_line: 'line2', reason: 'r2' }
    ];
    assignGapIds(intents, 'btnExport_Click', 0);
    expect(intents[1].gap_id).toBe('btnExport_Click:0');
    expect(intents[3].gap_id).toBe('btnExport_Click:1');
    // Non-gap intents should not have gap_id
    expect(intents[0].gap_id).toBeUndefined();
    expect(intents[2].gap_id).toBeUndefined();
  });

  test('assigns gap_id recursively in branches', () => {
    const intents = [
      {
        type: 'branch',
        classification: 'gap',
        then: [
          { type: 'gap', classification: 'gap', vba_line: 'then-gap', reason: 'r1' }
        ],
        else: [
          { type: 'gap', classification: 'gap', vba_line: 'else-gap', reason: 'r2' }
        ]
      }
    ];
    const nextIdx = assignGapIds(intents, 'Form_Load', 0);
    expect(intents[0].then[0].gap_id).toBe('Form_Load:0');
    expect(intents[0].else[0].gap_id).toBe('Form_Load:1');
    expect(nextIdx).toBe(2);
  });

  test('assigns gap_id recursively in children (loop/error-handler)', () => {
    const intents = [
      {
        type: 'loop',
        classification: 'gap',
        children: [
          { type: 'gap', classification: 'gap', vba_line: 'child-gap', reason: 'r1' },
          { type: 'show-message', classification: 'mechanical' }
        ]
      }
    ];
    assignGapIds(intents, 'ProcessAll', 0);
    expect(intents[0].children[0].gap_id).toBe('ProcessAll:0');
    expect(intents[0].children[1].gap_id).toBeUndefined();
  });

  test('returns next index for chaining', () => {
    const intents = [
      { type: 'gap', classification: 'gap', vba_line: 'g1', reason: 'r1' }
    ];
    const nextIdx = assignGapIds(intents, 'proc', 5);
    expect(intents[0].gap_id).toBe('proc:5');
    expect(nextIdx).toBe(6);
  });

  test('empty list returns startIndex unchanged', () => {
    expect(assignGapIds([], 'proc', 0)).toBe(0);
  });
});

// ============================================================
// mapIntentsToTransforms — gap_id integration
// ============================================================

describe('mapIntentsToTransforms — gap_id assignment', () => {
  test('gaps in mapped output have gap_id', () => {
    const intentResult = {
      procedures: [{
        name: 'btnExport_Click',
        trigger: 'on-click',
        intents: [
          { type: 'show-message', message: 'Exporting...' },
          { type: 'gap', vba_line: 'DoCmd.TransferSpreadsheet ...', reason: 'Excel export' }
        ]
      }],
      gaps: []
    };
    const result = mapIntentsToTransforms(intentResult);
    const gapIntent = result.procedures[0].intents.find(i => i.type === 'gap');
    expect(gapIntent.gap_id).toBe('btnExport_Click:0');
  });

  test('multiple procedures get independent gap_id sequences', () => {
    const intentResult = {
      procedures: [
        {
          name: 'proc1',
          trigger: null,
          intents: [{ type: 'gap', vba_line: 'g1', reason: 'r1' }]
        },
        {
          name: 'proc2',
          trigger: null,
          intents: [{ type: 'gap', vba_line: 'g2', reason: 'r2' }]
        }
      ],
      gaps: []
    };
    const result = mapIntentsToTransforms(intentResult);
    expect(result.procedures[0].intents[0].gap_id).toBe('proc1:0');
    expect(result.procedures[1].intents[0].gap_id).toBe('proc2:0');
  });
});
