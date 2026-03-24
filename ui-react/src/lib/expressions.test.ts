import { describe, it, expect } from 'vitest';
import { tokenize, parse, evaluate, evaluateExpression, truthy, isExpression, applyConditionalFormatting } from './expressions';

// ============================================================
// tokenize
// ============================================================

describe('tokenize', () => {
  it('tokenizes field references', () => {
    const tokens = tokenize('[FieldName]');
    expect(tokens).toEqual([{ type: 'field-ref', value: 'FieldName' }]);
  });

  it('tokenizes string literals', () => {
    expect(tokenize('"hello"')).toEqual([{ type: 'string', value: 'hello' }]);
  });

  it('tokenizes date literals', () => {
    expect(tokenize('#2024-01-15#')).toEqual([{ type: 'date', value: '2024-01-15' }]);
  });

  it('tokenizes numbers', () => {
    expect(tokenize('42')).toEqual([{ type: 'number', value: 42 }]);
    expect(tokenize('3.14')).toEqual([{ type: 'number', value: 3.14 }]);
    expect(tokenize('.5')).toEqual([{ type: 'number', value: 0.5 }]);
  });

  it('tokenizes operators', () => {
    expect(tokenize('+ - * / &')).toEqual([
      { type: 'operator', value: '+' },
      { type: 'operator', value: '-' },
      { type: 'operator', value: '*' },
      { type: 'operator', value: '/' },
      { type: 'operator', value: '&' },
    ]);
  });

  it('tokenizes comparison operators', () => {
    expect(tokenize('<>')).toEqual([{ type: 'operator', value: '<>' }]);
    expect(tokenize('<=')).toEqual([{ type: 'operator', value: '<=' }]);
    expect(tokenize('>=')).toEqual([{ type: 'operator', value: '>=' }]);
    expect(tokenize('<')).toEqual([{ type: 'operator', value: '<' }]);
    expect(tokenize('>')).toEqual([{ type: 'operator', value: '>' }]);
    expect(tokenize('=')).toEqual([{ type: 'operator', value: '=' }]);
  });

  it('tokenizes identifiers', () => {
    expect(tokenize('IIf')).toEqual([{ type: 'identifier', value: 'IIf' }]);
    expect(tokenize('True')).toEqual([{ type: 'identifier', value: 'True' }]);
  });

  it('tokenizes parens and commas', () => {
    expect(tokenize('(a,b)')).toEqual([
      { type: 'paren-open', value: '(' },
      { type: 'identifier', value: 'a' },
      { type: 'comma', value: ',' },
      { type: 'identifier', value: 'b' },
      { type: 'paren-close', value: ')' },
    ]);
  });

  it('skips whitespace', () => {
    expect(tokenize('  42  ')).toEqual([{ type: 'number', value: 42 }]);
  });

  it('handles complex expression', () => {
    const tokens = tokenize('[Price] * [Quantity]');
    expect(tokens).toHaveLength(3);
    expect(tokens[0]).toEqual({ type: 'field-ref', value: 'Price' });
    expect(tokens[1]).toEqual({ type: 'operator', value: '*' });
    expect(tokens[2]).toEqual({ type: 'field-ref', value: 'Quantity' });
  });
});

// ============================================================
// parse
// ============================================================

describe('parse', () => {
  it('returns null for empty tokens', () => {
    expect(parse([])).toBeNull();
  });

  it('parses a number literal', () => {
    const ast = parse(tokenize('42'));
    expect(ast).toEqual({ type: 'literal', value: 42 });
  });

  it('parses a string literal', () => {
    const ast = parse(tokenize('"hello"'));
    expect(ast).toEqual({ type: 'string', value: 'hello' });
  });

  it('parses field references', () => {
    const ast = parse(tokenize('[Name]'));
    expect(ast).toEqual({ type: 'field-ref', name: 'Name' });
  });

  it('parses True/False/Null identifiers', () => {
    expect(parse(tokenize('True'))).toEqual({ type: 'literal', value: true });
    expect(parse(tokenize('False'))).toEqual({ type: 'literal', value: false });
    expect(parse(tokenize('Null'))).toEqual({ type: 'literal', value: null });
  });

  it('parses binary operations', () => {
    const ast = parse(tokenize('1 + 2'));
    expect(ast).toEqual({
      type: 'binary-op', op: '+',
      left: { type: 'literal', value: 1 },
      right: { type: 'literal', value: 2 },
    });
  });

  it('respects operator precedence (* before +)', () => {
    const ast = parse(tokenize('1 + 2 * 3'));
    expect(ast!.type).toBe('binary-op');
    const binAst = ast as { type: 'binary-op'; op: string; left: unknown; right: unknown };
    expect(binAst.op).toBe('+');
    expect((binAst.right as { op: string }).op).toBe('*');
  });

  it('parses string concatenation', () => {
    const ast = parse(tokenize('"hello" & " " & "world"'));
    expect(ast!.type).toBe('concat');
  });

  it('parses function calls', () => {
    const ast = parse(tokenize('Len("hello")'));
    expect(ast).toEqual({
      type: 'call', fn: 'len',
      args: [{ type: 'string', value: 'hello' }],
    });
  });

  it('parses aggregate calls', () => {
    const ast = parse(tokenize('Sum([Price])'));
    expect(ast).toEqual({
      type: 'aggregate', fn: 'sum',
      arg: { type: 'field-ref', name: 'Price' },
    });
  });

  it('parses Count(*)', () => {
    const ast = parse(tokenize('Count(*)'));
    expect(ast).toEqual({
      type: 'aggregate', fn: 'count',
      arg: { type: 'literal', value: '*' },
    });
  });

  it('parses Not operator', () => {
    const ast = parse(tokenize('Not True'));
    expect(ast).toEqual({
      type: 'not-op',
      operand: { type: 'literal', value: true },
    });
  });

  it('parses And/Or operators', () => {
    const ast = parse(tokenize('True And False'));
    expect(ast!.type).toBe('and-op');
    const ast2 = parse(tokenize('True Or False'));
    expect(ast2!.type).toBe('or-op');
  });

  it('parses unary minus', () => {
    const ast = parse(tokenize('-5'));
    expect(ast).toEqual({
      type: 'binary-op', op: '*',
      left: { type: 'literal', value: -1 },
      right: { type: 'literal', value: 5 },
    });
  });

  it('parses parenthesized expression', () => {
    const ast = parse(tokenize('(1 + 2) * 3'));
    expect(ast!.type).toBe('binary-op');
    const binAst = ast as { type: 'binary-op'; op: string; left: unknown; right: unknown };
    expect(binAst.op).toBe('*');
    expect((binAst.left as { op: string }).op).toBe('+');
  });

  it('parses unadorned identifiers as field-ref', () => {
    const ast = parse(tokenize('Name'));
    expect(ast).toEqual({ type: 'field-ref', name: 'Name' });
  });
});

// ============================================================
// truthy
// ============================================================

describe('truthy', () => {
  it('null/undefined → false', () => {
    expect(truthy(null)).toBe(false);
    expect(truthy(undefined)).toBe(false);
  });
  it('booleans', () => {
    expect(truthy(true)).toBe(true);
    expect(truthy(false)).toBe(false);
  });
  it('numbers: 0 → false, nonzero → true', () => {
    expect(truthy(0)).toBe(false);
    expect(truthy(1)).toBe(true);
    expect(truthy(-1)).toBe(true);
  });
  it('strings: empty/whitespace → false, nonempty → true', () => {
    expect(truthy('')).toBe(false);
    expect(truthy('  ')).toBe(false);
    expect(truthy('hello')).toBe(true);
  });
  it('objects → true', () => {
    expect(truthy({})).toBe(true);
  });
});

// ============================================================
// evaluate (via evaluateExpression)
// ============================================================

describe('evaluate', () => {
  const ctx = { record: { name: 'Alice', age: 30, price: 10, quantity: 3 } };

  it('evaluates field reference', () => {
    expect(evaluateExpression('[name]', ctx)).toBe('Alice');
  });

  it('field lookup is case-insensitive', () => {
    expect(evaluateExpression('[Name]', ctx)).toBe('Alice');
    expect(evaluateExpression('[NAME]', ctx)).toBe('Alice');
  });

  it('evaluates math: add, subtract, multiply, divide', () => {
    expect(evaluateExpression('10 + 5', {})).toBe(15);
    expect(evaluateExpression('10 - 3', {})).toBe(7);
    expect(evaluateExpression('4 * 5', {})).toBe(20);
    expect(evaluateExpression('15 / 3', {})).toBe(5);
  });

  it('division by zero → null', () => {
    expect(evaluateExpression('10 / 0', {})).toBeNull();
  });

  it('evaluates string concatenation with &', () => {
    expect(evaluateExpression('"Hello" & " " & "World"', {})).toBe('Hello World');
  });

  it('evaluates comparisons (return -1 or 0)', () => {
    expect(evaluateExpression('5 = 5', {})).toBe(-1);
    expect(evaluateExpression('5 = 3', {})).toBe(0);
    expect(evaluateExpression('5 <> 3', {})).toBe(-1);
    expect(evaluateExpression('5 < 10', {})).toBe(-1);
    expect(evaluateExpression('5 > 10', {})).toBe(0);
    expect(evaluateExpression('5 <= 5', {})).toBe(-1);
    expect(evaluateExpression('5 >= 6', {})).toBe(0);
  });

  it('evaluates boolean operators (return -1 or 0)', () => {
    expect(evaluateExpression('True And True', {})).toBe(-1);
    expect(evaluateExpression('True And False', {})).toBe(0);
    expect(evaluateExpression('True Or False', {})).toBe(-1);
    expect(evaluateExpression('False Or False', {})).toBe(0);
    expect(evaluateExpression('Not True', {})).toBe(0);
    expect(evaluateExpression('Not False', {})).toBe(-1);
  });

  it('evaluates field expressions', () => {
    expect(evaluateExpression('[price] * [quantity]', ctx)).toBe(30);
  });

  it('returns #Error on parse/eval failure', () => {
    expect(evaluateExpression('(((', {})).toBe('#Error');
  });

  it('evaluates page/pages context', () => {
    expect(evaluateExpression('[Page]', { page: 3, pages: 10 })).toBe(3);
    expect(evaluateExpression('[Pages]', { page: 3, pages: 10 })).toBe(10);
  });
});

// ============================================================
// Built-in functions
// ============================================================

describe('built-in functions', () => {
  it('IIf — conditional', () => {
    expect(evaluateExpression('IIf(True, "yes", "no")', {})).toBe('yes');
    expect(evaluateExpression('IIf(False, "yes", "no")', {})).toBe('no');
  });

  it('Nz — null coalesce', () => {
    expect(evaluateExpression('Nz(Null, "default")', {})).toBe('default');
    expect(evaluateExpression('Nz("value", "default")', {})).toBe('value');
    expect(evaluateExpression('Nz(Null)', {})).toBe(0);
  });

  it('Left / Right / Mid', () => {
    const ctx = { record: { s: 'Hello World' } };
    expect(evaluateExpression('Left("Hello", 3)', ctx)).toBe('Hel');
    expect(evaluateExpression('Right("Hello", 3)', ctx)).toBe('llo');
    expect(evaluateExpression('Mid("Hello World", 7)', ctx)).toBe('World');
    expect(evaluateExpression('Mid("Hello World", 7, 3)', ctx)).toBe('Wor');
  });

  it('Len / Trim', () => {
    expect(evaluateExpression('Len("test")', {})).toBe(4);
    expect(evaluateExpression('Trim("  hi  ")', {})).toBe('hi');
  });

  it('UCase / LCase', () => {
    expect(evaluateExpression('UCase("hello")', {})).toBe('HELLO');
    expect(evaluateExpression('LCase("HELLO")', {})).toBe('hello');
  });

  it('Int / Abs / Round / Val', () => {
    expect(evaluateExpression('Int(3.7)', {})).toBe(3);
    expect(evaluateExpression('Abs(-5)', {})).toBe(5);
    expect(evaluateExpression('Round(3.456, 2)', {})).toBe(3.46);
    expect(evaluateExpression('Val("42.5abc")', {})).toBe(42.5);
    expect(evaluateExpression('Val("abc")', {})).toBe(0);
  });

  it('InStr — find substring (1-based)', () => {
    expect(evaluateExpression('InStr("Hello World", "World")', {})).toBe(7);
    expect(evaluateExpression('InStr("Hello", "xyz")', {})).toBe(0);
  });

  it('InStr — case-insensitive', () => {
    expect(evaluateExpression('InStr("Hello World", "world")', {})).toBe(7);
  });

  it('Replace', () => {
    expect(evaluateExpression('Replace("aXbXc", "X", "-")', {})).toBe('a-b-c');
  });

  it('IsNull', () => {
    expect(evaluateExpression('IsNull(Null)', {})).toBe(-1);
    expect(evaluateExpression('IsNull("text")', {})).toBe(0);
  });

  it('Format — currency', () => {
    expect(evaluateExpression('Format(1234.5, "Currency")', {})).toBe('$1234.50');
  });

  it('Format — percent', () => {
    expect(evaluateExpression('Format(0.75, "Percent")', {})).toBe('75%');
  });

  it('Format — fixed', () => {
    expect(evaluateExpression('Format(3.1, "Fixed")', {})).toBe('3.10');
  });
});

// ============================================================
// Aggregates
// ============================================================

describe('aggregates', () => {
  const records = [
    { price: 10, qty: 2 },
    { price: 20, qty: 3 },
    { price: 30, qty: 1 },
  ];
  const ctx = { allRecords: records };

  it('Sum', () => {
    expect(evaluateExpression('Sum([price])', ctx)).toBe(60);
  });

  it('Count(*)', () => {
    expect(evaluateExpression('Count(*)', ctx)).toBe(3);
  });

  it('Avg', () => {
    expect(evaluateExpression('Avg([price])', ctx)).toBe(20);
  });

  it('Min / Max', () => {
    expect(evaluateExpression('Min([price])', ctx)).toBe(10);
    expect(evaluateExpression('Max([price])', ctx)).toBe(30);
  });

  it('aggregates with empty records', () => {
    expect(evaluateExpression('Sum([price])', { allRecords: [] })).toBe(0);
    expect(evaluateExpression('Avg([price])', { allRecords: [] })).toBe(0);
    expect(evaluateExpression('Min([price])', { allRecords: [] })).toBeNull();
    expect(evaluateExpression('Max([price])', { allRecords: [] })).toBeNull();
  });
});

// ============================================================
// isExpression
// ============================================================

describe('isExpression', () => {
  it('returns true for strings starting with =', () => {
    expect(isExpression('=[Price]*[Qty]')).toBe(true);
  });
  it('returns false for plain strings', () => {
    expect(isExpression('Price')).toBe(false);
  });
  it('returns false for non-strings', () => {
    expect(isExpression(null)).toBe(false);
    expect(isExpression(42)).toBe(false);
    expect(isExpression(undefined)).toBe(false);
  });
});

// ============================================================
// applyConditionalFormatting
// ============================================================

describe('applyConditionalFormatting', () => {
  it('returns null when no rules', () => {
    expect(applyConditionalFormatting({}, {})).toBeNull();
  });

  it('returns style from first matching rule', () => {
    const ctrl = {
      'conditional-formatting': [
        { expression: '[Price] > 100', 'fore-color': '#ff0000', 'font-bold': 1 },
        { expression: '[Price] > 50', 'back-color': '#00ff00' },
      ],
    };
    const record = { Price: 75 };
    const result = applyConditionalFormatting(ctrl, record);
    expect(result).toEqual({ backgroundColor: '#00ff00' });
  });

  it('returns null when no rules match', () => {
    const ctrl = {
      'conditional-formatting': [
        { expression: '[Price] > 1000', 'fore-color': '#ff0000' },
      ],
    };
    expect(applyConditionalFormatting(ctrl, { Price: 5 })).toBeNull();
  });

  it('handles JSON string rules', () => {
    const ctrl = {
      'conditional-formatting': JSON.stringify([
        { expression: '1 = 1', 'fore-color': '#ff0000' },
      ]),
    };
    const result = applyConditionalFormatting(ctrl, {});
    expect(result).toEqual({ color: '#ff0000' });
  });

  it('includes font-bold and font-italic', () => {
    const ctrl = {
      'conditional-formatting': [
        { expression: 'True', 'font-bold': 1, 'font-italic': 1 },
      ],
    };
    const result = applyConditionalFormatting(ctrl, {});
    expect(result).toEqual({ fontWeight: 'bold', fontStyle: 'italic' });
  });
});
