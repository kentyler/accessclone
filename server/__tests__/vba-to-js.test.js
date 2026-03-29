const {
  translateStatement, translateCondition, stripBoilerplate,
  parseIfBlock, translateBlock, findEndKeyword,
  parseVbaToHandlers, translateAssignmentRHS,
  parseSelectCaseBlock, parseForLoop,
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
// translateAssignmentRHS
// ============================================================

describe('translateAssignmentRHS', () => {
  test('string literal', () => {
    expect(translateAssignmentRHS('"Hello"')).toBe('"Hello"');
  });

  test('numeric literal', () => {
    expect(translateAssignmentRHS('42')).toBe('42');
    expect(translateAssignmentRHS('3.14')).toBe('3.14');
  });

  test('boolean literals', () => {
    expect(translateAssignmentRHS('True')).toBe('true');
    expect(translateAssignmentRHS('False')).toBe('false');
  });

  test('Me.OpenArgs', () => {
    expect(translateAssignmentRHS('Me.OpenArgs')).toBe('AC.getOpenArgs()');
  });

  test('Me.ControlName → AC.getValue', () => {
    expect(translateAssignmentRHS('Me.txtName')).toBe('AC.getValue("txtName")');
    expect(translateAssignmentRHS('Me.cboStatus')).toBe('AC.getValue("cboStatus")');
  });

  test('Me.Name (non-control property) returns null', () => {
    expect(translateAssignmentRHS('Me.Name')).toBeNull();
    expect(translateAssignmentRHS('Me.RecordSource')).toBeNull();
  });

  test('Nz(Me.OpenArgs, "")', () => {
    expect(translateAssignmentRHS('Nz(Me.OpenArgs, "")')).toBe('AC.nz(AC.getOpenArgs(), "")');
  });

  test('Nz(Me.ctrl, default)', () => {
    expect(translateAssignmentRHS('Nz(Me.txtId, 0)')).toBe('AC.nz(AC.getValue("txtId"), 0)');
  });

  test('Nz with single arg', () => {
    expect(translateAssignmentRHS('Nz(Me.OpenArgs)')).toBe('AC.nz(AC.getOpenArgs())');
  });

  test('complex expression returns null', () => {
    expect(translateAssignmentRHS('CurrentDb.OpenRecordset("tbl")')).toBeNull();
    expect(translateAssignmentRHS('DLookup("Name", "tbl")')).toBeNull();
  });

  test('empty/null returns null', () => {
    expect(translateAssignmentRHS('')).toBeNull();
    expect(translateAssignmentRHS(null)).toBeNull();
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

  test('Not Me.NewRecord translates', () => {
    expect(translateCondition('Not Me.NewRecord')).toBe('!(AC.isNewRecord())');
  });

  test('Me.NewRecord → AC.isNewRecord()', () => {
    expect(translateCondition('Me.NewRecord')).toBe('AC.isNewRecord()');
  });

  test('Me.Dirty → AC.isDirty()', () => {
    expect(translateCondition('Me.Dirty')).toBe('AC.isDirty()');
  });

  test('IsNull(Me.OpenArgs) → AC.getOpenArgs() == null', () => {
    expect(translateCondition('IsNull(Me.OpenArgs)')).toBe('AC.getOpenArgs() == null');
  });

  test('IsNull(Me.ctrl) → AC.getValue("ctrl") == null', () => {
    expect(translateCondition('IsNull(Me.txtName)')).toBe('AC.getValue("txtName") == null');
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

  test('And with Me.NewRecord translates', () => {
    expect(translateCondition('True And Me.NewRecord')).toBe('true && AC.isNewRecord()');
  });

  test('comparison with unknown variable returns null', () => {
    expect(translateCondition('strAction = "Add"')).toBeNull();
  });

  test('empty/null input returns null', () => {
    expect(translateCondition('')).toBeNull();
    expect(translateCondition(null)).toBeNull();
  });

  // --- New: translateCondition with assignedVars ---

  test('variable comparison with assignedVars', () => {
    const vars = new Set(['straction']);
    expect(translateCondition('strAction = "Add"', vars)).toBe('strAction === "Add"');
    expect(translateCondition('strAction <> "Delete"', vars)).toBe('strAction !== "Delete"');
    expect(translateCondition('strAction = "Edit"', vars)).toBe('strAction === "Edit"');
  });

  test('variable comparison with number', () => {
    const vars = new Set(['intmode']);
    expect(translateCondition('intMode = 1', vars)).toBe('intMode === 1');
    expect(translateCondition('intMode > 0', vars)).toBe('intMode > 0');
    expect(translateCondition('intMode <> 0', vars)).toBe('intMode !== 0');
  });

  test('variable comparison without assignedVars returns null', () => {
    expect(translateCondition('strAction = "Add"')).toBeNull();
    expect(translateCondition('strAction = "Add"', new Set())).toBeNull();
  });

  test('Me.ctrl.Visible = True/False', () => {
    expect(translateCondition('Me.btnSave.Visible = True')).toBe('AC.getVisible("btnSave")');
    expect(translateCondition('Me.btnSave.Visible = False')).toBe('!(AC.getVisible("btnSave"))');
    expect(translateCondition('Me.panel.Visible = -1')).toBe('AC.getVisible("panel")');
    expect(translateCondition('Me.panel.Visible = 0')).toBe('!(AC.getVisible("panel"))');
  });

  test('Me.ctrl.Enabled = True/False', () => {
    expect(translateCondition('Me.txtName.Enabled = True')).toBe('AC.getEnabled("txtName")');
    expect(translateCondition('Me.txtName.Enabled = False')).toBe('!(AC.getEnabled("txtName"))');
  });

  test('Me.ctrl = literal in condition', () => {
    expect(translateCondition('Me.cboStatus = "Active"')).toBe('AC.getValue("cboStatus") === "Active"');
    expect(translateCondition('Me.txtCount = 0')).toBe('AC.getValue("txtCount") === 0');
  });

  test('IsNull(variable) with assignedVars', () => {
    const vars = new Set(['straction']);
    expect(translateCondition('IsNull(strAction)', vars)).toBe('strAction == null');
  });

  test('And/Or with assignedVars passes through', () => {
    const vars = new Set(['straction']);
    expect(translateCondition('strAction = "Add" And True', vars))
      .toBe('strAction === "Add" && true');
    expect(translateCondition('strAction = "A" Or strAction = "B"', vars))
      .toBe('strAction === "A" || strAction === "B"');
  });

  test('Not with assignedVars', () => {
    const vars = new Set(['straction']);
    expect(translateCondition('Not IsNull(strAction)', vars)).toBe('!(strAction == null)');
  });

  test('Me.Dirty And Me.NewRecord compound', () => {
    expect(translateCondition('Me.Dirty And Me.NewRecord'))
      .toBe('AC.isDirty() && AC.isNewRecord()');
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
    // No assignedVars → strAction is unknown → untranslatable
    const result = parseIfBlock(lines, 0, 'frmTest');
    expect(result.endIdx).toBe(4);
    const js = result.jsLines.join('\n');
    expect(js).toContain('// [VBA If block - condition not translatable]');
    expect(js).toContain('// If strAction = "Add" Then');
    expect(js).not.toContain('AC.gotoRecord');
    expect(js).not.toContain('alert');
  });

  test('If with assignedVars translates condition', () => {
    const lines = [
      'If strAction = "Add" Then',
      'DoCmd.GoToRecord , , acNewRec',
      'Else',
      'MsgBox "unknown"',
      'End If',
    ];
    const vars = new Set(['straction']);
    const assigned = new Set(['straction']);
    const result = parseIfBlock(lines, 0, 'frmTest', vars, assigned);
    expect(result.endIdx).toBe(4);
    const js = result.jsLines.join('\n');
    expect(js).toContain('if (strAction === "Add")');
    expect(js).toContain('AC.gotoRecord("new");');
    expect(js).toContain('alert("unknown");');
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
    // Outer If is translatable (True), inner If (Me.NewRecord) now also translatable
    expect(js).toContain('if (true)');
    expect(js).toContain('AC.isNewRecord()');
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

  test('Dim emits let, Set/Const/GoTo skipped', () => {
    const lines = [
      'Dim x As Integer',
      'Set rs = Nothing',
      'Const MAX_VAL = 100',
      'GoTo Exit_Handler',
      'DoCmd.Close',
    ];
    const result = translateBlock(lines, 0, 'frmTest');
    expect(result.jsLines).toEqual(['let x;', 'AC.closeForm("frmTest");']);
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

  test('Select Case with unknown expr emits comment', () => {
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
    expect(result.jsLines[0]).toBe('// [VBA Select Case - expression not translatable]');
    // Last line is still the requery after all the comment lines
    expect(result.jsLines[result.jsLines.length - 1]).toBe('AC.requery();');
  });

  test('numeric For loop translates', () => {
    const lines = [
      'For i = 1 To 10',
      'DoCmd.Close',
      'Next i',
      'DoCmd.Requery',
    ];
    const result = translateBlock(lines, 0, 'frmTest');
    expect(result.jsLines[0]).toBe('for (let i = 1; i <= 10; i++) {');
    expect(result.jsLines[1]).toBe('  AC.closeForm("frmTest");');
    expect(result.jsLines[2]).toBe('}');
    expect(result.jsLines[3]).toBe('AC.requery();');
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

  // --- New: variable tracking ---

  test('Dim + assignment tracks variable', () => {
    const lines = [
      'Dim strAction As String',
      'strAction = "Add"',
      'If strAction = "Add" Then',
      'DoCmd.GoToRecord , , acNewRec',
      'End If',
    ];
    const result = translateBlock(lines, 0, 'frmTest');
    const js = result.jsLines.join('\n');
    expect(js).toContain('let strAction;');
    expect(js).toContain('strAction = "Add";');
    expect(js).toContain('if (strAction === "Add")');
    expect(js).toContain('AC.gotoRecord("new");');
  });

  test('Dim + Me.OpenArgs assignment', () => {
    const lines = [
      'Dim strAction As String',
      'strAction = Nz(Me.OpenArgs, "")',
      'If strAction = "Add" Then',
      'DoCmd.GoToRecord , , acNewRec',
      'Else',
      'MsgBox "other"',
      'End If',
    ];
    const result = translateBlock(lines, 0, 'frmTest');
    const js = result.jsLines.join('\n');
    expect(js).toContain('let strAction;');
    expect(js).toContain('strAction = AC.nz(AC.getOpenArgs(), "");');
    expect(js).toContain('if (strAction === "Add")');
    expect(js).toContain('AC.gotoRecord("new");');
    expect(js).toContain('} else {');
    expect(js).toContain('alert("other");');
  });

  test('Dim + untranslatable RHS emits comment', () => {
    const lines = [
      'Dim rs As DAO.Recordset',
      'rs = CurrentDb.OpenRecordset("tbl")',
      'DoCmd.Close',
    ];
    const result = translateBlock(lines, 0, 'frmTest');
    const js = result.jsLines.join('\n');
    expect(js).toContain('let rs;');
    expect(js).toContain('// rs = CurrentDb.OpenRecordset("tbl")');
    expect(js).toContain('AC.closeForm("frmTest");');
  });

  test('assignment without Dim does not track', () => {
    const lines = [
      'strAction = "Add"',
      'If strAction = "Add" Then',
      'DoCmd.Close',
      'End If',
    ];
    const result = translateBlock(lines, 0, 'frmTest');
    const js = result.jsLines.join('\n');
    // strAction is not declared, so assignment is not captured and If is untranslatable
    expect(js).toContain('// [VBA If block - condition not translatable]');
  });

  test('Dim + Me.ctrl assignment', () => {
    const lines = [
      'Dim val As String',
      'val = Me.txtName',
    ];
    const result = translateBlock(lines, 0, 'frmTest');
    const js = result.jsLines.join('\n');
    expect(js).toContain('let val;');
    expect(js).toContain('val = AC.getValue("txtName");');
  });
});

// ============================================================
// Select Case
// ============================================================

describe('parseSelectCaseBlock', () => {
  test('string switch with assigned variable', () => {
    const lines = [
      'Select Case strAction',
      'Case "Add"',
      'DoCmd.GoToRecord , , acNewRec',
      'Case "Edit"',
      'DoCmd.Requery',
      'Case Else',
      'MsgBox "unknown"',
      'End Select',
    ];
    const vars = new Set(['straction']);
    const assigned = new Set(['straction']);
    const result = parseSelectCaseBlock(lines, 0, 'frmTest', vars, assigned);
    const js = result.jsLines.join('\n');
    expect(js).toContain('switch (strAction)');
    expect(js).toContain('case "Add":');
    expect(js).toContain('AC.gotoRecord("new");');
    expect(js).toContain('case "Edit":');
    expect(js).toContain('AC.requery();');
    expect(js).toContain('default:');
    expect(js).toContain('alert("unknown");');
    expect(js).toContain('break;');
  });

  test('numeric switch', () => {
    const lines = [
      'Select Case intMode',
      'Case 1',
      'DoCmd.Close',
      'Case 2, 3',
      'DoCmd.Save',
      'End Select',
    ];
    const vars = new Set(['intmode']);
    const assigned = new Set(['intmode']);
    const result = parseSelectCaseBlock(lines, 0, 'frmTest', vars, assigned);
    const js = result.jsLines.join('\n');
    expect(js).toContain('switch (intMode)');
    expect(js).toContain('case 1:');
    expect(js).toContain('case 2:');
    expect(js).toContain('case 3:');
  });

  test('Case Is comparisons → if/else chain', () => {
    const lines = [
      'Select Case intScore',
      'Case Is >= 90',
      'MsgBox "A"',
      'Case Is >= 80',
      'MsgBox "B"',
      'Case Else',
      'MsgBox "F"',
      'End Select',
    ];
    const vars = new Set(['intscore']);
    const assigned = new Set(['intscore']);
    const result = parseSelectCaseBlock(lines, 0, 'frmTest', vars, assigned);
    const js = result.jsLines.join('\n');
    expect(js).toContain('if (intScore >= 90)');
    expect(js).toContain('} else if (intScore >= 80)');
    expect(js).toContain('} else {');
    expect(js).not.toContain('switch');
  });

  test('Me.OpenArgs as switch expression', () => {
    const lines = [
      'Select Case Me.OpenArgs',
      'Case "Add"',
      'DoCmd.GoToRecord , , acNewRec',
      'Case "Edit"',
      'DoCmd.Requery',
      'End Select',
    ];
    const result = parseSelectCaseBlock(lines, 0, 'frmTest');
    const js = result.jsLines.join('\n');
    expect(js).toContain('switch (AC.getOpenArgs())');
    expect(js).toContain('case "Add":');
    expect(js).toContain('case "Edit":');
  });

  test('Me.ctrl as switch expression', () => {
    const lines = [
      'Select Case Me.cboType',
      'Case "A"',
      'DoCmd.Close',
      'End Select',
    ];
    const result = parseSelectCaseBlock(lines, 0, 'frmTest');
    const js = result.jsLines.join('\n');
    expect(js).toContain('switch (AC.getValue("cboType"))');
  });

  test('untranslatable expression emits comment', () => {
    const lines = [
      'Select Case DLookup("Type", "tbl")',
      'Case "A"',
      'DoCmd.Close',
      'End Select',
    ];
    const result = parseSelectCaseBlock(lines, 0, 'frmTest');
    const js = result.jsLines.join('\n');
    expect(js).toContain('// [VBA Select Case - expression not translatable]');
    expect(js).not.toContain('switch');
  });

  test('integration: Select Case in translateBlock with tracked variable', () => {
    const lines = [
      'Dim strMode As String',
      'strMode = Me.OpenArgs',
      'Select Case strMode',
      'Case "Add"',
      'DoCmd.GoToRecord , , acNewRec',
      'Case "Edit"',
      'DoCmd.Requery',
      'End Select',
    ];
    const result = translateBlock(lines, 0, 'frmTest');
    const js = result.jsLines.join('\n');
    expect(js).toContain('let strMode;');
    expect(js).toContain('strMode = AC.getOpenArgs();');
    expect(js).toContain('switch (strMode)');
    expect(js).toContain('case "Add":');
  });
});

// ============================================================
// For Loops
// ============================================================

describe('parseForLoop', () => {
  test('simple numeric For loop', () => {
    const lines = [
      'For i = 1 To 10',
      'DoCmd.Save',
      'Next i',
    ];
    const result = parseForLoop(lines, 0, 'frmTest');
    expect(result).not.toBeNull();
    const js = result.jsLines.join('\n');
    expect(js).toContain('for (let i = 1; i <= 10; i++)');
    expect(js).toContain('AC.saveRecord();');
  });

  test('For loop with Step -1', () => {
    const lines = [
      'For i = 10 To 1 Step -1',
      'DoCmd.Close',
      'Next i',
    ];
    const result = parseForLoop(lines, 0, 'frmTest');
    expect(result).not.toBeNull();
    const js = result.jsLines.join('\n');
    expect(js).toContain('for (let i = 10; i >= 1; i--)');
  });

  test('For loop with Step 2', () => {
    const lines = [
      'For i = 0 To 20 Step 2',
      'DoCmd.Save',
      'Next i',
    ];
    const result = parseForLoop(lines, 0, 'frmTest');
    expect(result).not.toBeNull();
    const js = result.jsLines.join('\n');
    expect(js).toContain('for (let i = 0; i <= 20; i += 2)');
  });

  test('non-numeric bounds returns null', () => {
    const lines = [
      'For i = 1 To UBound(arr)',
      'DoCmd.Close',
      'Next i',
    ];
    const result = parseForLoop(lines, 0, 'frmTest');
    expect(result).toBeNull();
  });

  test('integration: numeric For translated by translateBlock', () => {
    const lines = [
      'For j = 0 To 5',
      'MsgBox "hello"',
      'Next j',
    ];
    const result = translateBlock(lines, 0, 'frmTest');
    const js = result.jsLines.join('\n');
    expect(js).toContain('for (let j = 0; j <= 5; j++)');
    expect(js).toContain('alert("hello");');
  });

  test('non-numeric For falls back to skip comment', () => {
    const lines = [
      'For i = 1 To UBound(arr)',
      'DoCmd.Close',
      'Next i',
      'DoCmd.Requery',
    ];
    const result = translateBlock(lines, 0, 'frmTest');
    expect(result.jsLines[0]).toBe('// [VBA For loop skipped]');
    expect(result.jsLines[1]).toBe('AC.requery();');
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

  test('handler with Dim+assignment makes If/Else translatable', () => {
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
    // Variable tracking makes strAction translatable → handler IS emitted
    expect(handlers).toHaveLength(1);
    const js = handlers[0].js;
    expect(js).toContain('strAction = AC.nz(AC.getOpenArgs(), "");');
    expect(js).toContain('if (strAction === "Add")');
    expect(js).toContain('AC.gotoRecord("new");');
    expect(js).toContain('alert("An unknown action has been requested.");');
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
    // DoCmd.Requery translates; strMode has no Dim → If block is commented out
    expect(js).toContain('AC.requery();');
    expect(js).toContain('// [VBA If block - condition not translatable]');
  });

  test('handler with Select Case Me.OpenArgs translates to switch', () => {
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
    expect(js).toContain('switch (AC.getOpenArgs())');
    expect(js).toContain('case "Add":');
    expect(js).toContain('case "Edit":');
  });

  test('handler with Dim produces let, skips Set', () => {
    const vba = `
Private Sub cmdRun_Click()
    Dim rs As DAO.Recordset
    Set rs = CurrentDb.OpenRecordset("tbl")
    DoCmd.Close
End Sub
`;
    const handlers = parseVbaToHandlers(vba, 'Form_frmRun');
    expect(handlers).toHaveLength(1);
    const js = handlers[0].js;
    expect(js).toContain('AC.closeForm("frmRun");');
    expect(js).toContain('let rs;');
    expect(js).not.toContain('Set');
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

  test('frmCompanyDetail Form_Load pattern — now translatable with variable tracking', () => {
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
    // Variable tracking: strAction is declared and assigned → conditions translate
    expect(handlers).toHaveLength(1);
    const js = handlers[0].js;
    expect(js).toContain('let strAction;');
    expect(js).toContain('strAction = AC.nz(AC.getOpenArgs(), "");');
    expect(js).toContain('if (strAction === "Add")');
    expect(js).toContain('} else if (strAction === "Edit")');
    expect(js).toContain('} else {');
    expect(js).toContain('AC.gotoRecord("new");');
    expect(js).toContain('alert("An unknown action has been requested.");');
  });

  test('Me.NewRecord in handler condition', () => {
    const vba = `
Private Sub Form_BeforeUpdate(Cancel As Integer)
    If Me.NewRecord Then
        MsgBox "New record"
    Else
        MsgBox "Existing record"
    End If
End Sub
`;
    const handlers = parseVbaToHandlers(vba, 'Form_frmTest');
    expect(handlers).toHaveLength(1);
    const js = handlers[0].js;
    expect(js).toContain('if (AC.isNewRecord())');
    expect(js).toContain('alert("New record");');
    expect(js).toContain('alert("Existing record");');
  });

  test('Me.Dirty in handler condition', () => {
    const vba = `
Private Sub cmdSave_Click()
    If Me.Dirty Then
        DoCmd.RunCommand acCmdSaveRecord
    End If
End Sub
`;
    const handlers = parseVbaToHandlers(vba, 'Form_frmTest');
    expect(handlers).toHaveLength(1);
    const js = handlers[0].js;
    expect(js).toContain('if (AC.isDirty())');
    expect(js).toContain('AC.saveRecord();');
  });
});
