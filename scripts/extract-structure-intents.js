#!/usr/bin/env node
/**
 * Standalone script to extract structure intents for all forms in a database.
 *
 * Usage: node scripts/extract-structure-intents.js <database_id>
 * Example: node scripts/extract-structure-intents.js northwind_18
 *
 * Requires: ANTHROPIC_API_KEY env var or secrets config, running PostgreSQL
 */

const path = require('path');
try { require('dotenv').config({ path: path.join(__dirname, '..', '.env') }); } catch (_) {}

// Resolve modules from server/node_modules
const serverDir = path.join(__dirname, '..', 'server');
const Module = require('module');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function(request, parent, ...rest) {
  try { return originalResolve.call(this, request, parent, ...rest); }
  catch (e) {
    if (e.code === 'MODULE_NOT_FOUND') {
      const serverPath = path.join(serverDir, 'node_modules', request);
      return originalResolve.call(this, serverPath, parent, ...rest);
    }
    throw e;
  }
};

// Parse -Password before requiring config (config reads PGPASSWORD at require time)
const passwordArg = process.argv.indexOf('-Password');
if (passwordArg !== -1 && process.argv[passwordArg + 1]) {
  process.env.PGPASSWORD = process.argv[passwordArg + 1];
}

const { Pool } = require('pg');
const config = require('../server/config');
const { extractFormStructureIntents } = require('../server/lib/object-intent-extractor');
const { buildGraphContext } = require('../server/routes/chat/context');

const databaseId = process.argv[2];
if (!databaseId) {
  console.error('Usage: node scripts/extract-structure-intents.js <database_id> [-Password <pw>]');
  process.exit(1);
}

// Try to load secrets
let apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  try {
    const secrets = require('../secrets.json');
    apiKey = secrets?.anthropic?.api_key;
  } catch (_) {}
}
if (!apiKey) {
  try {
    const secrets = require('../server/secrets.json');
    apiKey = secrets?.anthropic?.api_key;
  } catch (_) {}
}
if (!apiKey) {
  console.error('No ANTHROPIC_API_KEY found in env or secrets.json');
  process.exit(1);
}

async function main() {
  const pool = new Pool({
    connectionString: config.database.connectionString
  });

  try {
    // Verify database exists
    const dbResult = await pool.query(
      'SELECT schema_name FROM shared.databases WHERE database_id = $1',
      [databaseId]
    );
    if (dbResult.rows.length === 0) {
      console.error(`Database "${databaseId}" not found`);
      process.exit(1);
    }
    console.log(`Database: ${databaseId} (schema: ${dbResult.rows[0].schema_name})`);

    // Build graph context once
    console.log('Building graph context...');
    const graphContext = await buildGraphContext(pool, databaseId);
    console.log(`  Tables: ${graphContext?.tables?.length || 0}, Views: ${graphContext?.views?.length || 0}, Forms: ${graphContext?.forms?.length || 0}`);

    // Load all forms
    const formsResult = await pool.query(
      `SELECT id, name, definition FROM shared.objects
       WHERE database_id = $1 AND type = 'form' AND is_current = true
       ORDER BY name`,
      [databaseId]
    );
    console.log(`\nExtracting structure intents for ${formsResult.rows.length} forms...\n`);

    let succeeded = 0;
    let failed = 0;

    for (const form of formsResult.rows) {
      process.stdout.write(`  ${form.name}... `);
      try {
        const structure = await extractFormStructureIntents(form.definition, form.name, graphContext, apiKey);

        // Save to shared.intents
        await pool.query('DELETE FROM shared.intents WHERE object_id = $1 AND intent_type = $2', [form.id, 'structure']);
        await pool.query(
          `INSERT INTO shared.intents (object_id, intent_type, content, generated_by) VALUES ($1, 'structure', $2, 'llm')`,
          [form.id, JSON.stringify(structure)]
        );

        console.log(`${structure.pattern} (${structure.confidence})`);
        succeeded++;
      } catch (err) {
        console.log(`FAILED: ${err.message}`);
        failed++;
      }
    }

    console.log(`\nDone: ${succeeded} succeeded, ${failed} failed`);
  } finally {
    await pool.end();
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
