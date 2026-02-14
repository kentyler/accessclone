const { convertAccessQuery, sanitizeName } = require('../lib/query-converter');

// Helper: run conversion with defaults
function convert(sql, opts = {}) {
  return convertAccessQuery({
    queryName: opts.queryName || 'test_query',
    queryType: opts.queryType || 'Select',
    queryTypeCode: opts.queryTypeCode ?? 0,
    sql,
    parameters: opts.parameters || []
  }, opts.schema || 'myschema', opts.columnTypes, opts.controlMapping);
}

// Helper: get the single DDL statement (skipping aggregate preambles)
function ddl(result) {
  return result.statements[result.statements.length - 1];
}

// ============================================================
// sanitizeName
// ============================================================

describe('sanitizeName', () => {
  test('lowercases and replaces spaces with underscores', () => {
    expect(sanitizeName('Hello World')).toBe('hello_world');
  });

  test('strips non-alphanumeric characters', () => {
    expect(sanitizeName('Recipe (v2.1)')).toBe('recipe_v21');
  });

  test('handles already-clean names', () => {
    expect(sanitizeName('recipe')).toBe('recipe');
  });
});

// ============================================================
// Function translations
// ============================================================

describe('function translations', () => {
  test('Nz with 2 args → COALESCE', () => {
    const r = convert('SELECT Nz(Name, "") FROM tbl');
    expect(ddl(r)).toContain('COALESCE(Name, ');
    expect(ddl(r)).not.toContain('Nz');
  });

  test('Nz with 1 arg → COALESCE with empty string', () => {
    const r = convert('SELECT Nz(Name) FROM tbl');
    expect(ddl(r)).toContain("COALESCE(Name, '')");
  });

  test('IIf → CASE WHEN', () => {
    const r = convert('SELECT IIf(x > 0, x, 0) FROM tbl');
    expect(ddl(r)).toContain('CASE WHEN x > 0 THEN x ELSE 0 END');
  });

  test('nested Nz(IIf(...)) translates both', () => {
    const r = convert('SELECT Nz(IIf(x > 0, x, 0), -1) FROM tbl');
    const s = ddl(r);
    expect(s).toContain('COALESCE(CASE WHEN x > 0 THEN x ELSE 0 END, -1)');
  });

  test('Len → LENGTH', () => {
    const r = convert('SELECT Len(Name) FROM tbl');
    expect(ddl(r)).toContain('LENGTH(Name)');
  });

  test('Mid with 3 args → SUBSTRING FROM FOR', () => {
    const r = convert('SELECT Mid(Name, 1, 5) FROM tbl');
    expect(ddl(r)).toContain('SUBSTRING(Name FROM 1 FOR 5)');
  });

  test('Left/Right', () => {
    const r = convert('SELECT Left(Name, 3), Right(Name, 2) FROM tbl');
    const s = ddl(r);
    expect(s).toContain('LEFT(Name, 3)');
    expect(s).toContain('RIGHT(Name, 2)');
  });

  test('UCase/LCase → UPPER/LOWER', () => {
    const r = convert('SELECT UCase(Name), LCase(Name) FROM tbl');
    const s = ddl(r);
    expect(s).toContain('UPPER(Name)');
    expect(s).toContain('LOWER(Name)');
  });

  test('CInt/CLng/CStr casts', () => {
    const r = convert('SELECT CInt(x), CLng(y), CStr(z) FROM tbl');
    const s = ddl(r);
    expect(s).toContain('(x)::integer');
    expect(s).toContain('(y)::bigint');
    expect(s).toContain('(z)::text');
  });

  test('DateSerial → make_date', () => {
    const r = convert('SELECT DateSerial(2024, 1, 15) FROM tbl');
    expect(ddl(r)).toContain('make_date(2024, 1, 15)');
  });

  test('Year/Month/Day → EXTRACT', () => {
    const r = convert('SELECT Year(tbl.created_at), Month(tbl.created_at), Day(tbl.created_at) FROM tbl');
    const s = ddl(r);
    expect(s).toContain('EXTRACT(YEAR FROM');
    expect(s).toContain('EXTRACT(MONTH FROM');
    expect(s).toContain('EXTRACT(DAY FROM');
    expect(s).toContain('::integer');
  });

  test('DateAdd → INTERVAL', () => {
    const r = convert('SELECT DateAdd("d", 7, start_date) FROM tbl');
    expect(ddl(r)).toContain("INTERVAL '1 day'");
  });

  test('DateDiff days', () => {
    const r = convert('SELECT DateDiff("d", d1, d2) FROM tbl');
    expect(ddl(r)).toContain('d2::date - d1::date');
  });

  test('Format with known format', () => {
    const r = convert('SELECT Format(d, "Short Date") FROM tbl');
    expect(ddl(r)).toContain("to_char(d, 'MM/DD/YYYY')");
  });

  test('Int → FLOOR, Abs → ABS', () => {
    const r = convert('SELECT Int(x), Abs(y) FROM tbl');
    const s = ddl(r);
    expect(s).toContain('FLOOR(x)');
    expect(s).toContain('ABS(y)');
  });

  test('Replace → REPLACE', () => {
    const r = convert('SELECT Replace(Name, "a", "b") FROM tbl');
    expect(ddl(r)).toContain('REPLACE(Name,');
  });

  test('IsNull → IS NULL', () => {
    const r = convert('SELECT IsNull(x) FROM tbl');
    expect(ddl(r)).toContain('(x IS NULL)');
  });

  test('First → first_agg (triggers custom aggregate)', () => {
    const r = convert('SELECT First(Name) FROM tbl');
    expect(ddl(r)).toContain('first_agg(Name)');
    // Should include aggregate creation statements
    expect(r.statements.length).toBeGreaterThan(1);
    expect(r.statements[0]).toContain('first_agg_sfunc');
  });

  test('Switch → CASE WHEN pairs', () => {
    const r = convert('SELECT Switch(x=1, "a", x=2, "b") FROM tbl');
    const s = ddl(r);
    expect(s).toContain('CASE WHEN');
    expect(s).toContain('END');
  });
});

// ============================================================
// Syntax translations
// ============================================================

describe('syntax translations', () => {
  test('DISTINCTROW → DISTINCT', () => {
    const r = convert('SELECT DISTINCTROW Id FROM tbl');
    expect(ddl(r)).toContain('SELECT DISTINCT');
    expect(ddl(r)).not.toContain('DISTINCTROW');
  });

  test('TOP N → LIMIT N', () => {
    const r = convert('SELECT TOP 10 Id FROM tbl');
    const s = ddl(r);
    expect(s).toContain('LIMIT 10');
    expect(s).not.toContain('TOP');
  });

  test('SELECT DISTINCT TOP N → DISTINCT ... LIMIT N', () => {
    const r = convert('SELECT DISTINCT TOP 5 Id FROM tbl');
    const s = ddl(r);
    expect(s).toContain('SELECT DISTINCT');
    expect(s).toContain('LIMIT 5');
    expect(s).not.toContain('TOP');
  });

  test('True/False → true/false', () => {
    const r = convert('SELECT Id FROM tbl WHERE active = True AND deleted = False');
    const s = ddl(r);
    expect(s).toContain('= true');
    expect(s).toContain('= false');
  });

  test('Date() → CURRENT_DATE', () => {
    const r = convert('SELECT Date() FROM tbl');
    expect(ddl(r)).toContain('CURRENT_DATE');
  });

  test('Now() → CURRENT_TIMESTAMP', () => {
    const r = convert('SELECT Now() FROM tbl');
    expect(ddl(r)).toContain('CURRENT_TIMESTAMP');
  });

  test('Access date literal #mm/dd/yyyy# → PG date', () => {
    const r = convert('SELECT Id FROM tbl WHERE d > #01/15/2024#');
    expect(ddl(r)).toContain("'2024-01-15'::date");
  });

  test('Access date literal #yyyy-mm-dd# → PG date', () => {
    const r = convert('SELECT Id FROM tbl WHERE d > #2024-01-15#');
    expect(ddl(r)).toContain("'2024-01-15'::date");
  });

  test('& → || for string concatenation', () => {
    const r = convert('SELECT first_name & " " & last_name FROM tbl');
    expect(ddl(r)).toContain('||');
    expect(ddl(r)).not.toContain('&');
  });

  test('square brackets → double-quoted identifiers (sanitized)', () => {
    const r = convert('SELECT [First Name] FROM tbl');
    expect(ddl(r)).toContain('"first_name"');
    expect(ddl(r)).not.toContain('[');
  });

  test('LIKE with Access wildcards → PG wildcards', () => {
    const r = convert('SELECT Id FROM tbl WHERE Name LIKE "*test*"');
    const s = ddl(r);
    expect(s).toContain("LIKE '%test%'");
  });
});

// ============================================================
// TempVars extraction
// ============================================================

describe('TempVars → session_state cross-join', () => {
  test('[TempVars]![var] → cross-join (view, not function)', () => {
    const r = convert('SELECT Id FROM recipe WHERE Id=[TempVars]![recipe_id]');
    expect(r.pgObjectType).toBe('view');
    const s = ddl(r);
    expect(s).toContain('shared.session_state ss1');
    expect(s).toContain("ss1.table_name = '_tempvars'");
    expect(s).toContain("ss1.column_name = 'recipe_id'");
    expect(s).toContain('ss1.value');
  });

  test('TempVars("var") → cross-join', () => {
    const r = convert('SELECT Id FROM recipe WHERE Id=TempVars("recipe_id")');
    expect(r.pgObjectType).toBe('view');
    const s = ddl(r);
    expect(s).toContain('shared.session_state ss1');
    expect(s).toContain("ss1.column_name = 'recipe_id'");
  });

  test('TempVars!var → cross-join', () => {
    const r = convert('SELECT Id FROM recipe WHERE Id=TempVars!recipe_id');
    expect(r.pgObjectType).toBe('view');
    const s = ddl(r);
    expect(s).toContain('shared.session_state ss1');
    expect(s).toContain("ss1.column_name = 'recipe_id'");
  });

  test('session_state view is used (no current_setting in query)', () => {
    const r = convert('SELECT Id FROM recipe WHERE Id=[TempVars]![recipe_id]');
    // The view handles session scoping, so current_setting should NOT appear in the query
    expect(ddl(r)).not.toContain("current_setting");
    expect(ddl(r)).toContain('shared.session_state');
  });

  test('multiple TempVars get separate aliases (ss1, ss2)', () => {
    const r = convert(
      'SELECT Id FROM recipe WHERE Id=[TempVars]![recipe_id] AND name=[TempVars]![recipe_name]'
    );
    const s = ddl(r);
    expect(s).toContain("ss1.column_name = 'recipe_id'");
    expect(s).toContain("ss2.column_name = 'recipe_name'");
    expect(s).toContain('shared.session_state ss1');
    expect(s).toContain('shared.session_state ss2');
    expect(r.pgObjectType).toBe('view');
  });

  test('duplicate TempVars both get separate aliases in WHERE', () => {
    const r = convert(
      'SELECT Id FROM recipe WHERE Id=[TempVars]![recipe_id] AND Id2=[TempVars]![recipe_id]'
    );
    const s = ddl(r);
    // Each occurrence gets its own alias
    expect(s).toContain('ss1.value');
    expect(s).toContain('ss2.value');
    const matches = s.match(/column_name = 'recipe_id'/g);
    expect(matches.length).toBe(2);
  });

  test('TempVars with no WHERE clause get WHERE added', () => {
    const r = convert('SELECT Id, [TempVars]![recipe_id] AS rid FROM recipe');
    const s = ddl(r);
    expect(s).toContain('shared.session_state ss1');
    expect(s).toContain("ss1.table_name = '_tempvars'");
  });
});

// ============================================================
// Query type routing
// ============================================================

describe('query type routing', () => {
  test('simple SELECT → VIEW', () => {
    const r = convert('SELECT Id, Name FROM recipe');
    expect(r.pgObjectType).toBe('view');
    expect(ddl(r)).toContain('CREATE OR REPLACE VIEW');
  });

  test('SELECT with TempVars → VIEW with session_state cross-join (not function)', () => {
    const r = convert('SELECT Id, Name FROM recipe WHERE Id=[TempVars]![rid]');
    expect(r.pgObjectType).toBe('view');
    expect(ddl(r)).toContain('CREATE OR REPLACE VIEW');
    expect(ddl(r)).toContain('shared.session_state ss1');
  });

  test('UPDATE → plpgsql FUNCTION returning integer', () => {
    const r = convert('UPDATE recipe SET Name="test" WHERE Id=1', { queryTypeCode: 48 });
    expect(r.pgObjectType).toBe('function');
    expect(ddl(r)).toContain('RETURNS integer');
    expect(ddl(r)).toContain('GET DIAGNOSTICS');
    expect(ddl(r)).toContain('plpgsql');
  });

  test('DELETE → plpgsql FUNCTION returning integer', () => {
    const r = convert('DELETE FROM recipe WHERE Id=1', { queryTypeCode: 32 });
    expect(r.pgObjectType).toBe('function');
    expect(ddl(r)).toContain('RETURNS integer');
    expect(ddl(r)).toContain('plpgsql');
  });

  test('INSERT → plpgsql FUNCTION returning integer', () => {
    const r = convert('INSERT INTO recipe (Name) VALUES ("test")', { queryTypeCode: 64 });
    expect(r.pgObjectType).toBe('function');
    expect(ddl(r)).toContain('RETURNS integer');
    expect(ddl(r)).toContain('plpgsql');
  });

  test('MakeTable (SELECT INTO) → FUNCTION with DROP/CREATE TABLE', () => {
    const r = convert('SELECT Id, Name INTO archive_recipe FROM recipe', { queryTypeCode: 80 });
    expect(r.pgObjectType).toBe('function');
    expect(ddl(r)).toContain('DROP TABLE IF EXISTS');
    expect(ddl(r)).toContain('CREATE TABLE');
  });

  test('Union → VIEW', () => {
    const r = convert('SELECT Id FROM t1 UNION SELECT Id FROM t2', { queryTypeCode: 128 });
    expect(r.pgObjectType).toBe('view');
    expect(ddl(r)).toContain('CREATE OR REPLACE VIEW');
    expect(ddl(r)).toContain('UNION');
  });

  test('Crosstab → comment with warning', () => {
    const r = convert('TRANSFORM Count(Id) SELECT Name FROM tbl', { queryTypeCode: 16 });
    expect(r.pgObjectType).toBe('view');
    expect(r.warnings.some(w => w.includes('Crosstab'))).toBe(true);
  });

  test('empty SQL → no statements', () => {
    const r = convert('');
    expect(r.pgObjectType).toBe('none');
    expect(r.statements).toHaveLength(0);
    expect(r.warnings[0]).toContain('Empty SQL');
  });

  test('unsupported type → comment with warning', () => {
    const r = convert('SOMETHING WEIRD', { queryTypeCode: 999, queryType: 'Unknown' });
    expect(r.pgObjectType).toBe('none');
    expect(r.warnings[0]).toContain('Unsupported');
  });
});

// ============================================================
// Schema prefixing
// ============================================================

describe('schema prefixing', () => {
  test('adds schema to FROM table (quoted with alias)', () => {
    const r = convert('SELECT Id FROM recipe');
    expect(ddl(r)).toContain('FROM myschema."recipe" recipe');
  });

  test('adds schema to JOIN table (quoted, preserves alias)', () => {
    const r = convert('SELECT r.Id FROM recipe r JOIN ingredient i ON r.Id = i.recipe_id');
    expect(ddl(r)).toContain('myschema."recipe" r');
    expect(ddl(r)).toContain('JOIN myschema."ingredient" i');
  });

  test('does not double-prefix already-qualified tables', () => {
    const r = convert('SELECT Id FROM recipe', { schema: 'app' });
    const s = ddl(r);
    expect(s).toContain('FROM app."recipe"');
    expect(s).not.toContain('app.app.');
  });

  test('does not mangle shared.session_state in cross-joins', () => {
    const r = convert('SELECT Id FROM recipe WHERE Id=[TempVars]![rid]');
    expect(ddl(r)).toContain('shared.session_state');
    expect(ddl(r)).not.toContain('myschema."shared"');
  });

  test('does not schema-prefix FROM inside EXTRACT(YEAR FROM ...)', () => {
    const r = convert('SELECT Year([OrderDate]) FROM orders');
    const s = ddl(r);
    // EXTRACT(YEAR FROM ...) should NOT prefix the column after FROM
    expect(s).toContain('EXTRACT(YEAR FROM');
    expect(s).not.toContain('EXTRACT(YEAR FROM myschema.');
    // The real FROM clause should still be prefixed
    expect(s).toContain('FROM myschema."orders"');
  });
});

// ============================================================
// Calculated column extraction
// ============================================================

describe('calculated column extraction (disabled — inline in views)', () => {
  test('expressions stay inline (no extraction)', () => {
    const r = convert('SELECT COALESCE(Name, \'unknown\') AS display_name FROM tbl');
    expect(r.extractedFunctions).toHaveLength(0);
    // Expression stays in the view SQL
    expect(ddl(r)).toContain('COALESCE');
    expect(ddl(r)).toContain('display_name');
  });

  test('does not extract simple column AS alias', () => {
    const r = convert('SELECT Name AS display_name FROM tbl');
    expect(r.extractedFunctions).toHaveLength(0);
  });

  test('does not extract table.column AS alias', () => {
    const r = convert('SELECT tbl.Name AS display_name FROM tbl');
    expect(r.extractedFunctions).toHaveLength(0);
  });
});

// ============================================================
// Return column extraction
// ============================================================

describe('return columns for parameterized SELECT', () => {
  test('generates RETURNS TABLE with column names (declared params)', () => {
    const r = convert(
      'SELECT recipe.Id, recipe.Name FROM recipe WHERE Id=[rid]',
      { parameters: [{ name: 'rid', type: 'Long' }] }
    );
    expect(r.pgObjectType).toBe('function');
    expect(ddl(r)).toContain('RETURNS TABLE(');
    expect(ddl(r)).toMatch(/"id" text/);
    expect(ddl(r)).toMatch(/"name" text/);
  });

  test('falls back to SETOF record for complex expressions (declared params)', () => {
    const r = convert(
      'SELECT 1 + 2 FROM recipe WHERE Id=[rid]',
      { parameters: [{ name: 'rid', type: 'Long' }] }
    );
    expect(r.pgObjectType).toBe('function');
    expect(ddl(r)).toContain('RETURNS SETOF record');
    expect(r.warnings.some(w => w.includes('SETOF record'))).toBe(true);
  });
});

// ============================================================
// PARAMETERS declaration stripping
// ============================================================

describe('PARAMETERS declaration', () => {
  test('strips Access PARAMETERS prefix', () => {
    const r = convert('PARAMETERS [rid] Long; SELECT Id FROM recipe WHERE Id=[rid]');
    const s = ddl(r);
    expect(s).not.toContain('PARAMETERS');
    expect(s).toContain('SELECT');
  });

  test('Parent ref declared as DAO parameter → filtered out, creates VIEW not FUNCTION', () => {
    const r = convert(
      'SELECT * FROM orders WHERE EmployeeID=[Parent].[EmployeeID]',
      {
        parameters: [{ name: '[Parent].[EmployeeID]', type: 'Long' }],
        controlMapping: { 'employees.employeeid': { table: 'employees', column: 'employeeid' } }
      }
    );
    // Should be a VIEW (no real params), not a FUNCTION
    expect(r.pgObjectType).toBe('view');
    expect(ddl(r)).toContain('CREATE OR REPLACE VIEW');
    expect(ddl(r)).not.toContain('p_parentemployeeid');
    // Parent ref should resolve to session_state cross-join
    expect(ddl(r)).toContain('shared.session_state');
  });

  test('Table.Column declared as DAO parameter → filtered out, creates VIEW not FUNCTION', () => {
    const r = convert(
      'SELECT Sum(Quantity) AS Total, Employees.FullName AS Expr1 FROM orders GROUP BY Employees.FullName',
      { parameters: [{ name: 'Employees.FullNameFNLN', type: 'Text' }] }
    );
    expect(r.pgObjectType).toBe('view');
    expect(ddl(r)).toContain('CREATE OR REPLACE VIEW');
    expect(ddl(r)).not.toContain('p_employeesfullnamefnln');
  });
});

// ============================================================
// Form references → state table subquery
// ============================================================

describe('Form references → session_state cross-join', () => {
  // Standard controlMapping for tests: frmProducts has cboCategory bound to products.categoryid
  const productMapping = {
    'frmproducts.cbocategory': { table: 'products', column: 'categoryid' },
    'frmproducts.cboproductcategories': { table: 'products', column: 'categoryid' },
    'frmproducts.vendorid': { table: 'products', column: 'vendorid' }
  };

  test('[Forms]![formName]![controlName] → resolved cross-join', () => {
    const r = convert(
      'SELECT Id FROM orders WHERE CategoryID = [Forms]![frmProducts]![cboCategory]',
      { controlMapping: productMapping }
    );
    expect(r.pgObjectType).toBe('view');
    const s = ddl(r);
    expect(s).toContain('shared.session_state ss1');
    expect(s).toContain("ss1.table_name = 'products'");
    expect(s).toContain("ss1.column_name = 'categoryid'");
    expect(s).toContain('ss1.value');
  });

  test('Forms![formName]![controlName] → resolved cross-join', () => {
    const r = convert(
      'SELECT Id FROM orders WHERE CategoryID = Forms![frmProducts]![cboCategory]',
      { controlMapping: productMapping }
    );
    const s = ddl(r);
    expect(s).toContain('shared.session_state ss1');
    expect(s).toContain("ss1.table_name = 'products'");
    expect(s).toContain("ss1.column_name = 'categoryid'");
  });

  test('Forms!formName!controlName (bare) → resolved cross-join', () => {
    const r = convert(
      'SELECT Id FROM orders WHERE CategoryID = Forms!frmProducts!cboCategory',
      { controlMapping: productMapping }
    );
    const s = ddl(r);
    expect(s).toContain('shared.session_state ss1');
    expect(s).toContain("ss1.table_name = 'products'");
    expect(s).toContain("ss1.column_name = 'categoryid'");
  });

  test('Forms!formName.controlName (dot notation) → resolved cross-join', () => {
    const r = convert(
      'SELECT Id FROM orders WHERE CategoryID = Forms!frmProducts.cboCategory',
      { controlMapping: productMapping }
    );
    const s = ddl(r);
    expect(s).toContain('shared.session_state ss1');
    expect(s).toContain("ss1.table_name = 'products'");
    expect(s).toContain("ss1.column_name = 'categoryid'");
  });

  test('form names with spaces are sanitized and resolved', () => {
    const r = convert(
      'SELECT Id FROM orders WHERE x = [Forms]![Product Entry Form]![txtQty]',
      { controlMapping: { 'product_entry_form.txtqty': { table: 'orders', column: 'quantity' } } }
    );
    const s = ddl(r);
    expect(s).toContain("ss1.table_name = 'orders'");
    expect(s).toContain("ss1.column_name = 'quantity'");
  });

  test('mixed TempVars and Form refs in same query', () => {
    const r = convert(
      'SELECT Id FROM orders WHERE CategoryID = [Forms]![frmProducts]![cboCategory] AND Status = [TempVars]![currentStatus]',
      { controlMapping: productMapping }
    );
    expect(r.pgObjectType).toBe('view');
    const s = ddl(r);
    // TempVars is translated first, so it gets ss1; form ref gets ss2
    expect(s).toContain("table_name = '_tempvars'");
    expect(s).toContain("table_name = 'products'");
    expect(s).toContain("column_name = 'currentstatus'");
  });

  test('[Form]![controlName] → resolved via control-name-only lookup', () => {
    const r = convert(
      'SELECT Id FROM products WHERE CategoryID = [Form]![cboProductCategories]',
      { controlMapping: productMapping }
    );
    const s = ddl(r);
    expect(s).toContain('shared.session_state ss1');
    expect(s).toContain("ss1.table_name = 'products'");
    expect(s).toContain("ss1.column_name = 'categoryid'");
  });

  test('Form!controlName (bare) → resolved via control-name-only lookup', () => {
    const r = convert(
      'SELECT Id FROM products WHERE CategoryID = Form!cboCategory',
      { controlMapping: { 'someform.cbocategory': { table: 'categories', column: 'id' } } }
    );
    const s = ddl(r);
    expect(s).toContain('shared.session_state ss1');
    expect(s).toContain("ss1.table_name = 'categories'");
    expect(s).toContain("ss1.column_name = 'id'");
  });

  test('[Parent]![controlName] → resolved via control-name-only lookup', () => {
    const r = convert(
      'SELECT Id FROM products WHERE VendorID = [Parent]![VendorID]',
      { controlMapping: productMapping }
    );
    const s = ddl(r);
    expect(s).toContain('shared.session_state ss1');
    expect(s).toContain("ss1.table_name = 'products'");
    expect(s).toContain("ss1.column_name = 'vendorid'");
  });

  test('Parent!controlName (bare) → resolved via control-name-only lookup', () => {
    const r = convert(
      'SELECT Id FROM products WHERE VendorID = Parent!VendorID',
      { controlMapping: productMapping }
    );
    const s = ddl(r);
    expect(s).toContain('shared.session_state ss1');
    expect(s).toContain("ss1.table_name = 'products'");
    expect(s).toContain("ss1.column_name = 'vendorid'");
  });

  test('[Parent]![Parent]![controlName] → resolved (chained grandparent ref)', () => {
    const r = convert(
      'SELECT Id FROM products WHERE CustomerID = [Parent]![Parent]![CustomerID]',
      { controlMapping: { 'orders.customerid': { table: 'orders', column: 'customerid' } } }
    );
    const s = ddl(r);
    expect(s).toContain('shared.session_state ss1');
    expect(s).toContain("ss1.table_name = 'orders'");
    expect(s).toContain("ss1.column_name = 'customerid'");
    // No dangling !"customerid"
    expect(s).not.toContain('!"');
  });

  test('Parent!Parent!controlName (bare) → resolved (chained grandparent ref)', () => {
    const r = convert(
      'SELECT Id FROM products WHERE CustomerID = Parent!Parent!CustomerID',
      { controlMapping: { 'orders.customerid': { table: 'orders', column: 'customerid' } } }
    );
    const s = ddl(r);
    expect(s).toContain("ss1.column_name = 'customerid'");
    expect(s).not.toContain('!"');
  });

  test('[Parent].[controlName] dot notation → resolved', () => {
    const r = convert(
      'SELECT Id FROM products WHERE EmployeeID = [Parent].[EmployeeID]',
      { controlMapping: { 'orders.employeeid': { table: 'orders', column: 'employeeid' } } }
    );
    const s = ddl(r);
    expect(s).toContain('shared.session_state ss1');
    expect(s).toContain("ss1.column_name = 'employeeid'");
    expect(s).not.toContain('"parent"');
  });

  test('unresolved 2-part ref (no mapping) → NULL with comment', () => {
    const r = convert(
      'SELECT Id FROM products WHERE CategoryID = [Form]![unknownCtrl]',
      { controlMapping: {} }
    );
    expect(ddl(r)).toContain('NULL /* UNRESOLVED: Form!unknownCtrl */');
    expect(r.warnings.some(w => w.includes('Unresolved'))).toBe(true);
  });

  test('unresolved 3-part ref (no mapping) → fallback cross-join with warning', () => {
    const r = convert(
      'SELECT Id FROM orders WHERE x = [Forms]![frmMissing]![ctrl1]',
      { controlMapping: {} }
    );
    const s = ddl(r);
    // Falls back to form name as table, control as column
    expect(s).toContain("ss1.table_name = 'frmmissing'");
    expect(s).toContain("ss1.column_name = 'ctrl1'");
    expect(r.warnings.some(w => w.includes('Unresolved'))).toBe(true);
  });

  test('referencedStateEntries populated for resolved refs', () => {
    const r = convert(
      'SELECT Id FROM orders WHERE CategoryID = [Forms]![frmProducts]![cboCategory]',
      { controlMapping: productMapping }
    );
    expect(r.referencedStateEntries).toEqual(
      expect.arrayContaining([{ tableName: 'products', columnName: 'categoryid' }])
    );
  });

  test('::text cast added for columns compared with session_state ref (=)', () => {
    const r = convert(
      'SELECT Id FROM products WHERE CategoryID = [Forms]![frmProducts]![cboCategory]',
      { controlMapping: productMapping }
    );
    // The column being compared should get ::text cast
    expect(ddl(r)).toMatch(/::text/);
  });

  test('::text cast added for <> operator with session_state ref', () => {
    const r = convert(
      'SELECT Id FROM products WHERE CategoryID <> [Forms]![frmProducts]![cboCategory]',
      { controlMapping: productMapping }
    );
    expect(ddl(r)).toMatch(/::text.*<>/);
  });

  test('form refs do not interfere with schema prefixing', () => {
    const r = convert(
      'SELECT Id FROM orders WHERE x = [Forms]![frmTest]![ctrl1]',
      { controlMapping: { 'frmtest.ctrl1': { table: 'orders', column: 'status' } } }
    );
    const s = ddl(r);
    // The main table should be prefixed, session_state should use shared. intact
    expect(s).toContain('myschema."orders"');
    expect(s).toContain('shared.session_state');
    expect(s).not.toContain('myschema."shared"');
  });

  // --- Report references (same resolution as Forms) ---

  test('[Reports]![reportName]![controlName] → resolved cross-join', () => {
    const r = convert(
      'SELECT Id FROM orders WHERE OrderDate >= [Reports]![rptSales]![StartDate]',
      { controlMapping: { 'rptsales.startdate': { table: 'orders', column: 'orderdate' } } }
    );
    const s = ddl(r);
    expect(s).toContain('shared.session_state ss1');
    expect(s).toContain("ss1.table_name = 'orders'");
    expect(s).toContain("ss1.column_name = 'orderdate'");
  });

  test('Reports!reportName!controlName (bare) → resolved cross-join', () => {
    const r = convert(
      'SELECT Id FROM orders WHERE OrderDate >= Reports!rptSales!StartDate',
      { controlMapping: { 'rptsales.startdate': { table: 'orders', column: 'orderdate' } } }
    );
    const s = ddl(r);
    expect(s).toContain('shared.session_state ss1');
    expect(s).toContain("ss1.column_name = 'orderdate'");
  });

  test('[Report]![controlName] → resolved via control-name-only lookup', () => {
    const r = convert(
      'SELECT Id FROM orders WHERE OrderDate >= [Report]![StartDate]',
      { controlMapping: { 'rptsales.startdate': { table: 'orders', column: 'orderdate' } } }
    );
    const s = ddl(r);
    expect(s).toContain('shared.session_state ss1');
    expect(s).toContain("ss1.column_name = 'orderdate'");
  });

  test('Report!controlName (bare) → resolved via control-name-only lookup', () => {
    const r = convert(
      'SELECT Id FROM orders WHERE OrderDate >= Report!StartDate',
      { controlMapping: { 'rptsales.startdate': { table: 'orders', column: 'orderdate' } } }
    );
    const s = ddl(r);
    expect(s).toContain('shared.session_state ss1');
    expect(s).toContain("ss1.column_name = 'orderdate'");
  });

  test('unresolved [Reports]! ref → fallback cross-join with warning', () => {
    const r = convert(
      'SELECT Id FROM orders WHERE x = [Reports]![rptMissing]![ctrl1]',
      { controlMapping: {} }
    );
    const s = ddl(r);
    expect(s).toContain("ss1.table_name = 'rptmissing'");
    expect(s).toContain("ss1.column_name = 'ctrl1'");
    expect(r.warnings.some(w => w.includes('Unresolved'))).toBe(true);
  });

  test('[Reports]![rptName]![ctrl with spaces] → resolved', () => {
    const r = convert(
      'SELECT Id FROM orders WHERE OrderDate >= [Reports]![rptSales]![Report Parameter Start Date]',
      { controlMapping: { 'rptsales.report_parameter_start_date': { table: 'config', column: 'start_date' } } }
    );
    const s = ddl(r);
    expect(s).toContain('shared.session_state ss1');
    expect(s).toContain("ss1.table_name = 'config'");
    expect(s).toContain("ss1.column_name = 'start_date'");
    // Must NOT appear as a function call
    expect(s).not.toContain('reportparameterstartdate(');
  });
});

// ============================================================
// User-defined function schema prefixing
// ============================================================

describe('user-defined function schema prefixing', () => {
  test('VBA function calls get schema prefix', () => {
    const r = convert(
      'SELECT ProductNoStock([Products].[ProductID]) AS NoStock FROM Products'
    );
    expect(ddl(r)).toContain('"myschema"."productnostock"(');
  });

  test('multiple VBA function calls all get prefixed', () => {
    const r = convert(
      'SELECT ProductNoStock([Products].[ProductID]) AS A, ProductAllocated([Products].[ProductID]) AS B FROM Products'
    );
    expect(ddl(r)).toContain('"myschema"."productnostock"(');
    expect(ddl(r)).toContain('"myschema"."productallocated"(');
  });

  test('PG builtins are NOT prefixed', () => {
    const r = convert(
      'SELECT COUNT(*), COALESCE(x, 0), UPPER(name) FROM tbl'
    );
    const sql = ddl(r);
    expect(sql).toContain('COUNT(');
    expect(sql).toContain('COALESCE(');
    expect(sql).toContain('UPPER(');
    expect(sql).not.toContain('"myschema"."count"');
    expect(sql).not.toContain('"myschema"."coalesce"');
    expect(sql).not.toContain('"myschema"."upper"');
  });

  test('Access functions translated to PG builtins are NOT prefixed', () => {
    // Nz → COALESCE, IIf → CASE WHEN, Len → LENGTH
    const r = convert('SELECT Nz(x, 0), Len(name) FROM tbl');
    const sql = ddl(r);
    expect(sql).toContain('COALESCE(');
    expect(sql).toContain('LENGTH(');
    expect(sql).not.toContain('"myschema"."coalesce"');
    expect(sql).not.toContain('"myschema"."length"');
  });

  test('Get_UserID() style function gets prefixed', () => {
    const r = convert(
      'SELECT * FROM MRU WHERE EmployeeID = Get_UserID()'
    );
    expect(ddl(r)).toContain('"myschema"."get_userid"(');
  });
});

// ============================================================
// Edge cases
// ============================================================

describe('edge cases', () => {
  test('query name with spaces sanitized', () => {
    const r = convert('SELECT Id FROM tbl', { queryName: 'My Complex Query' });
    expect(r.pgObjectName).toBe('my_complex_query');
  });

  test('trailing semicolons stripped', () => {
    const r = convert('SELECT Id FROM tbl;');
    expect(ddl(r)).not.toMatch(/;\s*\n.*\$\$/); // no semicolon before $$
  });

  test('datetime literal with time', () => {
    const r = convert('SELECT Id FROM tbl WHERE d > #01/15/2024 14:30:00#');
    expect(ddl(r)).toContain("'2024-01-15 14:30:00'::timestamp");
  });
});
