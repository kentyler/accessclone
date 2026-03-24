const { parseVbaDeclarations, mapVbaTypeToPg, buildStubDDL, collectEnumNames } = require('../lib/vba-stub-generator');

// ============================================================
// mapVbaTypeToPg
// ============================================================

describe('mapVbaTypeToPg', () => {
  test('maps known VBA types', () => {
    expect(mapVbaTypeToPg('Long')).toBe('bigint');
    expect(mapVbaTypeToPg('Integer')).toBe('integer');
    expect(mapVbaTypeToPg('String')).toBe('text');
    expect(mapVbaTypeToPg('Double')).toBe('double precision');
    expect(mapVbaTypeToPg('Boolean')).toBe('boolean');
    expect(mapVbaTypeToPg('Currency')).toBe('numeric(19,4)');
    expect(mapVbaTypeToPg('Date')).toBe('timestamp');
    expect(mapVbaTypeToPg('Byte')).toBe('smallint');
    expect(mapVbaTypeToPg('Single')).toBe('real');
  });

  test('returns text for Variant and unknown types', () => {
    expect(mapVbaTypeToPg('Variant')).toBe('text');
    expect(mapVbaTypeToPg('SomeCustomType')).toBe('text');
    expect(mapVbaTypeToPg(null)).toBe('text');
    expect(mapVbaTypeToPg(undefined)).toBe('text');
  });

  test('maps enum types to integer when enumNames provided', () => {
    const enumNames = new Set(['enumstrings', 'enumcolors']);
    expect(mapVbaTypeToPg('enumStrings', enumNames)).toBe('integer');
    expect(mapVbaTypeToPg('EnumColors', enumNames)).toBe('integer');
    // Known types still take precedence
    expect(mapVbaTypeToPg('Long', enumNames)).toBe('bigint');
    // Unknown types without enum match stay text
    expect(mapVbaTypeToPg('SomeClass', enumNames)).toBe('text');
  });
});

// ============================================================
// parseVbaDeclarations
// ============================================================

describe('parseVbaDeclarations', () => {
  test('parses a simple public function', () => {
    const source = `
Public Function ProductAllocated(ProductID As Long) As Double
  ' body
End Function
`;
    const decls = parseVbaDeclarations(source);
    expect(decls).toHaveLength(1);
    expect(decls[0].name).toBe('ProductAllocated');
    expect(decls[0].returnType).toBe('Double');
    expect(decls[0].isSub).toBe(false);
    expect(decls[0].params).toEqual([{ name: 'ProductID', type: 'Long' }]);
  });

  test('parses a sub with no params', () => {
    const source = `
Public Sub InitApp()
  ' body
End Sub
`;
    const decls = parseVbaDeclarations(source);
    expect(decls).toHaveLength(1);
    expect(decls[0].name).toBe('InitApp');
    expect(decls[0].isSub).toBe(true);
    expect(decls[0].params).toEqual([]);
    expect(decls[0].returnType).toBeNull();
  });

  test('parses multiple functions from one module', () => {
    const source = `
Public Function Foo(x As Integer) As String
End Function

Private Function Bar(a As Long, b As Double) As Boolean
End Function

Public Sub DoStuff(msg As String)
End Sub
`;
    const decls = parseVbaDeclarations(source);
    expect(decls).toHaveLength(3);
    expect(decls[0].name).toBe('Foo');
    expect(decls[1].name).toBe('Bar');
    expect(decls[1].params).toHaveLength(2);
    expect(decls[2].name).toBe('DoStuff');
    expect(decls[2].isSub).toBe(true);
  });

  test('handles ByVal, ByRef, Optional prefixes', () => {
    const source = `
Public Function Calc(ByVal x As Long, ByRef y As String, Optional z As Integer) As Double
End Function
`;
    const decls = parseVbaDeclarations(source);
    expect(decls[0].params).toEqual([
      { name: 'x', type: 'Long' },
      { name: 'y', type: 'String' },
      { name: 'z', type: 'Integer' }
    ]);
  });

  test('handles function with no type annotation (defaults to Variant)', () => {
    const source = `
Public Function Untyped(x)
End Function
`;
    const decls = parseVbaDeclarations(source);
    expect(decls[0].returnType).toBeNull();
    expect(decls[0].params).toEqual([{ name: 'x', type: null }]);
  });

  test('returns empty array for null/empty source', () => {
    expect(parseVbaDeclarations(null)).toEqual([]);
    expect(parseVbaDeclarations('')).toEqual([]);
  });

  test('handles Static keyword', () => {
    const source = `
Public Static Function Counter() As Long
End Function
`;
    const decls = parseVbaDeclarations(source);
    expect(decls).toHaveLength(1);
    expect(decls[0].name).toBe('Counter');
  });

  test('handles ParamArray parameter', () => {
    const source = `
Public Function GetString(ByVal ID As enumStrings, ParamArray params() As Variant) As String
End Function
`;
    const decls = parseVbaDeclarations(source);
    expect(decls).toHaveLength(1);
    expect(decls[0].name).toBe('GetString');
    expect(decls[0].returnType).toBe('String');
    expect(decls[0].params).toHaveLength(2);
    expect(decls[0].params[0]).toEqual({ name: 'ID', type: 'enumStrings' });
    expect(decls[0].params[1]).toEqual({ name: 'params', type: 'Variant', isParamArray: true });
  });
});

// ============================================================
// collectEnumNames
// ============================================================

describe('collectEnumNames', () => {
  test('collects public and private enum names', () => {
    const source = `
Public Enum enumStrings
    sHelloWorld = 1
    sGoodbye = 2
End Enum

Private Enum enumColors
    Red = 1
    Blue = 2
End Enum
`;
    const enums = collectEnumNames(source);
    expect(enums.has('enumstrings')).toBe(true);
    expect(enums.has('enumcolors')).toBe(true);
  });

  test('returns empty set for null/empty source', () => {
    expect(collectEnumNames(null).size).toBe(0);
    expect(collectEnumNames('').size).toBe(0);
  });

  test('collects enum without access modifier', () => {
    const source = `
Enum SimpleEnum
    A = 1
End Enum
`;
    const enums = collectEnumNames(source);
    expect(enums.has('simpleenum')).toBe(true);
  });
});

// ============================================================
// buildStubDDL
// ============================================================

describe('buildStubDDL', () => {
  test('generates function stub with params and return type', () => {
    const decl = {
      name: 'ProductAllocated',
      params: [{ name: 'ProductID', type: 'Long' }],
      returnType: 'Double',
      isSub: false
    };
    const sql = buildStubDDL('db_northwind', decl);
    expect(sql).toContain('"db_northwind"."productallocated"');
    expect(sql).toContain('"productid" bigint');
    expect(sql).toContain('RETURNS double precision');
    expect(sql).toContain('RETURN NULL');
    expect(sql).toContain('LANGUAGE plpgsql');
  });

  test('generates void function for sub', () => {
    const decl = {
      name: 'DoStuff',
      params: [],
      returnType: null,
      isSub: true
    };
    const sql = buildStubDDL('db_northwind', decl);
    expect(sql).toContain('RETURNS void');
    expect(sql).toContain('LANGUAGE plpgsql');
  });

  test('uses anyelement type for untyped/Variant params', () => {
    const decl = {
      name: 'Untyped',
      params: [{ name: 'x', type: null }],
      returnType: null,
      isSub: false
    };
    const sql = buildStubDDL('db_northwind', decl);
    expect(sql).toContain('"x" anyelement');
    expect(sql).toContain('RETURNS text');
    expect(sql).toContain('LANGUAGE sql');
  });

  test('excludes ParamArray params from stub signature', () => {
    const decl = {
      name: 'GetString',
      params: [
        { name: 'ID', type: 'enumStrings' },
        { name: 'params', type: 'Variant', isParamArray: true }
      ],
      returnType: 'String',
      isSub: false
    };
    const sql = buildStubDDL('db_northwind', decl);
    // Should only have the ID param, not the ParamArray param
    expect(sql).toContain('"id"');
    expect(sql).not.toContain('"params"');
    expect(sql).toContain('RETURNS text');
  });

  test('maps enum type to integer when enumNames provided', () => {
    const decl = {
      name: 'GetString',
      params: [{ name: 'ID', type: 'enumStrings' }],
      returnType: 'String',
      isSub: false
    };
    const enumNames = new Set(['enumstrings']);
    const sql = buildStubDDL('db_northwind', decl, enumNames);
    expect(sql).toContain('"id" integer');
    expect(sql).toContain('RETURNS text');
    // integer param means no anyelement, so should use plpgsql
    expect(sql).toContain('LANGUAGE plpgsql');
  });
});
