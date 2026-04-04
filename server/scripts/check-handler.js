const { Pool } = require('pg');
const pool = new Pool({ host: 'localhost', user: 'postgres', password: '7297', database: 'polyaccess' });

(async () => {
  const r = await pool.query(
    `SELECT definition->'js_handlers' as h FROM shared.objects WHERE database_id='northwind_18' AND name='modStrings' AND is_current=true`
  );
  const handlers = r.rows[0].h;
  if (!handlers) { console.log('No handlers'); await pool.end(); return; }
  for (const h of handlers) {
    // Show handlers that have comment lines
    const lines = h.js.split('\n');
    const hasComments = lines.some(l => /^\s*\/\//.test(l));
    if (hasComments) {
      console.log('=== ' + h.key + ' ===');
      lines.forEach((line, i) => console.log((i + 1) + ': ' + line));
      console.log('');
    }
  }
  await pool.end();
})();
