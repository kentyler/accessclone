const { validateIntents, repairJson, KNOWN_INTENT_TYPES } = require('../lib/vba-intent-extractor');

// ============================================================
// validateIntents — unit tests (no LLM)
// ============================================================

describe('validateIntents', () => {
  test('valid result passes validation', () => {
    const result = {
      procedures: [
        {
          name: 'btnSave_Click',
          trigger: 'on-click',
          intents: [
            { type: 'validate-required', field: 'Name', message: 'Name is required' },
            { type: 'save-record' }
          ]
        }
      ],
      gaps: []
    };
    const v = validateIntents(result);
    expect(v.valid).toBe(true);
    expect(v.unknown).toEqual([]);
    expect(v.warnings).toEqual([]);
  });

  test('flags unknown intent types', () => {
    const result = {
      procedures: [{
        name: 'test',
        trigger: null,
        intents: [
          { type: 'save-record' },
          { type: 'do-something-weird' }
        ]
      }],
      gaps: []
    };
    const v = validateIntents(result);
    expect(v.valid).toBe(false);
    expect(v.unknown).toContain('do-something-weird');
  });

  test('flags missing procedure name', () => {
    const result = {
      procedures: [{ intents: [{ type: 'save-record' }] }],
      gaps: []
    };
    const v = validateIntents(result);
    expect(v.warnings).toContain('Procedure missing name');
  });

  test('flags missing intents array', () => {
    const result = {
      procedures: [{ name: 'test' }],
      gaps: []
    };
    const v = validateIntents(result);
    expect(v.warnings.length).toBeGreaterThan(0);
  });

  test('validates nested children (branch with unknown type)', () => {
    const result = {
      procedures: [{
        name: 'test',
        trigger: null,
        intents: [{
          type: 'branch',
          condition: 'x > 0',
          then: [{ type: 'invented-intent' }]
        }]
      }],
      gaps: []
    };
    const v = validateIntents(result);
    expect(v.unknown).toContain('invented-intent');
  });

  test('validates nested confirm-action children', () => {
    const result = {
      procedures: [{
        name: 'test',
        trigger: null,
        intents: [{
          type: 'confirm-action',
          message: 'Sure?',
          then: [{ type: 'delete-record' }],
          else: [{ type: 'show-message', message: 'Cancelled' }]
        }]
      }],
      gaps: []
    };
    const v = validateIntents(result);
    expect(v.valid).toBe(true);
  });

  test('rejects null input', () => {
    const v = validateIntents(null);
    expect(v.valid).toBe(false);
    expect(v.warnings).toContain('Result is not an object');
  });

  test('rejects missing procedures', () => {
    const v = validateIntents({ gaps: [] });
    expect(v.valid).toBe(false);
    expect(v.warnings).toContain('Missing procedures array');
  });

  test('flags intent with missing type', () => {
    const result = {
      procedures: [{
        name: 'test',
        trigger: null,
        intents: [{ field: 'Name' }]
      }],
      gaps: []
    };
    const v = validateIntents(result);
    expect(v.warnings.some(w => w.includes('missing type'))).toBe(true);
  });

  test('deduplicates unknown types', () => {
    const result = {
      procedures: [{
        name: 'test',
        trigger: null,
        intents: [
          { type: 'mystery' },
          { type: 'mystery' },
          { type: 'mystery' }
        ]
      }],
      gaps: []
    };
    const v = validateIntents(result);
    expect(v.unknown).toEqual(['mystery']);
  });
});

// ============================================================
// KNOWN_INTENT_TYPES
// ============================================================

describe('KNOWN_INTENT_TYPES', () => {
  test('contains expected core types', () => {
    expect(KNOWN_INTENT_TYPES.has('open-form')).toBe(true);
    expect(KNOWN_INTENT_TYPES.has('save-record')).toBe(true);
    expect(KNOWN_INTENT_TYPES.has('branch')).toBe(true);
    expect(KNOWN_INTENT_TYPES.has('gap')).toBe(true);
  });

  test('has 30 intent types', () => {
    expect(KNOWN_INTENT_TYPES.size).toBe(30);
  });
});

// ============================================================
// repairJson — unit tests
// ============================================================

describe('repairJson', () => {
  test('passes valid JSON through unchanged', () => {
    const json = '{"type": "save-record"}';
    expect(JSON.parse(repairJson(json))).toEqual({ type: 'save-record' });
  });

  test('fixes backslash-quote inside string values', () => {
    // LLM outputs: "criteria": "OrderID = \" & Me.OrderID"
    // Which has \" that looks like end-of-string but isn't followed by JSON structure
    const broken = '{"criteria": "OrderID = \\" & Me.OrderID"}';
    const repaired = repairJson(broken);
    const parsed = JSON.parse(repaired);
    expect(parsed.criteria).toBeTruthy();
  });

  test('handles embedded VBA concatenation in string values', () => {
    const broken = '{"message": "Has \\" & cnt & \\" items"}';
    const repaired = repairJson(broken);
    const parsed = JSON.parse(repaired);
    expect(parsed.message).toBeTruthy();
  });

  test('preserves legitimate end-of-string quotes', () => {
    const json = '{"a": "hello", "b": "world"}';
    const parsed = JSON.parse(repairJson(json));
    expect(parsed.a).toBe('hello');
    expect(parsed.b).toBe('world');
  });

  test('handles complex nested JSON', () => {
    const json = '{"procedures": [{"name": "test", "intents": [{"type": "save-record"}]}]}';
    const parsed = JSON.parse(repairJson(json));
    expect(parsed.procedures[0].intents[0].type).toBe('save-record');
  });
});

// ============================================================
// Integration tests — gated behind ACCESSCLONE_LLM_TESTS=1
// ============================================================

const runLlmTests = process.env.ACCESSCLONE_LLM_TESTS === '1';

(runLlmTests ? describe : describe.skip)('extractIntents (LLM integration)', () => {
  const { extractIntents } = require('../lib/vba-intent-extractor');
  const apiKey = process.env.ANTHROPIC_API_KEY;

  test('extracts intents from simple button handler', async () => {
    const vba = `
Private Sub btnClose_Click()
    DoCmd.Close
End Sub
`;
    const result = await extractIntents(vba, 'TestModule', {}, apiKey);
    expect(result.procedures).toHaveLength(1);
    expect(result.procedures[0].name).toContain('btnClose');
    expect(result.procedures[0].intents.some(i => i.type === 'close-current')).toBe(true);
  }, 30000);
});
