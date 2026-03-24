import { describe, it, expect } from 'vitest';
import {
  coerceYesNo, coerceToNumber, coerceToControlType,
  normalizeControl, normalizeFormDefinition, normalizeReportDefinition,
} from './normalize';

// ============================================================
// coerceYesNo
// ============================================================

describe('coerceYesNo', () => {
  it('null/undefined → null', () => {
    expect(coerceYesNo(null)).toBeNull();
    expect(coerceYesNo(undefined)).toBeNull();
  });
  it('numbers: 0 → 0, nonzero → 1', () => {
    expect(coerceYesNo(0)).toBe(0);
    expect(coerceYesNo(1)).toBe(1);
    expect(coerceYesNo(-1)).toBe(1);
    expect(coerceYesNo(42)).toBe(1);
  });
  it('booleans: true → 1, false → 0', () => {
    expect(coerceYesNo(true)).toBe(1);
    expect(coerceYesNo(false)).toBe(0);
  });
  it('strings: yes/true/1 → 1, others → 0', () => {
    expect(coerceYesNo('Yes')).toBe(1);
    expect(coerceYesNo('TRUE')).toBe(1);
    expect(coerceYesNo('1')).toBe(1);
    expect(coerceYesNo('no')).toBe(0);
    expect(coerceYesNo('false')).toBe(0);
    expect(coerceYesNo('0')).toBe(0);
    expect(coerceYesNo('anything')).toBe(0);
  });
  it('other types → 1', () => {
    expect(coerceYesNo({})).toBe(1);
    expect(coerceYesNo([])).toBe(1);
  });
});

// ============================================================
// coerceToNumber
// ============================================================

describe('coerceToNumber', () => {
  it('null/undefined → null', () => {
    expect(coerceToNumber(null)).toBeNull();
    expect(coerceToNumber(undefined)).toBeNull();
  });
  it('number → same number', () => {
    expect(coerceToNumber(42)).toBe(42);
    expect(coerceToNumber(3.14)).toBe(3.14);
  });
  it('string → parseFloat', () => {
    expect(coerceToNumber('100')).toBe(100);
    expect(coerceToNumber('3.14')).toBe(3.14);
    expect(coerceToNumber('abc')).toBeNull();
  });
  it('other types → null', () => {
    expect(coerceToNumber(true)).toBeNull();
    expect(coerceToNumber({})).toBeNull();
  });
});

// ============================================================
// coerceToControlType
// ============================================================

describe('coerceToControlType', () => {
  it('falsy → text-box default', () => {
    expect(coerceToControlType(null)).toBe('text-box');
    expect(coerceToControlType(undefined)).toBe('text-box');
    expect(coerceToControlType('')).toBe('text-box');
  });
  it('strips leading colon from CLJS keywords', () => {
    expect(coerceToControlType(':combo-box')).toBe('combo-box');
    expect(coerceToControlType(':label')).toBe('label');
  });
  it('passes through plain strings', () => {
    expect(coerceToControlType('button')).toBe('button');
  });
});

// ============================================================
// normalizeControl
// ============================================================

describe('normalizeControl', () => {
  it('coerces type to string', () => {
    const ctrl = normalizeControl({ type: ':combo-box', name: 'x' });
    expect(ctrl.type).toBe('combo-box');
  });

  it('defaults visible=1, enabled=1, locked=0, tab-stop=1', () => {
    const ctrl = normalizeControl({ type: 'text-box', name: 'x' });
    expect(ctrl.visible).toBe(1);
    expect(ctrl.enabled).toBe(1);
    expect(ctrl.locked).toBe(0);
    expect((ctrl as Record<string, unknown>)['tab-stop']).toBe(1);
  });

  it('coerces yes/no values', () => {
    const ctrl = normalizeControl({ type: 'text-box', name: 'x', visible: 'Yes', locked: true });
    expect(ctrl.visible).toBe(1);
    expect(ctrl.locked).toBe(1);
  });

  it('coerces numeric properties', () => {
    const ctrl = normalizeControl({ type: 'text-box', name: 'x', width: '100', height: '50' });
    expect(ctrl.width).toBe(100);
    expect(ctrl.height).toBe(50);
  });

  it('only coerces numeric props that exist in the object', () => {
    const ctrl = normalizeControl({ type: 'text-box', name: 'x' });
    // width/height not in source, so should not be set
    expect('width' in ctrl).toBe(false);
  });
});

// ============================================================
// normalizeFormDefinition
// ============================================================

describe('normalizeFormDefinition', () => {
  it('applies yes/no defaults for missing form props', () => {
    const form = normalizeFormDefinition({});
    expect(form.popup).toBe(0);
    expect(form.modal).toBe(0);
    expect((form as Record<string, unknown>)['allow-additions']).toBe(1);
    expect((form as Record<string, unknown>)['allow-deletions']).toBe(1);
    expect((form as Record<string, unknown>)['allow-edits']).toBe(1);
    expect((form as Record<string, unknown>)['navigation-buttons']).toBe(1);
    expect((form as Record<string, unknown>)['record-selectors']).toBe(1);
    expect((form as Record<string, unknown>)['dividing-lines']).toBe(1);
    expect((form as Record<string, unknown>)['data-entry']).toBe(0);
  });

  it('coerces form yes/no props', () => {
    const form = normalizeFormDefinition({ popup: true, modal: -1 });
    expect(form.popup).toBe(1);
    expect(form.modal).toBe(1);
  });

  it('normalizes sections and their controls', () => {
    const form = normalizeFormDefinition({
      detail: {
        controls: [
          { type: ':text-box', name: 'field1', width: '100' },
        ],
      },
    });
    const ctrl = ((form.detail as Record<string, unknown>)?.controls as Record<string, unknown>[])?.[0];
    expect(ctrl?.type).toBe('text-box');
    expect(ctrl?.width).toBe(100);
  });

  it('lowercases record-source', () => {
    const form = normalizeFormDefinition({ 'record-source': 'Employees' });
    expect(form['record-source']).toBe('employees');
  });

  it('coerces width to number', () => {
    const form = normalizeFormDefinition({ width: '500' });
    expect(form.width).toBe(500);
  });
});

// ============================================================
// normalizeReportDefinition
// ============================================================

describe('normalizeReportDefinition', () => {
  it('normalizes standard band sections', () => {
    const report = normalizeReportDefinition({
      detail: {
        controls: [{ type: ':label', name: 'lbl', width: '200' }],
      },
    });
    const ctrl = ((report.detail as Record<string, unknown>)?.controls as Record<string, unknown>[])?.[0];
    expect(ctrl?.type).toBe('label');
    expect(ctrl?.width).toBe(200);
  });

  it('normalizes group band sections', () => {
    const report = normalizeReportDefinition({
      'group-header-0': {
        controls: [{ type: 'text-box', name: 'gh', visible: 'no' }],
      },
      'group-footer-1': {
        controls: [{ type: 'label', name: 'gf' }],
      },
    });
    const ghCtrl = ((report as Record<string, unknown>)['group-header-0'] as Record<string, unknown>)?.controls as Record<string, unknown>[];
    expect(ghCtrl?.[0]?.visible).toBe(0);
  });

  it('lowercases record-source', () => {
    const report = normalizeReportDefinition({ 'record-source': 'SalesReport' });
    expect(report['record-source']).toBe('salesreport');
  });

  it('coerces width to number', () => {
    const report = normalizeReportDefinition({ width: '600' });
    expect(report.width).toBe(600);
  });
});
