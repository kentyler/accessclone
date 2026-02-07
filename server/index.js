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

// Load routes
const databasesRoutes = require('./routes/databases');
const metadataRoutes = require('./routes/metadata');
const dataRoutes = require('./routes/data');
const sessionsRoutes = require('./routes/sessions');
const eventsRoutes = require('./routes/events');
const chatRoutes = require('./routes/chat');
const formsRoutes = require('./routes/forms');
const reportsRoutes = require('./routes/reports');
const configRoutes = require('./routes/config');
const lintRoutes = require('./routes/lint');
const graphRoutes = require('./routes/graph');
const accessImportRoutes = require('./routes/access-import');

// Load graph modules
const { initializeGraph } = require('./graph/schema');
const { populateFromSchemas } = require('./graph/populate');

const app = express();
const PORT = config.server.port;

// Directories
const SETTINGS_DIR = path.join(__dirname, '..', 'settings');
const UI_PUBLIC_DIR = path.join(__dirname, '..', 'ui', 'resources', 'public');

// Database connection pool
const pool = new Pool({
  connectionString: config.database.connectionString,
  max: config.database.max,
  idleTimeoutMillis: config.database.idleTimeoutMillis,
  connectionTimeoutMillis: config.database.connectionTimeoutMillis,
});

// Initialize databases router first to get currentDatabaseId getter
const databasesRouter = databasesRoutes(pool);

// Test database connection and initialize on startup
pool.query('SELECT NOW()')
  .then(async () => {
    console.log('Database connected successfully');

    // Initialize shared schema (graph, forms, reports tables)
    try {
      await initializeGraph(pool);

      // Only populate graph if empty (first run)
      const countResult = await pool.query('SELECT COUNT(*) FROM shared._nodes');
      const nodeCount = parseInt(countResult.rows[0].count);

      if (nodeCount === 0) {
        console.log('Graph is empty, populating from schemas...');
        await populateFromSchemas(pool);
      } else {
        console.log(`Graph already has ${nodeCount} nodes, skipping population`);
      }
    } catch (err) {
      console.error('Schema initialization error:', err.message);
    }

    // Initialize default database selection
    try {
      await databasesRouter.initializeDefault();
    } catch (err) {
      console.error('Database initialization error:', err.message);
    }
  })
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

// Serve UI static files (CSS, JS)
app.use(express.static(UI_PUBLIC_DIR));

// ============================================================
// DATABASE SCHEMA ROUTING MIDDLEWARE
// ============================================================

/**
 * Middleware to set search_path based on X-Database-ID header
 */
app.use('/api', async (req, res, next) => {
  // Skip for endpoints that query shared schema or don't need database context
  if (req.path === '/databases' || req.path.startsWith('/databases') ||
      req.path.startsWith('/access-import')) {
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

    // Set search_path for this request.
    // schemaName comes from a parameterized lookup against shared.databases (line 122),
    // not from user input, so string interpolation is safe here.
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
app.use('/api/forms', formsRoutes(pool));
app.use('/api/reports', reportsRoutes(pool));
app.use('/api/config', configRoutes(SETTINGS_DIR, pool));
app.use('/api/lint', lintRoutes(pool, secrets));
app.use('/api/graph', graphRoutes(pool));
app.use('/api/access-import', accessImportRoutes(pool));

// ============================================================
// START SERVER
// ============================================================

app.listen(PORT, () => {
  console.log(`PolyAccess backend running on http://localhost:${PORT}`);
  console.log(`Database: ${config.database.connectionString.replace(/:[^:@]+@/, ':****@')}`);
  console.log(`Forms: stored in shared.forms table`);

  // Clean up expired sessions every hour
  setInterval(() => {
    pool.query('SELECT cleanup_old_sessions()').catch(err => {
      console.error('Session cleanup error:', err.message);
    });
  }, 60 * 60 * 1000);
});
