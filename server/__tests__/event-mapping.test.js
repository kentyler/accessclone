const {
  classifyHandler,
  populateControlEventMap,
  extractEventsFromObject,
  boolFlagMap,
  eventSuffixMap,
} = require('../lib/event-mapping');

// ============================================================
// classifyHandler
// ============================================================

describe('classifyHandler', () => {
  test('[Event Procedure] for control click', () => {
    const result = classifyHandler('[Event Procedure]', 'btnSave', 'on-click', 'MyForm', 'form');
    expect(result).toEqual({
      handler_type: 'event-procedure',
      handler_ref: 'btnSave_Click',
      module_name: 'Form_MyForm',
    });
  });

  test('[Event Procedure] for form-level load', () => {
    const result = classifyHandler('[Event Procedure]', '_form', 'on-load', 'MyForm', 'form');
    expect(result).toEqual({
      handler_type: 'event-procedure',
      handler_ref: 'Form_Load',
      module_name: 'Form_MyForm',
    });
  });

  test('[Event Procedure] for report-level open', () => {
    const result = classifyHandler('[Event Procedure]', '_report', 'on-open', 'SalesReport', 'report');
    expect(result).toEqual({
      handler_type: 'event-procedure',
      handler_ref: 'Report_Open',
      module_name: 'Report_SalesReport',
    });
  });

  test('[Event Procedure] for after-update', () => {
    const result = classifyHandler('[Event Procedure]', 'cboStatus', 'after-update', 'MyForm', 'form');
    expect(result).toEqual({
      handler_type: 'event-procedure',
      handler_ref: 'cboStatus_AfterUpdate',
      module_name: 'Form_MyForm',
    });
  });

  test('expression handler =FunctionName()', () => {
    const result = classifyHandler('=MyFunction()', 'btnRun', 'on-click', 'MyForm', 'form');
    expect(result).toEqual({
      handler_type: 'expression',
      handler_ref: 'MyFunction',
      module_name: null,
    });
  });

  test('expression handler with args =CalcTotal(arg1)', () => {
    const result = classifyHandler('=CalcTotal(arg1)', 'btnCalc', 'on-click', 'MyForm', 'form');
    expect(result).toEqual({
      handler_type: 'expression',
      handler_ref: 'CalcTotal',
      module_name: null,
    });
  });

  test('expression handler with spaces = FnName ()', () => {
    const result = classifyHandler('= FnName ()', 'btn', 'on-click', 'MyForm', 'form');
    expect(result).toEqual({
      handler_type: 'expression',
      handler_ref: 'FnName',
      module_name: null,
    });
  });

  test('macro handler (bare string)', () => {
    const result = classifyHandler('MyMacro', 'btnRun', 'on-click', 'MyForm', 'form');
    expect(result).toEqual({
      handler_type: 'macro',
      handler_ref: 'MyMacro',
      module_name: null,
    });
  });

  test('returns null for null/empty/undefined', () => {
    expect(classifyHandler(null, 'btn', 'on-click', 'F', 'form')).toBeNull();
    expect(classifyHandler('', 'btn', 'on-click', 'F', 'form')).toBeNull();
    expect(classifyHandler(undefined, 'btn', 'on-click', 'F', 'form')).toBeNull();
    expect(classifyHandler('   ', 'btn', 'on-click', 'F', 'form')).toBeNull();
  });

  test('returns null for non-string input', () => {
    expect(classifyHandler(42, 'btn', 'on-click', 'F', 'form')).toBeNull();
    expect(classifyHandler(true, 'btn', 'on-click', 'F', 'form')).toBeNull();
  });

  test('[Event Procedure] with unknown event key returns null', () => {
    const result = classifyHandler('[Event Procedure]', 'btn', 'on-unknown-event', 'F', 'form');
    expect(result).toBeNull();
  });
});

// ============================================================
// extractEventsFromObject
// ============================================================

describe('extractEventsFromObject', () => {
  test('extracts from .events map', () => {
    const obj = {
      events: {
        'on-click': '[Event Procedure]',
        'on-load': '=MyFunc()',
        'after-update': 'RunMacro',
      },
    };
    const result = extractEventsFromObject(obj, 'btnTest');
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ controlName: 'btnTest', eventKey: 'on-click', rawValue: '[Event Procedure]' });
    expect(result[1]).toEqual({ controlName: 'btnTest', eventKey: 'on-load', rawValue: '=MyFunc()' });
    expect(result[2]).toEqual({ controlName: 'btnTest', eventKey: 'after-update', rawValue: 'RunMacro' });
  });

  test('extracts from boolean flags when no .events map', () => {
    const obj = {
      'has-click-event': true,
      'has-load-event': true,
    };
    const result = extractEventsFromObject(obj, '_form');
    expect(result).toHaveLength(2);
    const events = result.map(r => r.eventKey);
    expect(events).toContain('on-click');
    expect(events).toContain('on-load');
    // All boolean flags produce [Event Procedure] as rawValue
    for (const r of result) {
      expect(r.rawValue).toBe('[Event Procedure]');
    }
  });

  test('events map takes precedence over boolean flags', () => {
    const obj = {
      events: { 'on-click': '=MyFunc()' },
      'has-click-event': true,  // Should be ignored because events map covers on-click
    };
    const result = extractEventsFromObject(obj, 'btn');
    const clickEntries = result.filter(r => r.eventKey === 'on-click');
    expect(clickEntries).toHaveLength(1);
    expect(clickEntries[0].rawValue).toBe('=MyFunc()');
  });

  test('boolean flags supplement events map for uncovered events', () => {
    const obj = {
      events: { 'on-click': '[Event Procedure]' },
      'has-load-event': true,  // Not covered by events map, should be added
    };
    const result = extractEventsFromObject(obj, '_form');
    expect(result).toHaveLength(2);
    const events = result.map(r => r.eventKey);
    expect(events).toContain('on-click');
    expect(events).toContain('on-load');
  });

  test('empty object returns empty array', () => {
    expect(extractEventsFromObject({}, 'ctrl')).toEqual([]);
  });

  test('ignores empty/null values in events map', () => {
    const obj = {
      events: { 'on-click': '', 'on-load': null, 'after-update': '[Event Procedure]' },
    };
    const result = extractEventsFromObject(obj, 'ctrl');
    expect(result).toHaveLength(1);
    expect(result[0].eventKey).toBe('after-update');
  });
});

// ============================================================
// populateControlEventMap (with mock pool)
// ============================================================

describe('populateControlEventMap', () => {
  let mockClient;
  let mockPool;
  let queries;

  beforeEach(() => {
    queries = [];
    mockClient = {
      query: jest.fn(async (sql, params) => {
        queries.push({ sql, params });
        return { rows: [] };
      }),
      release: jest.fn(),
    };
    mockPool = {
      connect: jest.fn(async () => mockClient),
    };
  });

  test('inserts form-level and control-level events', async () => {
    const definition = {
      'has-load-event': true,
      header: {
        controls: [
          {
            name: 'btnSave',
            events: { 'on-click': '[Event Procedure]' },
          },
        ],
      },
      detail: {
        controls: [
          {
            name: 'cboStatus',
            'has-after-update-event': true,
          },
        ],
      },
    };

    await populateControlEventMap(mockPool, 'testdb', 'MyForm', definition, 'form');

    // Should have BEGIN, DELETE, INSERT, COMMIT
    expect(mockClient.query).toHaveBeenCalledTimes(4);
    const deleteCall = queries[1];
    expect(deleteCall.sql).toContain('DELETE FROM shared.control_event_map');
    expect(deleteCall.params).toEqual(['testdb', 'MyForm']);

    const insertCall = queries[2];
    expect(insertCall.sql).toContain('INSERT INTO shared.control_event_map');
    // Should have 3 events: form-level on-load, btnSave on-click, cboStatus after-update
    // Each entry has 8 values
    expect(insertCall.params.length).toBe(3 * 8);
  });

  test('handles definition with no events (just deletes)', async () => {
    const definition = {
      header: { controls: [{ name: 'lbl1' }] },
      detail: { controls: [] },
    };

    await populateControlEventMap(mockPool, 'testdb', 'MyForm', definition, 'form');

    // Should have BEGIN, DELETE, COMMIT (no INSERT since no events)
    expect(mockClient.query).toHaveBeenCalledTimes(3);
  });

  test('handles report with section events', async () => {
    const definition = {
      'has-open-event': true,
      detail: {
        'has-format-event': true,
        controls: [],
      },
    };

    await populateControlEventMap(mockPool, 'testdb', 'SalesReport', definition, 'report');

    // Should have BEGIN, DELETE, INSERT, COMMIT
    expect(mockClient.query).toHaveBeenCalledTimes(4);
    const insertCall = queries[2];
    // 2 events: report-level on-open, section on-format
    expect(insertCall.params.length).toBe(2 * 8);
  });

  test('handles string JSON input', async () => {
    const definition = JSON.stringify({
      header: {
        controls: [
          { name: 'btn1', events: { 'on-click': '[Event Procedure]' } },
        ],
      },
    });

    await populateControlEventMap(mockPool, 'testdb', 'MyForm', definition, 'form');
    expect(mockClient.query).toHaveBeenCalledTimes(4);
  });

  test('idempotent — running twice yields same result', async () => {
    const definition = {
      events: { 'on-load': '[Event Procedure]' },
      detail: { controls: [{ name: 'btn1', events: { 'on-click': '[Event Procedure]' } }] },
    };

    await populateControlEventMap(mockPool, 'testdb', 'MyForm', definition, 'form');
    const firstInsert = queries.find(q => q.sql.includes('INSERT'));

    queries = [];
    await populateControlEventMap(mockPool, 'testdb', 'MyForm', definition, 'form');
    const secondInsert = queries.find(q => q.sql.includes('INSERT'));

    expect(firstInsert.params).toEqual(secondInsert.params);
  });

  test('skips silently on invalid JSON string', async () => {
    await populateControlEventMap(mockPool, 'testdb', 'MyForm', 'not valid json', 'form');
    expect(mockPool.connect).not.toHaveBeenCalled();
  });

  test('expression and macro handlers are classified correctly', async () => {
    const definition = {
      events: {
        'on-load': '=InitForm()',
        'on-close': 'CleanupMacro',
      },
      detail: { controls: [] },
    };

    await populateControlEventMap(mockPool, 'testdb', 'MyForm', definition, 'form');

    const insertCall = queries.find(q => q.sql.includes('INSERT'));
    // 2 events, 8 params each
    expect(insertCall.params.length).toBe(2 * 8);

    // First event: expression
    expect(insertCall.params[4]).toBe('on-load');
    expect(insertCall.params[5]).toBe('expression');
    expect(insertCall.params[6]).toBe('InitForm');

    // Second event: macro
    expect(insertCall.params[12]).toBe('on-close');
    expect(insertCall.params[13]).toBe('macro');
    expect(insertCall.params[14]).toBe('CleanupMacro');
  });
});

// ============================================================
// Coverage checks
// ============================================================

describe('boolFlagMap coverage', () => {
  test('all boolean flags map to valid event suffix keys', () => {
    for (const eventKey of Object.values(boolFlagMap)) {
      expect(eventSuffixMap).toHaveProperty(eventKey);
    }
  });
});
