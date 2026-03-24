const {
  translateStatement, translateCondition, stripBoilerplate,
  parseIfBlock, translateBlock, findEndKeyword,
  parseVbaToHandlers,
} = require('../lib/vba-to-js');

// ============================================================
// translateStatement
// ============================================================

describe('translateStatement', () => {
  test('DoCmd.Close with formName', () => {
    expect(translateStatement('DoCmd.Close acForm, Me.Name', 'frmMain'))
      .toBe('AC.closeForm("frmMain")');
  });

  test('DoCmd.Close without formName', () => {
    expect(translateStatement('DoCmd.Close')).toBe('AC.closeForm()');
  });

  test('DoCmd.OpenForm simple', () => {
    expect(translateStatement('DoCmd.OpenForm "frmDetails"'))
      .toBe('AC.openForm("frmDetails")');
  });

  test('DoCmd.OpenForm with where clause', () => {
    expect(translateStatement('DoCmd.OpenForm "frmDetails", acNormal, , "ID=5"'))
      .toBe('AC.openForm("frmDetails", "ID=5")');
  });

  test('DoCmd.OpenReport', () => {
    expect(translateStatement('DoCmd.OpenReport "rptSales"'))
      .toBe('AC.openReport("rptSales")');
  });

  test('DoCmd.GoToRecord acNewRec', () => {
    expect(translateStatement('DoCmd.GoToRecord , , acNewRec'))
      .toBe('AC.gotoRecord("new")');
  });

  test('DoCmd.GoToRecord acFirst/acLast/acNext/acPrevious', () => {
    expect(translateStatement('DoCmd.GoToRecord , , acFirst')).toBe('AC.gotoRecord("first")');
    expect(translateStatement('DoCmd.GoToRecord , , acLast')).toBe('AC.gotoRecord("last")');
    expect(translateStatement('DoCmd.GoToRecord , , acNext')).toBe('AC.gotoRecord("next")');
    expect(translateStatement('DoCmd.GoToRecord , , acPrevious')).toBe('AC.gotoRecord("previous")');
  });

  test('DoCmd.RunSQL', () => {
    expect(translateStatement('DoCmd.RunSQL "DELETE FROM tblTemp"'))
      .toBe('AC.runSQL("DELETE FROM tblTemp")');
  });

  test('DoCmd.Quit maps to closeForm', () => {
    expect(translateStatement('DoCmd.Quit', 'frmMain'))
      .toBe('AC.closeForm("frmMain")');
  });

  test('DoCmd.Requery', () => {
    expect(translateStatement('DoCmd.Requery')).toBe('AC.requery()');
  });

  test('DoCmd.Save', () => {
    expect(translateStatement('DoCmd.Save')).toBe('AC.saveRecord()');
  });

  test('DoCmd.RunCommand acCmdSaveRecord', () => {
    expect(translateStatement('DoCmd.RunCommand acCmdSaveRecord'))
      .toBe('AC.saveRecord()');
  });

  test('MsgBox', () => {
    expect(translateStatement('MsgBox "Hello World"'))
      .toBe('alert("Hello World")');
  });

  test('Me.Requery and Me.Refresh', () => {
    expect(translateStatement('Me.Requery')).toBe('AC.requery()');
    expect(translateStatement('Me.Refresh')).toBe('AC.requery()');
  });

  test('Me.control.Visible', () => {
    expect(translateStatement('Me.btnSave.Visible = True'))
      .toBe('AC.setVisible("btnSave", true)');
    expect(translateStatement('Me.btnSave.Visible = False'))
      .toBe('AC.setVisible("btnSave", false)');
  });

  test('Me.control.Enabled', () => {
    expect(translateStatement('Me.txtName.Enabled = True'))
      .toBe('AC.setEnabled("txtName", true)');
    expect(translateStatement('Me.txtName.Enabled = False'))
      .toBe('AC.setEnabled("txtName", false)');
  });

  test('SourceObject assignment', () => {
    expect(translateStatement('Me.subMain.SourceObject = "frmChild"'))
      .toBe('AC.setSubformSource("subMain", "frmChild")');
  });

  test('Caption assignment', () => {
    expect(translateStatement('Me.lblTitle.Caption = "Welcome"'))
      .toBe('AC.setValue("lblTitle", "Welcome")');
  });

  test('Me.control = value', () => {
    expect(translateStatement('Me.txtCount = 42'))
      .toBe('AC.setValue("txtCount", 42)');
    expect(translateStatement('Me.chkActive = True'))
      .toBe('AC.setValue("chkActive", true)');
  });

  test('unrecognized statement returns null', () => {
    expect(translateStatement('Dim x As Integer')).toBeNull();
    expect(translateStatement('Set rs = CurrentDb.OpenRecordset("SELECT 1")')).toBeNull();
  });
});

// ============================================================
// translateCondition
// ============================================================

describe('translateCondition', () => {
  test('True/False literals', () => {
    expect(translateCondition('True')).toBe('true');
    expect(translateCondition('False')).toBe('false');
    expect(translateCondition('true')).toBe('true');
  });

  test('Not <condition> with translatable inner', () => {
    expect(translateCondition('Not True')).toBe('!(true)');
    expect(translateCondition('Not False')).toBe('!(false)');
  });

  test('Not <condition> with untranslatable inner returns null', () => {
    expect(translateCondition('Not Me.NewRecord')).toBeNull();
  });

  test('Me.NewRecord returns null', () => {
    expect(translateCondition('Me.NewRecord')).toBeNull();
  });

  test('Me.Dirty returns null', () => {
    expect(translateCondition('Me.Dirty')).toBeNull();
  });

  test('IsNull(Me.OpenArgs) returns null', () => {
    expect(translateCondition('IsNull(Me.OpenArgs)')).toBeNull();
  });

  test('IsNull with Me.control returns null', () => {
    expect(translateCondition('IsNull(Me.txtName)')).toBeNull();
  });

  test('MsgBox = vbYes translates to confirm', () => {
    expect(translateCondition('MsgBox("Are you sure?", vbYesNo) = vbYes'))
      .toBe('confirm("Are you sure?")');
  });

  test('And with both sides translatable', () => {
    expect(translateCondition('True And False')).toBe('true && false');
  });

  test('Or with both sides translatable', () => {
    expect(translateCondition('True Or False')).toBe('true || false');
  });

  test('And with one side untranslatable returns null', () => {
    expect(translateCondition('True And Me.NewRecord')).toBeNull();
  });

  test('comparison with local VBA variable returns null', () => {
    expect(translateCondition('strAction = "Add"')).toBeNull();
  });

  test('empty/null input returns null', () => {
    expect(translateCondition('')).toBeNull();
    expect(translateCondition(null)).toBeNull();
  });
});

// ============================================================
// stripBoilerplate
// ============================================================

describe('stripBoilerplate', () => {
  test('strips basic boilerplate', () => {
    const body = [
      "On Error GoTo Err_Handler",
      "DoCmd.OpenForm \"frmMain\"",
      "Exit Sub",
      "Err_Handler:",
      "MsgBox Err.Description",
    ].join('\n');
    const result = stripBoilerplate(body);
    expect(result).toEqual(['DoCmd.OpenForm "frmMain"']);
  });

  test('strips line numbers', () => {
    const body = "10 DoCmd.Close\n20 DoCmd.Quit";
    const result = stripBoilerplate(body);
    expect(result).toEqual(['DoCmd.Close', 'DoCmd.Quit']);
  });

  test('strips comments', () => {
    const body = "' This is a comment\nDoCmd.Close";
    const result = stripBoilerplate(body);
    expect(result).toEqual(['DoCmd.Close']);
  });

  test('merges line continuations', () => {
    const body = [
      'If strAction = _',
      '    "Add" Then',
    ].join('\n');
    const result = stripBoilerplate(body);
    expect(result).toEqual(['If strAction = "Add" Then']);
  });

  test('merges multi-line continuations', () => {
    const body = [
      'If x = _',
      '    y And _',
      '    z Then',
    ].join('\n');
    const result = stripBoilerplate(body);
    expect(result).toEqual(['If x = y And z Then']);
  });

  test('preserves If/Else/End If structure', () => {
    const body = [
      'If True Then',
      '    DoCmd.Close',
      'Else',
      '    MsgBox "error"',
      'End If',
    ].join('\n');
    const result = stripBoilerplate(body);
    expect(result).toEqual([
      'If True Then',
      'DoCmd.Close',
      'Else',
      'MsgBox "error"',
      'End If',
    ]);
  });
});

// ============================================================
// findEndKeyword
// ============================================================

describe('findEndKeyword', () => {
  test('finds End Select', () => {
    const lines = ['Case "A"', 'DoCmd.Close', 'End Select'];
    expect(findEndKeyword(lines, 0, 'SELECT CASE')).toBe(2);
  });

  test('handles nested Select Case', () => {
    const lines = [
      'Case "A"',
      'Select Case y',
      'Case 1',
      'End Select',
      'Case "B"',
      'End Select',
    ];
    expect(findEndKeyword(lines, 0, 'SELECT CASE')).toBe(5);
  });

  test('finds Next for For loop', () => {
    const lines = ['x = x + 1', 'Next i'];
    expect(findEndKeyword(lines, 0, 'FOR')).toBe(1);
  });

  test('finds Loop for Do', () => {
    const lines = ['x = x + 1', 'Loop'];
    expect(findEndKeyword(lines, 0, 'DO')).toBe(1);
  });

  test('finds Wend for While', () => {
    const lines = ['x = x + 1', 'Wend'];
    expect(findEndKeyword(lines, 0, 'WHILE')).toBe(1);
  });

  test('finds End With', () => {
    const lines = ['.Name = "test"', 'End With'];
    expect(findEndKeyword(lines, 0, 'WITH')).toBe(1);
  });

  test('returns lines.length if not found', () => {
    const lines = ['x = 1', 'y = 2'];
    expect(findEndKeyword(lines, 0, 'SELECT CASE')).toBe(2);
  });
});

// ============================================================
// parseIfBlock
// ============================================================

describe('parseIfBlock', () => {
  test('simple If/End If with translatable condition', () => {
    const lines = [
      'If True Then',
      'DoCmd.Close',
      'End If',
    ];
    const result = parseIfBlock(lines, 0, 'frmTest');
    expect(result.endIdx).toBe(2);
    expect(result.jsLines.join('\n')).toContain('if (true)');
    expect(result.jsLines.join('\n')).toContain('AC.closeForm("frmTest");');
  });

  test('If/Else with translatable condition', () => {
    const lines = [
      'If True Then',
      'DoCmd.Close',
      'Else',
      'MsgBox "stay"',
      'End If',
    ];
    const result = parseIfBlock(lines, 0, 'frmTest');
    expect(result.endIdx).toBe(4);
    const js = result.jsLines.join('\n');
    expect(js).toContain('if (true)');
    expect(js).toContain('} else {');
    expect(js).toContain('AC.closeForm("frmTest");');
    expect(js).toContain('alert("stay");');
  });

  test('If/ElseIf/Else with translatable conditions', () => {
    const lines = [
      'If True Then',
      'DoCmd.Close',
      'ElseIf False Then',
      'DoCmd.Save',
      'Else',
      'MsgBox "other"',
      'End If',
    ];
    const result = parseIfBlock(lines, 0, 'frmTest');
    expect(result.endIdx).toBe(6);
    const js = result.jsLines.join('\n');
    expect(js).toContain('if (true)');
    expect(js).toContain('} else if (false)');
    expect(js).toContain('} else {');
  });

  test('untranslatable condition emits comment block', () => {
    const lines = [
      'If strAction = "Add" Then',
      'DoCmd.GoToRecord , , acNewRec',
      'Else',
      'MsgBox "unknown"',
      'End If',
    ];
    const result = parseIfBlock(lines, 0, 'frmTest');
    expect(result.endIdx).toBe(4);
    const js = result.jsLines.join('\n');
    expect(js).toContain('// [VBA If block - condition not translatable]');
    expect(js).toContain('// If strAction = "Add" Then');
    expect(js).not.toContain('AC.gotoRecord');
    expect(js).not.toContain('alert');
  });

  test('nested If blocks handled correctly', () => {
    const lines = [
      'If True Then',
      'If Me.NewRecord Then',
      'DoCmd.Close',
      'End If',
      'DoCmd.Save',
      'End If',
    ];
    const result = parseIfBlock(lines, 0, 'frmTest');
    expect(result.endIdx).toBe(5);
    const js = result.jsLines.join('\n');
    // Outer If is translatable (True), inner If body is recursively translated
    expect(js).toContain('if (true)');
  });

  test('empty branches produce valid output', () => {
    const lines = [
      'If True Then',
      'End If',
    ];
    const result = parseIfBlock(lines, 0, 'frmTest');
    expect(result.endIdx).toBe(1);
    expect(result.jsLines).toContain('if (true) {');
    expect(result.jsLines).toContain('}');
  });
});

// ============================================================
// translateBlock
// ============================================================

describe('translateBlock', () => {
  test('flat statements produce semicoloned output', () => {
    const lines = ['DoCmd.Close', 'DoCmd.Requery'];
    const result = translateBlock(lines, 0, 'frmTest');
    expect(result.jsLines).toEqual([
      'AC.closeForm("frmTest");',
      'AC.requery();',
    ]);
  });

  test('skips Dim, Set, Const, GoTo', () => {
    const lines = [
      'Dim x As Integer',
      'Set rs = Nothing',
      'Const MAX_VAL = 100',
      'GoTo Exit_Handler',
      'DoCmd.Close',
    ];
    const result = translateBlock(lines, 0, 'frmTest');
    expect(result.jsLines).toEqual(['AC.closeForm("frmTest");']);
  });

  test('single-line If with translatable condition', () => {
    const lines = ['If True Then DoCmd.Close'];
    const result = translateBlock(lines, 0, 'frmTest');
    expect(result.jsLines[0]).toBe('if (true) { AC.closeForm("frmTest"); }');
  });

  test('single-line If with untranslatable condition emits comment', () => {
    const lines = ['If x > 0 Then DoCmd.Close'];
    const result = translateBlock(lines, 0, 'frmTest');
    expect(result.jsLines[0]).toMatch(/^\/\/ If x > 0 Then DoCmd\.Close/);
  });

  test('Select Case skipped with comment', () => {
    const lines = [
      'Select Case x',
      'Case "A"',
      'DoCmd.Close',
      'Case "B"',
      'DoCmd.Save',
      'End Select',
      'DoCmd.Requery',
    ];
    const result = translateBlock(lines, 0, 'frmTest');
    expect(result.jsLines[0]).toBe('// [VBA Select Case block skipped]');
    expect(result.jsLines[1]).toBe('AC.requery();');
  });

  test('For loop skipped with comment', () => {
    const lines = [
      'For i = 1 To 10',
      'DoCmd.Close',
      'Next i',
      'DoCmd.Requery',
    ];
    const result = translateBlock(lines, 0, 'frmTest');
    expect(result.jsLines[0]).toBe('// [VBA For loop skipped]');
    expect(result.jsLines[1]).toBe('AC.requery();');
  });

  test('For Each loop skipped with comment', () => {
    const lines = [
      'For Each ctl In Me.Controls',
      'ctl.Visible = True',
      'Next ctl',
    ];
    const result = translateBlock(lines, 0, 'frmTest');
    expect(result.jsLines[0]).toBe('// [VBA For Each loop skipped]');
  });

  test('Do loop skipped with comment', () => {
    const lines = [
      'Do While Not rs.EOF',
      'rs.MoveNext',
      'Loop',
    ];
    const result = translateBlock(lines, 0, 'frmTest');
    expect(result.jsLines[0]).toBe('// [VBA Do loop skipped]');
  });

  test('While/Wend skipped with comment', () => {
    const lines = [
      'While x > 0',
      'x = x - 1',
      'Wend',
    ];
    const result = translateBlock(lines, 0, 'frmTest');
    expect(result.jsLines[0]).toBe('// [VBA While loop skipped]');
  });

  test('With block skipped with comment', () => {
    const lines = [
      'With Me.txtName',
      '.Visible = True',
      'End With',
    ];
    const result = translateBlock(lines, 0, 'frmTest');
    expect(result.jsLines[0]).toBe('// [VBA With block skipped]');
  });

  test('block If integrated into translateBlock', () => {
    const lines = [
      'DoCmd.Save',
      'If True Then',
      'DoCmd.Close',
      'End If',
      'DoCmd.Requery',
    ];
    const result = translateBlock(lines, 0, 'frmTest');
    expect(result.jsLines[0]).toBe('AC.saveRecord();');
    expect(result.jsLines).toContain('if (true) {');
    expect(result.jsLines[result.jsLines.length - 1]).toBe('AC.requery();');
  });

  test('unrecognized statements are silently dropped', () => {
    const lines = ['SomeUnknownCall "arg"', 'DoCmd.Close'];
    const result = translateBlock(lines, 0, 'frmTest');
    expect(result.jsLines).toEqual(['AC.closeForm("frmTest");']);
  });
});

// ============================================================
// parseVbaToHandlers (integration)
// ============================================================

describe('parseVbaToHandlers', () => {
  test('simple click handler', () => {
    const vba = `
Private Sub cmdClose_Click()
    DoCmd.Close
End Sub
`;
    const handlers = parseVbaToHandlers(vba, 'Form_frmMain');
    expect(handlers).toHaveLength(1);
    expect(handlers[0].key).toBe('cmd-close.on-click');
    expect(handlers[0].js).toContain('AC.closeForm("frmMain")');
  });

  test('handler with If/Else where condition is untranslatable', () => {
    const vba = `
Private Sub Form_Load()
    Dim strAction As String
    strAction = Nz(Me.OpenArgs, "")
    If strAction = "Add" Then
        DoCmd.GoToRecord , , acNewRec
    Else
        MsgBox "An unknown action has been requested."
    End If
End Sub
`;
    const handlers = parseVbaToHandlers(vba, 'Form_frmCompanyDetail');
    // The If block condition is untranslatable, so it becomes comments
    // No real JS lines remain → handler should not be emitted
    expect(handlers).toHaveLength(0);
  });

  test('handler with translatable If/Else', () => {
    const vba = `
Private Sub cmdToggle_Click()
    If True Then
        Me.subPanel.Visible = True
    Else
        Me.subPanel.Visible = False
    End If
End Sub
`;
    const handlers = parseVbaToHandlers(vba, 'Form_frmMain');
    expect(handlers).toHaveLength(1);
    const js = handlers[0].js;
    expect(js).toContain('if (true)');
    expect(js).toContain('AC.setVisible("subPanel", true);');
    expect(js).toContain('AC.setVisible("subPanel", false);');
  });

  test('backward compat: flat handler produces same output', () => {
    const vba = `
Private Sub cmdSave_Click()
    DoCmd.RunCommand acCmdSaveRecord
    DoCmd.Close
End Sub
`;
    const handlers = parseVbaToHandlers(vba, 'Form_frmEdit');
    expect(handlers).toHaveLength(1);
    const js = handlers[0].js;
    expect(js).toContain('AC.saveRecord();');
    expect(js).toContain('AC.closeForm("frmEdit");');
  });

  test('handler with mixed translatable and untranslatable code', () => {
    const vba = `
Private Sub Form_Load()
    DoCmd.Requery
    If strMode = "Edit" Then
        Me.btnSave.Visible = True
    End If
End Sub
`;
    const handlers = parseVbaToHandlers(vba, 'Form_frmData');
    expect(handlers).toHaveLength(1);
    const js = handlers[0].js;
    // DoCmd.Requery translates; the If block is commented out
    expect(js).toContain('AC.requery();');
    expect(js).toContain('// [VBA If block - condition not translatable]');
  });

  test('handler with Select Case skipped', () => {
    const vba = `
Private Sub Form_Load()
    DoCmd.Save
    Select Case Me.OpenArgs
        Case "Add"
            DoCmd.GoToRecord , , acNewRec
        Case "Edit"
            DoCmd.Requery
    End Select
End Sub
`;
    const handlers = parseVbaToHandlers(vba, 'Form_frmX');
    expect(handlers).toHaveLength(1);
    const js = handlers[0].js;
    expect(js).toContain('AC.saveRecord();');
    expect(js).toContain('// [VBA Select Case block skipped]');
  });

  test('handler skips Dim/Set/Const statements', () => {
    const vba = `
Private Sub cmdRun_Click()
    Dim rs As DAO.Recordset
    Set rs = CurrentDb.OpenRecordset("tbl")
    DoCmd.Close
End Sub
`;
    const handlers = parseVbaToHandlers(vba, 'Form_frmRun');
    expect(handlers).toHaveLength(1);
    expect(handlers[0].js).toContain('AC.closeForm("frmRun");');
    expect(handlers[0].js).not.toContain('Dim');
    expect(handlers[0].js).not.toContain('Set');
  });

  test('line continuations merged before translation', () => {
    const vba = `
Private Sub cmdOpen_Click()
    DoCmd.OpenForm _
        "frmDetails"
End Sub
`;
    const handlers = parseVbaToHandlers(vba, 'Form_frmMain');
    expect(handlers).toHaveLength(1);
    expect(handlers[0].js).toContain('AC.openForm("frmDetails")');
  });

  test('form events use form control key', () => {
    const vba = `
Private Sub Form_Current()
    DoCmd.Requery
End Sub
`;
    const handlers = parseVbaToHandlers(vba, 'Form_frmNav');
    expect(handlers).toHaveLength(1);
    expect(handlers[0].key).toBe('form.on-current');
    expect(handlers[0].control).toBe('form');
  });

  test('report events use report control key', () => {
    const vba = `
Private Sub Report_Open(Cancel As Integer)
    DoCmd.Requery
End Sub
`;
    const handlers = parseVbaToHandlers(vba, 'Report_rptSales');
    expect(handlers).toHaveLength(1);
    expect(handlers[0].key).toBe('report.on-open');
    expect(handlers[0].control).toBe('report');
  });

  test('empty source returns empty array', () => {
    expect(parseVbaToHandlers('')).toEqual([]);
    expect(parseVbaToHandlers(null)).toEqual([]);
  });

  test('frmCompanyDetail Form_Load pattern — no accidental execution', () => {
    // Real-world pattern: condition references local VBA variable
    const vba = `
Option Compare Database
Option Explicit

Private Sub Form_Load()
    On Error GoTo Err_Handler
    Dim strAction As String
    strAction = Nz(Me.OpenArgs, "")
    If strAction = "Add" Then
        DoCmd.GoToRecord , , acNewRec
        Me.txtCompanyName.SetFocus
    ElseIf strAction = "Edit" Then
        ' Already on current record
    Else
        MsgBox "An unknown action has been requested."
    End If
    Exit Sub
Err_Handler:
    MsgBox Err.Description
End Sub
`;
    const handlers = parseVbaToHandlers(vba, 'Form_frmCompanyDetail');
    // All conditions reference strAction (local var) → untranslatable
    // No real JS → no handler emitted
    expect(handlers).toHaveLength(0);
  });
});
