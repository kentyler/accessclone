const { createMockAC, executeWithMockAC, AC_METHODS } = require('../lib/test-harness/mock-ac');

describe('createMockAC', () => {
  test('records method calls with args', () => {
    const { ac, calls } = createMockAC();
    ac.openForm('frmLogin');
    ac.setValue('txtName', 'test');
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({ method: 'openForm', args: ['frmLogin'] });
    expect(calls[1]).toEqual({ method: 'setValue', args: ['txtName', 'test'] });
  });

  test('overrides return specific values', () => {
    const { ac } = createMockAC({ getValue: 'hello' });
    expect(ac.getValue('txtField')).toBe('hello');
  });

  test('override functions receive args', () => {
    const { ac } = createMockAC({
      getValue: (field) => field === 'txtName' ? 'Ken' : null
    });
    expect(ac.getValue('txtName')).toBe('Ken');
    expect(ac.getValue('txtOther')).toBeNull();
  });

  test('async methods return promises', async () => {
    const { ac } = createMockAC();
    const result = await ac.dLookup();
    expect(result).toBe(0);
  });

  test('async overrides wrapped in Promise.resolve', async () => {
    const { ac } = createMockAC({ dLookup: 42 });
    const result = await ac.dLookup('field', 'table', 'criteria');
    expect(result).toBe(42);
  });

  test('callFn defaults to null', async () => {
    const { ac } = createMockAC();
    const result = await ac.callFn('SomeFunc', 1, 2);
    expect(result).toBeNull();
  });

  test('getter defaults work', () => {
    const { ac } = createMockAC();
    expect(ac.getValue('x')).toBeNull();
    expect(ac.getVisible('x')).toBe(true);
    expect(ac.getEnabled('x')).toBe(true);
    expect(ac.isDirty()).toBe(false);
    expect(ac.isNewRecord()).toBe(false);
  });

  test('reset clears call log', () => {
    const { ac, calls, reset } = createMockAC();
    ac.openForm('test');
    expect(calls).toHaveLength(1);
    reset();
    expect(calls).toHaveLength(0);
  });

  test('alert is available as a method', () => {
    const { ac, calls } = createMockAC();
    ac.alert('message');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ method: 'alert', args: ['message'] });
  });

  test('all AC_METHODS are registered', () => {
    const { ac } = createMockAC();
    for (const method of AC_METHODS) {
      expect(typeof ac[method]).toBe('function');
    }
  });
});

describe('executeWithMockAC', () => {
  test('simple sync handler', async () => {
    const { ac, calls } = createMockAC();
    await executeWithMockAC('AC.openForm("frmTest");', ac);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ method: 'openForm', args: ['frmTest'] });
  });

  test('async handler with await', async () => {
    const { ac, calls } = createMockAC({ dLookup: 'result' });
    await executeWithMockAC('const val = await AC.dLookup("f", "t", "c");', ac);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('dLookup');
  });

  test('handler using alert', async () => {
    const { ac, calls } = createMockAC();
    await executeWithMockAC('alert("Hello!");', ac);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ method: 'alert', args: ['Hello!'] });
  });

  test('thrown errors propagate', async () => {
    const { ac } = createMockAC();
    await expect(
      executeWithMockAC('throw new Error("test error");', ac)
    ).rejects.toThrow('test error');
  });

  test('globals are accessible', async () => {
    const { ac, calls } = createMockAC();
    await executeWithMockAC(
      'AC.setValue("txtResult", myVar);',
      ac,
      { myVar: 42 }
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(['txtResult', 42]);
  });

  test('handler return value is captured', async () => {
    const { ac } = createMockAC();
    const result = await executeWithMockAC('return 42;', ac);
    expect(result).toBe(42);
  });

  test('multi-step handler', async () => {
    const { ac, calls } = createMockAC({ getValue: null });
    const code = `
      const val = AC.getValue("txtName");
      if (val === null) {
        alert("Name is required!");
        return false;
      }
      AC.saveRecord();
    `;
    const result = await executeWithMockAC(code, ac);
    expect(result).toBe(false);
    expect(calls.some(c => c.method === 'alert')).toBe(true);
    expect(calls.some(c => c.method === 'saveRecord')).toBe(false);
  });
});
