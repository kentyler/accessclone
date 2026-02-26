// Run from server/ directory: node dump-analyses.js
const { Pool } = require('pg');
const config = require('./config');
const pool = new Pool({ connectionString: config.database.connectionString });

pool.query("SELECT object_name, transcript FROM shared.chat_transcripts WHERE object_type = 'forms' ORDER BY object_name")
  .then(r => {
    r.rows.forEach(row => {
      const t = typeof row.transcript === 'string' ? JSON.parse(row.transcript) : row.transcript;
      const asst = t.filter(m => m.role === 'assistant');
      if (asst.length) {
        console.log('=== ' + row.object_name + ' ===');
        console.log(asst[asst.length - 1].content);
        console.log();
      }
    });
    pool.end();
  })
  .catch(e => { console.error(e.message); pool.end(); });
