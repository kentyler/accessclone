/**
 * Tests for targeted graph population functions:
 * populateFromTable, populateFromQuery, populateFromModule, populateFromMacro
 */

const {
  populateFromTable,
  populateFromQuery,
  populateFromModule,
  populateFromMacro
} = require('../graph/populate');

// Mock the graph query module
jest.mock('../graph/query', () => {
  const nodes = new Map();
  let nodeCounter = 0;
  const edges = [];

  const mockModule = {
    upsertNode: jest.fn(async (pool, node) => {
      const id = `node-${++nodeCounter}`;
      const created = { id, ...node };
      nodes.set(id, created);
      return created;
    }),
    upsertEdge: jest.fn(async (pool, edge) => {
      const created = { id: `edge-${edges.length + 1}`, ...edge };
      edges.push(created);
      return created;
    }),
    findNode: jest.fn(async (pool, nodeType, name, databaseId) => {
      for (const [id, n] of nodes) {
        if (n.node_type === nodeType && n.name === name && n.database_id === databaseId) {
          return n;
        }
      }
      return null;
    }),
    findNodesByType: jest.fn(async () => []),
    deleteNode: jest.fn(async () => true),
    // Expose internals for test inspection
    _reset: () => { nodes.clear(); nodeCounter = 0; edges.length = 0; },
    _nodes: nodes,
    _edges: edges,
  };

  return mockModule;
});

const graphQuery = require('../graph/query');

// Mock pool
function createMockPool(queryResults = {}) {
  return {
    query: jest.fn(async (sql, params) => {
      // Match by keyword in the SQL
      for (const [key, result] of Object.entries(queryResults)) {
        if (sql.includes(key)) return result;
      }
      return { rows: [] };
    })
  };
}

beforeEach(() => {
  graphQuery._reset();
  jest.clearAllMocks();
});

// ─── populateFromTable ──────────────────────────────────────────────

describe('populateFromTable', () => {
  test('creates table node and column nodes with contains edges', async () => {
    const pool = createMockPool({
      'information_schema.columns': {
        rows: [
          { column_name: 'id', data_type: 'integer', is_nullable: 'NO', column_default: null },
          { column_name: 'name', data_type: 'character varying', is_nullable: 'YES', column_default: null },
        ]
      },
      'FOREIGN KEY': { rows: [] }
    });

    const stats = await populateFromTable(pool, 'customers', 'northwind', 'nw_schema');

    expect(stats.table).toBeTruthy();
    expect(stats.table.node_type).toBe('table');
    expect(stats.table.name).toBe('customers');
    expect(stats.columns).toBe(2);
    expect(stats.edges).toBe(2); // 2 contains edges

    // Verify upsertNode calls: 1 table + 2 columns
    expect(graphQuery.upsertNode).toHaveBeenCalledTimes(3);
    expect(graphQuery.upsertNode).toHaveBeenCalledWith(pool, expect.objectContaining({
      node_type: 'table', name: 'customers', database_id: 'northwind'
    }));
    expect(graphQuery.upsertNode).toHaveBeenCalledWith(pool, expect.objectContaining({
      node_type: 'column', name: 'id', metadata: expect.objectContaining({ table: 'customers' })
    }));

    // Verify upsertEdge calls: 2 contains
    expect(graphQuery.upsertEdge).toHaveBeenCalledTimes(2);
    expect(graphQuery.upsertEdge).toHaveBeenCalledWith(pool, expect.objectContaining({
      rel_type: 'contains'
    }));
  });

  test('creates FK references edges when foreign keys exist', async () => {
    const pool = createMockPool({
      'information_schema.columns': {
        rows: [
          { column_name: 'id', data_type: 'integer', is_nullable: 'NO', column_default: null },
          { column_name: 'category_id', data_type: 'integer', is_nullable: 'YES', column_default: null },
        ]
      },
      'FOREIGN KEY': {
        rows: [
          { column_name: 'category_id', referenced_table: 'categories', referenced_column: 'id' }
        ]
      }
    });

    // Pre-populate a categories table node so findNode can find it
    await graphQuery.upsertNode(pool, {
      node_type: 'table', name: 'categories', database_id: 'northwind', scope: 'local', metadata: {}
    });
    jest.clearAllMocks();

    const stats = await populateFromTable(pool, 'products', 'northwind', 'nw_schema');

    // 2 contains + 1 FK reference
    expect(stats.edges).toBe(3);
    expect(graphQuery.upsertEdge).toHaveBeenCalledWith(pool, expect.objectContaining({
      rel_type: 'references',
      metadata: { referenced_column: 'id' }
    }));
  });

  test('handles table with no columns gracefully', async () => {
    const pool = createMockPool({
      'information_schema.columns': { rows: [] },
      'FOREIGN KEY': { rows: [] }
    });

    const stats = await populateFromTable(pool, 'empty_table', 'db1', 'schema1');

    expect(stats.table).toBeTruthy();
    expect(stats.columns).toBe(0);
    expect(stats.edges).toBe(0);
  });

  test('metadata includes schema name', async () => {
    const pool = createMockPool({
      'information_schema.columns': { rows: [] },
      'FOREIGN KEY': { rows: [] }
    });

    await populateFromTable(pool, 'orders', 'northwind', 'nw_schema');

    expect(graphQuery.upsertNode).toHaveBeenCalledWith(pool, expect.objectContaining({
      metadata: { schema: 'nw_schema' }
    }));
  });
});

// ─── populateFromQuery ──────────────────────────────────────────────

describe('populateFromQuery', () => {
  test('creates query node with correct metadata for views', async () => {
    const pool = createMockPool({
      'view_column_usage': { rows: [{ table_name: 'orders' }] }
    });

    // Pre-populate orders table node
    await graphQuery.upsertNode(pool, {
      node_type: 'table', name: 'orders', database_id: 'northwind', scope: 'local', metadata: {}
    });
    jest.clearAllMocks();

    const stats = await populateFromQuery(pool, 'active_orders', 'northwind', 'nw_schema', 'view');

    expect(stats.query).toBeTruthy();
    expect(stats.query.node_type).toBe('query');
    expect(stats.query.name).toBe('active_orders');
    expect(stats.query.metadata).toEqual(
      expect.objectContaining({ schema: 'nw_schema', pgObjectType: 'view' })
    );
    expect(stats.edges).toBe(1);

    expect(graphQuery.upsertEdge).toHaveBeenCalledWith(pool, expect.objectContaining({
      rel_type: 'references'
    }));
  });

  test('creates references edges to multiple base tables', async () => {
    const pool = createMockPool({
      'view_column_usage': {
        rows: [{ table_name: 'orders' }, { table_name: 'customers' }]
      }
    });

    // Pre-populate table nodes
    await graphQuery.upsertNode(pool, {
      node_type: 'table', name: 'orders', database_id: 'db1', scope: 'local', metadata: {}
    });
    await graphQuery.upsertNode(pool, {
      node_type: 'table', name: 'customers', database_id: 'db1', scope: 'local', metadata: {}
    });
    jest.clearAllMocks();

    const stats = await populateFromQuery(pool, 'order_summary', 'db1', 'schema1', 'view');

    expect(stats.edges).toBe(2);
  });

  test('skips references for function type (no view_column_usage query)', async () => {
    const pool = createMockPool();

    const stats = await populateFromQuery(pool, 'get_total', 'db1', 'schema1', 'function');

    expect(stats.query).toBeTruthy();
    expect(stats.query.metadata.pgObjectType).toBe('function');
    expect(stats.edges).toBe(0);
    // pool.query should NOT be called for view_column_usage
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('defaults pgObjectType to view when not provided', async () => {
    const pool = createMockPool({
      'view_column_usage': { rows: [] }
    });

    const stats = await populateFromQuery(pool, 'my_query', 'db1', 'schema1', undefined);

    expect(stats.query.metadata.pgObjectType).toBe('view');
  });
});

// ─── populateFromModule ─────────────────────────────────────────────

describe('populateFromModule', () => {
  test('creates module node with handler count', async () => {
    const pool = createMockPool();
    const definition = {
      vba_source: 'Sub Test()\nEnd Sub',
      js_handlers: [
        { key: 'btn.on-click', js: 'AC.openForm("MyForm")' },
        { key: 'form.on-load', js: 'AC.gotoRecord("new")' },
      ]
    };

    const result = await populateFromModule(pool, 'Form_Orders', 'northwind', definition);

    expect(result.module).toBeTruthy();
    expect(result.module.node_type).toBe('module');
    expect(result.module.name).toBe('Form_Orders');
    expect(result.module.metadata).toEqual(
      expect.objectContaining({ has_vba: true, handler_count: 2 })
    );
  });

  test('handles null/empty definition', async () => {
    const pool = createMockPool();

    const result = await populateFromModule(pool, 'Module1', 'db1', null);

    expect(result.module).toBeTruthy();
    expect(result.module.metadata.has_vba).toBe(false);
    expect(result.module.metadata.handler_count).toBe(0);
  });

  test('handles definition without js_handlers', async () => {
    const pool = createMockPool();

    const result = await populateFromModule(pool, 'Module1', 'db1', { vba_source: 'some code' });

    expect(result.module.metadata.has_vba).toBe(true);
    expect(result.module.metadata.handler_count).toBe(0);
  });
});

// ─── populateFromMacro ──────────────────────────────────────────────

describe('populateFromMacro', () => {
  test('creates macro node with has_xml true', async () => {
    const pool = createMockPool();
    const definition = { macro_xml: '<xml>...</xml>' };

    const result = await populateFromMacro(pool, 'AutoExec', 'northwind', definition);

    expect(result.macro).toBeTruthy();
    expect(result.macro.node_type).toBe('macro');
    expect(result.macro.name).toBe('AutoExec');
    expect(result.macro.metadata).toEqual(
      expect.objectContaining({ has_xml: true })
    );
  });

  test('creates macro node with has_xml false when no xml', async () => {
    const pool = createMockPool();

    const result = await populateFromMacro(pool, 'EmptyMacro', 'db1', { cljs_source: 'something' });

    expect(result.macro.metadata.has_xml).toBe(false);
  });

  test('handles null definition', async () => {
    const pool = createMockPool();

    const result = await populateFromMacro(pool, 'NullMacro', 'db1', null);

    expect(result.macro).toBeTruthy();
    expect(result.macro.metadata.has_xml).toBe(false);
  });
});
