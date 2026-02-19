/**
 * Dump all form definitions (latest version per form) to a JSON file.
 * Run from the server/ directory on Windows:
 *   node ../scripts/dump-form-definitions.js
 */
const { Pool } = require('pg');

const pool = new Pool({
  host: '127.0.0.1',
  port: 5432,
  user: 'postgres',
  password: '',
  database: 'polyaccess',
});

async function main() {
  const { rows } = await pool.query(`
    SELECT f.database_id, f.name, f.definition
    FROM shared.forms f
    INNER JOIN (
      SELECT database_id, name, MAX(version) as max_ver
      FROM shared.forms
      GROUP BY database_id, name
    ) latest ON f.database_id = latest.database_id
           AND f.name = latest.name
           AND f.version = latest.max_ver
    ORDER BY f.database_id, f.name
  `);

  const output = rows.map(r => ({
    database_id: r.database_id,
    name: r.name,
    definition: r.definition,
  }));

  const fs = require('fs');
  const outPath = require('path').join(__dirname, '..', 'form-definitions.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`Wrote ${output.length} form definitions to ${outPath}`);
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
