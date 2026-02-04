const { jsonToEdn } = require('../lib/helpers');
const { parseEDN } = require('../../scripts/lint-forms');
const { extractRecordSource } = require('../routes/forms');

describe('form round-trip (JSON -> EDN -> parse)', () => {
  const fullForm = {
    id: 'carriers',
    name: 'List_of_Carriers',
    record_source: 'list_of_carriers',
    default_view: 'single',
    header: {
      height: 50,
      controls: [
        { type: 'label', text: 'Carrier List', x: 10, y: 10, width: 300, height: 30 }
      ]
    },
    detail: {
      height: 250,
      controls: [
        { type: 'text-box', field: 'carrier', x: 10, y: 10, width: 300, height: 25 },
        { type: 'text-box', field: 'contact_name', x: 10, y: 40, width: 300, height: 25 },
        { type: 'combo-box', field: 'status', x: 10, y: 70, width: 200, height: 25 },
        { type: 'check-box', field: 'active', x: 10, y: 100, width: 100, height: 25 }
      ]
    },
    footer: {
      height: 40,
      controls: [
        { type: 'button', x: 10, y: 5, width: 80, height: 30 }
      ]
    }
  };

  let edn, parsed;

  beforeAll(() => {
    edn = jsonToEdn(fullForm);
    parsed = parseEDN(edn);
  });

  test('complete form converts to EDN and parses back', () => {
    expect(parsed).toBeTruthy();
    expect(parsed.id).toBe('carriers');
    expect(parsed.name).toBe('List_of_Carriers');
  });

  test('all three sections survive round-trip', () => {
    expect(parsed.header).toBeTruthy();
    expect(parsed.detail).toBeTruthy();
    expect(parsed.footer).toBeTruthy();
    expect(parsed.header.height).toBe(50);
    expect(parsed.detail.height).toBe(250);
    expect(parsed.footer.height).toBe(40);
  });

  test('control types are usable after round-trip', () => {
    const detailTypes = parsed.detail.controls.map(c => c.type);
    // jsonToEdn produces string values, parseEDN returns them as strings
    expect(detailTypes).toEqual(['text-box', 'text-box', 'combo-box', 'check-box']);
    // Verify they're actual strings (not keywords with colon prefix)
    for (const t of detailTypes) {
      expect(t).not.toMatch(/^:/);
    }
  });

  test('field bindings are preserved after round-trip', () => {
    const fields = parsed.detail.controls.map(c => c.field).filter(Boolean);
    expect(fields).toEqual(['carrier', 'contact_name', 'status', 'active']);
  });

  test('record-source is extractable via regex after round-trip', () => {
    const rs = extractRecordSource(edn);
    expect(rs).toBe('list_of_carriers');
  });

  test('header label text survives round-trip', () => {
    expect(parsed.header.controls[0].text).toBe('Carrier List');
    expect(parsed.header.controls[0].type).toBe('label');
  });

  test('default-view is preserved (key hyphenated)', () => {
    expect(parsed['default-view']).toBe('single');
  });
});
