/**
 * Backend for CloneTemplate
 * Handles form file operations and database access
 */

const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const cors = require('cors');
const { Pool } = require('pg');
const config = require('./config');

const app = express();
const PORT = config.server.port;

// Forms directory (relative to server location)
const FORMS_DIR = path.join(__dirname, '..', 'forms');

// Settings directory
const SETTINGS_DIR = path.join(__dirname, '..', 'settings');

// UI static files directory
const UI_PUBLIC_DIR = path.join(__dirname, '..', 'ui', 'resources', 'public');

// Database connection pool
const pool = new Pool({
  connectionString: config.database.connectionString,
  max: config.database.max,
  idleTimeoutMillis: config.database.idleTimeoutMillis,
  connectionTimeoutMillis: config.database.connectionTimeoutMillis,
});

// Test database connection on startup
pool.query('SELECT NOW()')
  .then(() => console.log('Database connected successfully'))
  .catch(err => console.error('Database connection error:', err.message));

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.text({ type: 'application/edn' }));

// Serve forms directory as static files
app.use('/forms', express.static(FORMS_DIR));

// Serve UI static files (CSS, JS)
app.use(express.static(UI_PUBLIC_DIR));

// ============================================================
// MULTI-DATABASE SUPPORT
// ============================================================

// Default database ID
let currentDatabaseId = 'calculator';

/**
 * Middleware to set search_path based on X-Database-ID header
 */
app.use('/api', async (req, res, next) => {
  // Skip for /api/databases endpoint (needs to query shared schema)
  if (req.path === '/databases') {
    return next();
  }

  const dbId = req.headers['x-database-id'] || currentDatabaseId;

  try {
    // Look up schema name for this database
    const result = await pool.query(
      'SELECT schema_name FROM shared.databases WHERE database_id = $1',
      [dbId]
    );

    const schemaName = result.rows[0]?.schema_name || 'public';

    // Set search_path for this request
    await pool.query(`SET search_path = ${schemaName}, shared, public`);

    req.databaseId = dbId;
    req.schemaName = schemaName;
    next();
  } catch (err) {
    console.error('Error setting search_path:', err.message);
    // Fall back to public schema
    await pool.query('SET search_path = public, shared');
    next();
  }
});

/**
 * GET /api/databases
 * List all available databases
 */
app.get('/api/databases', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT database_id, name, schema_name, description, last_accessed
      FROM shared.databases
      ORDER BY name
    `);
    res.json({
      databases: result.rows,
      current: currentDatabaseId
    });
  } catch (err) {
    console.error('Error fetching databases:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/databases/switch
 * Switch to a different database
 */
app.post('/api/databases/switch', async (req, res) => {
  const { database_id } = req.body;

  try {
    // Verify database exists
    const result = await pool.query(
      'SELECT database_id, name, schema_name FROM shared.databases WHERE database_id = $1',
      [database_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Database not found' });
    }

    // Update last_accessed
    await pool.query(
      'UPDATE shared.databases SET last_accessed = NOW() WHERE database_id = $1',
      [database_id]
    );

    currentDatabaseId = database_id;

    res.json({
      success: true,
      current: currentDatabaseId,
      database: result.rows[0]
    });
  } catch (err) {
    console.error('Error switching database:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// DATABASE METADATA ENDPOINTS
// ============================================================

/**
 * GET /api/tables
 * List all tables with their columns
 */
app.get('/api/tables', async (req, res) => {
  try {
    const schemaName = req.schemaName || 'public';

    // Get all tables from the current database schema
    const tablesResult = await pool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = $1
        AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `, [schemaName]);

    const tables = [];
    for (const row of tablesResult.rows) {
      // Get columns for each table
      const columnsResult = await pool.query(`
        SELECT
          c.column_name,
          c.data_type,
          c.is_nullable,
          c.column_default,
          CASE WHEN pk.column_name IS NOT NULL THEN true ELSE false END as is_primary_key,
          CASE WHEN fk.column_name IS NOT NULL THEN true ELSE false END as is_foreign_key,
          fk.foreign_table_name
        FROM information_schema.columns c
        LEFT JOIN (
          SELECT kcu.column_name
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON tc.constraint_name = kcu.constraint_name
          WHERE tc.table_name = $1
            AND tc.constraint_type = 'PRIMARY KEY'
        ) pk ON c.column_name = pk.column_name
        LEFT JOIN (
          SELECT
            kcu.column_name,
            ccu.table_name as foreign_table_name
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON tc.constraint_name = kcu.constraint_name
          JOIN information_schema.constraint_column_usage ccu
            ON tc.constraint_name = ccu.constraint_name
          WHERE tc.table_name = $1
            AND tc.constraint_type = 'FOREIGN KEY'
        ) fk ON c.column_name = fk.column_name
        WHERE c.table_name = $1
          AND c.table_schema = $2
        ORDER BY c.ordinal_position
      `, [row.table_name, schemaName]);

      tables.push({
        name: row.table_name,
        fields: columnsResult.rows.map(col => ({
          name: col.column_name,
          type: col.data_type,
          nullable: col.is_nullable === 'YES',
          default: col.column_default,
          isPrimaryKey: col.is_primary_key,
          isForeignKey: col.is_foreign_key,
          foreignTable: col.foreign_table_name
        }))
      });
    }

    res.json({ tables });
  } catch (err) {
    console.error('Error fetching tables:', err);
    res.status(500).json({ error: 'Failed to fetch tables', details: err.message });
  }
});

/**
 * GET /api/queries
 * List all views with their columns
 */
app.get('/api/queries', async (req, res) => {
  try {
    const schemaName = req.schemaName || 'public';

    // Get all views from the current database schema
    const viewsResult = await pool.query(`
      SELECT table_name
      FROM information_schema.views
      WHERE table_schema = $1
      ORDER BY table_name
    `, [schemaName]);

    const queries = [];
    for (const row of viewsResult.rows) {
      // Get columns for each view
      const columnsResult = await pool.query(`
        SELECT column_name, data_type, is_nullable
        FROM information_schema.columns
        WHERE table_name = $1
          AND table_schema = $2
        ORDER BY ordinal_position
      `, [row.table_name, schemaName]);

      queries.push({
        name: row.table_name,
        fields: columnsResult.rows.map(col => ({
          name: col.column_name,
          type: col.data_type,
          nullable: col.is_nullable === 'YES'
        }))
      });
    }

    res.json({ queries });
  } catch (err) {
    console.error('Error fetching queries:', err);
    res.status(500).json({ error: 'Failed to fetch queries', details: err.message });
  }
});

/**
 * GET /api/functions
 * List all stored functions (excluding system functions)
 */
app.get('/api/functions', async (req, res) => {
  try {
    const schemaName = req.schemaName || 'public';

    const result = await pool.query(`
      SELECT
        p.proname as name,
        pg_get_function_arguments(p.oid) as arguments,
        pg_get_function_result(p.oid) as return_type
      FROM pg_proc p
      JOIN pg_namespace n ON p.pronamespace = n.oid
      WHERE n.nspname = $1
        AND p.prokind = 'f'
      ORDER BY p.proname
    `, [schemaName]);

    res.json({
      functions: result.rows.map(row => ({
        name: row.name,
        arguments: row.arguments,
        returnType: row.return_type
      }))
    });
  } catch (err) {
    console.error('Error fetching functions:', err);
    res.status(500).json({ error: 'Failed to fetch functions', details: err.message });
  }
});

// ============================================================
// DATA ENDPOINTS
// ============================================================

/**
 * GET /api/data/:source
 * Fetch records from a table or view
 * Query params: limit, offset, orderBy, orderDir
 */
app.get('/api/data/:source', async (req, res) => {
  try {
    const { source } = req.params;
    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;
    const orderBy = req.query.orderBy || null;
    const orderDir = req.query.orderDir === 'desc' ? 'DESC' : 'ASC';

    // Validate source name (prevent SQL injection)
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(source)) {
      return res.status(400).json({ error: 'Invalid source name' });
    }

    let query = `SELECT * FROM "${source}"`;
    if (orderBy && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(orderBy)) {
      query += ` ORDER BY "${orderBy}" ${orderDir}`;
    }
    query += ` LIMIT $1 OFFSET $2`;

    const result = await pool.query(query, [limit, offset]);

    // Get total count
    const countResult = await pool.query(`SELECT COUNT(*) FROM "${source}"`);
    const totalCount = parseInt(countResult.rows[0].count);

    res.json({
      data: result.rows,
      pagination: {
        limit,
        offset,
        totalCount,
        hasMore: offset + result.rows.length < totalCount
      }
    });
  } catch (err) {
    console.error('Error fetching data:', err);
    res.status(500).json({ error: 'Failed to fetch data', details: err.message });
  }
});

/**
 * GET /api/data/:source/:id
 * Fetch a single record by primary key
 */
app.get('/api/data/:source/:id', async (req, res) => {
  try {
    const { source, id } = req.params;

    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(source)) {
      return res.status(400).json({ error: 'Invalid source name' });
    }

    // Find primary key column
    const pkResult = await pool.query(`
      SELECT kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
      WHERE tc.table_name = $1
        AND tc.constraint_type = 'PRIMARY KEY'
      LIMIT 1
    `, [source]);

    if (pkResult.rows.length === 0) {
      return res.status(400).json({ error: 'Table has no primary key' });
    }

    const pkColumn = pkResult.rows[0].column_name;
    const result = await pool.query(
      `SELECT * FROM "${source}" WHERE "${pkColumn}" = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Record not found' });
    }

    res.json({ data: result.rows[0] });
  } catch (err) {
    console.error('Error fetching record:', err);
    res.status(500).json({ error: 'Failed to fetch record', details: err.message });
  }
});

/**
 * POST /api/data/:table
 * Insert a new record
 */
app.post('/api/data/:table', async (req, res) => {
  try {
    const { table } = req.params;
    const data = req.body;

    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) {
      return res.status(400).json({ error: 'Invalid table name' });
    }

    const columns = Object.keys(data);
    const values = Object.values(data);
    const placeholders = columns.map((_, i) => `$${i + 1}`);

    const query = `
      INSERT INTO "${table}" (${columns.map(c => `"${c}"`).join(', ')})
      VALUES (${placeholders.join(', ')})
      RETURNING *
    `;

    const result = await pool.query(query, values);
    res.status(201).json({ data: result.rows[0] });
  } catch (err) {
    console.error('Error inserting record:', err);
    res.status(500).json({ error: 'Failed to insert record', details: err.message });
  }
});

/**
 * PUT /api/data/:table/:id
 * Update an existing record
 */
app.put('/api/data/:table/:id', async (req, res) => {
  try {
    const { table, id } = req.params;
    const data = req.body;

    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) {
      return res.status(400).json({ error: 'Invalid table name' });
    }

    // Find primary key column
    const pkResult = await pool.query(`
      SELECT kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
      WHERE tc.table_name = $1
        AND tc.constraint_type = 'PRIMARY KEY'
      LIMIT 1
    `, [table]);

    if (pkResult.rows.length === 0) {
      return res.status(400).json({ error: 'Table has no primary key' });
    }

    const pkColumn = pkResult.rows[0].column_name;
    const columns = Object.keys(data);
    const values = Object.values(data);

    const setClause = columns.map((col, i) => `"${col}" = $${i + 1}`).join(', ');
    const query = `
      UPDATE "${table}"
      SET ${setClause}
      WHERE "${pkColumn}" = $${columns.length + 1}
      RETURNING *
    `;

    const result = await pool.query(query, [...values, id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Record not found' });
    }

    res.json({ data: result.rows[0] });
  } catch (err) {
    console.error('Error updating record:', err);
    res.status(500).json({ error: 'Failed to update record', details: err.message });
  }
});

/**
 * DELETE /api/data/:table/:id
 * Delete a record
 */
app.delete('/api/data/:table/:id', async (req, res) => {
  try {
    const { table, id } = req.params;

    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) {
      return res.status(400).json({ error: 'Invalid table name' });
    }

    // Find primary key column
    const pkResult = await pool.query(`
      SELECT kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
      WHERE tc.table_name = $1
        AND tc.constraint_type = 'PRIMARY KEY'
      LIMIT 1
    `, [table]);

    if (pkResult.rows.length === 0) {
      return res.status(400).json({ error: 'Table has no primary key' });
    }

    const pkColumn = pkResult.rows[0].column_name;
    const result = await pool.query(
      `DELETE FROM "${table}" WHERE "${pkColumn}" = $1 RETURNING *`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Record not found' });
    }

    res.json({ success: true, deleted: result.rows[0] });
  } catch (err) {
    console.error('Error deleting record:', err);
    res.status(500).json({ error: 'Failed to delete record', details: err.message });
  }
});

// ============================================================
// SESSION STATE / FUNCTION CALLING
// ============================================================

/**
 * POST /api/session
 * Create a new session for function execution
 */
app.post('/api/session', async (req, res) => {
  try {
    const result = await pool.query('SELECT create_session() as session_id');
    res.json({ sessionId: result.rows[0].session_id });
  } catch (err) {
    console.error('Error creating session:', err);
    res.status(500).json({ error: 'Failed to create session', details: err.message });
  }
});

/**
 * DELETE /api/session/:id
 * Clear a session
 */
app.delete('/api/session/:id', async (req, res) => {
  try {
    await pool.query('SELECT clear_session($1)', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Error clearing session:', err);
    res.status(500).json({ error: 'Failed to clear session', details: err.message });
  }
});

/**
 * GET /api/session/:id/state
 * Get all state variables for a session
 */
app.get('/api/session/:id/state', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT var_name, var_value, var_type FROM execution_state WHERE session_id = $1',
      [req.params.id]
    );
    const state = {};
    for (const row of result.rows) {
      state[row.var_name] = { value: row.var_value, type: row.var_type };
    }
    res.json({ state });
  } catch (err) {
    console.error('Error fetching session state:', err);
    res.status(500).json({ error: 'Failed to fetch session state', details: err.message });
  }
});

/**
 * PUT /api/session/:id/state
 * Set state variables for a session
 * Body: { varName: { value: "...", type: "text|integer|numeric|boolean|date" }, ... }
 */
app.put('/api/session/:id/state', async (req, res) => {
  try {
    const sessionId = req.params.id;
    const state = req.body;

    for (const [name, { value, type }] of Object.entries(state)) {
      await pool.query(
        'SELECT set_state($1, $2, $3, $4)',
        [sessionId, name, value, type || 'text']
      );
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Error setting session state:', err);
    res.status(500).json({ error: 'Failed to set session state', details: err.message });
  }
});

/**
 * POST /api/function/:name
 * Call a PostgreSQL function with session state
 * Body: { sessionId: "uuid" }
 */
app.post('/api/function/:name', async (req, res) => {
  try {
    const { name } = req.params;
    const { sessionId } = req.body;

    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
      return res.status(400).json({ error: 'Invalid function name' });
    }

    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId required' });
    }

    // Call the function
    await pool.query(`SELECT ${name}($1)`, [sessionId]);

    // Return the updated session state
    const stateResult = await pool.query(
      'SELECT var_name, var_value, var_type FROM execution_state WHERE session_id = $1',
      [sessionId]
    );

    const state = {};
    for (const row of stateResult.rows) {
      state[row.var_name] = { value: row.var_value, type: row.var_type };
    }

    res.json({
      success: true,
      state,
      userMessage: state.user_message?.value || null,
      navigateTo: state.navigate_to?.value || null,
      confirmRequired: state.confirm_required?.value === 'true'
    });
  } catch (err) {
    console.error('Error calling function:', err);
    res.status(500).json({ error: 'Failed to call function', details: err.message });
  }
});

// ============================================================
// CHAT ENDPOINT
// ============================================================

// Load secrets
let secrets = {};
try {
  const secretsPath = path.join(__dirname, '..', 'secrets.json');
  secrets = JSON.parse(require('fs').readFileSync(secretsPath, 'utf8'));
  console.log('Secrets loaded from secrets.json');
} catch (err) {
  console.log('No secrets.json found, using environment variables');
}

/**
 * POST /api/chat
 * Send a message to the LLM and get a response
 */
app.post('/api/chat', async (req, res) => {
  const { message, database_id } = req.body;

  if (!message) {
    return res.status(400).json({ error: 'Message is required' });
  }

  const apiKey = secrets.anthropic?.api_key || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Anthropic API key not configured in secrets.json' });
  }

  try {
    // Get context about current database
    let dbContext = '';
    if (database_id) {
      const dbResult = await pool.query(
        'SELECT name, description FROM shared.databases WHERE database_id = $1',
        [database_id]
      );
      if (dbResult.rows[0]) {
        dbContext = `Current database: ${dbResult.rows[0].name} - ${dbResult.rows[0].description || 'No description'}`;
      }
    }

    // Call Anthropic API
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        system: `You are a helpful assistant for a database application called PolyAccess. You help users understand their data, create forms, write queries, and work with their databases. ${dbContext}

Keep responses concise and helpful. When discussing code or SQL, use markdown code blocks.`,
        messages: [{ role: 'user', content: message }]
      })
    });

    if (!response.ok) {
      const errorData = await response.json();
      console.error('Anthropic API error:', errorData);
      return res.status(500).json({ error: errorData.error?.message || 'API request failed' });
    }

    const data = await response.json();
    const assistantMessage = data.content[0]?.text || 'No response';

    res.json({ message: assistantMessage });
  } catch (err) {
    console.error('Error in chat:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// FORM FILE ENDPOINTS (existing)
// ============================================================

/**
 * GET /api/forms
 * List all form files
 */
app.get('/api/forms', async (req, res) => {
  try {
    const files = await fs.readdir(FORMS_DIR);
    const formFiles = files
      .filter(f => f.endsWith('.edn') && f !== '_index.edn')
      .map(f => f.replace('.edn', ''));
    res.json({ forms: formFiles });
  } catch (err) {
    console.error('Error listing forms:', err);
    res.status(500).json({ error: 'Failed to list forms' });
  }
});

/**
 * GET /api/forms/:name
 * Read a single form file
 */
app.get('/api/forms/:name', async (req, res) => {
  try {
    const filename = `${req.params.name}.edn`;
    const filepath = path.join(FORMS_DIR, filename);
    const content = await fs.readFile(filepath, 'utf8');
    res.type('application/edn').send(content);
  } catch (err) {
    if (err.code === 'ENOENT') {
      res.status(404).json({ error: 'Form not found' });
    } else {
      console.error('Error reading form:', err);
      res.status(500).json({ error: 'Failed to read form' });
    }
  }
});

/**
 * PUT /api/forms/:name
 * Save a form file (create or update)
 */
app.put('/api/forms/:name', async (req, res) => {
  try {
    const filename = `${req.params.name}.edn`;
    const filepath = path.join(FORMS_DIR, filename);

    let content;
    if (typeof req.body === 'string') {
      content = req.body;
    } else {
      content = jsonToEdn(req.body);
    }

    await fs.writeFile(filepath, content, 'utf8');
    await updateIndex(req.params.name);

    console.log(`Saved form: ${filename}`);
    res.json({ success: true, filename });
  } catch (err) {
    console.error('Error saving form:', err);
    res.status(500).json({ error: 'Failed to save form' });
  }
});

/**
 * DELETE /api/forms/:name
 * Delete a form file
 */
app.delete('/api/forms/:name', async (req, res) => {
  try {
    const filename = `${req.params.name}.edn`;
    const filepath = path.join(FORMS_DIR, filename);

    await fs.unlink(filepath);
    await removeFromIndex(req.params.name);

    console.log(`Deleted form: ${filename}`);
    res.json({ success: true });
  } catch (err) {
    if (err.code === 'ENOENT') {
      res.status(404).json({ error: 'Form not found' });
    } else {
      console.error('Error deleting form:', err);
      res.status(500).json({ error: 'Failed to delete form' });
    }
  }
});

// ============================================================
// CONFIG ENDPOINTS
// ============================================================

/**
 * GET /api/config
 * Read app configuration from settings/config.edn
 */
app.get('/api/config', async (req, res) => {
  try {
    const filepath = path.join(SETTINGS_DIR, 'config.edn');
    const content = await fs.readFile(filepath, 'utf8');
    res.type('application/edn').send(content);
  } catch (err) {
    if (err.code === 'ENOENT') {
      // Return default config if file doesn't exist
      res.type('application/edn').send('{:form-designer {:grid-size 8}}');
    } else {
      console.error('Error reading config:', err);
      res.status(500).json({ error: 'Failed to read config' });
    }
  }
});

/**
 * PUT /api/config
 * Save app configuration to settings/config.edn
 */
app.put('/api/config', async (req, res) => {
  try {
    const filepath = path.join(SETTINGS_DIR, 'config.edn');

    // Ensure settings directory exists
    await fs.mkdir(SETTINGS_DIR, { recursive: true });

    let content;
    if (typeof req.body === 'string') {
      content = req.body;
    } else {
      content = jsonToEdn(req.body);
    }

    await fs.writeFile(filepath, content, 'utf8');
    console.log('Saved config');
    res.json({ success: true });
  } catch (err) {
    console.error('Error saving config:', err);
    res.status(500).json({ error: 'Failed to save config' });
  }
});

// ============================================================
// HELPER FUNCTIONS
// ============================================================

async function updateIndex(formName) {
  const indexPath = path.join(FORMS_DIR, '_index.edn');
  try {
    const content = await fs.readFile(indexPath, 'utf8');
    const match = content.match(/\[([\s\S]*)\]/);
    if (match) {
      const items = match[1]
        .split('\n')
        .map(s => s.trim())
        .filter(s => s.startsWith('"'))
        .map(s => s.replace(/^"|"$/g, '').replace(/",?$/, ''));

      if (!items.includes(formName)) {
        items.push(formName);
        const newContent = `["${items.join('"\n "')}"]`;
        await fs.writeFile(indexPath, newContent, 'utf8');
        console.log(`Added ${formName} to index`);
      }
    }
  } catch (err) {
    if (err.code === 'ENOENT') {
      await fs.writeFile(indexPath, `["${formName}"]`, 'utf8');
    } else {
      console.error('Error updating index:', err);
    }
  }
}

async function removeFromIndex(formName) {
  const indexPath = path.join(FORMS_DIR, '_index.edn');
  try {
    const content = await fs.readFile(indexPath, 'utf8');
    const match = content.match(/\[([\s\S]*)\]/);
    if (match) {
      const items = match[1]
        .split('\n')
        .map(s => s.trim())
        .filter(s => s.startsWith('"'))
        .map(s => s.replace(/^"|"$/g, '').replace(/",?$/, ''))
        .filter(s => s !== formName);

      const newContent = items.length > 0
        ? `["${items.join('"\n "')}"]`
        : '[]';
      await fs.writeFile(indexPath, newContent, 'utf8');
      console.log(`Removed ${formName} from index`);
    }
  } catch (err) {
    console.error('Error updating index:', err);
  }
}

function jsonToEdn(obj, indent = 0) {
  const spaces = ' '.repeat(indent);

  if (obj === null) return 'nil';
  if (typeof obj === 'boolean') return obj.toString();
  if (typeof obj === 'number') return obj.toString();
  if (typeof obj === 'string') return `"${obj}"`;

  if (Array.isArray(obj)) {
    if (obj.length === 0) return '[]';
    const items = obj.map(item => jsonToEdn(item, indent + 1));
    return `[${items.join('\n' + spaces + ' ')}]`;
  }

  if (typeof obj === 'object') {
    const entries = Object.entries(obj);
    if (entries.length === 0) return '{}';

    const pairs = entries.map(([k, v]) => {
      const key = `:${k.replace(/_/g, '-')}`;
      const val = jsonToEdn(v, indent + 1);
      return `${key} ${val}`;
    });

    return `{${pairs.join('\n' + spaces + ' ')}}`;
  }

  return obj.toString();
}

// Start server
app.listen(PORT, () => {
  console.log(`CloneTemplate backend running on http://localhost:${PORT}`);
  console.log(`Forms directory: ${FORMS_DIR}`);
  console.log(`Database: ${config.database.connectionString.replace(/:[^:@]+@/, ':****@')}`);
});
