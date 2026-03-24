const { extractFunctionBody, findFunctionInModules } = require('../lib/vba-function-translator');
const { addSchemaFunctionPrefix } = require('../lib/query-converter/syntax');

// ============================================================
// extractFunctionBody
// ============================================================

describe('extractFunctionBody', () => {
  test('extracts a simple public function', () => {
    const source = `
Option Compare Database
Option Explicit

Public Function GetString(ByVal ID As enumStrings, ParamArray params() As Variant) As String
    Dim rs As DAO.Recordset
    Set rs = CurrentDb.OpenRecordset("SELECT StringValue FROM tblStrings WHERE StringID = " & ID)
    If Not rs.EOF Then
        GetString = rs!StringValue
    End If
    rs.Close
End Function

Public Sub InitApp()
    DoCmd.OpenForm "frmMain"
End Sub
`;
    const body = extractFunctionBody(source, 'GetString');
    expect(body).not.toBeNull();
    expect(body).toContain('Public Function GetString');
    expect(body).toContain('End Function');
    expect(body).toContain('tblStrings');
    expect(body).not.toContain('InitApp');
  });

  test('extracts a private function', () => {
    const source = `
Private Function CalcTotal(ByVal qty As Long, ByVal price As Double) As Double
    CalcTotal = qty * price
End Function
`;
    const body = extractFunctionBody(source, 'CalcTotal');
    expect(body).not.toBeNull();
    expect(body).toContain('Private Function CalcTotal');
    expect(body).toContain('qty * price');
  });

  test('is case-insensitive for function name', () => {
    const source = `
Public Function MyFunc() As String
    MyFunc = "hello"
End Function
`;
    expect(extractFunctionBody(source, 'myfunc')).not.toBeNull();
    expect(extractFunctionBody(source, 'MYFUNC')).not.toBeNull();
    expect(extractFunctionBody(source, 'MyFunc')).not.toBeNull();
  });

  test('returns null for non-existent function', () => {
    const source = `
Public Function Foo() As String
End Function
`;
    expect(extractFunctionBody(source, 'Bar')).toBeNull();
  });

  test('returns null for null/empty inputs', () => {
    expect(extractFunctionBody(null, 'Foo')).toBeNull();
    expect(extractFunctionBody('', 'Foo')).toBeNull();
    expect(extractFunctionBody('some code', null)).toBeNull();
  });

  test('extracts function with DLookup body', () => {
    const source = `
Public Function GetSetting(ByVal settingName As String) As String
    GetSetting = Nz(DLookup("SettingValue", "tblSettings", "SettingName = '" & settingName & "'"), "")
End Function
`;
    const body = extractFunctionBody(source, 'GetSetting');
    expect(body).toContain('DLookup');
    expect(body).toContain('tblSettings');
  });
});

// ============================================================
// findFunctionInModules
// ============================================================

describe('findFunctionInModules', () => {
  const modules = [
    {
      name: 'modUtilities',
      vba_source: `
Public Function GetString(ByVal ID As Long) As String
    GetString = DLookup("StringValue", "tblStrings", "StringID = " & ID)
End Function

Public Function FormatPhone(ByVal phone As String) As String
    FormatPhone = "(" & Left(phone, 3) & ") " & Mid(phone, 4, 3) & "-" & Right(phone, 4)
End Function
`
    },
    {
      name: 'modCalc',
      vba_source: `
Public Function CalcTotal(ByVal qty As Long, ByVal price As Double) As Double
    CalcTotal = qty * price
End Function
`
    }
  ];

  test('finds function in correct module', () => {
    const result = findFunctionInModules(modules, 'GetString');
    expect(result).not.toBeNull();
    expect(result.moduleName).toBe('modUtilities');
    expect(result.functionBody).toContain('GetString');
  });

  test('finds function case-insensitively', () => {
    const result = findFunctionInModules(modules, 'getstring');
    expect(result).not.toBeNull();
    expect(result.moduleName).toBe('modUtilities');
  });

  test('finds function in second module', () => {
    const result = findFunctionInModules(modules, 'CalcTotal');
    expect(result).not.toBeNull();
    expect(result.moduleName).toBe('modCalc');
  });

  test('returns null for non-existent function', () => {
    expect(findFunctionInModules(modules, 'NonExistent')).toBeNull();
  });

  test('returns null for empty modules array', () => {
    expect(findFunctionInModules([], 'GetString')).toBeNull();
  });
});

// ============================================================
// Expression converter schema-prefixing (Phase 4.5)
// ============================================================

describe('addSchemaFunctionPrefix in expressions', () => {
  test('prefixes simple function call', () => {
    const result = addSchemaFunctionPrefix('getstring(41)', 'db_northwind_15');
    expect(result).toBe('"db_northwind_15"."getstring"(41)');
  });

  test('does not prefix PG builtins', () => {
    const result = addSchemaFunctionPrefix('COALESCE(x, 0)', 'db_northwind_15');
    expect(result).toBe('COALESCE(x, 0)');
  });

  test('does not prefix SQL keywords', () => {
    const result = addSchemaFunctionPrefix('SELECT count(*) FROM t', 'db_northwind_15');
    expect(result).toContain('count(');
    expect(result).not.toContain('"count"');
  });

  test('prefixes multiple UDF calls', () => {
    const result = addSchemaFunctionPrefix('getstring(41) || formatphone(p_phone)', 'myschema');
    expect(result).toContain('"myschema"."getstring"(41)');
    expect(result).toContain('"myschema"."formatphone"(p_phone)');
  });

  test('does not double-prefix already qualified calls', () => {
    const result = addSchemaFunctionPrefix('"myschema"."getstring"(41)', 'myschema');
    // Should not add another prefix
    expect(result).toBe('"myschema"."getstring"(41)');
  });
});
