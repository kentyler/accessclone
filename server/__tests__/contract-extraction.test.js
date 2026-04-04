const { extractRoutesFromSource, extractDestructuredFields } = require('../graph/extract-routes');
const { extractFunctionsFromSource, parseObjectLiteralFields } = require('../graph/extract-functions');
const { evaluatePredicate } = require('../lib/test-harness/predicate-evaluator');

// ============================================================
// Route extraction
// ============================================================

describe('extractRoutesFromSource', () => {
  test('extracts POST route with req.body destructuring', () => {
    const source = `
      router.post('/import-table', async (req, res) => {
        const { databasePath, tableName, targetDatabaseId, force } = req.body;
        res.json({ ok: true });
      });
    `;
    const routes = extractRoutesFromSource(source, 'routes/import-table.js');
    expect(routes).toHaveLength(1);
    expect(routes[0].method).toBe('POST');
    expect(routes[0].path).toBe('/import-table');
    expect(routes[0].file).toBe('routes/import-table.js');
    expect(routes[0].fields.body).toEqual(expect.arrayContaining(['databasePath', 'tableName', 'targetDatabaseId', 'force']));
    expect(routes[0].fields.params).toEqual([]);
  });

  test('extracts GET route with req.query destructuring', () => {
    const source = `
      router.get('/nodes', async (req, res) => {
        const { type, database_id } = req.query;
        res.json({ nodes: [] });
      });
    `;
    const routes = extractRoutesFromSource(source, 'routes/graph.js');
    expect(routes).toHaveLength(1);
    expect(routes[0].method).toBe('GET');
    expect(routes[0].fields.query).toEqual(expect.arrayContaining(['type', 'database_id']));
    expect(routes[0].fields.body).toEqual([]);
  });

  test('extracts params from path pattern', () => {
    const source = `
      router.get('/:name/versions/:version', async (req, res) => {
        res.json({});
      });
    `;
    const routes = extractRoutesFromSource(source, 'routes/forms.js');
    expect(routes).toHaveLength(1);
    expect(routes[0].fields.params).toEqual(['name', 'version']);
  });

  test('extracts multiple routes from same file', () => {
    const source = `
      router.get('/', async (req, res) => { res.json({}); });
      router.post('/create', async (req, res) => {
        const { name, definition } = req.body;
        res.json({});
      });
      router.delete('/:id', async (req, res) => { res.json({}); });
    `;
    const routes = extractRoutesFromSource(source, 'routes/test.js');
    expect(routes).toHaveLength(3);
    expect(routes[0].method).toBe('GET');
    expect(routes[1].method).toBe('POST');
    expect(routes[1].fields.body).toEqual(expect.arrayContaining(['name', 'definition']));
    expect(routes[2].method).toBe('DELETE');
    expect(routes[2].fields.params).toEqual(['id']);
  });

  test('handles default values in destructuring', () => {
    const source = `
      router.get('/data', async (req, res) => {
        const { direction = 'downstream', depth = '3', rel_types } = req.query;
        res.json({});
      });
    `;
    const routes = extractRoutesFromSource(source, 'routes/graph.js');
    expect(routes[0].fields.query).toEqual(expect.arrayContaining(['direction', 'depth', 'rel_types']));
  });

  test('returns empty array for file with no routes', () => {
    const source = `
      function helper() { return 42; }
      module.exports = { helper };
    `;
    const routes = extractRoutesFromSource(source, 'routes/helpers.js');
    expect(routes).toEqual([]);
  });
});

describe('extractDestructuredFields', () => {
  test('extracts simple fields', () => {
    const source = 'const { a, b, c } = req.body;';
    expect(extractDestructuredFields(source, 'req.body')).toEqual(['a', 'b', 'c']);
  });

  test('handles defaults', () => {
    const source = "const { x = 'foo', y = 5 } = req.query;";
    expect(extractDestructuredFields(source, 'req.query')).toEqual(['x', 'y']);
  });

  test('returns empty for no match', () => {
    const source = 'const x = req.body.name;';
    expect(extractDestructuredFields(source, 'req.body')).toEqual([]);
  });

  test('deduplicates fields', () => {
    const source = `
      const { a, b } = req.body;
      const { a, c } = req.body;
    `;
    const fields = extractDestructuredFields(source, 'req.body');
    expect(fields).toEqual(['a', 'b', 'c']);
  });
});

// ============================================================
// Function extraction
// ============================================================

describe('extractFunctionsFromSource', () => {
  test('extracts import store functions with api.post', () => {
    const source = `
      async importTable(databasePath, name) {
        const targetDatabaseId = api.getDatabaseId();
        const res = await api.post<{ ok?: boolean }>('/api/database-import/import-table', {
          databasePath, tableName: name, targetDatabaseId,
        });
        return res.ok;
      },

      async importForm(databasePath, name) {
        const targetDatabaseId = api.getDatabaseId();
        const res = await api.post<Record<string, unknown>>('/api/database-import/export-form', {
          databasePath, formName: name, targetDatabaseId,
        });
        return true;
      },
    `;
    const fns = extractFunctionsFromSource(source, 'store/import.ts');
    expect(fns).toHaveLength(2);

    expect(fns[0].name).toBe('importTable');
    expect(fns[0].endpoint).toBe('/api/database-import/import-table');
    expect(fns[0].method).toBe('POST');
    expect(fns[0].fields).toEqual(expect.arrayContaining(['databasePath', 'tableName', 'targetDatabaseId']));

    expect(fns[1].name).toBe('importForm');
    expect(fns[1].endpoint).toBe('/api/database-import/export-form');
    expect(fns[1].fields).toEqual(expect.arrayContaining(['databasePath', 'formName', 'targetDatabaseId']));
  });

  test('extracts api.put calls', () => {
    const source = `
      async saveForm(name) {
        const res = await api.put('/api/forms/test', {
          name, definition,
        });
        return res.ok;
      },
    `;
    const fns = extractFunctionsFromSource(source, 'store/forms.ts');
    expect(fns).toHaveLength(1);
    expect(fns[0].method).toBe('PUT');
    expect(fns[0].fields).toEqual(expect.arrayContaining(['name', 'definition']));
  });

  test('returns empty for functions with no API calls', () => {
    const source = `
      async reset() {
        this.data = {};
      },
    `;
    const fns = extractFunctionsFromSource(source, 'store/test.ts');
    expect(fns).toEqual([]);
  });
});

describe('parseObjectLiteralFields', () => {
  test('parses shorthand fields', () => {
    expect(parseObjectLiteralFields('databasePath, tableName, targetDatabaseId')).toEqual(
      ['databasePath', 'tableName', 'targetDatabaseId']
    );
  });

  test('parses key-value fields', () => {
    expect(parseObjectLiteralFields('tableName: name, force: true')).toEqual(
      ['tableName', 'force']
    );
  });

  test('parses mixed shorthand and key-value', () => {
    expect(parseObjectLiteralFields('databasePath, formName: name, targetDatabaseId')).toEqual(
      ['databasePath', 'formName', 'targetDatabaseId']
    );
  });

  test('handles empty string', () => {
    expect(parseObjectLiteralFields('')).toEqual([]);
  });
});

// ============================================================
// Contract predicates
// ============================================================

describe('route_accepts_fields', () => {
  const routeMap = new Map();
  routeMap.set('POST /import-table', {
    fields: { body: ['databasePath', 'tableName', 'targetDatabaseId', 'force'] }
  });

  test('passes when all expected fields are present', () => {
    const ctx = { routeMap };
    const pred = { type: 'route_accepts_fields', route: 'POST /import-table', fields: ['databasePath', 'tableName'] };
    expect(evaluatePredicate(pred, ctx)).toBe(true);
  });

  test('fails when expected field is missing', () => {
    const ctx = { routeMap };
    const pred = { type: 'route_accepts_fields', route: 'POST /import-table', fields: ['databasePath', 'missingField'] };
    expect(evaluatePredicate(pred, ctx)).toBe(false);
  });

  test('fails when route not found', () => {
    const ctx = { routeMap };
    const pred = { type: 'route_accepts_fields', route: 'POST /nonexistent', fields: ['x'] };
    expect(evaluatePredicate(pred, ctx)).toBe(false);
  });

  test('passes by default when no routeMap', () => {
    const pred = { type: 'route_accepts_fields', route: 'POST /import-table', fields: ['x'] };
    expect(evaluatePredicate(pred, {})).toBe(true);
  });
});

describe('function_sends_fields', () => {
  const functionMap = new Map();
  functionMap.set('importTable', {
    fields: ['databasePath', 'tableName', 'targetDatabaseId']
  });

  test('passes when all expected fields are sent', () => {
    const ctx = { functionMap };
    const pred = { type: 'function_sends_fields', function: 'importTable', fields: ['databasePath', 'tableName'] };
    expect(evaluatePredicate(pred, ctx)).toBe(true);
  });

  test('fails when expected field is not sent', () => {
    const ctx = { functionMap };
    const pred = { type: 'function_sends_fields', function: 'importTable', fields: ['databasePath', 'extraField'] };
    expect(evaluatePredicate(pred, ctx)).toBe(false);
  });

  test('fails when function not found', () => {
    const ctx = { functionMap };
    const pred = { type: 'function_sends_fields', function: 'nonexistent', fields: ['x'] };
    expect(evaluatePredicate(pred, ctx)).toBe(false);
  });
});

describe('contract_fields_match', () => {
  test('passes when function fields are subset of route fields', () => {
    const routeMap = new Map();
    routeMap.set('POST /import-table', {
      fields: { body: ['databasePath', 'tableName', 'targetDatabaseId', 'force'] }
    });
    const functionMap = new Map();
    functionMap.set('importTable', {
      fields: ['databasePath', 'tableName', 'targetDatabaseId']
    });

    const ctx = { routeMap, functionMap };
    const pred = { type: 'contract_fields_match', function: 'importTable', route: 'POST /import-table' };
    expect(evaluatePredicate(pred, ctx)).toBe(true);
  });

  test('fails when function sends field not accepted by route', () => {
    const routeMap = new Map();
    routeMap.set('POST /import-table', {
      fields: { body: ['path', 'name', 'targetId'] } // renamed fields!
    });
    const functionMap = new Map();
    functionMap.set('importTable', {
      fields: ['databasePath', 'tableName', 'targetDatabaseId'] // original names
    });

    const ctx = { routeMap, functionMap };
    const pred = { type: 'contract_fields_match', function: 'importTable', route: 'POST /import-table' };
    expect(evaluatePredicate(pred, ctx)).toBe(false); // DRIFT DETECTED
  });

  test('fails when route or function not found', () => {
    const ctx = { routeMap: new Map(), functionMap: new Map() };
    const pred = { type: 'contract_fields_match', function: 'x', route: 'POST /y' };
    expect(evaluatePredicate(pred, ctx)).toBe(false);
  });
});

// ============================================================
// Integration: drift detection scenario
// ============================================================

describe('drift detection scenario', () => {
  test('detects the exact Claude Code drift that motivated this feature', () => {
    // Step 1: Extract routes from "correct" source
    const routeSource = `
      router.post('/import-table', async (req, res) => {
        const { databasePath, tableName, targetDatabaseId } = req.body;
        res.json({ ok: true });
      });
    `;
    const routes = extractRoutesFromSource(routeSource, 'routes/import-table.js');
    expect(routes[0].fields.body).toEqual(['databasePath', 'tableName', 'targetDatabaseId']);

    // Step 2: Extract functions from "correct" frontend
    const frontendSource = `
      async importTable(databasePath, name) {
        const targetDatabaseId = api.getDatabaseId();
        const res = await api.post<{ ok?: boolean }>('/api/database-import/import-table', {
          databasePath, tableName: name, targetDatabaseId,
        });
        return res.ok;
      },
    `;
    const fns = extractFunctionsFromSource(frontendSource, 'store/import.ts');
    expect(fns[0].fields).toEqual(['databasePath', 'tableName', 'targetDatabaseId']);

    // Step 3: Build context and verify contract matches
    const routeMap = new Map();
    routeMap.set('POST /import-table', { fields: { body: routes[0].fields.body } });
    const functionMap = new Map();
    functionMap.set('importTable', { fields: fns[0].fields });

    const ctx = { routeMap, functionMap };
    const pred = { type: 'contract_fields_match', function: 'importTable', route: 'POST /import-table' };
    expect(evaluatePredicate(pred, ctx)).toBe(true);

    // Step 4: Simulate the DRIFT — Claude renames params
    const driftedSource = `
      async importTable(path, name) {
        const targetId = api.getDatabaseId();
        const res = await api.post<{ ok?: boolean }>('/api/database-import/import-table', {
          path, name, targetId,
        });
        return res.ok;
      },
    `;
    const driftedFns = extractFunctionsFromSource(driftedSource, 'store/import.ts');
    expect(driftedFns[0].fields).toEqual(['path', 'name', 'targetId']); // Wrong!

    // Step 5: Re-evaluate with drifted function — FAILS
    const driftedFnMap = new Map();
    driftedFnMap.set('importTable', { fields: driftedFns[0].fields });
    const driftedCtx = { routeMap, functionMap: driftedFnMap };
    expect(evaluatePredicate(pred, driftedCtx)).toBe(false); // Cord pulled!

    // The function_sends_fields predicate also catches it
    const fieldPred = {
      type: 'function_sends_fields',
      function: 'importTable',
      fields: ['databasePath', 'tableName', 'targetDatabaseId'] // frozen at freeze time
    };
    expect(evaluatePredicate(fieldPred, driftedCtx)).toBe(false);
  });
});

// ============================================================
// classifyPredicate for contract types
// ============================================================

const { classifyPredicate } = require('../lib/test-harness/predicate-evaluator');

describe('classifyPredicate for contract types', () => {
  test('route_accepts_fields → boundary', () => {
    expect(classifyPredicate({ type: 'route_accepts_fields' })).toBe('boundary');
  });

  test('function_sends_fields → boundary', () => {
    expect(classifyPredicate({ type: 'function_sends_fields' })).toBe('boundary');
  });

  test('contract_fields_match → resolution', () => {
    expect(classifyPredicate({ type: 'contract_fields_match' })).toBe('resolution');
  });
});
