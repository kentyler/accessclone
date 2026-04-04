/**
 * Test File Generator — produces Jest test files from intent data + JS handlers.
 *
 * Each generated test file tests that a module's JS handlers satisfy the
 * intents extracted from its VBA source.
 */

const { getIntentTemplate } = require('./intent-templates');

/**
 * Flatten nested intent trees (branch/then/else) into a flat array.
 * @param {Array} intents
 * @returns {Array}
 */
function flattenIntents(intents) {
  const flat = [];
  for (const intent of intents) {
    flat.push(intent);
    if (intent.children) flat.push(...flattenIntents(intent.children));
    if (intent.then) flat.push(...flattenIntents(Array.isArray(intent.then) ? intent.then : [intent.then]));
    if (intent.else) flat.push(...flattenIntents(Array.isArray(intent.else) ? intent.else : [intent.else]));
  }
  return flat;
}

/**
 * Build assertion code string for a single assertion spec.
 * @param {Object} assertion
 * @returns {string}
 */
function buildAssertionCode(assertion) {
  switch (assertion.type) {
    case 'calledWith': {
      const args = assertion.args || [];
      const argStr = args.map(a => JSON.stringify(a)).join(', ');
      return `    expect(calls.some(c => c.method === ${JSON.stringify(assertion.method)}` +
        (args.length > 0
          ? ` && ${args.map((a, i) => `c.args[${i}] === ${JSON.stringify(a)}`).join(' && ')}`
          : '') +
        `)).toBe(true);`;
    }
    case 'called':
      return `    expect(calls.some(c => c.method === ${JSON.stringify(assertion.method)})).toBe(true);`;
    case 'alertCalled':
      return `    expect(calls.some(c => c.method === 'alert')).toBe(true);`;
    case 'noThrow':
      return `    // Handler executed without throwing (verified by test not failing)`;
    default:
      return `    // Unknown assertion type: ${assertion.type}`;
  }
}

/**
 * Generate a complete Jest test file string.
 *
 * @param {string} databaseId
 * @param {string} moduleName
 * @param {Object} handlers - { [handlerKey]: { js: string, ... } }
 * @param {Array} intentData - Array of { procedure, intents: [...] }
 * @returns {string} - Complete Jest test file content
 */
function generateTestFile(databaseId, moduleName, handlers, intentData) {
  const lines = [];

  lines.push(`// Auto-generated intent tests for ${moduleName} (${databaseId})`);
  lines.push(`// Generated at ${new Date().toISOString()}`);
  lines.push(`// Do not edit manually — regenerate with: node scripts/generate-intent-tests.js ${databaseId} ${moduleName}`);
  lines.push('');
  lines.push("const { createMockAC, executeWithMockAC } = require('../../lib/test-harness/mock-ac');");
  lines.push('');
  lines.push(`describe('${moduleName} (${databaseId})', () => {`);

  let testCount = 0;

  for (const proc of intentData) {
    const procName = proc.procedure;
    const handlerKey = proc.handler_key || procName;
    const handler = handlers[handlerKey];

    if (!handler || !handler.js) continue;

    const flatIntents = flattenIntents(proc.intents || []);
    if (flatIntents.length === 0) continue;

    lines.push('');
    lines.push(`  describe('${procName}', () => {`);

    // Collect all overrides needed for this procedure's intents
    const allOverrides = {};
    for (const intent of flatIntents) {
      const template = getIntentTemplate(intent);
      Object.assign(allOverrides, template.setup.overrides);
    }

    for (const intent of flatIntents) {
      const intentType = intent.type || intent.intent_type;
      const template = getIntentTemplate(intent);

      // Skip structural intents that just verify noThrow — we'll have one combined test
      if (template.assertions.length === 1 && template.assertions[0].type === 'noThrow') {
        continue;
      }

      const testName = `${intentType}: ${template.description}`;
      lines.push('');
      lines.push(`    test('${testName.replace(/'/g, "\\'")}', async () => {`);
      lines.push(`      const { ac, calls } = createMockAC(${JSON.stringify(allOverrides)});`);
      lines.push(`      await executeWithMockAC(${JSON.stringify(handler.js)}, ac);`);

      for (const assertion of template.assertions) {
        lines.push(buildAssertionCode(assertion));
      }

      lines.push('    });');
      testCount++;
    }

    // Add one combined noThrow test for the procedure
    lines.push('');
    lines.push(`    test('executes without throwing', async () => {`);
    lines.push(`      const { ac } = createMockAC(${JSON.stringify(allOverrides)});`);
    lines.push(`      await expect(executeWithMockAC(${JSON.stringify(handler.js)}, ac)).resolves.not.toThrow();`);
    lines.push('    });');
    testCount++;

    lines.push('  });');
  }

  lines.push('});');
  lines.push('');

  return { content: lines.join('\n'), testCount };
}

module.exports = { generateTestFile, flattenIntents };
