/**
 * Backend for AccessClone
 * Main server entry point - routes are in /routes
 */

const path = require('path');
const { Pool } = require('pg');
const config = require('./config');
const { createApp } = require('./app');

// Load graph modules
const { initializeGraph } = require('./graph/schema');
const { populateFromSchemas } = require('./graph/populate');

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

// Load secrets for chat
let secrets = {};
try {
  const secretsPath = path.join(__dirname, '..', 'secrets.json');
  secrets = JSON.parse(require('fs').readFileSync(secretsPath, 'utf8'));
  console.log('Secrets loaded from secrets.json');
} catch (err) {
  console.log('No secrets.json found, using environment variables');
}

// Create Express app + routes
const { app, databasesRouter } = createApp({
  pool,
  secrets,
  settingsDir: SETTINGS_DIR,
  uiPublicDir: UI_PUBLIC_DIR
});

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

// ============================================================
// START SERVER
// ============================================================

app.listen(PORT, () => {
  console.log(`AccessClone backend running on http://localhost:${PORT}`);
  console.log(`Database: ${config.database.connectionString.replace(/:[^:@]+@/, ':****@')}`);
  console.log(`Forms: stored in shared.forms table`);

  // Clean up expired sessions every hour
  setInterval(() => {
    pool.query('SELECT cleanup_old_sessions()').catch(err => {
      console.error('Session cleanup error:', err.message);
    });
  }, 60 * 60 * 1000);
});
