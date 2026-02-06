const {
  validateForm, validateControl, normalizeType,
  validateReport, validateFormCrossObject, validateReportCrossObject, isReportBand
} = require('../routes/lint');

describe('normalizeType', () => {
  test('strips leading colon from keyword-style type', () => {
    expect(normalizeType(':text-box')).toBe('text-box');
    expect(normalizeType(':label')).toBe('label');
    expect(normalizeType(':combo-box')).toBe('combo-box');
  });

  test('passes through plain string type unchanged', () => {
    expect(normalizeType('text-box')).toBe('text-box');
    expect(normalizeType('label')).toBe('label');
  });

  test('returns null for falsy input', () => {
    expect(normalizeType(null)).toBeNull();
    expect(normalizeType(undefined)).toBeNull();
    expect(normalizeType('')).toBeNull();
  });
});

describe('validateForm', () => {
  test('form missing id is rejected', () => {
    const form = { name: 'Test', 'record-source': 'users' };
    const issues = validateForm(form);
    const errors = issues.filter(i => i.severity === 'error');
    expect(errors.some(e => e.field === 'id')).toBe(true);
  });

  test('form missing name is rejected', () => {
    const form = { id: '1', 'record-source': 'users' };
    const issues = validateForm(form);
    const errors = issues.filter(i => i.severity === 'error');
    expect(errors.some(e => e.field === 'name')).toBe(true);
  });

  test('form missing record-source is rejected', () => {
    const form = { id: '1', name: 'Test' };
    const issues = validateForm(form);
    const errors = issues.filter(i => i.severity === 'error');
    expect(errors.some(e => e.field === 'record-source')).toBe(true);
  });

  test('control with string type "text-box" passes validation', () => {
    const form = {
      id: '1',
      name: 'Test',
      'record-source': 'users',
      detail: {
        height: 200,
        controls: [
          { type: 'text-box', field: 'name', x: 10, y: 10, width: 200, height: 25 }
        ]
      }
    };
    const issues = validateForm(form);
    const errors = issues.filter(i => i.severity === 'error');
    expect(errors).toHaveLength(0);
  });

  test('control with keyword-prefixed type ":text-box" passes (normalizeType strips colon)', () => {
    const form = {
      id: '1',
      name: 'Test',
      'record-source': 'users',
      detail: {
        height: 200,
        controls: [
          { type: ':text-box', field: 'name', x: 10, y: 10, width: 200, height: 25 }
        ]
      }
    };
    const issues = validateForm(form);
    const typeErrors = issues.filter(i => i.severity === 'error' && i.field === 'type');
    expect(typeErrors).toHaveLength(0);
  });

  test('text-box without field generates a warning', () => {
    const form = {
      id: '1',
      name: 'Test',
      'record-source': 'users',
      detail: {
        height: 200,
        controls: [
          { type: 'text-box', x: 10, y: 10, width: 200, height: 25 }
        ]
      }
    };
    const issues = validateForm(form);
    const warnings = issues.filter(i => i.severity === 'warning');
    expect(warnings.some(w => w.field === 'field')).toBe(true);
  });

  test('section missing height is rejected', () => {
    const form = {
      id: '1',
      name: 'Test',
      'record-source': 'users',
      detail: {
        controls: [
          { type: 'label', text: 'Hi', x: 0, y: 0, width: 100, height: 25 }
        ]
      }
    };
    const issues = validateForm(form);
    const errors = issues.filter(i => i.severity === 'error');
    expect(errors.some(e => e.field === 'height')).toBe(true);
  });

  test('section missing controls is rejected', () => {
    const form = {
      id: '1',
      name: 'Test',
      'record-source': 'users',
      detail: {
        height: 200
      }
    };
    const issues = validateForm(form);
    const errors = issues.filter(i => i.severity === 'error');
    expect(errors.some(e => e.field === 'controls')).toBe(true);
  });

  test('valid section-based form passes cleanly', () => {
    const form = {
      id: '1',
      name: 'Test',
      'record-source': 'users',
      header: {
        height: 50,
        controls: [
          { type: 'label', text: 'Title', x: 0, y: 0, width: 200, height: 30 }
        ]
      },
      detail: {
        height: 200,
        controls: [
          { type: 'text-box', field: 'name', x: 10, y: 10, width: 200, height: 25 },
          { type: 'text-box', field: 'email', x: 10, y: 40, width: 200, height: 25 }
        ]
      },
      footer: {
        height: 40,
        controls: [
          { type: 'button', x: 10, y: 5, width: 80, height: 30 }
        ]
      }
    };
    const issues = validateForm(form);
    const errors = issues.filter(i => i.severity === 'error');
    expect(errors).toHaveLength(0);
  });
});

// ============================================================
// REPORT VALIDATION
// ============================================================

describe('isReportBand', () => {
  test('recognizes standard bands', () => {
    expect(isReportBand('report-header')).toBe(true);
    expect(isReportBand('page-header')).toBe(true);
    expect(isReportBand('detail')).toBe(true);
    expect(isReportBand('page-footer')).toBe(true);
    expect(isReportBand('report-footer')).toBe(true);
  });

  test('recognizes group bands', () => {
    expect(isReportBand('group-header-0')).toBe(true);
    expect(isReportBand('group-header-1')).toBe(true);
    expect(isReportBand('group-footer-0')).toBe(true);
    expect(isReportBand('group-footer-2')).toBe(true);
  });

  test('rejects non-band keys', () => {
    expect(isReportBand('id')).toBe(false);
    expect(isReportBand('name')).toBe(false);
    expect(isReportBand('record-source')).toBe(false);
    expect(isReportBand('grouping')).toBe(false);
    expect(isReportBand('group-header-')).toBe(false);
  });
});

describe('validateReport', () => {
  test('report missing required fields is rejected', () => {
    const report = {};
    const issues = validateReport(report);
    const errors = issues.filter(i => i.severity === 'error');
    expect(errors.some(e => e.field === 'id')).toBe(true);
    expect(errors.some(e => e.field === 'name')).toBe(true);
    expect(errors.some(e => e.field === 'record-source')).toBe(true);
  });

  test('report with no bands generates warning', () => {
    const report = { id: '1', name: 'Test', 'record-source': 'users' };
    const issues = validateReport(report);
    const warnings = issues.filter(i => i.severity === 'warning');
    expect(warnings.some(w => w.message.includes('No band sections'))).toBe(true);
  });

  test('report validates band sections', () => {
    const report = {
      id: '1',
      name: 'Test',
      'record-source': 'users',
      detail: {
        controls: [] // missing height
      }
    };
    const issues = validateReport(report);
    const errors = issues.filter(i => i.severity === 'error');
    expect(errors.some(e => e.field === 'height' && e.location === 'detail')).toBe(true);
  });

  test('valid banded report passes cleanly', () => {
    const report = {
      id: '1',
      name: 'Test Report',
      'record-source': 'orders',
      'report-header': {
        height: 40,
        controls: [
          { type: 'label', text: 'Orders Report', x: 0, y: 0, width: 300, height: 30 }
        ]
      },
      'page-header': {
        height: 20,
        controls: [
          { type: 'label', text: 'Order ID', x: 0, y: 0, width: 80, height: 18 }
        ]
      },
      detail: {
        height: 20,
        controls: [
          { type: 'text-box', field: 'order_id', x: 0, y: 0, width: 80, height: 18 }
        ]
      },
      'page-footer': {
        height: 20,
        controls: []
      },
      'report-footer': {
        height: 30,
        controls: []
      }
    };
    const issues = validateReport(report);
    const errors = issues.filter(i => i.severity === 'error');
    expect(errors).toHaveLength(0);
  });

  test('report validates group-header and group-footer bands', () => {
    const report = {
      id: '1',
      name: 'Grouped Report',
      'record-source': 'orders',
      'group-header-0': {
        height: 25,
        controls: [
          { type: 'text-box', field: 'category', x: 0, y: 0, width: 150, height: 20 }
        ]
      },
      'group-footer-0': {
        height: 20,
        controls: []
      },
      detail: {
        height: 18,
        controls: [
          { type: 'text-box', field: 'item', x: 0, y: 0, width: 200, height: 16 }
        ]
      }
    };
    const issues = validateReport(report);
    const errors = issues.filter(i => i.severity === 'error');
    expect(errors).toHaveLength(0);
  });
});

// ============================================================
// CROSS-OBJECT VALIDATION
// ============================================================

describe('validateFormCrossObject', () => {
  const schemaInfo = new Map([
    ['users', ['id', 'name', 'email', 'created_at']],
    ['orders', ['id', 'user_id', 'total', 'status']],
  ]);

  test('valid form with existing record-source and fields passes', () => {
    const form = {
      id: '1',
      name: 'User Form',
      'record-source': 'users',
      detail: {
        height: 200,
        controls: [
          { type: 'text-box', field: 'name', x: 10, y: 10, width: 200, height: 25 },
          { type: 'text-box', field: 'email', x: 10, y: 40, width: 200, height: 25 }
        ]
      }
    };
    const issues = validateFormCrossObject(form, schemaInfo);
    expect(issues).toHaveLength(0);
  });

  test('record-source not in schema produces error', () => {
    const form = {
      id: '1',
      name: 'Bad Form',
      'record-source': 'nonexistent_table',
      detail: { height: 200, controls: [] }
    };
    const issues = validateFormCrossObject(form, schemaInfo);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('error');
    expect(issues[0].message).toContain('not found in database');
    expect(issues[0].suggestion).toContain('users');
  });

  test('field binding not in table produces error', () => {
    const form = {
      id: '1',
      name: 'User Form',
      'record-source': 'users',
      detail: {
        height: 200,
        controls: [
          { type: 'text-box', field: 'name', x: 10, y: 10, width: 200, height: 25 },
          { type: 'text-box', field: 'nonexistent_col', x: 10, y: 40, width: 200, height: 25 }
        ]
      }
    };
    const issues = validateFormCrossObject(form, schemaInfo);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain("'nonexistent_col'");
    expect(issues[0].message).toContain("'users'");
  });

  test('field binding is case-insensitive', () => {
    const form = {
      id: '1',
      name: 'User Form',
      'record-source': 'Users', // Capital U
      detail: {
        height: 200,
        controls: [
          { type: 'text-box', field: 'Name', x: 10, y: 10, width: 200, height: 25 } // Capital N
        ]
      }
    };
    const issues = validateFormCrossObject(form, schemaInfo);
    expect(issues).toHaveLength(0);
  });

  test('control-source is checked as well as field', () => {
    const form = {
      id: '1',
      name: 'User Form',
      'record-source': 'users',
      detail: {
        height: 200,
        controls: [
          { type: 'text-box', 'control-source': 'bogus_column', x: 10, y: 10, width: 200, height: 25 }
        ]
      }
    };
    const issues = validateFormCrossObject(form, schemaInfo);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('bogus_column');
  });

  test('empty record-source returns no issues', () => {
    const form = {
      id: '1',
      name: 'Unbound Form',
      'record-source': '',
      detail: { height: 200, controls: [] }
    };
    const issues = validateFormCrossObject(form, schemaInfo);
    expect(issues).toHaveLength(0);
  });

  test('labels and buttons without field are not flagged', () => {
    const form = {
      id: '1',
      name: 'User Form',
      'record-source': 'users',
      detail: {
        height: 200,
        controls: [
          { type: 'label', text: 'Name:', x: 10, y: 10, width: 100, height: 20 },
          { type: 'button', x: 10, y: 40, width: 80, height: 30 }
        ]
      }
    };
    const issues = validateFormCrossObject(form, schemaInfo);
    expect(issues).toHaveLength(0);
  });
});

describe('validateReportCrossObject', () => {
  const schemaInfo = new Map([
    ['orders', ['id', 'customer', 'total', 'order_date']],
    ['products', ['id', 'name', 'price']],
  ]);

  test('valid report with existing fields passes', () => {
    const report = {
      id: '1',
      name: 'Orders Report',
      'record-source': 'orders',
      detail: {
        height: 20,
        controls: [
          { type: 'text-box', field: 'customer', x: 0, y: 0, width: 150, height: 18 },
          { type: 'text-box', field: 'total', x: 160, y: 0, width: 80, height: 18 }
        ]
      }
    };
    const issues = validateReportCrossObject(report, schemaInfo);
    expect(issues).toHaveLength(0);
  });

  test('record-source miss produces error', () => {
    const report = {
      id: '1',
      name: 'Bad Report',
      'record-source': 'missing_table',
      detail: { height: 20, controls: [] }
    };
    const issues = validateReportCrossObject(report, schemaInfo);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('not found in database');
  });

  test('field binding miss in band section produces error', () => {
    const report = {
      id: '1',
      name: 'Orders Report',
      'record-source': 'orders',
      'group-header-0': {
        height: 25,
        controls: [
          { type: 'text-box', field: 'bogus_field', x: 0, y: 0, width: 150, height: 20 }
        ]
      },
      detail: {
        height: 20,
        controls: [
          { type: 'text-box', field: 'customer', x: 0, y: 0, width: 150, height: 18 }
        ]
      }
    };
    const issues = validateReportCrossObject(report, schemaInfo);
    expect(issues).toHaveLength(1);
    expect(issues[0].location).toBe('group-header-0 > control[0]');
    expect(issues[0].message).toContain('bogus_field');
  });

  test('non-band keys are ignored', () => {
    const report = {
      id: '1',
      name: 'Orders Report',
      'record-source': 'orders',
      grouping: [{ field: 'nonexistent' }], // not a band, should be ignored
      detail: {
        height: 20,
        controls: [
          { type: 'text-box', field: 'customer', x: 0, y: 0, width: 150, height: 18 }
        ]
      }
    };
    const issues = validateReportCrossObject(report, schemaInfo);
    expect(issues).toHaveLength(0);
  });
});
