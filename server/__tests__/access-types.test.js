/**
 * Tests for access-types.js — Access → PostgreSQL type mapping.
 * Covers resolveType (descriptor → PG type), mapAccessType (DAO code → descriptor),
 * and the full pipeline (DAO code → PG type).
 */

const { resolveType, mapAccessType, quoteIdent } = require('../lib/access-types');

// ─── resolveType ────────────────────────────────────────────────────────────

describe('resolveType', () => {
  test('Short Text with maxLength', () => {
    expect(resolveType({ type: 'Short Text', maxLength: 50 })).toBe('character varying(50)');
  });

  test('Short Text defaults to 255', () => {
    expect(resolveType({ type: 'Short Text' })).toBe('character varying(255)');
  });

  test('Long Text → text', () => {
    expect(resolveType({ type: 'Long Text' })).toBe('text');
  });

  test('Number/Byte → smallint', () => {
    expect(resolveType({ type: 'Number', fieldSize: 'Byte' })).toBe('smallint');
  });

  test('Number/Integer → smallint', () => {
    expect(resolveType({ type: 'Number', fieldSize: 'Integer' })).toBe('smallint');
  });

  test('Number/Long Integer → integer', () => {
    expect(resolveType({ type: 'Number', fieldSize: 'Long Integer' })).toBe('integer');
  });

  test('Number/Big Integer → bigint', () => {
    expect(resolveType({ type: 'Number', fieldSize: 'Big Integer' })).toBe('bigint');
  });

  test('Number/Single → real', () => {
    expect(resolveType({ type: 'Number', fieldSize: 'Single' })).toBe('real');
  });

  test('Number/Double → double precision', () => {
    expect(resolveType({ type: 'Number', fieldSize: 'Double' })).toBe('double precision');
  });

  test('Number/Decimal with precision and scale', () => {
    expect(resolveType({ type: 'Number', fieldSize: 'Decimal', precision: 10, scale: 2 }))
      .toBe('numeric(10,2)');
  });

  test('Number/Decimal defaults to 18,0', () => {
    expect(resolveType({ type: 'Number', fieldSize: 'Decimal' })).toBe('numeric(18,0)');
  });

  test('Number defaults to integer when fieldSize unknown', () => {
    expect(resolveType({ type: 'Number', fieldSize: 'SomeNew' })).toBe('integer');
  });

  test('Number defaults to Long Integer when fieldSize omitted', () => {
    expect(resolveType({ type: 'Number' })).toBe('integer');
  });

  test('Yes/No → boolean', () => {
    expect(resolveType({ type: 'Yes/No' })).toBe('boolean');
  });

  test('Date/Time → timestamp without time zone', () => {
    expect(resolveType({ type: 'Date/Time' })).toBe('timestamp without time zone');
  });

  test('Date/Time Extended → timestamp with time zone', () => {
    expect(resolveType({ type: 'Date/Time Extended' })).toBe('timestamp with time zone');
  });

  test('Currency → numeric(19,4)', () => {
    expect(resolveType({ type: 'Currency' })).toBe('numeric(19,4)');
  });

  test('AutoNumber → integer', () => {
    expect(resolveType({ type: 'AutoNumber' })).toBe('integer');
  });

  test('raw PG type passed through', () => {
    expect(resolveType({ type: 'jsonb' })).toBe('jsonb');
  });

  test('empty type → text', () => {
    expect(resolveType({ type: '' })).toBe('text');
    expect(resolveType({})).toBe('text');
  });
});

// ─── mapAccessType ──────────────────────────────────────────────────────────

describe('mapAccessType', () => {
  test('code 1 (Boolean) → Yes/No', () => {
    expect(mapAccessType({ type: 1 })).toEqual({ type: 'Yes/No' });
  });

  test('code 2 (Byte) → Number/Byte', () => {
    expect(mapAccessType({ type: 2 })).toEqual({ type: 'Number', fieldSize: 'Byte' });
  });

  test('code 3 (Integer) → Number/Integer', () => {
    expect(mapAccessType({ type: 3 })).toEqual({ type: 'Number', fieldSize: 'Integer' });
  });

  test('code 4 (Long) → Number/Long Integer', () => {
    expect(mapAccessType({ type: 4 })).toEqual({ type: 'Number', fieldSize: 'Long Integer' });
  });

  test('code 4 with AutoNumber → AutoNumber', () => {
    expect(mapAccessType({ type: 4, isAutoNumber: true })).toEqual({ type: 'AutoNumber' });
  });

  test('code 5 (Currency) → Currency', () => {
    expect(mapAccessType({ type: 5 })).toEqual({ type: 'Currency' });
  });

  test('code 6 (Single) → Number/Single', () => {
    expect(mapAccessType({ type: 6 })).toEqual({ type: 'Number', fieldSize: 'Single' });
  });

  test('code 7 (Double) → Number/Double', () => {
    expect(mapAccessType({ type: 7 })).toEqual({ type: 'Number', fieldSize: 'Double' });
  });

  test('code 8 (Date/Time) → Date/Time', () => {
    expect(mapAccessType({ type: 8 })).toEqual({ type: 'Date/Time' });
  });

  test('code 10 (Text) with size → Short Text', () => {
    expect(mapAccessType({ type: 10, size: 100 })).toEqual({ type: 'Short Text', maxLength: 100 });
  });

  test('code 10 (Text) without size defaults to 255', () => {
    expect(mapAccessType({ type: 10 })).toEqual({ type: 'Short Text', maxLength: 255 });
  });

  test('code 12 (Memo) → Long Text', () => {
    expect(mapAccessType({ type: 12 })).toEqual({ type: 'Long Text' });
  });

  test('code 15 (GUID) → Short Text/38', () => {
    expect(mapAccessType({ type: 15 })).toEqual({ type: 'Short Text', maxLength: 38 });
  });

  test('code 16 (BigInt) → Number/Big Integer', () => {
    expect(mapAccessType({ type: 16 })).toEqual({ type: 'Number', fieldSize: 'Big Integer' });
  });

  test('code 18 (Calculated) resolves via resultType', () => {
    // Calculated with resultType=7 (Double)
    const result = mapAccessType({ type: 18, resultType: 7 });
    expect(result).toEqual({ type: 'Number', fieldSize: 'Double' });
  });

  test('code 18 (Calculated) defaults resultType to 10 (Text)', () => {
    const result = mapAccessType({ type: 18 });
    expect(result).toEqual({ type: 'Short Text', maxLength: 255 });
  });

  test('code 20 (Decimal) with precision/scale', () => {
    const result = mapAccessType({ type: 20, precision: 10, scale: 4 });
    expect(result).toEqual({ type: 'Number', fieldSize: 'Decimal', precision: 10, scale: 4 });
  });

  test('code 20 (Decimal) defaults to 18,0', () => {
    const result = mapAccessType({ type: 20 });
    expect(result).toEqual({ type: 'Number', fieldSize: 'Decimal', precision: 18, scale: 0 });
  });

  test('code 26 (DateTimeExtended) → Date/Time Extended', () => {
    expect(mapAccessType({ type: 26 })).toEqual({ type: 'Date/Time Extended' });
  });

  test('unknown code falls back to Short Text/255', () => {
    expect(mapAccessType({ type: 999 })).toEqual({ type: 'Short Text', maxLength: 255 });
  });
});

// ─── Full pipeline: DAO code → PG type ──────────────────────────────────────

describe('DAO code → PG type (full pipeline)', () => {
  function daoPgType(field) {
    return resolveType(mapAccessType(field));
  }

  test('1 (Boolean) → boolean', () => {
    expect(daoPgType({ type: 1 })).toBe('boolean');
  });

  test('2 (Byte) → smallint', () => {
    expect(daoPgType({ type: 2 })).toBe('smallint');
  });

  test('3 (Integer) → smallint', () => {
    expect(daoPgType({ type: 3 })).toBe('smallint');
  });

  test('4 (Long) → integer', () => {
    expect(daoPgType({ type: 4 })).toBe('integer');
  });

  test('4 (AutoNumber) → integer', () => {
    expect(daoPgType({ type: 4, isAutoNumber: true })).toBe('integer');
  });

  test('5 (Currency) → numeric(19,4)', () => {
    expect(daoPgType({ type: 5 })).toBe('numeric(19,4)');
  });

  test('6 (Single) → real', () => {
    expect(daoPgType({ type: 6 })).toBe('real');
  });

  test('7 (Double) → double precision', () => {
    expect(daoPgType({ type: 7 })).toBe('double precision');
  });

  test('8 (Date/Time) → timestamp without time zone', () => {
    expect(daoPgType({ type: 8 })).toBe('timestamp without time zone');
  });

  test('10 (Text/50) → character varying(50)', () => {
    expect(daoPgType({ type: 10, size: 50 })).toBe('character varying(50)');
  });

  test('12 (Memo) → text', () => {
    expect(daoPgType({ type: 12 })).toBe('text');
  });

  test('15 (GUID) → character varying(38)', () => {
    expect(daoPgType({ type: 15 })).toBe('character varying(38)');
  });

  test('16 (BigInt) → bigint', () => {
    expect(daoPgType({ type: 16 })).toBe('bigint');
  });

  test('18 (Calculated/Double) → double precision', () => {
    expect(daoPgType({ type: 18, resultType: 7 })).toBe('double precision');
  });

  test('18 (Calculated/Currency) → numeric(19,4)', () => {
    expect(daoPgType({ type: 18, resultType: 5 })).toBe('numeric(19,4)');
  });

  test('20 (Decimal 10,2) → numeric(10,2)', () => {
    expect(daoPgType({ type: 20, precision: 10, scale: 2 })).toBe('numeric(10,2)');
  });

  test('20 (Decimal default) → numeric(18,0)', () => {
    expect(daoPgType({ type: 20 })).toBe('numeric(18,0)');
  });

  test('26 (DateTimeExtended) → timestamp with time zone', () => {
    expect(daoPgType({ type: 26 })).toBe('timestamp with time zone');
  });

  test('unknown code → character varying(255)', () => {
    expect(daoPgType({ type: 999 })).toBe('character varying(255)');
  });
});

// ─── quoteIdent ─────────────────────────────────────────────────────────────

describe('quoteIdent', () => {
  test('simple name', () => {
    expect(quoteIdent('users')).toBe('"users"');
  });

  test('name with spaces', () => {
    expect(quoteIdent('order details')).toBe('"order details"');
  });

  test('name with embedded quotes', () => {
    expect(quoteIdent('col"name')).toBe('"col""name"');
  });
});
