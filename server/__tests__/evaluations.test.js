const {
  runFormDeterministicChecks,
  runReportDeterministicChecks,
  runAndRecordEvaluation,
  classifyFailure
} = require('../lib/pipeline-evaluator');

// Mock pool for combo-box SQL validation (returns no errors by default)
const mockPool = {
  query: jest.fn().mockResolvedValue({ rows: [] })
};

// Shared schemaInfo for tests
const schemaInfo = new Map();
schemaInfo.set('employees', ['id', 'first_name', 'last_name', 'email']);
schemaInfo.set('departments', ['id', 'name']);
schemaInfo.set('orders', ['id', 'customer_id', 'order_date', 'total']);

// ============================================================
// runReportDeterministicChecks
// ============================================================

describe('runReportDeterministicChecks', () => {
  test('passes for report with valid record-source and bound controls', async () => {
    const definition = {
      name: 'rptEmployees',
      'record-source': 'employees',
      detail: {
        height: 300,
        controls: [
          { type: 'text-box', field: 'first_name', left: 10, top: 10, width: 200, height: 25 }
        ]
      }
    };

    const results = await runReportDeterministicChecks(mockPool, 'test_schema', 'rptEmployees', definition, schemaInfo);
    const rsCheck = results.find(r => r.check === 'record_source_exists');
    expect(rsCheck.passed).toBe(true);
    expect(rsCheck.details.found_in_schema).toBe(true);
  });

  test('fails for report with non-existent record-source', async () => {
    const definition = {
      name: 'rptMissing',
      'record-source': 'nonexistent_table',
      detail: { height: 300, controls: [] }
    };

    const results = await runReportDeterministicChecks(mockPool, 'test_schema', 'rptMissing', definition, schemaInfo);
    const rsCheck = results.find(r => r.check === 'record_source_exists');
    expect(rsCheck.passed).toBe(false);
    expect(rsCheck.details.found_in_schema).toBe(false);
  });

  test('unbound report (no record-source) passes', async () => {
    const definition = {
      name: 'rptCover',
      'report-header': { height: 500, controls: [{ type: 'label', caption: 'Cover Page', left: 10, top: 10, width: 200, height: 25 }] }
    };

    const results = await runReportDeterministicChecks(mockPool, 'test_schema', 'rptCover', definition, schemaInfo);
    const rsCheck = results.find(r => r.check === 'record_source_exists');
    expect(rsCheck.passed).toBe(true);
    expect(rsCheck.details.record_source).toBeNull();
  });

  test('structural issues are detected', async () => {
    // Report with no name in definition — structural lint should still run
    const definition = {
      detail: { height: 300, controls: [] }
    };

    const results = await runReportDeterministicChecks(mockPool, 'test_schema', 'rptBad', definition, schemaInfo);
    const lintCheck = results.find(r => r.check === 'structural_lint');
    expect(lintCheck).toBeDefined();
  });

  test('returns 3 checks (no combo-box check for reports)', async () => {
    const definition = {
      name: 'rptOrders',
      'record-source': 'orders',
      detail: { height: 300, controls: [] }
    };

    const results = await runReportDeterministicChecks(mockPool, 'test_schema', 'rptOrders', definition, schemaInfo);
    expect(results).toHaveLength(3);
    const checkNames = results.map(r => r.check);
    expect(checkNames).toContain('record_source_exists');
    expect(checkNames).toContain('structural_lint');
    expect(checkNames).toContain('control_bindings_match');
    expect(checkNames).not.toContain('combo_sql_valid');
  });

  test('accepts task object (pipeline path)', async () => {
    const task = { object_name: 'rptEmployees' };
    const definition = {
      name: 'rptEmployees',
      'record-source': 'employees',
      detail: { height: 300, controls: [] }
    };

    const results = await runReportDeterministicChecks(mockPool, 'test_schema', task, definition, schemaInfo);
    expect(results.length).toBeGreaterThan(0);
    const rsCheck = results.find(r => r.check === 'record_source_exists');
    expect(rsCheck.passed).toBe(true);
  });
});

// ============================================================
// runFormDeterministicChecks — backward compat
// ============================================================

describe('runFormDeterministicChecks — backward compat', () => {
  test('works with task object (pipeline path)', async () => {
    const task = { object_name: 'frmEmployees' };
    const definition = {
      name: 'frmEmployees',
      'record-source': 'employees',
      detail: { height: 200, controls: [] }
    };

    const results = await runFormDeterministicChecks(mockPool, 'test_schema', task, definition, schemaInfo);
    const rsCheck = results.find(r => r.check === 'record_source_exists');
    expect(rsCheck.passed).toBe(true);
  });

  test('works with string (save path)', async () => {
    const definition = {
      name: 'frmEmployees',
      'record-source': 'employees',
      detail: { height: 200, controls: [] }
    };

    const results = await runFormDeterministicChecks(mockPool, 'test_schema', 'frmEmployees', definition, schemaInfo);
    const rsCheck = results.find(r => r.check === 'record_source_exists');
    expect(rsCheck.passed).toBe(true);
  });
});

// ============================================================
// runAndRecordEvaluation
// ============================================================

describe('runAndRecordEvaluation', () => {
  test('inserts evaluation and returns result for form', async () => {
    const insertCalls = [];
    const evalPool = {
      query: jest.fn().mockImplementation((sql, params) => {
        if (sql.includes('shared.databases')) {
          return { rows: [{ schema_name: 'test_schema' }] };
        }
        if (sql.includes('information_schema')) {
          // getSchemaInfo queries — return employees table columns
          return { rows: [
            { table_name: 'employees', column_name: 'id' },
            { table_name: 'employees', column_name: 'first_name' }
          ]};
        }
        if (sql.includes('INSERT INTO shared.evaluations')) {
          insertCalls.push(params);
          return { rows: [] };
        }
        // EXPLAIN for combo-box SQL
        return { rows: [] };
      })
    };

    const result = await runAndRecordEvaluation(evalPool, {
      objectId: 42,
      databaseId: 'testdb',
      objectType: 'form',
      objectName: 'frmTest',
      version: 1,
      definition: { name: 'frmTest', 'record-source': 'employees', detail: { height: 200, controls: [] } },
      trigger: 'save'
    });

    expect(result.overall_passed).toBeDefined();
    expect(result.checks).toBeDefined();
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
    expect(insertCalls.length).toBe(1);
    // Verify INSERT params structure
    const params = insertCalls[0];
    expect(params[0]).toBe(42); // object_id
    expect(params[1]).toBe('testdb'); // database_id
    expect(params[2]).toBe('form'); // object_type
    expect(params[3]).toBe('frmTest'); // object_name
    expect(params[5]).toBe('save'); // trigger
  });

  test('gracefully skips for unknown objectType', async () => {
    const evalPool = {
      query: jest.fn().mockImplementation((sql) => {
        if (sql.includes('shared.databases')) {
          return { rows: [{ schema_name: 'test_schema' }] };
        }
        return { rows: [] };
      })
    };

    const result = await runAndRecordEvaluation(evalPool, {
      objectId: 1, databaseId: 'testdb', objectType: 'macro',
      objectName: 'mcrTest', version: 1, definition: {}, trigger: 'save'
    });

    expect(result.skipped).toBe(true);
    expect(result.reason).toContain('unknown objectType');
  });

  test('gracefully skips when database not found', async () => {
    const evalPool = {
      query: jest.fn().mockResolvedValue({ rows: [] })
    };

    const result = await runAndRecordEvaluation(evalPool, {
      objectId: 1, databaseId: 'nonexistent', objectType: 'form',
      objectName: 'frmTest', version: 1, definition: {}, trigger: 'save'
    });

    expect(result.skipped).toBe(true);
    expect(result.reason).toContain('database not found');
  });
});
