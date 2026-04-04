#!/usr/bin/env node
/**
 * Generate Jest test files from intent data + JS handlers.
 *
 * Usage:
 *   node scripts/generate-intent-tests.js <database_id> [module_name]
 *
 * Reads shared.intents (gesture) + shared.objects (js_handlers) from the database,
 * writes test files to server/__tests__/generated/{databaseId}/{ModuleName}.test.js
 */

const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');
const { generateTestFile, flattenIntents } = require('../lib/test-harness/generate-tests');

const databaseId = process.argv[2];
const moduleFilter = process.argv[3];

if (!databaseId) {
  console.error('Usage: node scripts/generate-intent-tests.js <database_id> [module_name]');
  process.exit(1);
}

async function main() {
  const pool = new Pool({
    host: 'localhost',
    port: 5432,
    database: 'polyaccess',
    user: 'postgres',
    password: process.env.PGPASSWORD || '7297'
  });

  try {
    // Load modules with js_handlers
    let modulesQuery = `
      SELECT name, definition
      FROM shared.objects
      WHERE database_id = $1 AND type = 'module' AND is_current = true
    `;
    const params = [databaseId];
    if (moduleFilter) {
      modulesQuery += ' AND name = $2';
      params.push(moduleFilter);
    }
    modulesQuery += ' ORDER BY name';

    const modulesResult = await pool.query(modulesQuery, params);
    if (modulesResult.rows.length === 0) {
      console.log(`No modules found for database "${databaseId}"${moduleFilter ? ` with name "${moduleFilter}"` : ''}`);
      process.exit(0);
    }

    // Load intents
    const intentsResult = await pool.query(`
      SELECT i.content, i.intent_type, o.name as module_name
      FROM shared.intents i
      JOIN shared.objects o ON i.object_id = o.id
      WHERE o.database_id = $1 AND i.intent_type = 'gesture' AND o.is_current = true
      ${moduleFilter ? 'AND o.name = $2' : ''}
      ORDER BY o.name
    `, moduleFilter ? [databaseId, moduleFilter] : [databaseId]);

    // Group intents by module
    const intentsByModule = {};
    for (const row of intentsResult.rows) {
      if (!intentsByModule[row.module_name]) intentsByModule[row.module_name] = [];
      const data = typeof row.content === 'string' ? JSON.parse(row.content) : row.content;
      if (data.procedures) {
        intentsByModule[row.module_name].push(...data.procedures);
      } else if (Array.isArray(data)) {
        intentsByModule[row.module_name].push(...data);
      }
    }

    // Generate test files
    const outDir = path.join(__dirname, '..', '__tests__', 'generated', databaseId);
    fs.mkdirSync(outDir, { recursive: true });

    let totalTests = 0;
    let filesWritten = 0;

    for (const row of modulesResult.rows) {
      const moduleName = row.name;
      const def = typeof row.definition === 'string' ? JSON.parse(row.definition) : row.definition;
      const handlers = def?.js_handlers || {};
      const intentData = intentsByModule[moduleName] || [];

      if (Object.keys(handlers).length === 0 || intentData.length === 0) {
        console.log(`  skip ${moduleName}: ${Object.keys(handlers).length} handlers, ${intentData.length} intent procs`);
        continue;
      }

      // Match intent procedures to handler keys
      const matchedIntentData = [];
      for (const proc of intentData) {
        const procName = proc.procedure || proc.name;
        // Try exact match, then event key patterns
        const possibleKeys = [
          procName,
          `evt.${procName}`,
          `fn.${procName}`
        ];
        let handlerKey = null;
        for (const key of possibleKeys) {
          if (handlers[key]) { handlerKey = key; break; }
        }
        if (handlerKey) {
          matchedIntentData.push({ ...proc, handler_key: handlerKey });
        }
      }

      if (matchedIntentData.length === 0) {
        console.log(`  skip ${moduleName}: no intent-handler matches`);
        continue;
      }

      const { content, testCount } = generateTestFile(databaseId, moduleName, handlers, matchedIntentData);
      const outFile = path.join(outDir, `${moduleName}.test.js`);
      fs.writeFileSync(outFile, content, 'utf-8');

      console.log(`  wrote ${moduleName}: ${testCount} tests → ${path.relative(process.cwd(), outFile)}`);
      totalTests += testCount;
      filesWritten++;
    }

    console.log(`\nDone: ${filesWritten} files, ${totalTests} tests generated in __tests__/generated/${databaseId}/`);

  } finally {
    await pool.end();
  }
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
