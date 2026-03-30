const {Pool} = require('pg');
const config = require('../config');
const pool = new Pool({connectionString: config.database.connectionString});
const name = process.argv[2] || 'frmLogin';
const db = process.argv[3] || 'northwind4';
pool.query(
  `SELECT definition FROM shared.objects WHERE database_id=$1 AND type='form' AND name=$2 AND is_current=true ORDER BY version DESC LIMIT 1`,
  [db, name]
).then(r => {
  if (!r.rows[0]) { console.log('Not found'); } else { console.log(JSON.stringify(r.rows[0].definition, null, 2)); }
  pool.end();
}).catch(e => { console.error(e.message); pool.end(); });
