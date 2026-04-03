/**
 * Re-parse VBA→JS handlers for all modules in a database.
 * Updates both the DB js_handlers field and handler files on disk.
 * Usage: node scripts/regen-js-handlers.js <database_id>
 */
const { Pool } = require('pg');
const { parseVbaToHandlers, collectEnumValues } = require('../lib/vba-to-js');
const { writeHandlerFile, deleteHandlerFile } = require('../lib/handler-gen/writer');

const dbId = process.argv[2];
if (!dbId) { console.error('Usage: node scripts/regen-js-handlers.js <database_id>'); process.exit(1); }

const pool = new Pool({ host: 'localhost', user: 'postgres', password: '7297', database: 'polyaccess' });

(async () => {
  const res = await pool.query(
    `SELECT id, name, definition->>'vba_source' as vba_source
     FROM shared.objects WHERE database_id = $1 AND type = 'module' AND is_current = true
       AND definition->>'vba_source' IS NOT NULL`,
    [dbId]
  );

  // Build combined enum map and shared fn registry across all modules
  const enumMap = new Map();
  const fnRegistry = new Set();
  for (const r of res.rows) {
    const e = collectEnumValues(r.vba_source);
    for (const [k, v] of e) enumMap.set(k, v);
  }

  let updated = 0;
  let filesWritten = 0;
  for (const row of res.rows) {
    const parsed = parseVbaToHandlers(row.vba_source, row.name, enumMap, fnRegistry);
    const handlers = parsed.length > 0 ? parsed : null;

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

  console.log(`Done. ${updated} modules re-parsed, ${filesWritten} handler files written.`);
  await pool.end();
})();
