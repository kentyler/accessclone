/**
 * Tests for extractIssuesJson and persistIssues helpers
 * from server/routes/chat/index.js
 */

const { extractIssuesJson, persistIssues } = require('../routes/chat');

describe('extractIssuesJson', () => {
  test('extracts valid issues block and returns cleaned text', () => {
    const text = `This form has some problems.

\`\`\`issues
[{"category":"empty-section","severity":"warning","message":"Footer is empty","suggestion":"Remove or add content"}]
\`\`\``;
    const { cleaned, issues } = extractIssuesJson(text);
    expect(cleaned).toBe('This form has some problems.');
    expect(issues).toHaveLength(1);
    expect(issues[0].category).toBe('empty-section');
    expect(issues[0].severity).toBe('warning');
    expect(issues[0].message).toBe('Footer is empty');
    expect(issues[0].suggestion).toBe('Remove or add content');
  });

  test('handles multiple issues', () => {
    const text = `Analysis complete.

\`\`\`issues
[
  {"category":"missing-field-binding","severity":"error","message":"TextBox1 has no field binding"},
  {"category":"layout-density","severity":"info","message":"Controls are well spaced"}
]
\`\`\``;
    const { cleaned, issues } = extractIssuesJson(text);
    expect(cleaned).toBe('Analysis complete.');
    expect(issues).toHaveLength(2);
    expect(issues[0].severity).toBe('error');
    expect(issues[1].severity).toBe('info');
  });

  test('returns empty issues when no code fence present', () => {
    const text = 'This form looks fine. No issues found.';
    const { cleaned, issues } = extractIssuesJson(text);
    expect(cleaned).toBe(text);
    expect(issues).toEqual([]);
  });

  test('returns empty issues on malformed JSON', () => {
    const text = `Some analysis.

\`\`\`issues
{not valid json}
\`\`\``;
    const { cleaned, issues } = extractIssuesJson(text);
    expect(cleaned).toBe(text);
    expect(issues).toEqual([]);
  });

  test('returns empty issues when parsed value is not an array', () => {
    const text = `Analysis.

\`\`\`issues
{"category":"test"}
\`\`\``;
    const { cleaned, issues } = extractIssuesJson(text);
    expect(cleaned).toBe('Analysis.');
    expect(issues).toEqual([]);
  });

  test('handles code fence with no newline after marker', () => {
    const text = `Text.\`\`\`issues[{"category":"other","severity":"warning","message":"test"}]\`\`\``;
    const { cleaned, issues } = extractIssuesJson(text);
    expect(cleaned).toBe('Text.');
    expect(issues).toHaveLength(1);
  });

  test('preserves text before and after the issues block', () => {
    const text = `Before the block.

\`\`\`issues
[{"category":"other","severity":"info","message":"note"}]
\`\`\`

After the block.`;
    const { cleaned, issues } = extractIssuesJson(text);
    expect(cleaned).toContain('Before the block.');
    expect(cleaned).toContain('After the block.');
    expect(cleaned).not.toContain('```issues');
    expect(issues).toHaveLength(1);
  });

  test('handles empty array in issues block', () => {
    const text = `No problems found.

\`\`\`issues
[]
\`\`\``;
    const { cleaned, issues } = extractIssuesJson(text);
    expect(cleaned).toBe('No problems found.');
    expect(issues).toEqual([]);
  });
});

describe('persistIssues', () => {
  test('calls pool.query for each valid issue', async () => {
    const mockPool = { query: jest.fn().mockResolvedValue({}) };
    const issues = [
      { category: 'empty-section', severity: 'warning', message: 'Footer empty', suggestion: 'Remove it' },
      { category: 'naming-mismatch', severity: 'error', message: 'Bad name' }
    ];
    const count = await persistIssues(mockPool, 'db1', 'form', 'MyForm', issues);
    expect(count).toBe(2);
    expect(mockPool.query).toHaveBeenCalledTimes(2);
    // Check first call params
    const firstCall = mockPool.query.mock.calls[0];
    expect(firstCall[1]).toEqual(['db1', 'form', 'MyForm', 'empty-section', 'warning', 'Footer empty', 'Remove it']);
  });

  test('skips issues without a message', async () => {
    const mockPool = { query: jest.fn().mockResolvedValue({}) };
    const issues = [
      { category: 'test', severity: 'warning' },  // no message
      { category: 'test', severity: 'info', message: 'Valid issue' }
    ];
    const count = await persistIssues(mockPool, 'db1', 'form', 'F', issues);
    expect(count).toBe(1);
    expect(mockPool.query).toHaveBeenCalledTimes(1);
  });

  test('defaults severity to warning for invalid values', async () => {
    const mockPool = { query: jest.fn().mockResolvedValue({}) };
    const issues = [
      { category: 'test', severity: 'critical', message: 'Bad severity' }
    ];
    await persistIssues(mockPool, 'db1', 'form', 'F', issues);
    const params = mockPool.query.mock.calls[0][1];
    expect(params[4]).toBe('warning');  // severity param
  });

  test('defaults category to other when missing', async () => {
    const mockPool = { query: jest.fn().mockResolvedValue({}) };
    const issues = [
      { severity: 'info', message: 'No category' }
    ];
    await persistIssues(mockPool, 'db1', 'form', 'F', issues);
    const params = mockPool.query.mock.calls[0][1];
    expect(params[3]).toBe('other');  // category param
  });

  test('defaults suggestion to null when missing', async () => {
    const mockPool = { query: jest.fn().mockResolvedValue({}) };
    const issues = [
      { category: 'test', severity: 'warning', message: 'No suggestion' }
    ];
    await persistIssues(mockPool, 'db1', 'form', 'F', issues);
    const params = mockPool.query.mock.calls[0][1];
    expect(params[6]).toBeNull();  // suggestion param
  });

  test('continues on database error and returns partial count', async () => {
    const mockPool = {
      query: jest.fn()
        .mockResolvedValueOnce({})       // first succeeds
        .mockRejectedValueOnce(new Error('DB error'))  // second fails
        .mockResolvedValueOnce({})       // third succeeds
    };
    const issues = [
      { category: 'a', severity: 'warning', message: 'First' },
      { category: 'b', severity: 'warning', message: 'Second' },
      { category: 'c', severity: 'warning', message: 'Third' }
    ];
    const count = await persistIssues(mockPool, 'db1', 'form', 'F', issues);
    expect(count).toBe(2);  // first + third
    expect(mockPool.query).toHaveBeenCalledTimes(3);
  });

  test('handles empty issues array', async () => {
    const mockPool = { query: jest.fn() };
    const count = await persistIssues(mockPool, 'db1', 'form', 'F', []);
    expect(count).toBe(0);
    expect(mockPool.query).not.toHaveBeenCalled();
  });
});
