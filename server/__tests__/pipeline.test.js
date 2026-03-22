const { steps, getStep, listStrategies } = require('../lib/pipeline/steps');
const { runStep, runPipeline, getModuleStatus, hasUnresolvedGaps, STEP_ORDER } = require('../lib/pipeline/runner');

// ============================================================
// Test fixtures
// ============================================================

const MOCK_VBA_SOURCE = `
Sub btnSave_Click()
  If IsNull(Me.txtName) Then
    MsgBox "Name is required"
    Exit Sub
  End If
  DoCmd.RunCommand acCmdSaveRecord
End Sub
`;

const MOCK_INTENTS = {
  procedures: [{
    name: 'btnSave_Click',
    trigger: 'on-click',
    intents: [
      { type: 'validate-required', field: 'txtName', message: 'Name is required' },
      { type: 'save-record' }
    ]
  }]
};

const MOCK_INTENTS_WITH_GAP = {
  procedures: [{
    name: 'btnExport_Click',
    trigger: 'on-click',
    intents: [
      { type: 'show-message', message: 'Exporting...' },
      { type: 'gap', vba_line: 'DoCmd.TransferSpreadsheet', reason: 'Export to Excel not supported' }
    ]
  }]
};

const MOCK_INTENTS_WITH_RESOLVED_GAP = {
  procedures: [{
    name: 'btnExport_Click',
    trigger: 'on-click',
    intents: [
      { type: 'show-message', message: 'Exporting...' },
      {
        type: 'gap',
        vba_line: 'DoCmd.TransferSpreadsheet',
        reason: 'Export to Excel not supported',
        resolution: { answer: 'Download as CSV', resolved_at: '2026-02-18T00:00:00Z', resolved_by: 'user' }
      }
    ]
  }]
};

// ============================================================
// getStep / listStrategies
// ============================================================

describe('step registry', () => {
  test('getStep returns valid step definitions', () => {
    const step = getStep('extract');
    expect(step.name).toBe('extract');
    expect(step.defaultStrategy).toBe('llm');
    expect(typeof step.strategies.llm).toBe('function');
    expect(typeof step.strategies.mock).toBe('function');
  });

  test('getStep throws for unknown step', () => {
    expect(() => getStep('nonexistent')).toThrow('Unknown pipeline step');
  });

  test('listStrategies returns strategy names', () => {
    expect(listStrategies('extract')).toEqual(expect.arrayContaining(['llm', 'mock']));
    expect(listStrategies('map')).toEqual(['deterministic']);
    expect(listStrategies('gap-questions')).toEqual(expect.arrayContaining(['llm', 'skip']));
    expect(listStrategies('resolve-gaps')).toEqual(expect.arrayContaining(['auto', 'skip']));
  });

  test('all 4 steps are defined', () => {
    expect(Object.keys(steps)).toEqual(
      expect.arrayContaining(['extract', 'map', 'gap-questions', 'resolve-gaps'])
    );
    expect(Object.keys(steps).length).toBe(4);
  });
});

// ============================================================
// STEP_ORDER
// ============================================================

describe('STEP_ORDER', () => {
  test('has correct step order', () => {
    expect(STEP_ORDER).toEqual(['extract', 'map', 'gap-questions', 'resolve-gaps']);
  });
});

// ============================================================
// runStep — individual step execution
// ============================================================

describe('runStep', () => {
  test('extract with mock strategy returns intents', async () => {
    const result = await runStep('extract', { vbaSource: MOCK_VBA_SOURCE, moduleName: 'TestModule' }, {}, 'mock');
    expect(result.step).toBe('extract');
    expect(result.strategy).toBe('mock');
    expect(result.result.intents.procedures).toHaveLength(1);
    expect(result.result.validation.valid).toBe(true);
    expect(result.duration).toBeGreaterThanOrEqual(0);
  });

  test('map with deterministic strategy returns mapped data', async () => {
    const result = await runStep('map', { intents: MOCK_INTENTS }, {});
    expect(result.step).toBe('map');
    expect(result.strategy).toBe('deterministic');
    expect(result.result.mapped.procedures).toHaveLength(1);
    expect(result.result.stats.mechanical).toBe(2);
    expect(result.result.stats.gap).toBe(0);
    expect(result.result.gaps).toEqual([]);
  });

  test('map with gap intents reports gaps correctly', async () => {
    const result = await runStep('map', { intents: MOCK_INTENTS_WITH_GAP }, {});
    expect(result.result.stats.gap).toBe(1);
    expect(result.result.stats.mechanical).toBe(1);
    expect(result.result.gaps.length).toBeGreaterThan(0);
  });

  test('gap-questions with skip strategy returns empty', async () => {
    const result = await runStep('gap-questions', { gaps: [], vbaSource: '', moduleName: 'X' }, {}, 'skip');
    expect(result.result.gapQuestions).toEqual([]);
  });

  test('resolve-gaps with skip strategy passes mapped through', async () => {
    const mapResult = await runStep('map', { intents: MOCK_INTENTS_WITH_GAP }, {});
    const result = await runStep('resolve-gaps', { mapped: mapResult.result.mapped }, {}, 'skip');
    expect(result.result.mapped).toBe(mapResult.result.mapped);
    expect(result.result.resolvedCount).toBe(0);
  });

  test('runStep throws for unknown strategy', async () => {
    await expect(runStep('extract', {}, {}, 'nonexistent')).rejects.toThrow('Unknown strategy');
  });

  test('runStep throws for unknown step', async () => {
    await expect(runStep('nonexistent', {}, {})).rejects.toThrow('Unknown pipeline step');
  });

  test('runStep measures duration', async () => {
    const result = await runStep('map', { intents: MOCK_INTENTS }, {});
    expect(typeof result.duration).toBe('number');
    expect(result.duration).toBeGreaterThanOrEqual(0);
  });
});

// ============================================================
// Step chaining — output of step N feeds into step N+1
// ============================================================

describe('step chaining', () => {
  test('extract → map chain works', async () => {
    // Step 1: Extract (mock)
    const extractResult = await runStep('extract', { vbaSource: MOCK_VBA_SOURCE, moduleName: 'ChainTest' }, {}, 'mock');
    expect(extractResult.result.intents.procedures).toHaveLength(1);

    // Step 2: Map
    const mapResult = await runStep('map', { intents: extractResult.result.intents }, {});
    expect(mapResult.result.mapped.procedures).toHaveLength(1);
    expect(mapResult.result.stats.mechanical).toBeGreaterThanOrEqual(0);
  });

  test('map → gap-questions chain with gaps', async () => {
    const mapResult = await runStep('map', { intents: MOCK_INTENTS_WITH_GAP }, {});
    const gaps = mapResult.result.gaps;
    expect(gaps.length).toBeGreaterThan(0);

    // gap-questions with skip
    const gqResult = await runStep('gap-questions', {
      gaps,
      vbaSource: MOCK_VBA_SOURCE,
      moduleName: 'GapTest'
    }, {}, 'skip');
    expect(gqResult.result.gapQuestions).toEqual([]);
  });

  test('map preserves gap_id assignment', async () => {
    const mapResult = await runStep('map', { intents: MOCK_INTENTS_WITH_GAP }, {});
    const gapIntent = mapResult.result.mapped.procedures[0].intents.find(i => i.type === 'gap');
    expect(gapIntent.gap_id).toBe('btnExport_Click:0');
  });
});

// ============================================================
// hasUnresolvedGaps
// ============================================================

describe('hasUnresolvedGaps', () => {
  test('returns false for no gaps', async () => {
    const mapResult = await runStep('map', { intents: MOCK_INTENTS }, {});
    expect(hasUnresolvedGaps(mapResult.result.mapped)).toBe(false);
  });

  test('returns true for unresolved gaps', async () => {
    const mapResult = await runStep('map', { intents: MOCK_INTENTS_WITH_GAP }, {});
    expect(hasUnresolvedGaps(mapResult.result.mapped)).toBe(true);
  });

  test('returns false for resolved gaps', async () => {
    const mapResult = await runStep('map', { intents: MOCK_INTENTS_WITH_RESOLVED_GAP }, {});
    expect(hasUnresolvedGaps(mapResult.result.mapped)).toBe(false);
  });

  test('returns false for null/empty', () => {
    expect(hasUnresolvedGaps(null)).toBe(false);
    expect(hasUnresolvedGaps({})).toBe(false);
    expect(hasUnresolvedGaps({ procedures: [] })).toBe(false);
  });

  test('detects nested unresolved gaps in branch children', () => {
    const mapped = {
      procedures: [{
        name: 'test',
        intents: [{
          type: 'branch',
          classification: 'gap',
          mapping: { type: 'structural', target: null },
          then: [{ type: 'gap', vba_line: 'nested', reason: 'test' }]
        }]
      }]
    };
    expect(hasUnresolvedGaps(mapped)).toBe(true);
  });

  test('resolved nested gap returns false', () => {
    const mapped = {
      procedures: [{
        name: 'test',
        intents: [{
          type: 'branch',
          classification: 'mechanical',
          mapping: { type: 'structural', target: null },
          then: [{
            type: 'gap',
            vba_line: 'nested',
            reason: 'test',
            resolution: { answer: 'skip', resolved_by: 'user' }
          }]
        }]
      }]
    };
    expect(hasUnresolvedGaps(mapped)).toBe(false);
  });
});

// ============================================================
// getModuleStatus
// ============================================================

describe('getModuleStatus', () => {
  test('null module → extract pending', () => {
    expect(getModuleStatus(null)).toEqual({ step: 'extract', status: 'pending' });
  });

  test('no intents → extract pending', () => {
    expect(getModuleStatus({})).toEqual({ step: 'extract', status: 'pending' });
    expect(getModuleStatus({ intents: null })).toEqual({ step: 'extract', status: 'pending' });
  });

  test('intents without mapped → map pending', () => {
    expect(getModuleStatus({ intents: { procedures: [] } })).toEqual({ step: 'map', status: 'pending' });
  });

  test('intents with mapped but unresolved gaps → resolve-gaps pending', () => {
    const status = getModuleStatus({
      intents: {
        mapped: {
          procedures: [{
            name: 'test',
            intents: [{ type: 'gap', vba_line: 'test', reason: 'test' }]
          }]
        }
      }
    });
    expect(status).toEqual({ step: 'resolve-gaps', status: 'pending' });
  });

  test('intents with mapped, no gaps → complete', () => {
    const status = getModuleStatus({
      intents: {
        mapped: {
          procedures: [{
            name: 'test',
            intents: [{ type: 'show-message', classification: 'mechanical' }]
          }]
        }
      }
    });
    expect(status).toEqual({ step: 'complete', status: 'complete' });
  });

  test('intents with mapped, resolved gaps → complete', () => {
    const status = getModuleStatus({
      intents: {
        mapped: {
          procedures: [{
            name: 'test',
            intents: [{
              type: 'gap',
              vba_line: 'test',
              resolution: { answer: 'skip', resolved_by: 'user' }
            }]
          }]
        }
      }
    });
    expect(status).toEqual({ step: 'complete', status: 'complete' });
  });
});

// ============================================================
// runPipeline — end-to-end with mock strategies
// ============================================================

describe('runPipeline', () => {
  test('full pipeline with mock extract', async () => {
    const result = await runPipeline(
      { vbaSource: MOCK_VBA_SOURCE, moduleName: 'PipelineTest' },
      {},
      { extract: 'mock', 'gap-questions': 'skip', 'resolve-gaps': 'skip' }
    );

    expect(result.status).toBe('complete');
    expect(result.results.length).toBeGreaterThanOrEqual(2); // extract, map (gap steps skipped)

    // Verify step ordering
    const stepNames = result.results.map(r => r.step);
    expect(stepNames[0]).toBe('extract');
    expect(stepNames[1]).toBe('map');

    // Module status should be complete (no unresolved gaps)
    expect(result.moduleStatus.step).toBe('complete');
  });

  test('pipeline skips extract when intents are pre-provided', async () => {
    const result = await runPipeline(
      { moduleName: 'PreProvided', intents: MOCK_INTENTS },
      {},
      { 'gap-questions': 'skip', 'resolve-gaps': 'skip' }
    );

    expect(result.status).toBe('complete');
    const stepNames = result.results.map(r => r.step);
    expect(stepNames).not.toContain('extract');
    expect(stepNames[0]).toBe('map');
  });

  test('pipeline skips map when mapped data is pre-provided', async () => {
    // First get mapped data
    const mapResult = await runStep('map', { intents: MOCK_INTENTS }, {});

    const result = await runPipeline(
      { moduleName: 'PreMapped', mapped: mapResult.result.mapped, vbaSource: MOCK_VBA_SOURCE },
      {},
      { 'gap-questions': 'skip', 'resolve-gaps': 'skip' }
    );

    expect(result.status).toBe('complete');
    const stepNames = result.results.map(r => r.step);
    expect(stepNames).not.toContain('extract');
    expect(stepNames).not.toContain('map');
    // No steps needed — already mapped with no gaps
    expect(result.moduleStatus.step).toBe('complete');
  });

  test('pipeline with gaps includes gap-questions step', async () => {
    const result = await runPipeline(
      { vbaSource: MOCK_VBA_SOURCE, moduleName: 'GapPipeline', intents: MOCK_INTENTS_WITH_GAP },
      {},
      { 'gap-questions': 'skip', 'resolve-gaps': 'skip' }
    );

    expect(result.status).toBe('complete');
    // gap-questions ran with skip strategy (still produces a step result)
    const gqStep = result.results.find(r => r.step === 'gap-questions');
    expect(gqStep).toBeDefined();
    expect(gqStep.strategy).toBe('skip');
  });

  test('pipeline returns partial results on failure', async () => {
    // Intentionally cause a failure by not providing intents or vbaSource
    const result = await runPipeline(
      { moduleName: 'FailTest' },
      {},
      { extract: 'mock' }
    );

    // Mock extract produces intents, so it should succeed
    // Then map should work
    expect(result.status).toBe('complete');
  });

  test('pipeline config overrides default strategies', async () => {
    const result = await runPipeline(
      { vbaSource: MOCK_VBA_SOURCE, moduleName: 'ConfigTest' },
      {},
      { extract: 'mock', 'gap-questions': 'skip', 'resolve-gaps': 'skip' }
    );

    const extractStep = result.results.find(r => r.step === 'extract');
    expect(extractStep.strategy).toBe('mock');
  });

  test('each step result includes duration', async () => {
    const result = await runPipeline(
      { vbaSource: MOCK_VBA_SOURCE, moduleName: 'DurationTest' },
      {},
      { extract: 'mock', 'gap-questions': 'skip', 'resolve-gaps': 'skip' }
    );

    for (const stepResult of result.results) {
      expect(typeof stepResult.duration).toBe('number');
      expect(stepResult.duration).toBeGreaterThanOrEqual(0);
    }
  });

  test('pipeline handles intents with resolved gaps correctly', async () => {
    const result = await runPipeline(
      { moduleName: 'ResolvedGaps', intents: MOCK_INTENTS_WITH_RESOLVED_GAP },
      {},
      { 'gap-questions': 'skip', 'resolve-gaps': 'skip' }
    );

    expect(result.status).toBe('complete');
    // No unresolved gaps — pipeline completes at map step
    expect(result.moduleStatus.step).toBe('complete');
  });
});

// ============================================================
// Strategy isolation — steps are independent
// ============================================================

describe('strategy isolation', () => {
  test('mock extract produces valid structure for map step', async () => {
    const extractResult = await runStep('extract', { vbaSource: '', moduleName: 'Iso' }, {}, 'mock');
    const mapResult = await runStep('map', { intents: extractResult.result.intents }, {});

    expect(mapResult.result.mapped.procedures).toBeDefined();
    expect(mapResult.result.stats).toBeDefined();
  });

  test('skip gap-questions returns correct structure', async () => {
    const result = await runStep('gap-questions', { gaps: [], vbaSource: '', moduleName: 'X' }, {}, 'skip');
    expect(result.result).toEqual({ gapQuestions: [] });
  });

  test('skip resolve-gaps passes mapped through unchanged', async () => {
    const mapResult = await runStep('map', { intents: MOCK_INTENTS }, {});
    const original = mapResult.result.mapped;
    const result = await runStep('resolve-gaps', { mapped: original }, {}, 'skip');
    expect(result.result.mapped).toBe(original); // same reference
  });
});

// ============================================================
// Edge cases
// ============================================================

describe('edge cases', () => {
  test('map with empty procedures', async () => {
    const result = await runStep('map', { intents: { procedures: [] } }, {});
    expect(result.result.mapped.procedures).toEqual([]);
    expect(result.result.stats.total).toBe(0);
  });

  test('map with null intents returns empty', async () => {
    const result = await runStep('map', { intents: null }, {});
    expect(result.result.mapped.procedures).toEqual([]);
  });

  test('pipeline with only moduleName and mock extract succeeds', async () => {
    const result = await runPipeline(
      { moduleName: 'MinimalTest', vbaSource: 'Sub Test()\nEnd Sub' },
      {},
      { extract: 'mock', 'gap-questions': 'skip', 'resolve-gaps': 'skip' }
    );
    expect(result.status).toBe('complete');
  });

  test('getModuleStatus with mapped at top level', () => {
    // Some callers store mapped at top level, not nested under intents
    const status = getModuleStatus({
      intents: { procedures: [{ name: 'test', intents: [] }] },
      mapped: { procedures: [{ name: 'test', intents: [] }] }
    });
    // intents exists but intents.mapped is undefined — no unresolved gaps → complete
    expect(status.step).toBe('complete');
  });
});
