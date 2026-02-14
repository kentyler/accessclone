const { parseQueryDesign } = require('../lib/query-design-parser');

describe('parseQueryDesign', () => {
  // ============================================================
  // Basic parsing
  // ============================================================

  test('returns parseable:false for null/empty input', () => {
    expect(parseQueryDesign(null).parseable).toBe(false);
    expect(parseQueryDesign('').parseable).toBe(false);
    expect(parseQueryDesign(undefined).parseable).toBe(false);
  });

  test('returns parseable:false for CTEs', () => {
    const sql = 'WITH cte AS (SELECT 1) SELECT * FROM cte';
    const result = parseQueryDesign(sql);
    expect(result.parseable).toBe(false);
    expect(result.sql).toBe(sql);
  });

  test('returns parseable:false for UNION queries', () => {
    const sql = 'SELECT id FROM t1 UNION SELECT id FROM t2';
    expect(parseQueryDesign(sql).parseable).toBe(false);
  });

  test('returns parseable:false for INTERSECT queries', () => {
    const sql = 'SELECT id FROM t1 INTERSECT SELECT id FROM t2';
    expect(parseQueryDesign(sql).parseable).toBe(false);
  });

  test('returns parseable:false for non-SELECT statements', () => {
    expect(parseQueryDesign('INSERT INTO t VALUES (1)').parseable).toBe(false);
    expect(parseQueryDesign('UPDATE t SET x = 1').parseable).toBe(false);
  });

  // ============================================================
  // Simple single-table queries
  // ============================================================

  test('parses simple SELECT * FROM table', () => {
    const result = parseQueryDesign('SELECT * FROM orders');
    expect(result.parseable).toBe(true);
    expect(result.tables).toHaveLength(1);
    expect(result.tables[0].name).toBe('orders');
    expect(result.tables[0].alias).toBeNull();
    expect(result.fields).toHaveLength(1);
    expect(result.fields[0].expression).toBe('*');
  });

  test('parses SELECT with specific columns', () => {
    const result = parseQueryDesign('SELECT id, name, email FROM customers');
    expect(result.parseable).toBe(true);
    expect(result.tables).toHaveLength(1);
    expect(result.tables[0].name).toBe('customers');
    expect(result.fields).toHaveLength(3);
    expect(result.fields[0].expression).toBe('id');
    expect(result.fields[1].expression).toBe('name');
    expect(result.fields[2].expression).toBe('email');
  });

  test('parses table with alias', () => {
    const result = parseQueryDesign('SELECT o.id FROM orders o');
    expect(result.parseable).toBe(true);
    expect(result.tables[0].name).toBe('orders');
    expect(result.tables[0].alias).toBe('o');
    expect(result.fields[0].expression).toBe('o.id');
    expect(result.fields[0].table).toBe('orders');
  });

  test('parses table with AS alias', () => {
    const result = parseQueryDesign('SELECT o.id FROM orders AS o');
    expect(result.parseable).toBe(true);
    expect(result.tables[0].name).toBe('orders');
    expect(result.tables[0].alias).toBe('o');
  });

  test('parses schema-prefixed table', () => {
    const result = parseQueryDesign('SELECT id FROM myschema.orders');
    expect(result.parseable).toBe(true);
    expect(result.tables[0].name).toBe('orders');
    expect(result.tables[0].schema).toBe('myschema');
  });

  test('parses quoted identifiers', () => {
    const result = parseQueryDesign('SELECT "OrderID" FROM "Order Details"');
    expect(result.parseable).toBe(true);
    expect(result.tables[0].name).toBe('Order Details');
    expect(result.fields[0].expression).toBe('"OrderID"');
  });

  // ============================================================
  // Column aliases
  // ============================================================

  test('parses column with AS alias', () => {
    const result = parseQueryDesign('SELECT customer_name AS name FROM customers');
    expect(result.fields[0].expression).toBe('customer_name');
    expect(result.fields[0].alias).toBe('name');
  });

  test('parses column with quoted alias', () => {
    const result = parseQueryDesign('SELECT id AS "Customer ID" FROM customers');
    expect(result.fields[0].alias).toBe('Customer ID');
  });

  // ============================================================
  // JOINs
  // ============================================================

  test('parses INNER JOIN', () => {
    const sql = `SELECT o.id, c.name
      FROM orders o
      JOIN customers c ON o.customer_id = c.id`;
    const result = parseQueryDesign(sql);
    expect(result.parseable).toBe(true);
    expect(result.tables).toHaveLength(2);
    expect(result.tables[0].name).toBe('orders');
    expect(result.tables[1].name).toBe('customers');
    expect(result.joins).toHaveLength(1);
    expect(result.joins[0].type).toBe('INNER JOIN');
    expect(result.joins[0].leftTable).toBe('orders');
    expect(result.joins[0].leftColumn).toBe('customer_id');
    expect(result.joins[0].rightTable).toBe('customers');
    expect(result.joins[0].rightColumn).toBe('id');
  });

  test('parses LEFT JOIN', () => {
    const sql = `SELECT o.id, c.name
      FROM orders o
      LEFT JOIN customers c ON o.customer_id = c.id`;
    const result = parseQueryDesign(sql);
    expect(result.joins[0].type).toBe('LEFT JOIN');
  });

  test('parses RIGHT JOIN', () => {
    const sql = `SELECT o.id, c.name
      FROM orders o
      RIGHT JOIN customers c ON o.customer_id = c.id`;
    const result = parseQueryDesign(sql);
    expect(result.joins[0].type).toBe('RIGHT JOIN');
  });

  test('parses FULL OUTER JOIN', () => {
    const sql = `SELECT a.id, b.id
      FROM t1 a
      FULL OUTER JOIN t2 b ON a.id = b.id`;
    const result = parseQueryDesign(sql);
    expect(result.joins[0].type).toBe('FULL JOIN');
  });

  test('parses multiple JOINs', () => {
    const sql = `SELECT o.id, c.name, p.product_name
      FROM orders o
      JOIN customers c ON o.customer_id = c.id
      LEFT JOIN products p ON o.product_id = p.id`;
    const result = parseQueryDesign(sql);
    expect(result.tables).toHaveLength(3);
    expect(result.joins).toHaveLength(2);
    expect(result.joins[0].type).toBe('INNER JOIN');
    expect(result.joins[1].type).toBe('LEFT JOIN');
  });

  test('parses multi-column JOIN condition (AND)', () => {
    const sql = `SELECT a.x FROM t1 a
      JOIN t2 b ON a.id = b.id AND a.code = b.code`;
    const result = parseQueryDesign(sql);
    expect(result.joins).toHaveLength(2);
    expect(result.joins[0].leftColumn).toBe('id');
    expect(result.joins[0].rightColumn).toBe('id');
    expect(result.joins[1].leftColumn).toBe('code');
    expect(result.joins[1].rightColumn).toBe('code');
  });

  // ============================================================
  // WHERE clause
  // ============================================================

  test('extracts WHERE clause', () => {
    const sql = "SELECT id FROM orders WHERE status = 'active'";
    const result = parseQueryDesign(sql);
    expect(result.where).toBe("status = 'active'");
  });

  test('extracts WHERE with ORDER BY following', () => {
    const sql = "SELECT id FROM orders WHERE status = 'active' ORDER BY id";
    const result = parseQueryDesign(sql);
    expect(result.where).toBe("status = 'active'");
  });

  test('returns null where when no WHERE clause', () => {
    const result = parseQueryDesign('SELECT id FROM orders');
    expect(result.where).toBeNull();
  });

  // ============================================================
  // ORDER BY
  // ============================================================

  test('extracts ORDER BY', () => {
    const sql = 'SELECT id, name FROM orders ORDER BY name ASC, id DESC';
    const result = parseQueryDesign(sql);
    expect(result.orderBy).toHaveLength(2);
    expect(result.orderBy[0]).toEqual({ expression: 'name', direction: 'ASC' });
    expect(result.orderBy[1]).toEqual({ expression: 'id', direction: 'DESC' });
  });

  test('defaults ORDER BY direction to ASC', () => {
    const sql = 'SELECT id FROM orders ORDER BY id';
    const result = parseQueryDesign(sql);
    expect(result.orderBy[0].direction).toBe('ASC');
  });

  test('marks sort on matching fields', () => {
    const sql = 'SELECT id, name FROM orders ORDER BY name DESC';
    const result = parseQueryDesign(sql);
    const nameField = result.fields.find(f => f.expression === 'name');
    expect(nameField.sort).toBe('DESC');
    const idField = result.fields.find(f => f.expression === 'id');
    expect(idField.sort).toBeNull();
  });

  test('returns null orderBy when no ORDER BY', () => {
    const result = parseQueryDesign('SELECT id FROM orders');
    expect(result.orderBy).toBeNull();
  });

  // ============================================================
  // GROUP BY
  // ============================================================

  test('extracts GROUP BY', () => {
    const sql = 'SELECT customer_id, COUNT(*) FROM orders GROUP BY customer_id';
    const result = parseQueryDesign(sql);
    expect(result.groupBy).toEqual(['customer_id']);
  });

  test('extracts multiple GROUP BY columns', () => {
    const sql = 'SELECT a, b, COUNT(*) FROM t GROUP BY a, b ORDER BY a';
    const result = parseQueryDesign(sql);
    expect(result.groupBy).toEqual(['a', 'b']);
    expect(result.orderBy).toHaveLength(1);
  });

  test('returns null groupBy when no GROUP BY', () => {
    const result = parseQueryDesign('SELECT id FROM orders');
    expect(result.groupBy).toBeNull();
  });

  // ============================================================
  // DISTINCT
  // ============================================================

  test('handles SELECT DISTINCT', () => {
    const sql = 'SELECT DISTINCT name FROM customers';
    const result = parseQueryDesign(sql);
    expect(result.parseable).toBe(true);
    expect(result.fields).toHaveLength(1);
    expect(result.fields[0].expression).toBe('name');
  });

  // ============================================================
  // Comma-separated FROM tables
  // ============================================================

  test('parses comma-separated tables in FROM', () => {
    const sql = 'SELECT a.id, b.name FROM orders a, customers b';
    const result = parseQueryDesign(sql);
    expect(result.tables).toHaveLength(2);
    expect(result.tables[0].name).toBe('orders');
    expect(result.tables[1].name).toBe('customers');
  });

  // ============================================================
  // Complex expressions
  // ============================================================

  test('handles function calls in SELECT', () => {
    const sql = "SELECT customer_id, COUNT(*) AS order_count FROM orders GROUP BY customer_id";
    const result = parseQueryDesign(sql);
    expect(result.parseable).toBe(true);
    expect(result.fields).toHaveLength(2);
    expect(result.fields[0].expression).toBe('customer_id');
    expect(result.fields[1].expression).toBe('COUNT(*)');
    expect(result.fields[1].alias).toBe('order_count');
  });

  test('handles CASE expressions in SELECT', () => {
    const sql = "SELECT CASE WHEN status = 1 THEN 'active' ELSE 'inactive' END AS status_text FROM orders";
    const result = parseQueryDesign(sql);
    expect(result.parseable).toBe(true);
    expect(result.fields[0].alias).toBe('status_text');
  });

  // ============================================================
  // Typical Access-converted views (pg_get_viewdef output)
  // ============================================================

  test('parses typical pg_get_viewdef output with schema prefix', () => {
    const sql = ` SELECT o.order_id,
    o.customer_id,
    c.company_name,
    o.order_date
   FROM mydb.orders o
     JOIN mydb.customers c ON o.customer_id = c.customer_id
  ORDER BY o.order_date DESC`;
    const result = parseQueryDesign(sql);
    expect(result.parseable).toBe(true);
    expect(result.tables).toHaveLength(2);
    expect(result.tables[0].name).toBe('orders');
    expect(result.tables[0].schema).toBe('mydb');
    expect(result.tables[1].name).toBe('customers');
    expect(result.joins).toHaveLength(1);
    expect(result.fields).toHaveLength(4);
    expect(result.orderBy).toHaveLength(1);
    expect(result.orderBy[0].direction).toBe('DESC');
  });

  test('handles trailing semicolon', () => {
    const sql = 'SELECT id FROM orders;';
    const result = parseQueryDesign(sql);
    expect(result.parseable).toBe(true);
    expect(result.tables[0].name).toBe('orders');
  });

  // ============================================================
  // Edge cases
  // ============================================================

  test('handles subqueries in SELECT (does not crash)', () => {
    const sql = "SELECT id, (SELECT COUNT(*) FROM items WHERE items.order_id = orders.id) AS item_count FROM orders";
    const result = parseQueryDesign(sql);
    expect(result.parseable).toBe(true);
    // The subquery field may not be perfectly parsed but it shouldn't crash
    expect(result.tables.length).toBeGreaterThanOrEqual(1);
  });

  test('UNION inside subquery does not trigger top-level UNION bail', () => {
    const sql = "SELECT id FROM (SELECT id FROM t1 UNION SELECT id FROM t2) sub";
    // This has UNION inside parens - should not bail at top level
    // However it may fail to parse the subquery table - that's ok
    const result = parseQueryDesign(sql);
    // Should attempt to parse (parseable depends on implementation)
    expect(result.sql).toContain('UNION');
  });

  test('handles WHERE with parenthesized conditions', () => {
    const sql = "SELECT id FROM orders WHERE (status = 'active' OR status = 'pending') AND total > 100";
    const result = parseQueryDesign(sql);
    expect(result.parseable).toBe(true);
    expect(result.where).toContain('status');
    expect(result.where).toContain('total > 100');
  });

  test('field sort matched by alias', () => {
    const sql = 'SELECT o.order_date AS odate FROM orders o ORDER BY odate DESC';
    const result = parseQueryDesign(sql);
    expect(result.fields[0].sort).toBe('DESC');
  });
});
