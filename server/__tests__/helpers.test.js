const { jsonToEdn } = require('../lib/helpers');
const { parseEDN } = require('../../scripts/lint-forms');

describe('jsonToEdn', () => {
  test('produces valid EDN for a form with controls', () => {
    const form = {
      id: 'test-form',
      name: 'TestForm',
      record_source: 'users',
      detail: {
        height: 300,
        controls: [
          { type: 'text-box', field: 'name', x: 10, y: 20, width: 200, height: 25 }
        ]
      }
    };

    const edn = jsonToEdn(form);
    // Should be parseable EDN
    const parsed = parseEDN(edn);
    expect(parsed).toBeTruthy();
    expect(parsed.id).toBe('test-form');
    expect(parsed.name).toBe('TestForm');
  });

  test('control types survive round-trip as usable strings', () => {
    const form = {
      detail: {
        controls: [
          { type: 'text-box', x: 0, y: 0, width: 100, height: 25 },
          { type: 'label', x: 0, y: 30, width: 100, height: 25 },
          { type: 'combo-box', x: 0, y: 60, width: 100, height: 25 }
        ]
      }
    };

    const edn = jsonToEdn(form);
    const parsed = parseEDN(edn);

    const types = parsed.detail.controls.map(c => c.type);
    // After round-trip, types are strings (jsonToEdn wraps them in quotes)
    expect(types).toEqual(['text-box', 'label', 'combo-box']);
  });

  test('field names are preserved through conversion', () => {
    const form = {
      detail: {
        controls: [
          { type: 'text-box', field: 'first_name', x: 0, y: 0, width: 100, height: 25 },
          { type: 'text-box', field: 'email', x: 0, y: 30, width: 100, height: 25 }
        ]
      }
    };

    const edn = jsonToEdn(form);
    const parsed = parseEDN(edn);

    expect(parsed.detail.controls[0].field).toBe('first_name');
    expect(parsed.detail.controls[1].field).toBe('email');
  });

  test('underscore-to-hyphen conversion on keys', () => {
    const form = {
      record_source: 'users',
      default_view: 'single'
    };

    const edn = jsonToEdn(form);
    // Keys should be converted: record_source -> :record-source
    expect(edn).toContain(':record-source');
    expect(edn).toContain(':default-view');
    // Values should NOT be converted
    expect(edn).toContain('"users"');
    expect(edn).toContain('"single"');
  });

  test('handles null, booleans, numbers, and empty collections', () => {
    expect(jsonToEdn(null)).toBe('nil');
    expect(jsonToEdn(true)).toBe('true');
    expect(jsonToEdn(false)).toBe('false');
    expect(jsonToEdn(42)).toBe('42');
    expect(jsonToEdn([])).toBe('[]');
    expect(jsonToEdn({})).toBe('{}');
  });

  test('round-trip: JSON form -> EDN -> parse -> verify structure', () => {
    const original = {
      id: 'carriers',
      name: 'List_of_Carriers',
      record_source: 'list_of_carriers',
      header: {
        height: 50,
        controls: [
          { type: 'label', text: 'Carriers', x: 10, y: 10, width: 200, height: 30 }
        ]
      },
      detail: {
        height: 200,
        controls: [
          { type: 'text-box', field: 'carrier', x: 10, y: 10, width: 300, height: 25 },
          { type: 'check-box', field: 'active', x: 10, y: 40, width: 100, height: 25 }
        ]
      }
    };

    const edn = jsonToEdn(original);
    const parsed = parseEDN(edn);

    // Top-level fields (keys hyphenated)
    expect(parsed.id).toBe('carriers');
    expect(parsed.name).toBe('List_of_Carriers');
    expect(parsed['record-source']).toBe('list_of_carriers');

    // Header
    expect(parsed.header.height).toBe(50);
    expect(parsed.header.controls[0].type).toBe('label');
    expect(parsed.header.controls[0].text).toBe('Carriers');

    // Detail
    expect(parsed.detail.height).toBe(200);
    expect(parsed.detail.controls).toHaveLength(2);
    expect(parsed.detail.controls[0].type).toBe('text-box');
    expect(parsed.detail.controls[0].field).toBe('carrier');
    expect(parsed.detail.controls[1].type).toBe('check-box');
    expect(parsed.detail.controls[1].field).toBe('active');
  });
});
