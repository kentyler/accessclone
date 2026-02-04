const { validateForm, validateControl, normalizeType } = require('../routes/lint');

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
