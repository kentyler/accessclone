import { describe, it, expect } from 'vitest';
import { twipsToPx, accessColorToHex, convertControl, convertAccessForm, convertAccessReport } from './Converter';

// ============================================================
// twipsToPx (Converter version — handles null/undefined)
// ============================================================

describe('twipsToPx', () => {
  it('converts twips to pixels', () => {
    expect(twipsToPx(150)).toBe(10);
    expect(twipsToPx(1440)).toBe(96);
  });
  it('handles null/undefined → 0', () => {
    expect(twipsToPx(null)).toBe(0);
    expect(twipsToPx(undefined)).toBe(0);
  });
  it('rounds correctly', () => {
    expect(twipsToPx(100)).toBe(7);
  });
});

// ============================================================
// accessColorToHex (Converter version)
// ============================================================

describe('accessColorToHex', () => {
  it('converts BGR to hex', () => {
    expect(accessColorToHex(16711680)).toBe('#0000ff');
    expect(accessColorToHex(255)).toBe('#ff0000');
    expect(accessColorToHex(0)).toBe('#000000');
  });
  it('handles string input', () => {
    expect(accessColorToHex('16777215')).toBe('#ffffff');
  });
  it('returns empty for null/NaN', () => {
    expect(accessColorToHex(null)).toBe('');
    expect(accessColorToHex('')).toBe('');
    expect(accessColorToHex('xyz')).toBe('');
  });
});

// ============================================================
// convertControl
// ============================================================

describe('convertControl', () => {
  it('maps basic properties', () => {
    const ctrl = convertControl({
      controlType: 'text-box',
      name: 'txtName',
      left: 150,
      top: 300,
      width: 1500,
      height: 375,
    });
    expect(ctrl.type).toBe('text-box');
    expect(ctrl.name).toBe('txtName');
    expect(ctrl.left).toBe(10);
    expect(ctrl.top).toBe(20);
    expect(ctrl.width).toBe(100);
    expect(ctrl.height).toBe(25);
  });

  it('maps font properties', () => {
    const ctrl = convertControl({
      controlType: 'label',
      name: 'lbl',
      fontName: 'Segoe UI',
      fontSize: 11,
      fontWeight: 700,
      fontItalic: -1,
    });
    expect((ctrl as Record<string, unknown>)['font-name']).toBe('Segoe UI');
    expect((ctrl as Record<string, unknown>)['font-size']).toBe(11);
    expect((ctrl as Record<string, unknown>)['font-weight']).toBe(700);
    expect((ctrl as Record<string, unknown>)['font-italic']).toBe(1);
  });

  it('maps controlSource expression', () => {
    const ctrl = convertControl({
      controlType: 'text-box',
      name: 'txtTotal',
      controlSource: '=[Price]*[Qty]',
    });
    expect((ctrl as Record<string, unknown>)['control-source']).toBe('=[Price]*[Qty]');
  });

  it('strips table qualification from field', () => {
    const ctrl = convertControl({
      controlType: 'text-box',
      name: 'txtName',
      controlSource: 'Employees.FullName',
    });
    expect(ctrl.field).toBe('FullName');
  });

  it('maps combo-box row source', () => {
    const ctrl = convertControl({
      controlType: 'combo-box',
      name: 'cboStatus',
      rowSource: 'SELECT id, name FROM statuses',
      boundColumn: 1,
      columnCount: 2,
      columnWidths: '0;2400',
    });
    expect((ctrl as Record<string, unknown>)['row-source']).toBe('SELECT id, name FROM statuses');
    expect((ctrl as Record<string, unknown>)['bound-column']).toBe(1);
    expect((ctrl as Record<string, unknown>)['column-count']).toBe(2);
    expect((ctrl as Record<string, unknown>)['column-widths']).toBe('0;2400');
  });

  it('maps subform linking fields', () => {
    const ctrl = convertControl({
      controlType: 'sub-form',
      name: 'sfOrders',
      sourceObject: 'frmOrderItems',
      linkChildFields: 'order_id',
      linkMasterFields: 'id',
    });
    expect((ctrl as Record<string, unknown>)['source-object']).toBe('frmOrderItems');
    expect((ctrl as Record<string, unknown>)['link-child-fields']).toBe('order_id');
    expect((ctrl as Record<string, unknown>)['link-master-fields']).toBe('id');
  });

  it('maps event flags to has-*-event', () => {
    const ctrl = convertControl({
      controlType: 'command-button',
      name: 'btnSave',
      onClick: '[Event Procedure]',
      afterUpdate: '[Event Procedure]',
    });
    expect((ctrl as Record<string, unknown>)['has-on-click-event']).toBe(true);
    expect((ctrl as Record<string, unknown>)['has-after-update-event']).toBe(true);
  });

  it('coerces visible and enabled', () => {
    const ctrl = convertControl({
      controlType: 'text-box',
      name: 'txt',
      visible: 0,
      enabled: false,
    });
    expect(ctrl.visible).toBe(0);
    expect(ctrl.enabled).toBe(0);
  });

  it('maps picture properties', () => {
    const ctrl = convertControl({
      controlType: 'image',
      name: 'img',
      picture: 'photo.bmp',
      pictureSizeMode: 3,
    });
    expect((ctrl as Record<string, unknown>).picture).toBe('photo.bmp');
    expect((ctrl as Record<string, unknown>)['picture-size-mode']).toBe('zoom');
  });
});

// ============================================================
// convertAccessForm
// ============================================================

describe('convertAccessForm', () => {
  it('builds sections from camelCase keys', () => {
    const form = convertAccessForm({
      headerControls: [{ controlType: 'label', name: 'lblTitle', left: 0, top: 0, width: 0, height: 0 }],
      detailControls: [{ controlType: 'text-box', name: 'txtName', left: 0, top: 0, width: 0, height: 0 }],
    });
    expect(form.header).toBeDefined();
    expect((form.header as Record<string, unknown>)?.controls).toHaveLength(1);
    expect(form.detail).toBeDefined();
    expect((form.detail as Record<string, unknown>)?.controls).toHaveLength(1);
  });

  it('extracts record source from SQL', () => {
    const form = convertAccessForm({
      detailControls: [],
      recordSource: 'SELECT * FROM [Employees];',
    });
    expect(form['record-source']).toBe('employees');
  });

  it('uses table name directly when not SQL', () => {
    const form = convertAccessForm({
      detailControls: [],
      recordSource: 'Customers',
    });
    expect(form['record-source']).toBe('customers');
  });

  it('maps default view', () => {
    const form = convertAccessForm({ detailControls: [], defaultView: 1 });
    expect(form['default-view']).toBe('Continuous Forms');
  });

  it('maps navigation/edit boolean flags', () => {
    const form = convertAccessForm({
      detailControls: [],
      navigationButtons: 0,
      allowAdditions: false,
      popup: -1,
    });
    expect((form as Record<string, unknown>)['navigation-buttons']).toBe(0);
    expect((form as Record<string, unknown>)['allow-additions']).toBe(0);
    expect(form.popup).toBe(1);
  });

  it('maps scroll bars', () => {
    const form = convertAccessForm({ detailControls: [], scrollBars: 2 });
    expect((form as Record<string, unknown>)['scroll-bars']).toBe('vertical');
  });

  it('detects form-level events', () => {
    const form = convertAccessForm({
      detailControls: [],
      onLoad: '[Event Procedure]',
      onCurrent: '[Event Procedure]',
    });
    expect((form as Record<string, unknown>)['has-on-load-event']).toBe(true);
    expect((form as Record<string, unknown>)['has-on-current-event']).toBe(true);
  });

  it('excludes empty header/footer', () => {
    const form = convertAccessForm({ detailControls: [] });
    expect(form.header).toBeUndefined();
    expect(form.footer).toBeUndefined();
  });
});

// ============================================================
// convertAccessReport
// ============================================================

describe('convertAccessReport', () => {
  it('builds standard sections', () => {
    const report = convertAccessReport({
      Detail: { height: 750 },
      DetailControls: [{ controlType: 'text-box', name: 'txtName', left: 0, top: 0, width: 0, height: 0 }],
    });
    expect(report.detail).toBeDefined();
    expect((report.detail as Record<string, unknown>)?.controls).toHaveLength(1);
    expect((report.detail as Record<string, unknown>)?.height).toBe(50);
  });

  it('builds group header/footer sections', () => {
    const report = convertAccessReport({
      grouping: [{ field: 'category', sortOrder: 0 }],
      GroupHeader0: { height: 450 },
      GroupHeader0Controls: [{ controlType: 'label', name: 'lblCat', left: 0, top: 0, width: 0, height: 0 }],
    });
    expect((report as Record<string, unknown>)['group-header-0']).toBeDefined();
    const gh = (report as Record<string, unknown>)['group-header-0'] as Record<string, unknown>;
    expect(gh.controls).toHaveLength(1);
  });

  it('converts grouping array', () => {
    const report = convertAccessReport({
      grouping: [
        { field: 'category', sortOrder: 0, groupOn: 0, groupInterval: 1, groupHeader: true, groupFooter: false, keepTogether: 1 },
      ],
    });
    expect(report.grouping).toHaveLength(1);
    const g = (report.grouping as Record<string, unknown>[])[0];
    expect(g.field).toBe('category');
    expect(g['sort-order']).toBe('Ascending');
    expect(g['group-on']).toBe('Each Value');
    expect(g['group-header']).toBe(1);
    expect(g['group-footer']).toBe(0);
    expect(g['keep-together']).toBe('Whole Group');
  });

  it('maps record source', () => {
    const report = convertAccessReport({ recordSource: 'SalesQuery' });
    expect(report['record-source']).toBe('salesquery');
  });

  it('maps page layout dimensions', () => {
    const report = convertAccessReport({
      pageWidth: 12240,
      pageHeight: 15840,
      leftMargin: 1440,
    });
    expect((report as Record<string, unknown>)['page-width']).toBe(816);
    expect((report as Record<string, unknown>)['page-height']).toBe(1056);
    expect((report as Record<string, unknown>)['margin-left']).toBe(96);
  });

  it('detects report-level events', () => {
    const report = convertAccessReport({
      onOpen: '[Event Procedure]',
      onNoData: '[Event Procedure]',
    });
    expect((report as Record<string, unknown>)['has-on-open-event']).toBe(true);
    expect((report as Record<string, unknown>)['has-on-no-data-event']).toBe(true);
  });

  it('report-specific control properties', () => {
    const report = convertAccessReport({
      Detail: {},
      DetailControls: [{
        controlType: 'text-box',
        name: 'txtAmount',
        left: 0, top: 0, width: 0, height: 0,
        runningSum: 2,
        canGrow: -1,
      }],
    });
    const ctrl = ((report.detail as Record<string, unknown>)?.controls as Record<string, unknown>[])?.[0];
    expect(ctrl?.['running-sum']).toBe('Over All');
    expect(ctrl?.['can-grow']).toBe(1);
  });
});
