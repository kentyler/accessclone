const {
  runFormDeterministicChecks,
  checkArtifactInvariants,
  classifyFailure
} = require('../lib/pipeline-evaluator');

// Mock pool for combo-box SQL validation (returns no errors by default)
const mockPool = {
  query: jest.fn().mockResolvedValue({ rows: [] })
};

describe('checkArtifactInvariants', () => {
  const invariants = [
    { check: 'record_source_preserved', desc: 'Form with record-source must not lose it' },
    { check: 'control_count_preserved', desc: 'Converted form must have same control count' },
    { check: 'section_count_preserved', desc: 'Converted form must have same sections' }
  ];

  test('passes when source had no record-source and converted has none', () => {
    const task = { source_artifact: 'Begin Form\nEnd Form' };
    const definition = { detail: { height: 200, controls: [] } };
    const results = checkArtifactInvariants(task, definition, invariants);
    const rsCheck = results.find(r => r.check === 'record_source_preserved');
    expect(rsCheck.passed).toBe(true);
  });

  test('fails when source had record-source but converted lost it', () => {
    const task = { source_artifact: 'Begin Form\nRecordSource ="Employees"\nEnd Form' };
    const definition = { detail: { height: 200, controls: [] } };
    const results = checkArtifactInvariants(task, definition, invariants);
    const rsCheck = results.find(r => r.check === 'record_source_preserved');
    expect(rsCheck.passed).toBe(false);
    expect(rsCheck.details.source_had_record_source).toBe(true);
    expect(rsCheck.details.converted_has_record_source).toBe(false);
  });

  test('passes when source had record-source and converted kept it', () => {
    const task = { source_artifact: 'Begin Form\nRecordSource ="Employees"\nEnd Form' };
    const definition = { 'record-source': 'employees', detail: { height: 200, controls: [] } };
    const results = checkArtifactInvariants(task, definition, invariants);
    const rsCheck = results.find(r => r.check === 'record_source_preserved');
    expect(rsCheck.passed).toBe(true);
  });

  test('control count preserved — within tolerance', () => {
    const sourceControls = Array(10).fill('    Begin TextBox').join('\n');
    const task = { source_artifact: `Begin Form\n${sourceControls}\nEnd Form` };
    const definition = {
      detail: {
        height: 200,
        controls: Array(9).fill({ type: 'text-box', left: 0, top: 0, width: 100, height: 25 })
      }
    };
    const results = checkArtifactInvariants(task, definition, invariants);
    const ccCheck = results.find(r => r.check === 'control_count_preserved');
    expect(ccCheck.passed).toBe(true);
  });

  test('control count preserved — beyond tolerance', () => {
    const sourceControls = Array(20).fill('    Begin TextBox').join('\n');
    const task = { source_artifact: `Begin Form\n${sourceControls}\nEnd Form` };
    const definition = {
      detail: {
        height: 200,
        controls: Array(5).fill({ type: 'text-box', left: 0, top: 0, width: 100, height: 25 })
      }
    };
    const results = checkArtifactInvariants(task, definition, invariants);
    const ccCheck = results.find(r => r.check === 'control_count_preserved');
    expect(ccCheck.passed).toBe(false);
    expect(ccCheck.details.source_count).toBe(20);
    expect(ccCheck.details.converted_count).toBe(5);
  });

  test('section count preserved — detail present', () => {
    const task = { source_artifact: 'Begin Form\nBegin Section = 0\nEnd Section\nEnd Form' };
    const definition = { detail: { height: 200, controls: [] } };
    const results = checkArtifactInvariants(task, definition, invariants);
    const scCheck = results.find(r => r.check === 'section_count_preserved');
    expect(scCheck.passed).toBe(true);
  });

  test('section count preserved — header lost', () => {
    const task = { source_artifact: 'Begin Form\nBegin FormHeader\nEnd\nBegin Section = 0\nEnd\nEnd Form' };
    const definition = { detail: { height: 200, controls: [] } };
    const results = checkArtifactInvariants(task, definition, invariants);
    const scCheck = results.find(r => r.check === 'section_count_preserved');
    expect(scCheck.passed).toBe(false);
  });

  test('unknown invariant check is skipped gracefully', () => {
    const task = { source_artifact: 'test' };
    const definition = {};
    const results = checkArtifactInvariants(task, definition, [{ check: 'future_check', desc: 'test' }]);
    expect(results[0].passed).toBe(true);
    expect(results[0].details.note).toContain('Unknown');
  });

  test('empty source artifact does not crash', () => {
    const task = { source_artifact: '' };
    const definition = { detail: { height: 200, controls: [] } };
    const results = checkArtifactInvariants(task, definition, invariants);
    expect(results).toHaveLength(3);
    // All should pass (no source = nothing to regress from)
    for (const r of results) {
      expect(r.passed).toBe(true);
    }
  });
});

describe('classifyFailure', () => {
  test('returns null when all pass', () => {
    const results = [
      { check: 'record_source_exists', passed: true, details: {} },
      { check: 'structural_lint', passed: true, details: {} }
    ];
    expect(classifyFailure(results)).toBeNull();
  });

  test('returns missing_dependency for record_source_exists failure', () => {
    const results = [
      { check: 'record_source_exists', passed: false, details: { found_in_schema: false } }
    ];
    expect(classifyFailure(results)).toBe('missing_dependency');
  });

  test('returns regression for record_source_preserved failure', () => {
    const results = [
      { check: 'record_source_preserved', passed: false, details: {} }
    ];
    expect(classifyFailure(results)).toBe('regression');
  });

  test('returns structural_error for control_count_preserved failure', () => {
    const results = [
      { check: 'control_count_preserved', passed: false, details: {} }
    ];
    expect(classifyFailure(results)).toBe('structural_error');
  });

  test('returns translation_ambiguity for control_bindings_match failure', () => {
    const results = [
      { check: 'control_bindings_match', passed: false, details: {} }
    ];
    expect(classifyFailure(results)).toBe('translation_ambiguity');
  });

  test('returns structural_error for structural_lint failure', () => {
    const results = [
      { check: 'structural_lint', passed: false, details: {} }
    ];
    expect(classifyFailure(results)).toBe('structural_error');
  });
});

describe('runFormDeterministicChecks', () => {
  // Create a minimal schemaInfo Map
  const schemaInfo = new Map();
  schemaInfo.set('employees', ['id', 'first_name', 'last_name', 'email']);
  schemaInfo.set('departments', ['id', 'name']);

  test('passes for form with valid record-source and bound controls', async () => {
    const task = { object_name: 'frmEmployees' };
    const definition = {
      name: 'frmEmployees',
      'record-source': 'employees',
      detail: {
        height: 200,
        controls: [
          { type: 'text-box', field: 'first_name', left: 10, top: 10, width: 200, height: 25 }
        ]
      }
    };

    const results = await runFormDeterministicChecks(mockPool, 'test_schema', task, definition, schemaInfo);
    const rsCheck = results.find(r => r.check === 'record_source_exists');
    expect(rsCheck.passed).toBe(true);
    expect(rsCheck.details.found_in_schema).toBe(true);
  });

  test('fails for form with non-existent record-source', async () => {
    const task = { object_name: 'frmMissing' };
    const definition = {
      name: 'frmMissing',
      'record-source': 'nonexistent_table',
      detail: {
        height: 200,
        controls: []
      }
    };

    const results = await runFormDeterministicChecks(mockPool, 'test_schema', task, definition, schemaInfo);
    const rsCheck = results.find(r => r.check === 'record_source_exists');
    expect(rsCheck.passed).toBe(false);
    expect(rsCheck.details.found_in_schema).toBe(false);
  });

  test('unbound form (no record-source) passes record_source_exists', async () => {
    const task = { object_name: 'frmAbout' };
    const definition = {
      name: 'frmAbout',
      detail: {
        height: 200,
        controls: [
          { type: 'label', caption: 'About', left: 10, top: 10, width: 200, height: 25 }
        ]
      }
    };

    const results = await runFormDeterministicChecks(mockPool, 'test_schema', task, definition, schemaInfo);
    const rsCheck = results.find(r => r.check === 'record_source_exists');
    expect(rsCheck.passed).toBe(true);
    expect(rsCheck.details.record_source).toBeNull();
  });

  test('returns structural_lint results', async () => {
    const task = { object_name: 'badForm' };
    // Form with no name — structural lint should catch it
    const definition = {
      detail: { height: 200, controls: [] }
    };

    const results = await runFormDeterministicChecks(mockPool, 'test_schema', task, definition, schemaInfo);
    const lintCheck = results.find(r => r.check === 'structural_lint');
    // validateForm checks for 'name' field, but we passed it through task.object_name
    // The form object { name: undefined } should trigger a lint error
    expect(lintCheck).toBeDefined();
  });
});
