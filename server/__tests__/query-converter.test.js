const { convertAccessQuery, sanitizeName } = require('../lib/query-converter');

// Helper: run conversion with defaults
function convert(sql, opts = {}) {
  return convertAccessQuery({
    queryName: opts.queryName || 'test_query',
    queryType: opts.queryType || 'Select',
    queryTypeCode: opts.queryTypeCode ?? 0,
    sql,
    parameters: opts.parameters || []
  }, opts.schema || 'myschema', opts.columnTypes);
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

  test('square brackets → double-quoted identifiers', () => {
    const r = convert('SELECT [First Name] FROM tbl');
    expect(ddl(r)).toContain('"First Name"');
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

describe('TempVars', () => {
  test('[TempVars]![var] → function parameter', () => {
    const r = convert('SELECT Id FROM recipe WHERE Id=[TempVars]![recipe_id]');
    expect(r.pgObjectType).toBe('function');
    expect(ddl(r)).toContain('p_recipe_id');
  });

  test('TempVars("var") → function parameter', () => {
    const r = convert('SELECT Id FROM recipe WHERE Id=TempVars("recipe_id")');
    expect(r.pgObjectType).toBe('function');
    expect(ddl(r)).toContain('p_recipe_id');
  });

  test('TempVars!var → function parameter', () => {
    const r = convert('SELECT Id FROM recipe WHERE Id=TempVars!recipe_id');
    expect(r.pgObjectType).toBe('function');
    expect(ddl(r)).toContain('p_recipe_id');
  });

  test('TempVar type resolved from columnTypes', () => {
    const r = convert(
      'SELECT Id FROM recipe WHERE Id=[TempVars]![recipe_id]',
      { columnTypes: { id: 'integer' } }
    );
    expect(ddl(r)).toContain('p_recipe_id integer');
  });

  test('TempVar defaults to text when no columnTypes', () => {
    const r = convert('SELECT Id FROM recipe WHERE Id=[TempVars]![recipe_id]');
    expect(ddl(r)).toContain('p_recipe_id text');
  });

  test('multiple TempVars deduplicated', () => {
    const r = convert(
      'SELECT Id FROM recipe WHERE Id=[TempVars]![recipe_id] AND Id2=[TempVars]![recipe_id]'
    );
    // Should have exactly one parameter, not two
    const paramMatch = ddl(r).match(/p_recipe_id/g);
    // The parameter list should have it once, but WHERE clause has it twice
    const funcSig = ddl(r).split('$$')[0];
    const sigOccurrences = (funcSig.match(/p_recipe_id/g) || []).length;
    expect(sigOccurrences).toBe(1); // once in the parameter list
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

  test('SELECT with TempVars → FUNCTION returning TABLE', () => {
    const r = convert('SELECT Id, Name FROM recipe WHERE Id=[TempVars]![rid]');
    expect(r.pgObjectType).toBe('function');
    expect(ddl(r)).toContain('CREATE OR REPLACE FUNCTION');
    expect(ddl(r)).toContain('RETURNS TABLE');
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
  test('adds schema to FROM table', () => {
    const r = convert('SELECT Id FROM recipe');
    expect(ddl(r)).toContain('FROM myschema.recipe');
  });

  test('adds schema to JOIN table', () => {
    const r = convert('SELECT r.Id FROM recipe r JOIN ingredient i ON r.Id = i.recipe_id');
    expect(ddl(r)).toContain('JOIN myschema.ingredient');
  });

  test('does not double-prefix already-qualified tables', () => {
    // This tests that we don't get myschema.myschema.recipe
    const r = convert('SELECT Id FROM recipe', { schema: 'app' });
    const s = ddl(r);
    expect(s).toContain('FROM app.recipe');
    expect(s).not.toContain('app.app.');
  });
});

// ============================================================
// Calculated column extraction
// ============================================================

describe('calculated column extraction', () => {
  test('extracts aliased expression into function', () => {
    const r = convert('SELECT COALESCE(Name, \'unknown\') AS display_name FROM tbl');
    expect(r.extractedFunctions.length).toBeGreaterThan(0);
    expect(r.extractedFunctions[0].name).toContain('calc_display_name');
    expect(r.extractedFunctions[0].sql).toContain('LANGUAGE SQL IMMUTABLE');
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
  test('generates RETURNS TABLE with column names', () => {
    const r = convert(
      'SELECT recipe.Id, recipe.Name FROM recipe WHERE Id=[TempVars]![rid]'
    );
    expect(ddl(r)).toContain('RETURNS TABLE(');
    expect(ddl(r)).toMatch(/"id" text/);
    expect(ddl(r)).toMatch(/"name" text/);
  });

  test('falls back to SETOF record for complex expressions', () => {
    // An expression without AS alias that can't be parsed as a column
    const r = convert(
      'SELECT 1 + 2 FROM recipe WHERE Id=[TempVars]![rid]'
    );
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
