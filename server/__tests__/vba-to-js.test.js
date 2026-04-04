const {
  translateStatement, translateCondition, stripBoilerplate,
  parseIfBlock, translateBlock, findEndKeyword,
  parseVbaToHandlers, translateAssignmentRHS,
  parseSelectCaseBlock, parseForLoop,
  parseDoLoop, parseWhileWend, parseWithBlock, parseForEachLoop,
  translateExpression, parseFunctionCall, splitOnOperator,
  translateCriteria, collectModuleVars, collectEnumValues,
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

  test('DoCmd.RunSQL string literal', () => {
    expect(translateStatement('DoCmd.RunSQL "DELETE FROM tblTemp"'))
      .toBe('AC.runSQL("DELETE FROM tblTemp")');
  });

  test('DoCmd.RunSQL variable', () => {
    const vars = new Set(); const assigned = new Set(['strsql']);
    expect(translateStatement('DoCmd.RunSQL strSQL', null, vars, assigned))
      .toBe('AC.runSQL(strSQL)');
  });

  test('g_dbApp().Execute variable', () => {
    const vars = new Set(); const assigned = new Set(['strsql']);
    expect(translateStatement('g_dbApp().Execute strSQL, dbFailOnError', null, vars, assigned))
      .toBe('AC.runSQL(strSQL)');
  });

  test('CurrentDb.Execute variable', () => {
    const vars = new Set(); const assigned = new Set(['strsql']);
    expect(translateStatement('CurrentDb.Execute strSQL', null, vars, assigned))
      .toBe('AC.runSQL(strSQL)');
  });

  test('DoCmd.Close acForm with name', () => {
    expect(translateStatement('DoCmd.Close acForm, "frmGenericDialog", acSaveNo'))
      .toBe('AC.closeForm("frmGenericDialog")');
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
      .toBe('await AC.saveRecord()');
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

  test('Me.ctrl = enumValue with enum map', () => {
    const enumMap = new Map([['enumOrderStatus.osClosed', 3]]);
    expect(translateStatement('Me.OrderStatusID = enumOrderStatus.osClosed', 'frmOrders', enumMap))
      .toBe('AC.setValue("OrderStatusID", 3)');
  });

  test('Me.ctrl = variable with assignedVars', () => {
    const assignedVars = new Set(['myval']);
    expect(translateStatement('Me.Total = myVal', 'frmOrders', null, assignedVars))
      .toBe('AC.setValue("Total", myVal)');
  });

  test('TempVars!Name = True', () => {
    expect(translateStatement('TempVars!GenerateToC = True'))
      .toBe('AC.setTempVar("GenerateToC", true)');
  });

  test('TempVars!Name = string literal', () => {
    expect(translateStatement('TempVars!Mode = "Edit"'))
      .toBe('AC.setTempVar("Mode", "Edit")');
  });

  test('TempVars("Name") = value', () => {
    expect(translateStatement('TempVars("MyVar") = 42'))
      .toBe('AC.setTempVar("MyVar", 42)');
  });

  test('TempVars("Name").Value = value', () => {
    expect(translateStatement('TempVars("GenerateToC").Value = True'))
      .toBe('AC.setTempVar("GenerateToC", true)');
    expect(translateStatement('TempVars!Mode.Value = "Edit"'))
      .toBe('AC.setTempVar("Mode", "Edit")');
  });

  test('Me.ctrl = DLookup fallback via translateAssignmentRHS', () => {
    expect(translateStatement('Me.TaxStatusID = DLookup("StandardTaxStatusID", "Companies", "CompanyID = " & Me.CustomerID)'))
      .toBe('AC.setValue("TaxStatusID", await AC.dLookup("StandardTaxStatusID", "Companies", "CompanyID = " + AC.getValue("CustomerID")))');
  });

  test('Me.ctrl = Nz(Me.other) fallback via translateAssignmentRHS', () => {
    expect(translateStatement('Me.txtResult = Nz(Me.txtInput, 0)'))
      .toBe('AC.setValue("txtResult", AC.nz(AC.getValue("txtInput"), 0))');
  });

  // ---- New patterns (step 1 expansion) ----

  test('Me.ctrl.SetFocus', () => {
    expect(translateStatement('Me.txtName.SetFocus'))
      .toBe('AC.setFocus("txtName")');
  });

  test('Me.ctrl.Requery', () => {
    expect(translateStatement('Me.cboStatus.Requery'))
      .toBe('AC.requeryControl("cboStatus")');
  });

  test('Me.Dirty = False → save record', () => {
    expect(translateStatement('Me.Dirty = False'))
      .toBe('await AC.saveRecord()');
  });

  test('Me.Undo', () => {
    expect(translateStatement('Me.Undo'))
      .toBe('AC.undo()');
  });

  test('Me.ctrl.Undo', () => {
    expect(translateStatement('Me.cboCompanyTypeID.Undo'))
      .toBe('AC.undo()');
  });

  test('Me.RecordSource = string literal', () => {
    expect(translateStatement('Me.RecordSource = "SELECT * FROM tblOrders"'))
      .toBe('AC.setRecordSource("SELECT * FROM tblOrders")');
  });

  test('Me.RecordSource = variable', () => {
    const assignedVars = new Set(['strsql']);
    expect(translateStatement('Me.RecordSource = strSQL', null, null, assignedVars))
      .toBe('AC.setRecordSource(strSQL)');
  });

  test('Me.Caption = string literal (form caption)', () => {
    expect(translateStatement('Me.Caption = "Order Entry"'))
      .toBe('AC.setFormCaption("Order Entry")');
  });

  test('Me.Caption = variable', () => {
    const assignedVars = new Set(['strtitle']);
    expect(translateStatement('Me.Caption = strTitle', null, null, assignedVars))
      .toBe('AC.setFormCaption(strTitle)');
  });

  test('Me.Filter = string literal', () => {
    expect(translateStatement('Me.Filter = "Status = 1"'))
      .toBe('AC.setFilter("Status = 1")');
  });

  test('Me.Filter = concatenation expression', () => {
    const vars = new Set(['lngreportfilter']);
    expect(translateStatement('Me.Filter = "EmployeeID = " & lngReportFilter', null, null, vars))
      .toBe('AC.setFilter("EmployeeID = " + lngReportFilter)');
  });

  test('Me.FilterOn = True/False', () => {
    expect(translateStatement('Me.FilterOn = True'))
      .toBe('AC.setFilterOn(true)');
    expect(translateStatement('Me.FilterOn = False'))
      .toBe('AC.setFilterOn(false)');
  });

  test('Forms!frmName.Requery → AC.requeryForm', () => {
    expect(translateStatement('Forms!frmCompanyList.Requery'))
      .toBe('AC.requeryForm("frmCompanyList")');
  });

  test('Forms!frmName.Recordset.Requery → AC.requeryForm', () => {
    expect(translateStatement('Forms!frmEmployeeList.Recordset.Requery'))
      .toBe('AC.requeryForm("frmEmployeeList")');
  });

  test('Forms("frmName").Requery → AC.requeryForm', () => {
    expect(translateStatement('Forms("frmCompanyList").Requery'))
      .toBe('AC.requeryForm("frmCompanyList")');
  });

  test('Forms(variable).Requery → AC.requeryForm with var', () => {
    const vars = new Set(['strform']);
    expect(translateStatement('Forms(strForm).Requery', null, null, vars))
      .toBe('AC.requeryForm(strForm)');
  });

  test('Cancel = True → return false', () => {
    expect(translateStatement('Cancel = True'))
      .toBe('return false');
  });

  test('MsgBox with icon argument stripped', () => {
    expect(translateStatement('MsgBox "Error occurred", vbExclamation'))
      .toBe('alert("Error occurred")');
    expect(translateStatement('MsgBox "Warning!", vbCritical'))
      .toBe('alert("Warning!")');
  });

  test('MsgBox variable', () => {
    const assignedVars = new Set(['strmsg']);
    expect(translateStatement('MsgBox strMsg', null, null, assignedVars))
      .toBe('alert(strMsg)');
  });

  test('MsgBox with & concatenation', () => {
    const assignedVars = new Set(['strname']);
    expect(translateStatement('MsgBox "Hello " & strName', null, null, assignedVars))
      .toBe('alert("Hello " + strName)');
  });

  test('MsgBox with Me.ctrl concatenation', () => {
    expect(translateStatement('MsgBox "Value: " & Me.txtTotal'))
      .toBe('alert("Value: " + AC.getValue("txtTotal"))');
  });

  test('MsgBox with fn call and icon arg', () => {
    const fnReg = new Set(['getstring']);
    const enumMap = new Map([['sReportNoData', 99]]);
    expect(translateStatement('MsgBox GetString(sReportNoData), vbExclamation', null, enumMap, null, fnReg))
      .toBe('alert(await AC.callFn("GetString", 99))');
  });

  test('bare function call as statement', () => {
    const fnReg = new Set(['ribbon_showreportsgroup']);
    expect(translateStatement('Ribbon_ShowReportsGroup', null, null, null, fnReg))
      .toBe('await AC.callFn("Ribbon_ShowReportsGroup")');
  });

  test('function call with args as statement', () => {
    const fnReg = new Set(['lockcontrols']);
    expect(translateStatement('LockControls(True)', null, null, null, fnReg))
      .toBe('await AC.callFn("LockControls", true)');
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
  });

  test('DLookup as assignment RHS', () => {
    expect(translateAssignmentRHS('DLookup("Name", "tbl")')).toBe('await AC.dLookup("Name", "tbl")');
    expect(translateAssignmentRHS('DLookup("PurchaseOrderID", "qryPO", "VendorID = " & Me.VendorID)')).toBe(
      'await AC.dLookup("PurchaseOrderID", "qryPO", "VendorID = " + AC.getValue("VendorID"))'
    );
  });

  test('TempVars!Name as RHS', () => {
    expect(translateAssignmentRHS('TempVars!GenerateToC')).toBe('AC.getTempVar("GenerateToC")');
    expect(translateAssignmentRHS('TempVars("MyVar")')).toBe('AC.getTempVar("MyVar")');
  });

  test('empty/null returns null', () => {
    expect(translateAssignmentRHS('')).toBeNull();
    expect(translateAssignmentRHS(null)).toBeNull();
  });

  test('Not FunctionCall(var) negation', () => {
    const assigned = new Set(['frm']);
    const fn = new Set(['isvalidform']);
    expect(translateAssignmentRHS('Not IsValidForm(frm)', assigned, null, fn))
      .toBe('!(await AC.callFn("IsValidForm", frm))');
  });

  test('Not True/False', () => {
    expect(translateAssignmentRHS('Not True')).toBe('!(true)');
    expect(translateAssignmentRHS('Not False')).toBe('!(false)');
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

  test('IsNull(TempVars!Name) → AC.getTempVar() == null', () => {
    expect(translateCondition('IsNull(TempVars!GenerateToC)')).toBe('AC.getTempVar("GenerateToC") == null');
    expect(translateCondition('IsNull(TempVars("MyVar"))')).toBe('AC.getTempVar("MyVar") == null');
  });

  test('TempVars!Name standalone as boolean', () => {
    expect(translateCondition('TempVars!GenerateToC')).toBe('AC.getTempVar("GenerateToC")');
    expect(translateCondition('TempVars("Mode")')).toBe('AC.getTempVar("Mode")');
  });

  test('TempVars!Name compared to literal', () => {
    expect(translateCondition('TempVars!Mode = "Edit"')).toBe('AC.getTempVar("Mode") === "Edit"');
    expect(translateCondition('TempVars!Count > 0')).toBe('AC.getTempVar("Count") > 0');
  });

  test('Not TempVars!Name', () => {
    expect(translateCondition('Not TempVars!GenerateToC')).toBe('!(AC.getTempVar("GenerateToC"))');
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

  test('IsNull(ctl.Value) — variable.Value in condition', () => {
    const vars = new Set(['ctl']);
    expect(translateCondition('IsNull(ctl.Value)', vars)).toBe('AC.getValue(ctl) == null');
  });

  test('variable.BackColor = enum in condition', () => {
    const vars = new Set(['ctl']);
    const enums = new Map([['HIGHLIGHT_COLOR', 65535]]);
    expect(translateCondition('ctl.BackColor = HIGHLIGHT_COLOR', vars, enums))
      .toBe('AC.getBackColor(ctl) === 65535');
  });

  test('Me.Dirty And Me.NewRecord compound', () => {
    expect(translateCondition('Me.Dirty And Me.NewRecord'))
      .toBe('AC.isDirty() && AC.isNewRecord()');
  });

  test('module-level variable in condition via assignedVars', () => {
    const moduleVars = new Set(['m_lngvendorproductcount']);
    expect(translateCondition('m_lngVendorProductCount > 0', moduleVars))
      .toBe('m_lngVendorProductCount > 0');
  });

  test('bare fn name (no parens) as boolean in condition', () => {
    const fnReg = new Set(['companyisactive']);
    expect(translateCondition('CompanyIsActive', null, null, fnReg))
      .toBe('await AC.callFn("CompanyIsActive")');
  });

  test('bare fn name = True in comparison', () => {
    const fnReg = new Set(['companyisactive']);
    expect(translateCondition('CompanyIsActive = True', null, null, fnReg))
      .toBe('await AC.callFn("CompanyIsActive") === true');
  });

  test('fn call with parens as standalone condition', () => {
    const fnReg = new Set(['isformopen']);
    expect(translateCondition('IsFormOpen("frmGenericDialog")', null, null, fnReg))
      .toBe('await AC.callFn("IsFormOpen", "frmGenericDialog")');
  });

  test('Or with fn call and module var', () => {
    const moduleVars = new Set(['m_lngvendorproductcount']);
    const fnReg = new Set(['companyisactive']);
    expect(translateCondition('CompanyIsActive = True Or m_lngVendorProductCount > 0', moduleVars, null, fnReg))
      .toBe('await AC.callFn("CompanyIsActive") === true || m_lngVendorProductCount > 0');
  });

  test('parenthesized And/Or with variable comparisons', () => {
    const vars = new Set(['intcurrentview', 'intdefaultview']);
    expect(translateCondition(
      '(intCurrentView = 1 And intDefaultView = 1) Or intCurrentView = 2', vars
    )).toBe('intCurrentView === 1 && intDefaultView === 1 || intCurrentView === 2');
  });

  test('outer parens are stripped', () => {
    expect(translateCondition('(True)')).toBe('true');
    expect(translateCondition('(Me.NewRecord)')).toBe('AC.isNewRecord()');
  });

  test('procedure params as known vars in parseVbaToHandlers', () => {
    const vba = [
      'Public Sub DoStuff(ctl As Control)',
      '  Dim x As Long',
      '  x = ControlView(ctl)',
      'End Sub',
    ].join('\n');
    const fnReg = new Set(['controlview']);
    const handlers = parseVbaToHandlers(vba, 'modTest', new Map(), fnReg);
    expect(handlers[0].js).toContain('await AC.callFn("ControlView", ctl)');
  });

  test('DCount in condition: DCount("*", "OrderDetails", criteria) = 0', () => {
    expect(translateCondition('DCount("*", "OrderDetails", "OrderID = " & Me.OrderID) = 0'))
      .toBe('await AC.dCount("*", "OrderDetails", "OrderID = " + AC.getValue("OrderID")) === 0');
  });

  test('DCount in condition: DCount("*", "tbl") > 0', () => {
    expect(translateCondition('DCount("*", "tbl") > 0'))
      .toBe('await AC.dCount("*", "tbl") > 0');
  });

  test('DCount with enum in criteria', () => {
    const enumMap = new Map([['enumStatus.Active', 1]]);
    expect(translateCondition('DCount("*", "Orders", "Status = " & enumStatus.Active) = 0', null, enumMap))
      .toBe('await AC.dCount("*", "Orders", "Status = " + 1) === 0');
  });

  test('DCount with variable in criteria', () => {
    const vars = new Set(['strwhere']);
    expect(translateCondition('DCount("*", "tbl", strWhere) > 0', vars))
      .toBe('await AC.dCount("*", "tbl", strWhere) > 0');
  });
});

// ============================================================
// domain aggregate parsing
// ============================================================

describe('domain aggregate parsing', () => {
  const { parseDomainCall, translateDomainCall, translateCriteria } = require('../lib/vba-to-js');

  test('parseDomainCall parses DCount with 3 args', () => {
    const result = parseDomainCall('DCount("*", "OrderDetails", "OrderID = " & Me.OrderID)');
    expect(result).not.toBeNull();
    expect(result.func).toBe('DCount');
    expect(result.expr).toBe('*');
    expect(result.domain).toBe('OrderDetails');
    expect(result.criteria).toBe('"OrderID = " & Me.OrderID');
  });

  test('parseDomainCall parses DLookup with 2 args', () => {
    const result = parseDomainCall('DLookup("Name", "Employees")');
    expect(result).not.toBeNull();
    expect(result.func).toBe('DLookup');
    expect(result.expr).toBe('Name');
    expect(result.domain).toBe('Employees');
    expect(result.criteria).toBeNull();
  });

  test('parseDomainCall returns null for non-domain call', () => {
    expect(parseDomainCall('MsgBox("hi")')).toBeNull();
  });

  test('translateCriteria handles string literal', () => {
    expect(translateCriteria('"StatusID = 1"')).toBe('"StatusID = 1"');
  });

  test('translateCriteria handles Me.ctrl concatenation', () => {
    expect(translateCriteria('"OrderID = " & Me.OrderID'))
      .toBe('"OrderID = " + AC.getValue("OrderID")');
  });

  test('translateCriteria handles variable', () => {
    const vars = new Set(['strwhere']);
    expect(translateCriteria('strWhere', vars)).toBe('strWhere');
  });

  test('translateCriteria returns null for complex expression', () => {
    expect(translateCriteria('StringFormatSQL("a = {0}", x)')).toBeNull();
  });

  test('translateDomainCall for DCount with criteria', () => {
    const result = translateDomainCall('DCount("*", "Orders", "Status = " & Me.Status)');
    expect(result).not.toBeNull();
    expect(result.js).toBe('await AC.dCount("*", "Orders", "Status = " + AC.getValue("Status"))');
  });

  test('translateDomainCall for DMin without criteria', () => {
    const result = translateDomainCall('DMin("Price", "Products")');
    expect(result).not.toBeNull();
    expect(result.js).toBe('await AC.dMin("Price", "Products")');
  });

  test('translateDomainCall for DMax', () => {
    const result = translateDomainCall('DMax("OrderID", "Orders")');
    expect(result).not.toBeNull();
    expect(result.js).toBe('await AC.dMax("OrderID", "Orders")');
  });

  test('translateDomainCall for DSum with criteria', () => {
    const result = translateDomainCall('DSum("Amount", "LineItems", "InvoiceID = " & Me.InvoiceID)');
    expect(result).not.toBeNull();
    expect(result.js).toBe('await AC.dSum("Amount", "LineItems", "InvoiceID = " + AC.getValue("InvoiceID"))');
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

  test('Dim emits let, Set preserved as comment, Const emits const, GoTo skipped', () => {
    const lines = [
      'Dim x As Integer',
      'Set rs = Nothing',
      'Const MAX_VAL = 100',
      'GoTo Exit_Handler',
      'DoCmd.Close',
    ];
    const result = translateBlock(lines, 0, 'frmTest');
    expect(result.jsLines).toEqual([
      'let x;',
      '// Set rs = Nothing',
      'const MAX_VAL = 100;',
      'AC.closeForm("frmTest");',
    ]);
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

  test('For Each over Me.Controls translates to AC.getControlNames()', () => {
    const lines = [
      'For Each ctl In Me.Controls',
      'ctl.Visible = True',
      'Next ctl',
    ];
    const result = translateBlock(lines, 0, 'frmTest');
    expect(result.jsLines[0]).toBe('for (const ctl of AC.getControlNames()) {');
  });

  test('Do While with untranslatable condition emits warning', () => {
    const lines = [
      'Do While Not rs.EOF',
      'rs.MoveNext',
      'Loop',
    ];
    const result = translateBlock(lines, 0, 'frmTest');
    expect(result.jsLines[0]).toBe('// [VBA Do While loop - condition not translatable: Not rs.EOF]');
  });

  test('While/Wend with untranslatable condition emits warning', () => {
    const lines = [
      'While x > 0',
      'x = x - 1',
      'Wend',
    ];
    const result = translateBlock(lines, 0, 'frmTest');
    // x is not in assignedVars, so condition is not translatable
    expect(result.jsLines[0]).toBe('// [VBA While loop - condition not translatable: x > 0]');
  });

  test('With Me.ctrl prefixes dot references and translates', () => {
    const lines = [
      'With Me.txtName',
      '.Visible = True',
      'End With',
    ];
    const result = translateBlock(lines, 0, 'frmTest');
    expect(result.jsLines[0]).toBe('AC.setVisible("txtName", true);');
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

  test('unrecognized statements preserved as comments', () => {
    const lines = ['SomeUnknownCall "arg"', 'DoCmd.Close'];
    const result = translateBlock(lines, 0, 'frmTest');
    expect(result.jsLines).toEqual(['// SomeUnknownCall "arg"', 'AC.closeForm("frmTest");']);
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

  test('DLookup as switch expression translates via domain aggregate', () => {
    const lines = [
      'Select Case DLookup("Type", "tbl")',
      'Case "A"',
      'DoCmd.Close',
      'End Select',
    ];
    const result = parseSelectCaseBlock(lines, 0, 'frmTest');
    const js = result.jsLines.join('\n');
    expect(js).toContain('switch (await AC.dLookup("Type", "tbl"))');
    expect(js).toContain('case "A"');
  });

  test('untranslatable expression emits comment', () => {
    const lines = [
      'Select Case SomeUnknownObj.Property',
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

  test('Dim var with untranslatable RHS still enables If condition', () => {
    const vba = `
Private Sub Form_Load()
    Dim lngUserID As Long
    lngUserID = Get_UserID()
    If lngUserID = 0 Then
        Me.AutoLogin_chk.Visible = False
    End If
End Sub
`;
    const handlers = parseVbaToHandlers(vba, 'Form_frmLogin');
    expect(handlers).toHaveLength(1);
    const js = handlers[0].js;
    expect(js).toContain('// lngUserID = Get_UserID()');
    expect(js).toContain('if (lngUserID === 0)');
    expect(js).toContain('AC.setVisible("AutoLogin_chk", false);');
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

  test('handler with Dim produces let, Set assignment preserved as comment', () => {
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
    // Set with untranslatable RHS is emitted as comment (not silently dropped)
    expect(js).toContain('// Set rs = CurrentDb.OpenRecordset("tbl")');
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

  // ---- Non-event procedure tests ----

  test('non-event procedure emits fn.ProcedureName key', () => {
    const vba = `
Private Sub LockControls()
    Me.txtName.Enabled = False
    Me.txtEmail.Enabled = False
End Sub
`;
    const handlers = parseVbaToHandlers(vba, 'Form_frmUser');
    expect(handlers).toHaveLength(1);
    expect(handlers[0].key).toBe('fn.LockControls');
    expect(handlers[0].control).toBe('fn');
    expect(handlers[0].event).toBe('LockControls');
    expect(handlers[0].procedure).toBe('LockControls');
    expect(handlers[0].js).toContain('AC.setEnabled("txtName", false)');
    expect(handlers[0].js).toContain('AC.setEnabled("txtEmail", false)');
  });

  test('mixed event and non-event procedures', () => {
    const vba = `
Private Sub Form_Load()
    DoCmd.Requery
End Sub

Public Sub SetFormStatus()
    Me.lblStatus.Caption = "Ready"
End Sub

Private Sub cmdClose_Click()
    DoCmd.Close
End Sub
`;
    const handlers = parseVbaToHandlers(vba, 'Form_frmMain');
    expect(handlers).toHaveLength(3);
    const keys = handlers.map(h => h.key);
    expect(keys).toContain('form.on-load');
    expect(keys).toContain('fn.SetFormStatus');
    expect(keys).toContain('cmd-close.on-click');
  });

  test('non-event procedure with underscore not in EVENT_MAP', () => {
    const vba = `
Private Sub Update_StatusBar()
    Me.lblMsg.Caption = "Updated"
End Sub
`;
    const handlers = parseVbaToHandlers(vba, 'Form_frmMain');
    expect(handlers).toHaveLength(1);
    // Update_StatusBar: "Update" is not a known control with "StatusBar" event
    expect(handlers[0].key).toBe('fn.Update_StatusBar');
    expect(handlers[0].control).toBe('fn');
  });

  test('Cancel = True in before-update handler', () => {
    const vba = `
Private Sub Form_BeforeUpdate(Cancel As Integer)
    If IsNull(Me.txtName) Then
        MsgBox "Name is required"
        Cancel = True
    End If
End Sub
`;
    const handlers = parseVbaToHandlers(vba, 'Form_frmEntry');
    expect(handlers).toHaveLength(1);
    expect(handlers[0].key).toBe('form.before-update');
    const js = handlers[0].js;
    expect(js).toContain('return false;');
    expect(js).toContain('alert("Name is required");');
  });

  test('Me.Dirty = False in handler', () => {
    const vba = `
Private Sub cmdSaveAndClose_Click()
    Me.Dirty = False
    DoCmd.Close
End Sub
`;
    const handlers = parseVbaToHandlers(vba, 'Form_frmEdit');
    expect(handlers).toHaveLength(1);
    const js = handlers[0].js;
    expect(js).toContain('await AC.saveRecord();');
    expect(js).toContain('AC.closeForm("frmEdit");');
  });

  test('SetFocus and Requery in handler', () => {
    const vba = `
Private Sub cboCategory_AfterUpdate()
    Me.lstItems.Requery
    Me.txtSearch.SetFocus
End Sub
`;
    const handlers = parseVbaToHandlers(vba, 'Form_frmSearch');
    expect(handlers).toHaveLength(1);
    const js = handlers[0].js;
    expect(js).toContain('AC.requeryControl("lstItems");');
    expect(js).toContain('AC.setFocus("txtSearch");');
  });

  test('fn registry enables inside-out resolution on retry pass', () => {
    const vba = `
Private Sub DoFormat()
    MsgBox "formatted"
End Sub

Private Sub Form_Load()
    Dim strResult As String
    strResult = DoFormat()
    MsgBox strResult
End Sub
`;
    // DoFormat is a fn.* — after pass 1, registry has it, pass 2 can resolve calls
    const fnRegistry = new Set();
    const handlers = parseVbaToHandlers(vba, 'Form_frmTest', null, fnRegistry);
    expect(fnRegistry.has('doformat')).toBe(true);
    expect(handlers).toHaveLength(2);
    const fnHandler = handlers.find(h => h.key === 'fn.DoFormat');
    expect(fnHandler).toBeTruthy();
    expect(fnHandler.js).toContain('alert("formatted")');
  });

  test('cross-module fn registry resolves function calls in criteria', () => {
    // Pre-populate registry as if StringFormatSQL was parsed from another module
    const fnRegistry = new Set(['stringformatsql']);
    const assignedVars = new Set(['strtitle']);
    const result = translateCriteria(
      'StringFormatSQL("TocTitle = {0}", strTitle)',
      assignedVars, null, fnRegistry
    );
    expect(result).toBe('await AC.callFn("StringFormatSQL", "TocTitle = {0}", strTitle)');
  });

  test('DCount with registry-known function in criteria translates', () => {
    const fnRegistry = new Set(['stringformatsql']);
    const assignedVars = new Set(['strtitle']);
    const cond = 'DCount("*", "Catalog_TableOfContents", StringFormatSQL("TocTitle = {0}", strTitle)) = 0';
    const result = translateCondition(cond, assignedVars, null, fnRegistry);
    expect(result).toContain('await AC.dCount("*", "Catalog_TableOfContents"');
    expect(result).toContain('await AC.callFn("StringFormatSQL"');
    expect(result).toContain('=== 0');
  });

  test('full rptProductCatalog onPrint with cross-module fnRegistry', () => {
    const vba = [
      'Private Sub Detail_Print(Cancel As Integer, PrintCount As Integer)',
      '  Dim strTitle As String',
      '  Dim intPageNumber As Integer',
      '  Dim strSQL As String',
      '  If IsNull(TempVars("GenerateToC")) Then',
      '    TempVars("GenerateToC").Value = True',
      '  End If',
      '  If TempVars("GenerateToC") Then',
      '    strTitle = Me.ProductCategoryName',
      '    intPageNumber = Me.Page',
      '    If DCount("*", "Catalog_TableOfContents", StringFormatSQL("TocTitle = {0}", strTitle)) = 0 Then',
      '      strSQL = StringFormatSQL("INSERT INTO Catalog_TableOfContents (TocTitle, TocPage) VALUES ({0}, {1});", strTitle, intPageNumber)',
      '      g_dbApp().Execute strSQL, dbFailOnError',
      '    End If',
      '  End If',
      'End Sub',
    ].join('\n');
    const fnReg = new Set(['stringformatsql']);
    const handlers = parseVbaToHandlers(vba, 'Report_rptProductCatalog', new Map(), fnReg);
    expect(handlers.length).toBe(1);
    expect(handlers[0].key).toBe('detail.on-print');
    // Should have zero comment lines — fully translated
    const comments = handlers[0].js.split('\n').filter(l => /^\s*\/\//.test(l));
    expect(comments.length).toBe(0);
    expect(handlers[0].js).toContain('AC.dCount');
    expect(handlers[0].js).toContain('AC.callFn("StringFormatSQL"');
    expect(handlers[0].js).toContain('AC.runSQL(strSQL)');
    expect(handlers[0].js).toContain('AC.setTempVar("GenerateToC", true)');
  });
});

// ============================================================
// collectModuleVars
// ============================================================

describe('collectModuleVars', () => {
  test('collects Dim/Private/Public at module level', () => {
    const vba = [
      'Private m_count As Long',
      'Public g_name As String',
      'Dim m_flag As Boolean',
      '',
      'Private Sub DoStuff()',
      '  Dim localVar As String',
      'End Sub',
    ].join('\n');
    const vars = collectModuleVars(vba);
    expect(vars.has('m_count')).toBe(true);
    expect(vars.has('g_name')).toBe(true);
    expect(vars.has('m_flag')).toBe(true);
    expect(vars.has('localvar')).toBe(false); // inside procedure
  });

  test('collects Const at module level', () => {
    const vars = collectModuleVars('Private Const MAX_ITEMS = 100\nPublic Const APP_NAME = "Test"');
    expect(vars.has('max_items')).toBe(true);
    expect(vars.has('app_name')).toBe(true);
  });
});

// ============================================================
// collectEnumValues — bare member names
// ============================================================

describe('collectEnumValues bare member names', () => {
  test('stores both qualified and bare member names', () => {
    const vba = 'Public Enum StringID\n  sFirst = 1\n  sSecond\nEnd Enum';
    const map = collectEnumValues(vba);
    expect(map.get('StringID.sFirst')).toBe(1);
    expect(map.get('sFirst')).toBe(1); // bare name
    expect(map.get('StringID.sSecond')).toBe(2);
    expect(map.get('sSecond')).toBe(2); // bare name
  });
});

// ============================================================
// translateExpression
// ============================================================

describe('translateExpression', () => {
  test('bare enum member resolves to number', () => {
    const enumMap = new Map([['sMyConst', 42]]);
    expect(translateExpression('sMyConst', null, enumMap)).toBe('42');
  });

  test('bare fn name (no parens) resolves to callFn', () => {
    const fnReg = new Set(['companyisactive']);
    expect(translateExpression('CompanyIsActive', null, null, fnReg))
      .toBe('await AC.callFn("CompanyIsActive")');
  });

  test('string literal', () => {
    expect(translateExpression('"hello"')).toBe('"hello"');
  });

  test('numeric literal', () => {
    expect(translateExpression('42')).toBe('42');
  });

  test('boolean literal', () => {
    expect(translateExpression('True')).toBe('true');
    expect(translateExpression('False')).toBe('false');
  });

  test('Me.ctrl', () => {
    expect(translateExpression('Me.txtName')).toBe('AC.getValue("txtName")');
  });

  test('Me.OpenArgs', () => {
    expect(translateExpression('Me.OpenArgs')).toBe('AC.getOpenArgs()');
  });

  test('variable in assignedVars', () => {
    const vars = new Set(['myvar']);
    expect(translateExpression('myVar', vars)).toBe('myVar');
  });

  test('string concatenation with &', () => {
    expect(translateExpression('"Hello " & Me.txtName'))
      .toBe('"Hello " + AC.getValue("txtName")');
  });

  test('known function call via fnRegistry', () => {
    const fnRegistry = new Set(['formatstring']);
    expect(translateExpression('FormatString("test", Me.txtVal)', null, null, fnRegistry))
      .toBe('await AC.callFn("FormatString", "test", AC.getValue("txtVal"))');
  });

  test('unknown function returns null', () => {
    expect(translateExpression('UnknownFunc("test")')).toBeNull();
  });

  test('nested function call — inner args translated', () => {
    const fnRegistry = new Set(['outer', 'inner']);
    const result = translateExpression('Outer(Inner("a"), 42)', null, null, fnRegistry);
    expect(result).toBe('await AC.callFn("Outer", await AC.callFn("Inner", "a"), 42)');
  });

  test('Nz with inner expression', () => {
    expect(translateExpression('Nz(Me.OpenArgs, "")')).toBe('AC.nz(AC.getOpenArgs(), "")');
  });

  test('TempVars reference', () => {
    expect(translateExpression('TempVars!MyVar')).toBe('AC.getTempVar("MyVar")');
  });

  test('[Forms]![frmName].[ctrlName] → AC.getFormValue', () => {
    expect(translateExpression('[Forms]![frmReports].[txtStartDate]'))
      .toBe('AC.getFormValue("frmReports", "txtStartDate")');
  });

  test('[Forms]![frmName]![ctrlName] with ! separator', () => {
    expect(translateExpression('[Forms]![frmReports]![txtEndDate]'))
      .toBe('AC.getFormValue("frmReports", "txtEndDate")');
  });

  test('Forms!frmName.ctrlName → AC.getFormValue', () => {
    expect(translateExpression('Forms!frmCompanyDetail.Caption'))
      .toBe('AC.getFormValue("frmCompanyDetail", "Caption")');
  });

  test('Forms("frmName").ctrlName → AC.getFormValue', () => {
    expect(translateExpression('Forms("frmReports").txtStartDate'))
      .toBe('AC.getFormValue("frmReports", "txtStartDate")');
  });

  test('cross-form ref in concatenation', () => {
    expect(translateExpression('"Between " & [Forms]![frmReports].[txtStartDate] & " And " & [Forms]![frmReports].[txtEndDate]'))
      .toBe('"Between " + AC.getFormValue("frmReports", "txtStartDate") + " And " + AC.getFormValue("frmReports", "txtEndDate")');
  });

  test('variable.Value → AC.getValue(variable)', () => {
    const assigned = new Set(['ctl']);
    expect(translateExpression('ctl.Value', assigned)).toBe('AC.getValue(ctl)');
  });

  test('variable.BackColor → AC.getBackColor(variable)', () => {
    const assigned = new Set(['ctl']);
    expect(translateExpression('ctl.BackColor', assigned)).toBe('AC.getBackColor(ctl)');
  });

  test('variable.Property getter not in assignedVars returns null', () => {
    expect(translateExpression('unknownCtl.BackColor')).toBeNull();
  });
});

// ============================================================
// parseFunctionCall
// ============================================================

describe('parseFunctionCall', () => {
  test('simple function', () => {
    const result = parseFunctionCall('Foo("a", "b")');
    expect(result.name).toBe('Foo');
    expect(result.args).toEqual(['"a"', '"b"']);
  });

  test('nested parens', () => {
    const result = parseFunctionCall('Outer(Inner("x"), 42)');
    expect(result.name).toBe('Outer');
    expect(result.args).toEqual(['Inner("x")', '42']);
  });

  test('no parens returns null', () => {
    expect(parseFunctionCall('justAWord')).toBeNull();
  });

  test('single argument', () => {
    const result = parseFunctionCall('Len("test")');
    expect(result.name).toBe('Len');
    expect(result.args).toEqual(['"test"']);
  });
});

// ============================================================
// splitOnOperator
// ============================================================

describe('splitOnOperator', () => {
  test('splits on &', () => {
    const parts = splitOnOperator('"a" & "b"', '&');
    expect(parts).toEqual(['"a" ', ' "b"']);
  });

  test('respects parens', () => {
    const parts = splitOnOperator('"x" & Func("a & b")', '&');
    expect(parts).toEqual(['"x" ', ' Func("a & b")']);
  });

  test('returns null if operator not found', () => {
    expect(splitOnOperator('"hello"', '&')).toBeNull();
  });
});

// ============================================================
// FunctionName = result → return pattern
// ============================================================

describe('function return value', () => {
  test('FuncName = variable → return variable', () => {
    const lines = ['Dim s', 's = "hello"', 'GetString = s'];
    const vars = new Set();
    const assigned = new Set();
    const result = translateBlock(lines, 0, null, vars, assigned, null, null, 'GetString');
    expect(result.jsLines).toContain('return s;');
  });

  test('FuncName = string literal → return "text"', () => {
    const lines = ['MyFunc = "done"'];
    const result = translateBlock(lines, 0, null, null, null, null, null, 'MyFunc');
    expect(result.jsLines).toContain('return "done";');
  });

  test('Sub does not produce return for same assignment', () => {
    const lines = ['Dim GetString', 'GetString = "hello"'];
    const result = translateBlock(lines, 0, null, null, null, null, null, null);
    // Without funcName, it's a regular variable assignment
    expect(result.jsLines.join('\n')).not.toContain('return');
    expect(result.jsLines).toContain('GetString = "hello";');
  });

  test('Set FuncName = variable → return variable', () => {
    const lines = ['Dim dict', 'Set StringToDictionary = dict'];
    const vars = new Set();
    const assigned = new Set(['dict']);
    const result = translateBlock(lines, 0, null, vars, assigned, null, null, 'StringToDictionary');
    expect(result.jsLines).toContain('return dict;');
  });

  test('parseVbaToHandlers generates return for Function procedures', () => {
    const vba = `
Public Function GetName() As String
    GetName = "test"
End Function
`;
    const handlers = parseVbaToHandlers(vba, 'modUtils');
    expect(handlers).toHaveLength(1);
    expect(handlers[0].key).toBe('fn.GetName');
    expect(handlers[0].js).toContain('return "test";');
  });

  test('parseVbaToHandlers does NOT generate return for Sub procedures', () => {
    const vba = `
Public Sub DoWork()
    Dim x
    x = 5
End Sub
`;
    const handlers = parseVbaToHandlers(vba, 'modUtils');
    expect(handlers).toHaveLength(1);
    expect(handlers[0].js).not.toContain('return');
  });
});

// ============================================================
// VBA built-in functions
// ============================================================

describe('VBA built-in functions', () => {
  test('Replace(s, find, repl) → s.replaceAll(find, repl)', () => {
    const vars = new Set(['s']);
    const result = translateExpression('Replace(s, "a", "b")', vars);
    expect(result).toBe('s.replaceAll("a", "b")');
  });

  test('UBound(arr) → (arr.length - 1)', () => {
    const vars = new Set(['arr']);
    const result = translateExpression('UBound(arr)', vars);
    expect(result).toBe('(arr.length - 1)');
  });

  test('LBound(arr) → 0', () => {
    const vars = new Set(['arr']);
    const result = translateExpression('LBound(arr)', vars);
    expect(result).toBe('0');
  });

  test('IsArray(x) → Array.isArray(x)', () => {
    const vars = new Set(['x']);
    const result = translateExpression('IsArray(x)', vars);
    expect(result).toBe('Array.isArray(x)');
  });

  test('Split(s, ",") → s.split(",")', () => {
    const vars = new Set(['s']);
    const result = translateExpression('Split(s, ",")', vars);
    expect(result).toBe('s.split(",")');
  });

  test('InStr(s, ",") → (s.indexOf(",") + 1)', () => {
    const vars = new Set(['s']);
    const result = translateExpression('InStr(s, ",")', vars);
    expect(result).toBe('(s.indexOf(",") + 1)');
  });

  test('InStr(3, s, ",") → 3-arg form with start offset', () => {
    const vars = new Set(['s']);
    const result = translateExpression('InStr(3, s, ",")', vars);
    expect(result).toBe('(s.indexOf(",", 3 - 1) + 1)');
  });

  test('Left$(s, 5) → s.substring(0, 5)', () => {
    const vars = new Set(['s']);
    const result = translateExpression('Left$(s, 5)', vars);
    expect(result).toBe('s.substring(0, 5)');
  });

  test('Mid$(s, 3, 2) → s.substring(3 - 1, 3 - 1 + 2)', () => {
    const vars = new Set(['s']);
    const result = translateExpression('Mid$(s, 3, 2)', vars);
    expect(result).toBe('s.substring(3 - 1, 3 - 1 + 2)');
  });

  test('Mid(s, 3) without length → s.substring(3 - 1)', () => {
    const vars = new Set(['s']);
    const result = translateExpression('Mid(s, 3)', vars);
    expect(result).toBe('s.substring(3 - 1)');
  });

  test('Len(s) → s.length', () => {
    const vars = new Set(['s']);
    const result = translateExpression('Len(s)', vars);
    expect(result).toBe('s.length');
  });

  test('LTrim(s) → s.trimStart()', () => {
    const vars = new Set(['s']);
    const result = translateExpression('LTrim(s)', vars);
    expect(result).toBe('s.trimStart()');
  });

  test('Trim$(s) → s.trim()', () => {
    const vars = new Set(['s']);
    const result = translateExpression('Trim$(s)', vars);
    expect(result).toBe('s.trim()');
  });

  test('CStr(x) → String(x)', () => {
    const vars = new Set(['x']);
    const result = translateExpression('CStr(x)', vars);
    expect(result).toBe('String(x)');
  });

  test('CInt(x) → parseInt(x)', () => {
    const vars = new Set(['x']);
    const result = translateExpression('CInt(x)', vars);
    expect(result).toBe('parseInt(x)');
  });

  test('Abs(x) → Math.abs(x)', () => {
    const vars = new Set(['x']);
    const result = translateExpression('Abs(x)', vars);
    expect(result).toBe('Math.abs(x)');
  });

  test('LCase(s) → s.toLowerCase()', () => {
    const vars = new Set(['s']);
    const result = translateExpression('LCase(s)', vars);
    expect(result).toBe('s.toLowerCase()');
  });

  test('Chr(65) → String.fromCharCode(65)', () => {
    const result = translateExpression('Chr(65)');
    expect(result).toBe('String.fromCharCode(65)');
  });

  test('Nz via builtins with nested DLookup', () => {
    const vars = new Set(['id']);
    const result = translateExpression('Nz(DLookup("Name", "tbl", "ID = " & id), "")', vars);
    expect(result).toBe('AC.nz(await AC.dLookup("Name", "tbl", "ID = " + id), "")');
  });

  test('builtins take priority over fnRegistry for known functions', () => {
    const vars = new Set(['s']);
    const fnReg = new Set(['replace']);
    // Replace is a VBA built-in — should use .replaceAll, not AC.callFn
    const result = translateExpression('Replace(s, "a", "b")', vars, null, fnReg);
    expect(result).toBe('s.replaceAll("a", "b")');
  });
});

// ============================================================
// For loop with expression bounds
// ============================================================

describe('For loop expression bounds', () => {
  test('For n = 0 To UBound(arr)', () => {
    const lines = ['For n = 0 To UBound(arr)', 'DoCmd.Close', 'Next'];
    const vars = new Set();
    const assigned = new Set(['arr']);
    const result = parseForLoop(lines, 0, 'frmTest', vars, assigned);
    expect(result).not.toBeNull();
    expect(result.jsLines[0]).toBe('for (let n = 0; n <= (arr.length - 1); n++) {');
    expect(result.jsLines[1]).toBe('  AC.closeForm("frmTest");');
  });

  test('For i = 1 To Len(s)', () => {
    const lines = ['For i = 1 To Len(s)', 'Next'];
    const vars = new Set();
    const assigned = new Set(['s']);
    const result = parseForLoop(lines, 0, 'frmTest', vars, assigned);
    expect(result).not.toBeNull();
    expect(result.jsLines[0]).toBe('for (let i = 1; i <= s.length; i++) {');
  });
});

// ============================================================
// Set prefix handling in translateBlock
// ============================================================

describe('Set prefix handling', () => {
  test('Set variable = translatable RHS produces assignment', () => {
    const lines = ['Dim x', 'Set x = "hello"'];
    const result = translateBlock(lines, 0, null);
    expect(result.jsLines).toContain('x = "hello";');
  });

  test('Set variable = untranslatable RHS produces comment', () => {
    const lines = ['Dim rs', 'Set rs = CreateObject("Dict")'];
    const result = translateBlock(lines, 0, null);
    expect(result.jsLines).toContain('// Set rs = CreateObject("Dict")');
  });
});

// ============================================================
// Nz with nested parens (parseFunctionCall-based)
// ============================================================

describe('Nz nested paren fix', () => {
  test('translateAssignmentRHS handles Nz(DLookup(...), "")', () => {
    const vars = new Set(['id']);
    const rhs = translateAssignmentRHS('Nz(DLookup("Name", "tbl", "ID = " & id), "")', vars);
    expect(rhs).toBe('AC.nz(await AC.dLookup("Name", "tbl", "ID = " + id), "")');
  });

  test('translateAssignmentRHS handles simple Nz(Me.OpenArgs)', () => {
    const rhs = translateAssignmentRHS('Nz(Me.OpenArgs)');
    expect(rhs).toBe('AC.nz(AC.getOpenArgs())');
  });

  test('translateAssignmentRHS handles Nz(Me.OpenArgs, 0)', () => {
    const rhs = translateAssignmentRHS('Nz(Me.OpenArgs, 0)');
    expect(rhs).toBe('AC.nz(AC.getOpenArgs(), 0)');
  });
});

// ============================================================
// Const handling in translateBlock
// ============================================================

describe('Const handling', () => {
  test('Const with string value emits const declaration', () => {
    const lines = ['Const DELIM As String = "&"', 'DoCmd.Close'];
    const result = translateBlock(lines, 0, 'frmTest');
    expect(result.jsLines[0]).toBe('const DELIM = "&";');
  });

  test('Const with numeric value emits const declaration', () => {
    const lines = ['Private Const MAX_ITEMS = 100'];
    const result = translateBlock(lines, 0, null);
    expect(result.jsLines[0]).toBe('const MAX_ITEMS = 100;');
  });

  test('Const variable is available in subsequent expressions', () => {
    const lines = ['Const DELIM As String = "&"', 'Dim parts', 'parts = Split("a&b", DELIM)'];
    const result = translateBlock(lines, 0, null);
    expect(result.jsLines[2]).toBe('parts = "a&b".split(DELIM);');
  });

  test('Dim variable available for function return even without explicit assignment', () => {
    const vba = `
Public Function MakeDict() As Object
    Dim dict As Object
    Set MakeDict = dict
End Function
`;
    const handlers = parseVbaToHandlers(vba, 'modUtils');
    expect(handlers[0].js).toContain('return dict;');
  });
});

// ============================================================
// Phase 1: Exit For / Exit Do → break
// ============================================================

describe('Exit For / Exit Do', () => {
  test('Exit For in For loop emits break', () => {
    const lines = [
      'For i = 1 To 10',
      'DoCmd.Close',
      'Exit For',
      'Next i',
    ];
    const result = translateBlock(lines, 0, 'frmTest');
    expect(result.jsLines).toContain('  break;');
  });

  test('Exit Do in Do loop emits break', () => {
    const lines = [
      'Do',
      'DoCmd.Close',
      'Exit Do',
      'Loop',
    ];
    const result = translateBlock(lines, 0, 'frmTest');
    expect(result.jsLines[0]).toBe('while (true) {');
    expect(result.jsLines).toContain('  break;');
  });

  test('Exit For inside nested If within For loop', () => {
    const lines = [
      'For i = 0 To 5',
      'If True Then',
      'Exit For',
      'End If',
      'Next i',
    ];
    const result = translateBlock(lines, 0, 'frmTest');
    const js = result.jsLines.join('\n');
    expect(js).toContain('break;');
    expect(js).toContain('for (let i = 0;');
  });
});

// ============================================================
// Phase 2: Do/While/Until loops
// ============================================================

describe('Do/While loops', () => {
  test('Do While cond ... Loop → while (cond) {}', () => {
    const assigned = new Set(['counter']);
    const lines = ['Do While counter > 0', 'DoCmd.Close', 'Loop'];
    const result = translateBlock(lines, 0, 'frmTest', null, assigned);
    expect(result.jsLines[0]).toBe('while (counter > 0) {');
    expect(result.jsLines[1]).toBe('  AC.closeForm("frmTest");');
    expect(result.jsLines[2]).toBe('}');
  });

  test('Do Until cond ... Loop → while (!(cond)) {}', () => {
    const assigned = new Set(['found']);
    const lines = ['Do Until found = True', 'DoCmd.Save', 'Loop'];
    const result = translateBlock(lines, 0, 'frmTest', null, assigned);
    expect(result.jsLines[0]).toBe('while (!(found === true)) {');
  });

  test('Do ... Loop While cond → do {} while (cond)', () => {
    const assigned = new Set(['x']);
    const lines = ['Do', 'DoCmd.Close', 'Loop While x > 0'];
    const result = translateBlock(lines, 0, 'frmTest', null, assigned);
    expect(result.jsLines[0]).toBe('do {');
    expect(result.jsLines[2]).toBe('} while (x > 0);');
  });

  test('Do ... Loop Until cond → do {} while (!(cond))', () => {
    const assigned = new Set(['done']);
    const lines = ['Do', 'DoCmd.Save', 'Loop Until done = True'];
    const result = translateBlock(lines, 0, 'frmTest', null, assigned);
    expect(result.jsLines[0]).toBe('do {');
    expect(result.jsLines[2]).toMatch(/while \(!\(done === true\)\)/);
  });

  test('Bare Do ... Loop → while (true) {}', () => {
    const lines = ['Do', 'DoCmd.Close', 'Exit Do', 'Loop'];
    const result = translateBlock(lines, 0, 'frmTest');
    expect(result.jsLines[0]).toBe('while (true) {');
    expect(result.jsLines).toContain('  break;');
  });

  test('While ... Wend with translatable condition', () => {
    const assigned = new Set(['count']);
    const lines = ['While count > 0', 'DoCmd.Save', 'Wend'];
    const result = translateBlock(lines, 0, 'frmTest', null, assigned);
    expect(result.jsLines[0]).toBe('while (count > 0) {');
    expect(result.jsLines[2]).toBe('}');
  });

  test('Do While with untranslatable condition preserves VBA', () => {
    const lines = ['Do While rs.Fields("ID") > 0', 'rs.MoveNext', 'Loop'];
    const result = translateBlock(lines, 0, 'frmTest');
    expect(result.jsLines[0]).toContain('condition not translatable');
    expect(result.jsLines.some(l => l.includes('rs.MoveNext'))).toBe(true);
  });

  test('Nested Do loops', () => {
    const assigned = new Set(['i', 'j']);
    const lines = [
      'Do While i > 0',
      'Do While j > 0',
      'DoCmd.Save',
      'Loop',
      'Loop',
    ];
    const result = translateBlock(lines, 0, 'frmTest', null, assigned);
    expect(result.jsLines[0]).toBe('while (i > 0) {');
    expect(result.jsLines[1]).toBe('  while (j > 0) {');
  });

  test('Do While with If/Else in body', () => {
    const assigned = new Set(['counter']);
    const lines = [
      'Do While counter > 0',
      'If True Then',
      'DoCmd.Close',
      'End If',
      'Loop',
    ];
    const result = translateBlock(lines, 0, 'frmTest', null, assigned);
    const js = result.jsLines.join('\n');
    expect(js).toContain('while (counter > 0)');
    expect(js).toContain('if (true)');
  });

  test('Exit Do inside Do While emits break', () => {
    const assigned = new Set(['counter']);
    const lines = [
      'Do While counter > 0',
      'Exit Do',
      'Loop',
    ];
    const result = translateBlock(lines, 0, 'frmTest', null, assigned);
    expect(result.jsLines).toContain('  break;');
  });

  test('Do While Me.NewRecord', () => {
    const lines = ['Do While Me.NewRecord', 'DoCmd.Save', 'Loop'];
    const result = translateBlock(lines, 0, 'frmTest');
    expect(result.jsLines[0]).toBe('while (AC.isNewRecord()) {');
  });

  test('While/Wend with Me.Dirty condition', () => {
    const lines = ['While Me.Dirty', 'DoCmd.Save', 'Wend'];
    const result = translateBlock(lines, 0, 'frmTest');
    expect(result.jsLines[0]).toBe('while (AC.isDirty()) {');
  });
});

// ============================================================
// Phase 3: Domain aggregates in conditions
// ============================================================

describe('IsNull with domain aggregates', () => {
  test('IsNull(DLookup(...)) in condition', () => {
    const cond = translateCondition('IsNull(DLookup("Name", "tblPeople", "ID = 1"))');
    expect(cond).toBe('await AC.dLookup("Name", "tblPeople", "ID = 1") == null');
  });

  test('Not IsNull(DLookup(...)) with criteria', () => {
    const assigned = new Set(['myid']);
    const cond = translateCondition('Not IsNull(DLookup("Name", "tblPeople", "ID = " & myID))', assigned);
    expect(cond).toContain('!(');
    expect(cond).toContain('await AC.dLookup');
    expect(cond).toContain('== null');
  });

  test('Nz(DLookup(...), "") <> "" in comparison already works', () => {
    // This tests the existing translateExpression path — Nz(DLookup) as expression
    const cond = translateCondition('Nz(DLookup("Name", "tblPeople"), "") <> ""');
    expect(cond).toContain('AC.nz');
    expect(cond).toContain('!==');
  });

  test('DCount in condition comparison still works', () => {
    const cond = translateCondition('DCount("*", "tblOrders", "Status = 1") > 0');
    expect(cond).toBe('await AC.dCount("*", "tblOrders", "Status = 1") > 0');
  });

  test('Compound condition with domain aggregate and IsNull', () => {
    const cond = translateCondition('DCount("*", "tblItems") > 0 And IsNull(DLookup("Name", "tblPeople"))');
    expect(cond).toContain('&&');
    expect(cond).toContain('dCount');
    expect(cond).toContain('dLookup');
  });

  test('Regression: IsNull(variable) still works', () => {
    const assigned = new Set(['myvar']);
    const cond = translateCondition('IsNull(myVar)', assigned);
    expect(cond).toBe('myVar == null');
  });
});

// ============================================================
// Phase 4: New translateStatement patterns
// ============================================================

describe('New statement patterns', () => {
  test('Me.ctrl.Locked = True', () => {
    expect(translateStatement('Me.txtName.Locked = True')).toBe('AC.setLocked("txtName", true)');
  });

  test('Me.ctrl.Locked = False', () => {
    expect(translateStatement('Me.txtName.Locked = False')).toBe('AC.setLocked("txtName", false)');
  });

  test('Me.ctrl.BackColor = numeric value', () => {
    expect(translateStatement('Me.txtName.BackColor = 16777215')).toBe('AC.setBackColor("txtName", 16777215)');
  });

  test('Me.ctrl.ForeColor = variable', () => {
    const assigned = new Set(['mycolor']);
    expect(translateStatement('Me.txtName.ForeColor = myColor', null, null, assigned)).toBe('AC.setForeColor("txtName", myColor)');
  });

  test('Me.ctrl.BackShade = value', () => {
    expect(translateStatement('Me.txtName.BackShade = 85')).toBe('AC.setBackShade("txtName", 85)');
  });

  test('Me.ctrl.DefaultValue = string', () => {
    expect(translateStatement('Me.txtPrice.DefaultValue = "0"')).toBe('AC.setDefaultValue("txtPrice", "0")');
  });

  test('Me.AllowEdits = True', () => {
    expect(translateStatement('Me.AllowEdits = True')).toBe('AC.setAllowEdits(true)');
  });

  test('Me.AllowAdditions = False', () => {
    expect(translateStatement('Me.AllowAdditions = False')).toBe('AC.setAllowAdditions(false)');
  });

  test('Me.AllowDeletions = True', () => {
    expect(translateStatement('Me.AllowDeletions = True')).toBe('AC.setAllowDeletions(true)');
  });

  test('Me.Painting = True is no-op', () => {
    expect(translateStatement('Me.Painting = True')).toBe('/* Me.Painting — no-op in web */');
  });

  test('Me.NavigationCaption = string', () => {
    expect(translateStatement('Me.NavigationCaption = "Orders"')).toBe('AC.setNavigationCaption("Orders")');
  });

  test('Me.sfrmX.Form.AllowEdits = True', () => {
    expect(translateStatement('Me.sfrmOrders.Form.AllowEdits = True')).toBe('AC.setSubformAllow("sfrmOrders", "allowEdits", true)');
  });

  test('Me.sfrmX.Form.AllowAdditions = False', () => {
    expect(translateStatement('Me.sfrmItems.Form.AllowAdditions = False')).toBe('AC.setSubformAllow("sfrmItems", "allowAdditions", false)');
  });

  test('Me.AllowEdits with variable RHS', () => {
    const assigned = new Set(['editable']);
    expect(translateStatement('Me.AllowEdits = editable', null, null, assigned)).toBe('AC.setAllowEdits(editable)');
  });

  // variable.Property = value (where variable is in assignedVars)
  test('variable.BackColor = constant', () => {
    const assigned = new Set(['ctl']);
    const enums = new Map([['HIGHLIGHT_COLOR', 65535]]);
    expect(translateStatement('ctl.BackColor = HIGHLIGHT_COLOR', null, enums, assigned)).toBe('AC.setBackColor(ctl, 65535)');
  });

  test('variable.BackStyle = numeric', () => {
    const assigned = new Set(['ctl']);
    expect(translateStatement('ctl.BackStyle = 1', null, null, assigned)).toBe('AC.setBackStyle(ctl, 1)');
  });

  test('variable.Visible = True', () => {
    const assigned = new Set(['ctrl']);
    expect(translateStatement('ctrl.Visible = True', null, null, assigned)).toBe('AC.setVisible(ctrl, true)');
  });

  test('variable.Property not in assignedVars returns null', () => {
    expect(translateStatement('unknownCtl.BackColor = 255')).toBeNull();
  });

  // Bare call with space-separated args (no parens)
  test('bare call with space-separated arg', () => {
    const assigned = new Set(['ctl']);
    const fn = new Set(['highlightcontrol']);
    expect(translateStatement('HighlightControl ctl', null, null, assigned, fn))
      .toBe('await AC.callFn("HighlightControl", ctl)');
  });

  test('bare call with multiple space-separated args', () => {
    const assigned = new Set(['frm']);
    const fn = new Set(['dosomething']);
    expect(translateStatement('DoSomething frm, True', null, null, assigned, fn))
      .toBe('await AC.callFn("DoSomething", frm, true)');
  });

  test('bare call with space arg — not in fnRegistry', () => {
    const assigned = new Set(['ctl']);
    expect(translateStatement('UnknownSub ctl', null, null, assigned)).toBeNull();
  });
});

// ============================================================
// Phase 5: With blocks
// ============================================================

describe('With blocks', () => {
  test('With Me + various property sets', () => {
    const lines = [
      'With Me',
      '.AllowEdits = True',
      '.AllowAdditions = False',
      'End With',
    ];
    const result = translateBlock(lines, 0, 'frmTest');
    expect(result.jsLines[0]).toBe('AC.setAllowEdits(true);');
    expect(result.jsLines[1]).toBe('AC.setAllowAdditions(false);');
  });

  test('With Me.ctrl — dot method', () => {
    const lines = [
      'With Me.txtName',
      '.SetFocus',
      '.Visible = False',
      'End With',
    ];
    const result = translateBlock(lines, 0, 'frmTest');
    expect(result.jsLines[0]).toBe('AC.setFocus("txtName");');
    expect(result.jsLines[1]).toBe('AC.setVisible("txtName", false);');
  });

  test('With Me.ctrl mixed dot and non-dot lines', () => {
    const lines = [
      'With Me.txtName',
      '.Visible = True',
      'DoCmd.Save',
      '.Enabled = False',
      'End With',
    ];
    const result = translateBlock(lines, 0, 'frmTest');
    expect(result.jsLines[0]).toBe('AC.setVisible("txtName", true);');
    expect(result.jsLines[1]).toBe('AC.saveRecord();');
    expect(result.jsLines[2]).toBe('AC.setEnabled("txtName", false);');
  });

  test('With untranslatable target preserves VBA', () => {
    const lines = [
      'With Me.RecordsetClone',
      '.FindFirst "ID = 1"',
      'End With',
    ];
    const result = translateBlock(lines, 0, 'frmTest');
    expect(result.jsLines[0]).toBe('// [VBA With block - target not translatable: Me.RecordsetClone]');
    expect(result.jsLines.some(l => l.includes('.FindFirst'))).toBe(true);
    expect(result.jsLines[result.jsLines.length - 1]).toBe('// End With');
  });

  test('With rs variable (untranslatable)', () => {
    const lines = [
      'With rsData',
      '.Fields("Name") = "test"',
      'End With',
    ];
    const result = translateBlock(lines, 0, 'frmTest');
    expect(result.jsLines[0]).toContain('target not translatable: rsData');
  });

  test('Nested With blocks', () => {
    const lines = [
      'With Me',
      '.AllowEdits = True',
      'With Me.txtName',
      '.Visible = False',
      'End With',
      'End With',
    ];
    const result = translateBlock(lines, 0, 'frmTest');
    expect(result.jsLines[0]).toBe('AC.setAllowEdits(true);');
    expect(result.jsLines[1]).toBe('AC.setVisible("txtName", false);');
  });

  test('With Me.sfrmX.Form sets subform allow props', () => {
    const lines = [
      'With Me.sfrmOrders.Form',
      '.AllowAdditions = True',
      '.AllowEdits = False',
      '.AllowDeletions = False',
      'End With',
    ];
    const result = translateBlock(lines, 0, 'frmTest');
    expect(result.jsLines[0]).toBe('AC.setSubformAllow("sfrmOrders", "allowAdditions", true);');
    expect(result.jsLines[1]).toBe('AC.setSubformAllow("sfrmOrders", "allowEdits", false);');
    expect(result.jsLines[2]).toBe('AC.setSubformAllow("sfrmOrders", "allowDeletions", false);');
  });

  test('With Me + Locked property', () => {
    const lines = [
      'With Me',
      '.txtName.Locked = True',
      '.txtPrice.Locked = False',
      'End With',
    ];
    const result = translateBlock(lines, 0, 'frmTest');
    expect(result.jsLines[0]).toBe('AC.setLocked("txtName", true);');
    expect(result.jsLines[1]).toBe('AC.setLocked("txtPrice", false);');
  });

  test('With Me + BackColor property', () => {
    const lines = [
      'With Me',
      '.txtName.BackColor = 16777215',
      'End With',
    ];
    const result = translateBlock(lines, 0, 'frmTest');
    expect(result.jsLines[0]).toBe('AC.setBackColor("txtName", 16777215);');
  });

  test('With Me resolves mid-line dot references (Nz, function args)', () => {
    const lines = [
      'With Me',
      'lngReportFilter = Nz(.cboFilterByEmployee, 0)',
      'End With',
    ];
    const vars = new Set(['lngreportfilter']);
    const result = translateBlock(lines, 0, 'frmTest', vars, vars);
    expect(result.jsLines[0]).toBe('lngReportFilter = AC.nz(AC.getValue("cboFilterByEmployee"), 0);');
  });

  test('With Me resolves dot refs after & and = operators', () => {
    const lines = [
      'With Me',
      '.Filter = "EmployeeID = " & .cboFilter',
      'End With',
    ];
    const result = translateBlock(lines, 0, 'frmTest');
    // .Filter → Me.Filter, .cboFilter → Me.cboFilter
    // Me.Filter = "..." & Me.cboFilter should translate via setFilter
    expect(result.jsLines[0]).toContain('AC.setFilter(');
  });

  test('With Me — full rptSalesByEmployee pattern', () => {
    const lines = [
      'With Me',
      '.FilterOn = False',
      '.cboFilterByEmployee.Requery',
      'lngReportFilter = Nz(.cboFilterByEmployee, 0)',
      'If lngReportFilter > 0 Then',
      '.Filter = "EmployeeID = " & lngReportFilter',
      '.FilterOn = True',
      'End If',
      'End With',
    ];
    const vars = new Set(['lngreportfilter']);
    const result = translateBlock(lines, 0, 'frmTest', vars, vars);
    expect(result.jsLines[0]).toBe('AC.setFilterOn(false);');
    expect(result.jsLines[1]).toBe('AC.requeryControl("cboFilterByEmployee");');
    expect(result.jsLines[2]).toBe('lngReportFilter = AC.nz(AC.getValue("cboFilterByEmployee"), 0);');
    expect(result.jsLines[3]).toBe('if (lngReportFilter > 0) {');
    expect(result.jsLines[4]).toContain('AC.setFilter(');
    expect(result.jsLines[5].trim()).toBe('AC.setFilterOn(true);');
  });
});

// ============================================================
// Phase 6: For Each loops
// ============================================================

describe('For Each loops', () => {
  test('For Each with Array()', () => {
    const lines = [
      'For Each item In Array("a", "b", "c")',
      'DoCmd.Close',
      'Next item',
    ];
    const result = translateBlock(lines, 0, 'frmTest');
    expect(result.jsLines[0]).toBe('for (const item of ["a", "b", "c"]) {');
  });

  test('For Each with Split()', () => {
    const assigned = new Set(['mystr']);
    const lines = [
      'For Each part In Split(myStr, ",")',
      'DoCmd.Close',
      'Next part',
    ];
    const result = translateBlock(lines, 0, 'frmTest', null, assigned);
    expect(result.jsLines[0]).toBe('for (const part of myStr.split(",")) {');
  });

  test('For Each with assigned variable', () => {
    const assigned = new Set(['mylist']);
    const lines = [
      'For Each item In myList',
      'DoCmd.Save',
      'Next item',
    ];
    const result = translateBlock(lines, 0, 'frmTest', null, assigned);
    expect(result.jsLines[0]).toBe('for (const item of myList) {');
  });

  test('For Each with dict.Keys', () => {
    const assigned = new Set(['dict']);
    const lines = [
      'For Each key In dict.Keys',
      'DoCmd.Close',
      'Next key',
    ];
    const result = translateBlock(lines, 0, 'frmTest', null, assigned);
    expect(result.jsLines[0]).toBe('for (const key of Object.keys(dict)) {');
  });

  test('For Each with Me.Controls → AC.getControlNames()', () => {
    const lines = [
      'For Each ctl In Me.Controls',
      'DoCmd.Close',
      'Next ctl',
    ];
    const result = translateBlock(lines, 0, 'frmTest');
    expect(result.jsLines[0]).toBe('for (const ctl of AC.getControlNames()) {');
  });

  test('For Each with TempVars → AC.getTempVarNames()', () => {
    const lines = [
      'For Each tv In TempVars',
      'DoCmd.Close',
      'Next tv',
    ];
    const result = translateBlock(lines, 0, 'frmTest');
    expect(result.jsLines[0]).toBe('for (const tv of AC.getTempVarNames()) {');
  });

  test('For Each with untranslatable DAO collection', () => {
    const lines = [
      'For Each tdf In db.TableDefs',
      'Debug.Print tdf.Name',
      'Next tdf',
    ];
    const result = translateBlock(lines, 0, 'frmTest');
    expect(result.jsLines[0]).toBe('// [VBA For Each - collection not translatable: db.TableDefs]');
    expect(result.jsLines.some(l => l.includes('Debug.Print'))).toBe(true);
  });

  test('Exit For inside For Each emits break', () => {
    const lines = [
      'For Each item In Array("a", "b")',
      'Exit For',
      'Next item',
    ];
    const result = translateBlock(lines, 0, 'frmTest');
    expect(result.jsLines).toContain('  break;');
  });

  test('Loop variable available in body expressions', () => {
    const lines = [
      'For Each item In Array("a", "b")',
      'MsgBox item',
      'Next item',
    ];
    const result = translateBlock(lines, 0, 'frmTest');
    expect(result.jsLines[1]).toBe('  alert(item);');
  });

  test('For Each nested in If', () => {
    const lines = [
      'If True Then',
      'For Each x In Array(1, 2)',
      'DoCmd.Close',
      'Next x',
      'End If',
    ];
    const result = translateBlock(lines, 0, 'frmTest');
    const js = result.jsLines.join('\n');
    expect(js).toContain('if (true)');
    expect(js).toContain('for (const x of [1, 2])');
  });
});

// ============================================================
// Integration: parseVbaToHandlers with new constructs
// ============================================================

describe('parseVbaToHandlers integration with new constructs', () => {
  test('Do While loop in event handler', () => {
    const vba = `
Private Sub cmdProcess_Click()
    Dim count As Long
    count = 10
    Do While count > 0
        DoCmd.Save
        count = count - 1
    Loop
End Sub
`;
    const handlers = parseVbaToHandlers(vba, 'Form_frmMain');
    const js = handlers[0].js;
    expect(js).toContain('while (count > 0)');
    expect(js).toContain('AC.saveRecord()');
  });

  test('With Me in event handler', () => {
    const vba = `
Private Sub Form_Current()
    With Me
        .AllowEdits = True
        .AllowDeletions = False
    End With
End Sub
`;
    const handlers = parseVbaToHandlers(vba, 'Form_frmOrders');
    const js = handlers[0].js;
    expect(js).toContain('AC.setAllowEdits(true)');
    expect(js).toContain('AC.setAllowDeletions(false)');
  });

  test('For Each Array in utility function', () => {
    const vba = `
Public Sub ToggleFields()
    Dim fld As Variant
    For Each fld In Array("Name", "Price", "Qty")
        Me.Controls(fld).Visible = True
    Next fld
End Sub
`;
    const handlers = parseVbaToHandlers(vba, 'Form_frmMain');
    const js = handlers[0].js;
    expect(js).toContain('for (const fld of ["Name", "Price", "Qty"])');
  });

  // --- Array indexing ---

  test('array indexing in expression: variable(index) → variable[index]', () => {
    const assignedVars = new Set(['vparams', 'n']);
    const result = translateExpression('vParams(n)', assignedVars, null, null);
    expect(result).toBe('vParams[n]');
  });

  test('array indexing: variable(0) → variable[0]', () => {
    const assignedVars = new Set(['params']);
    const result = translateExpression('params(0)', assignedVars, null, null);
    expect(result).toBe('params[0]');
  });

  test('array indexing NOT triggered for builtins', () => {
    const assignedVars = new Set(['isarray', 'x']);
    const result = translateExpression('IsArray(x)', assignedVars, null, null);
    // IsArray is a builtin — should NOT become IsArray[x]
    expect(result).not.toContain('[');
  });

  test('array indexing NOT triggered for fnRegistry functions', () => {
    const assignedVars = new Set(['myfunc', 'x']);
    const fnRegistry = new Set(['myfunc']);
    const result = translateExpression('MyFunc(x)', assignedVars, null, fnRegistry);
    expect(result).toContain('AC.callFn');
  });

  test('array element assignment: vParams(i) = value', () => {
    const lines = ['vParams(i) = "NULL"'];
    const variables = new Set(['vparams', 'i']);
    const assignedVars = new Set(['vparams', 'i']);
    const { jsLines } = translateBlock(lines, 0, 'frmTest', variables, assignedVars, null, null, null);
    expect(jsLines[0]).toBe('vParams[i] = "NULL";');
  });

  test('array element assignment with expression RHS', () => {
    const lines = ['vParams(i) = LTrim(Str(vParams(i)))'];
    const variables = new Set(['vparams', 'i']);
    const assignedVars = new Set(['vparams', 'i']);
    const { jsLines } = translateBlock(lines, 0, 'frmTest', variables, assignedVars, null, null, null);
    expect(jsLines[0]).toContain('vParams[i] =');
    expect(jsLines[0]).toContain('.trimStart()');
  });

  // --- Dictionary patterns ---

  test('dict.CompareMode = value → no-op', () => {
    const assignedVars = new Set(['dict']);
    const result = translateStatement('dict.CompareMode = vbTextCompare', 'frmTest', null, assignedVars, null);
    expect(result).toContain('no-op');
  });

  // --- Arithmetic expressions ---

  test('arithmetic: variable + literal', () => {
    const assignedVars = new Set(['intpos']);
    expect(translateExpression('intPos + 1', assignedVars, null, null)).toBe('intPos + 1');
  });

  test('arithmetic: variable - literal', () => {
    const assignedVars = new Set(['intpos']);
    expect(translateExpression('intPos - 1', assignedVars, null, null)).toBe('intPos - 1');
  });

  test('arithmetic: variable * variable', () => {
    const assignedVars = new Set(['a', 'b']);
    expect(translateExpression('a * b', assignedVars, null, null)).toBe('a * b');
  });

  test('arithmetic: multi-term', () => {
    const assignedVars = new Set(['a', 'b', 'c']);
    expect(translateExpression('a + b - c', assignedVars, null, null)).toBe('a + b - c');
  });

  test('arithmetic: negative literal', () => {
    expect(translateExpression('-1', null, null, null)).toBe('-1');
  });

  test('arithmetic inside function call args', () => {
    const assignedVars = new Set(['vartoken', 'intpos']);
    const result = translateExpression('Left$(varToken, intPos - 1)', assignedVars, null, null);
    expect(result).toContain('intPos - 1');
  });

  test('dict.Add key, value → dict[key] = value', () => {
    const assignedVars = new Set(['dict', 'mykey', 'myval']);
    const result = translateStatement('dict.Add myKey, myVal', 'frmTest', null, assignedVars, null);
    expect(result).toBe('dict[myKey] = myVal');
  });

  test('dict.Add with string args', () => {
    const assignedVars = new Set(['dict']);
    const result = translateStatement('dict.Add "name", "value"', 'frmTest', null, assignedVars, null);
    expect(result).toBe('dict["name"] = "value"');
  });

  test('Erase variable → no-op', () => {
    const result = translateStatement('Erase strTokens', 'frmTest', null, null, null);
    expect(result).toContain('no-op');
  });

  // --- modStrings integration ---

  test('StringFormat function translates array indexing', () => {
    const vba = `
Public Function StringFormat(ByVal s As String, ParamArray params() As Variant) As String
    Dim n As Integer
    Dim vParams As Variant
    If UBound(params) = -1 Then GoTo Exit_Handler
    If IsArray(params) And IsArray(params(0)) Then
        vParams = params(0)
    Else
        vParams = params
    End If
    For n = 0 To UBound(vParams)
        s = Replace(s, "{" & n & "}", vParams(n))
    Next n
Exit_Handler:
    StringFormat = s
    Exit Function
End Function
`;
    const handlers = parseVbaToHandlers(vba, 'modStrings');
    const h = handlers.find(h => h.key === 'fn.StringFormat');
    expect(h).toBeDefined();
    // Should NOT have comment lines for the core logic
    expect(h.js).toContain('vParams[n]');
    expect(h.js).toContain('return s;');
  });

  test('StringToDictionary translates dict patterns', () => {
    const vba = `
Public Function StringToDictionary(ByVal v As Variant) As Scripting.Dictionary
    Const KEYVALUE_DELIMITER As String = "&"
    Const VALUE_DELIMITER As String = "="
    Dim dict As New Scripting.Dictionary
    Dim intPos As Integer
    Dim strTokens() As String
    Dim varToken As Variant
    If IsNull(v) Then
        'Nothing to do
    Else
        dict.CompareMode = vbTextCompare
        strTokens = Split(v, KEYVALUE_DELIMITER)
        For Each varToken In strTokens
            intPos = InStr(varToken, VALUE_DELIMITER)
            If intPos = 0 Then
                'no equals sign
            Else
                dict.Add Left$(varToken, intPos - 1), Mid$(varToken, intPos + 1)
            End If
        Next varToken
        Erase strTokens
    End If
    Set StringToDictionary = dict
    Exit Function
End Function
`;
    const handlers = parseVbaToHandlers(vba, 'modStrings');
    const h = handlers.find(h => h.key === 'fn.StringToDictionary');
    expect(h).toBeDefined();
    // Should have dict operations translated
    expect(h.js).toContain('no-op'); // CompareMode and Erase
    expect(h.js).toContain('dict['); // dict.Add now translates with arithmetic
    expect(h.js).toContain('for (const varToken of');
  });

  // --- Date/Format builtins ---

  test('CDate in expression', () => {
    const result = translateExpression('CDate(v)', new Set(['v']), null, null);
    expect(result).toBe('new Date(v)');
  });

  test('DateValue in expression', () => {
    const result = translateExpression('DateValue("2024-01-01")', null, null, null);
    expect(result).toBe('new Date("2024-01-01")');
  });

  test('Date() and Now() in expression', () => {
    expect(translateExpression('Date', null, null, null)).toBe('new Date()');
    expect(translateExpression('Now', null, null, null)).toBe('new Date()');
  });

  test('Format(expr, fmt) in expression', () => {
    const result = translateExpression('Format(dt, "yyyy-mm-dd")', new Set(['dt']), null, null);
    expect(result).toBe('AC.formatValue(dt, "yyyy-mm-dd")');
  });

  // --- Module-qualified calls ---

  test('module-qualified call strips prefix', () => {
    const fnRegistry = new Set(['setapptitle']);
    const result = translateStatement('modStartup.SetAppTitle False', 'frmTest', null, null, fnRegistry);
    expect(result).toBe('await AC.callFn("SetAppTitle", false)');
  });

  // --- Application / CurrentDb patterns ---

  test('Application.SetOption → no-op', () => {
    const result = translateStatement('Application.SetOption "Error Trapping", 2', 'frmTest', null, null, null);
    expect(result).toContain('no-op');
  });

  test('Application.Quit → no-op', () => {
    const result = translateStatement('Application.Quit acQuitSaveNone', 'frmTest', null, null, null);
    expect(result).toContain('no-op');
  });

  test('RefreshTitleBar → no-op', () => {
    const result = translateStatement('RefreshTitleBar', 'frmTest', null, null, null);
    expect(result).toContain('no-op');
  });

  test('CurrentDb.Properties("AppTitle") = expr', () => {
    const assignedVars = new Set(['g_strappname']);
    const result = translateStatement('CurrentDb.Properties("AppTitle") = g_strAppName', 'frmTest', null, assignedVars, null);
    expect(result).toBe('AC.setAppTitle(g_strAppName)');
  });

  // --- frmCompanyDetail patterns ---

  test('RunCommand acCmdRecordsGoToNew', () => {
    expect(translateStatement('RunCommand acCmdRecordsGoToNew')).toBe('AC.gotoRecord("new")');
  });

  test('RunCommand acCmdDeleteRecord', () => {
    expect(translateStatement('RunCommand acCmdDeleteRecord')).toBe('AC.deleteRecord()');
  });

  test('Response = acDataErrContinue', () => {
    const result = translateStatement('Response = acDataErrContinue');
    expect(result).toContain('acDataErrContinue');
  });

  test('Me.[FieldName] bracketed reference', () => {
    expect(translateExpression('Me.[Address]', null, null, null)).toBe('AC.getValue("Address")');
  });

  test('Me.ctrl.Value in expression', () => {
    expect(translateExpression('Me.txtCompanyID.Value', null, null, null)).toBe('AC.getValue("txtCompanyID")');
  });

  test('Me as function argument', () => {
    expect(translateExpression('Me', null, null, null)).toBe('"Me"');
  });

  test('dict.Item(key) → dict[key]', () => {
    const assignedVars = new Set(['dict', 'key']);
    expect(translateExpression('dict.Item(key)', assignedVars, null, null)).toBe('dict[key]');
  });

  test('Me.Form.FilterOn in condition', () => {
    const result = translateCondition('Me.Form.FilterOn = True', null, null, null);
    expect(result).toBe('AC.getFilterOn() === true');
  });

  test('Me.SetFocus → no-op', () => {
    expect(translateStatement('Me.SetFocus')).toContain('no-op');
  });

  test('Me.ctrl.SelStart = 0 → no-op', () => {
    expect(translateStatement('Me.txtBusinessPhone.SelStart = 0')).toContain('no-op');
  });

  test('DoCmd.SearchForRecord', () => {
    const assignedVars = new Set(['m_lngcalledfromid']);
    const result = translateStatement('DoCmd.SearchForRecord acDataForm, Me.Name, acFirst, "CompanyID = " & m_lngCalledFromID', 'frmTest', null, assignedVars, null);
    expect(result).toContain('AC.searchForRecord');
  });

  test('SourceObject = empty string', () => {
    expect(translateStatement('Me.sfrmOrders.SourceObject = ""'))
      .toBe('AC.setSubformSource("sfrmOrders", "")');
  });

  test('Me.Caption = Me.ctrl.Value expression', () => {
    const assignedVars = new Set();
    const result = translateStatement('Me.Caption = Me.txtCompanyType.Value', 'frmTest', null, assignedVars);
    expect(result).toBe('AC.setFormCaption(AC.getValue("txtCompanyType"))');
  });

  test('controlName.Caption = expression', () => {
    const result = translateStatement('Me.lblsfrmOrders.Caption = "Orders"');
    expect(result).toBe('AC.setValue("lblsfrmOrders", "Orders")');
  });

  test('variable assignment in translateStatement', () => {
    const assignedVars = new Set(['m_lngcalledfromid']);
    const result = translateStatement('m_lngCalledFromID = Me.CompanyID', 'frmTest', null, assignedVars);
    expect(result).toBe('m_lngCalledFromID = AC.getValue("CompanyID")');
  });
});

// ============================================================
// MsgBox condition patterns
// ============================================================
describe('MsgBox conditions', () => {
  test('MsgBox(expr) = vbNo with function arg', () => {
    const fnRegistry = new Set(['getstring']);
    const assignedVars = new Set(['strmsg']);
    const result = translateCondition('MsgBox(GetString(strMsg), vbQuestion Or vbYesNo, "Save?") = vbNo', assignedVars, null, fnRegistry);
    expect(result).toContain('!confirm(');
    expect(result).toContain('AC.callFn("GetString"');
  });

  test('MsgBox("text") = vbYes with string literal', () => {
    const result = translateCondition('MsgBox("Continue?", vbYesNo) = vbYes');
    expect(result).toBe('confirm("Continue?")');
  });

  test('MsgBox(variable) = vbNo', () => {
    const assignedVars = new Set(['strmsg']);
    const result = translateCondition('MsgBox(strMsg, vbYesNo) = vbNo', assignedVars);
    expect(result).toBe('!confirm(strMsg)');
  });
});

// ============================================================
// Select Case with Me.ctrl.Value
// ============================================================
describe('Select Case expression via translateExpression', () => {
  test('Select Case Me.ctrl.Value', () => {
    const lines = [
      'Select Case Me.cboCompanyTypeID.Value',
      'Case 1',
      'DoCmd.Close',
      'End Select',
    ];
    const result = parseSelectCaseBlock(lines, 0, 'frmTest');
    const js = result.jsLines.join('\n');
    expect(js).toContain('switch (AC.getValue("cboCompanyTypeID"))');
  });
});
