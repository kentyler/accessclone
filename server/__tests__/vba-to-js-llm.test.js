const {
  needsLLMFallback,
  buildLLMPrompt,
  validateLLMOutput,
} = require('../lib/vba-to-js-llm');

// ============================================================
// needsLLMFallback
// ============================================================

describe('needsLLMFallback', () => {
  test('returns false for null/empty handler', () => {
    expect(needsLLMFallback(null)).toBe(false);
    expect(needsLLMFallback({})).toBe(false);
    expect(needsLLMFallback({ js: '' })).toBe(false);
  });

  test('returns false for fully clean handler (no comments)', () => {
    expect(needsLLMFallback({
      js: 'AC.openForm("frmDetails");\nAC.closeForm();'
    })).toBe(false);
  });

  test('returns false for all-comment handler (entire procedure untranslatable)', () => {
    expect(needsLLMFallback({
      js: '// [VBA] Dim rs As DAO.Recordset\n// [VBA] Set rs = CurrentDb.OpenRecordset("tbl")\n// [VBA] rs.MoveNext'
    })).toBe(false);
  });

  test('returns false when all comments are desktop no-ops', () => {
    expect(needsLLMFallback({
      js: 'AC.openForm("frmTest");\n// [VBA] Debug.Print "hello"\n// [VBA] DoEvents'
    })).toBe(false);
  });

  test('returns true for mixed handler with translatable comments', () => {
    expect(needsLLMFallback({
      js: 'AC.setEnabled("cmdDelete", false);\n// [VBA] Me.lblStatus.Caption = "New Record"'
    })).toBe(true);
  });

  test('returns true for handler with non-noop comment patterns', () => {
    expect(needsLLMFallback({
      js: 'AC.openForm("frmX");\n// [VBA] Me.sfrmOrders.Form.RecordSource = "SELECT * FROM Orders"'
    })).toBe(true);
  });

  test('returns false for Screen.MousePointer + Me.Painting only', () => {
    expect(needsLLMFallback({
      js: 'AC.closeForm();\n// [VBA] Screen.MousePointer = 11\n// [VBA] Me.Painting = False'
    })).toBe(false);
  });

  test('returns false for Application.Echo only', () => {
    expect(needsLLMFallback({
      js: 'AC.requery();\n// [VBA] Application.Echo False\n// [VBA] Application.Echo True'
    })).toBe(false);
  });
});

// ============================================================
// buildLLMPrompt
// ============================================================

describe('buildLLMPrompt', () => {
  const handler = {
    key: 'cmd-close.on-click',
    control: 'cmd-close',
    event: 'on-click',
    procedure: 'cmdClose_Click',
    js: 'AC.closeForm();\n// [VBA] Me.lblStatus.Caption = "Closed"',
  };

  const vbaSource = 'DoCmd.Close\nMe.lblStatus.Caption = "Closed"';

  const intent = {
    name: 'cmdClose_Click',
    intents: [{ type: 'close-form' }],
  };

  test('returns system and user strings', () => {
    const { system, user } = buildLLMPrompt(handler, vbaSource, intent, []);
    expect(typeof system).toBe('string');
    expect(typeof user).toBe('string');
    expect(system.length).toBeGreaterThan(100);
  });

  test('user prompt includes procedure name', () => {
    const { user } = buildLLMPrompt(handler, vbaSource, intent, []);
    expect(user).toContain('cmdClose_Click');
  });

  test('user prompt includes VBA source', () => {
    const { user } = buildLLMPrompt(handler, vbaSource, intent, []);
    expect(user).toContain('DoCmd.Close');
  });

  test('user prompt includes current JS translation', () => {
    const { user } = buildLLMPrompt(handler, vbaSource, intent, []);
    expect(user).toContain('AC.closeForm()');
    expect(user).toContain('// [VBA] Me.lblStatus.Caption');
  });

  test('user prompt includes intent data', () => {
    const { user } = buildLLMPrompt(handler, vbaSource, intent, []);
    expect(user).toContain('close-form');
  });

  test('user prompt includes other clean handlers', () => {
    const allHandlers = [
      handler,
      { key: 'cmd-save.on-click', js: 'AC.saveRecord();' },
      { key: 'form.on-load', js: 'AC.requery();' },
    ];
    const { user } = buildLLMPrompt(handler, vbaSource, intent, allHandlers);
    expect(user).toContain('cmd-save.on-click');
    expect(user).toContain('form.on-load');
  });

  test('handles null intent gracefully', () => {
    const { user } = buildLLMPrompt(handler, vbaSource, null, []);
    expect(user).toContain('(no intent data available)');
  });

  test('handles null vbaSource gracefully', () => {
    const { user } = buildLLMPrompt(handler, null, intent, []);
    expect(user).toContain('(not available)');
  });

  test('caps other handlers at 20', () => {
    const manyHandlers = Array.from({ length: 30 }, (_, i) => ({
      key: `ctrl${i}.on-click`,
      js: 'AC.saveRecord();',
    }));
    const { user } = buildLLMPrompt(handler, vbaSource, intent, manyHandlers);
    // Should list at most 20 other handlers
    const matches = user.match(/ctrl\d+\.on-click/g) || [];
    expect(matches.length).toBeLessThanOrEqual(20);
  });
});

// ============================================================
// validateLLMOutput
// ============================================================

describe('validateLLMOutput', () => {
  test('accepts valid AC.* code', () => {
    expect(validateLLMOutput('AC.openForm("frmTest");\nAC.closeForm();')).toBe(true);
  });

  test('accepts code with control flow', () => {
    expect(validateLLMOutput('if (AC.isNewRecord()) {\nAC.setEnabled("cmd", false);\n}')).toBe(true);
  });

  test('accepts code with comments (untranslatable lines)', () => {
    expect(validateLLMOutput('AC.saveRecord();\n// [VBA] Some DAO thing')).toBe(true);
  });

  test('rejects empty/null', () => {
    expect(validateLLMOutput('')).toBe(false);
    expect(validateLLMOutput(null)).toBe(false);
    expect(validateLLMOutput(undefined)).toBe(false);
  });

  test('rejects code with require()', () => {
    expect(validateLLMOutput('const fs = require("fs");\nAC.openForm("x");')).toBe(false);
  });

  test('rejects code with import', () => {
    expect(validateLLMOutput('import { foo } from "bar";\nAC.openForm("x");')).toBe(false);
  });

  test('rejects code with document.*', () => {
    expect(validateLLMOutput('document.getElementById("x").click();\nAC.openForm("x");')).toBe(false);
  });

  test('rejects code with window.* (except window.AC)', () => {
    expect(validateLLMOutput('window.location.href = "http://evil.com";')).toBe(false);
  });

  test('allows window.AC references', () => {
    expect(validateLLMOutput('window.AC.openForm("test");')).toBe(true);
  });

  test('rejects fetch calls', () => {
    expect(validateLLMOutput('fetch("http://evil.com");\nAC.openForm("x");')).toBe(false);
  });

  test('rejects eval', () => {
    expect(validateLLMOutput('eval("alert(1)");\nAC.openForm("x");')).toBe(false);
  });

  test('rejects code with no AC calls and no control flow', () => {
    expect(validateLLMOutput('console.log("hello");')).toBe(false);
  });

  test('accepts pure control flow (if/return)', () => {
    expect(validateLLMOutput('if (true) { return false; }')).toBe(true);
  });
});
