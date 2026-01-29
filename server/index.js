/**
 * Backend for PolyAccess
 * Main server entry point - routes are in /routes
 */

const express = require('express');
const path = require('path');
const cors = require('cors');
const { Pool } = require('pg');
const config = require('./config');

// Load helpers
const { logEvent, logError } = require('./lib/events');
const helpers = require('./lib/helpers');

// Load routes
const databasesRoutes = require('./routes/databases');
const metadataRoutes = require('./routes/metadata');
const dataRoutes = require('./routes/data');
const sessionsRoutes = require('./routes/sessions');
const eventsRoutes = require('./routes/events');
const chatRoutes = require('./routes/chat');
const formsRoutes = require('./routes/forms');
const configRoutes = require('./routes/config');

const app = express();
const PORT = config.server.port;

// Directories
const FORMS_DIR = path.join(__dirname, '..', 'forms');
const SETTINGS_DIR = path.join(__dirname, '..', 'settings');
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

// Load secrets for chat
let secrets = {};
try {
  const secretsPath = path.join(__dirname, '..', 'secrets.json');
  secrets = JSON.parse(require('fs').readFileSync(secretsPath, 'utf8'));
  console.log('Secrets loaded from secrets.json');
} catch (err) {
  console.log('No secrets.json found, using environment variables');
}

// ============================================================
// MIDDLEWARE
// ============================================================

app.use(cors());
app.use(express.json());
app.use(express.text({ type: 'application/edn' }));

// Serve forms directory as static files
app.use('/forms', express.static(FORMS_DIR));

// Serve UI static files (CSS, JS)
app.use(express.static(UI_PUBLIC_DIR));

// ============================================================
// DATABASE SCHEMA ROUTING MIDDLEWARE
// ============================================================

// Initialize databases router first to get currentDatabaseId getter
const databasesRouter = databasesRoutes(pool, (source, msg, err) => logError(pool, source, msg, err));

/**
 * Middleware to set search_path based on X-Database-ID header
 */
app.use('/api', async (req, res, next) => {
  // Skip for /api/databases endpoint (needs to query shared schema)
  if (req.path === '/databases' || req.path.startsWith('/databases')) {
    return next();
  }

  const dbId = req.headers['x-database-id'] || databasesRouter.getCurrentDatabaseId();

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

// ============================================================
// MOUNT ROUTES
// ============================================================

app.use('/api/databases', databasesRouter);
app.use('/api', metadataRoutes(pool));
app.use('/api/data', dataRoutes(pool));
app.use('/api/session', sessionsRoutes(pool));
app.use('/api/events', eventsRoutes(pool, logEvent));
app.use('/api/chat', chatRoutes(pool, secrets));
app.use('/api/forms', formsRoutes(FORMS_DIR, helpers));
app.use('/api/config', configRoutes(SETTINGS_DIR, helpers));

// ============================================================
// START SERVER
// ============================================================

app.listen(PORT, () => {
  console.log(`PolyAccess backend running on http://localhost:${PORT}`);
  console.log(`Forms directory: ${FORMS_DIR}`);
  console.log(`Database: ${config.database.connectionString.replace(/:[^:@]+@/, ':****@')}`);
});
