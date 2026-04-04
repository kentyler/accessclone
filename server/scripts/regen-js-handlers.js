/**
 * Re-parse VBA→JS handlers for all modules in a database.
 * Updates both the DB js_handlers field and handler files on disk.
 *
 * Usage:
 *   node scripts/regen-js-handlers.js <database_id>          # deterministic only
 *   node scripts/regen-js-handlers.js <database_id> --llm    # deterministic + LLM fallback
 *
 * The --llm flag runs an additional pass that sends partially-translated handlers
 * to Claude for improved translation using the AC.* runtime API.
 * Requires ANTHROPIC_API_KEY environment variable.
 */
const { Pool } = require('pg');
const { parseVbaToHandlers, collectEnumValues, extractProcedureNames, extractProcedures } = require('../lib/vba-to-js');
const { writeHandlerFile, deleteHandlerFile } = require('../lib/handler-gen/writer');
const { needsLLMFallback, translateHandlerWithLLM } = require('../lib/vba-to-js-llm');

const dbId = process.argv[2];
const useLLM = process.argv.includes('--llm');
if (!dbId) { console.error('Usage: node scripts/regen-js-handlers.js <database_id> [--llm]'); process.exit(1); }

if (useLLM && !process.env.ANTHROPIC_API_KEY) {
  console.error('Error: --llm requires ANTHROPIC_API_KEY environment variable');
  process.exit(1);
}

const pool = new Pool({ host: 'localhost', user: 'postgres', password: '7297', database: 'polyaccess' });

(async () => {
  const res = await pool.query(
    `SELECT id, name, definition->>'vba_source' as vba_source
     FROM shared.objects WHERE database_id = $1 AND type = 'module' AND is_current = true
       AND definition->>'vba_source' IS NOT NULL`,
    [dbId]
  );

  // Build combined enum map and pre-populate fn registry from ALL modules
  const enumMap = new Map();
  const fnRegistry = new Set();
  for (const r of res.rows) {
    const e = collectEnumValues(r.vba_source);
    for (const [k, v] of e) enumMap.set(k, v);
    for (const name of extractProcedureNames(r.vba_source)) {
      fnRegistry.add(name.toLowerCase());
    }
  }

  // Load intents if using LLM
  let intentsByModule = {};
  if (useLLM) {
    const intentRes = await pool.query(
      `SELECT o.name as module_name, i.content
       FROM shared.intents i
       JOIN shared.objects o ON o.id = i.object_id
       WHERE o.database_id = $1 AND o.type = 'module' AND o.is_current = true
         AND i.intent_type = 'gesture'
       ORDER BY i.created_at DESC`,
      [dbId]
    );
    // Keep only the latest intent per module
    for (const row of intentRes.rows) {
      if (!intentsByModule[row.module_name]) {
        intentsByModule[row.module_name] = row.content;
      }
    }
  }

  let updated = 0;
  let filesWritten = 0;
  let llmStats = { attempted: 0, succeeded: 0, failed: 0 };

  for (const row of res.rows) {
    const parsed = parseVbaToHandlers(row.vba_source, row.name, enumMap, fnRegistry);
    let handlers = parsed.length > 0 ? parsed : null;

    // LLM pass: improve handlers that have comment lines
    if (useLLM && handlers) {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      const moduleIntents = intentsByModule[row.name];
      const procedures = extractProcedures(row.vba_source);

      // Build procedure lookup: name → body
      const procByName = {};
      for (const proc of procedures) {
        procByName[proc.name] = proc.body;
      }

      // Build intent procedure lookup
      const intentProcs = {};
      if (moduleIntents?.mapped?.procedures) {
        for (const proc of moduleIntents.mapped.procedures) {
          if (proc.name) intentProcs[proc.name] = proc;
        }
      }

      for (let i = 0; i < handlers.length; i++) {
        const h = handlers[i];
        if (!needsLLMFallback(h)) continue;

        llmStats.attempted++;
        const vbaBody = procByName[h.procedure] || null;
        const intent = intentProcs[h.procedure] || null;

        try {
          const result = await translateHandlerWithLLM(h, vbaBody, intent, handlers, apiKey);
          if (result) {
            handlers[i] = { ...h, js: result.js, llm: true };
            llmStats.succeeded++;
            console.log(`  LLM improved: ${row.name} → ${h.key}`);
          } else {
            llmStats.failed++;
            console.log(`  LLM no improvement: ${row.name} → ${h.key}`);
          }
        } catch (err) {
          llmStats.failed++;
          console.error(`  LLM error: ${row.name} → ${h.key}: ${err.message}`);
        }
      }
    }

    // Update DB
    await pool.query(
      `UPDATE shared.objects SET definition = jsonb_set(definition, '{js_handlers}', $1::jsonb) WHERE id = $2`,
      [JSON.stringify(handlers), row.id]
    );
    updated++;

    // Write/delete handler file
    if (handlers) {
      writeHandlerFile(dbId, row.name, handlers);
      filesWritten++;
    } else {
      deleteHandlerFile(dbId, row.name);
    }
  }

  console.log(`\nDone. ${updated} modules re-parsed, ${filesWritten} handler files written.`);
  if (useLLM) {
    console.log(`LLM pass: ${llmStats.attempted} attempted, ${llmStats.succeeded} succeeded, ${llmStats.failed} failed.`);
  }
  await pool.end();
})();
