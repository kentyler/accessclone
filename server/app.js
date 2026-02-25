/**
 * Express app factory for AccessClone
 * Creates the app with routes and middleware, without starting the server.
 */

const express = require('express');
const path = require('path');
const cors = require('cors');

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
const modulesRoutes = require('./routes/modules');
const macrosRoutes = require('./routes/macros');
const configRoutes = require('./routes/config');
const lintRoutes = require('./routes/lint');
const graphRoutes = require('./routes/graph');
const accessImportRoutes = require('./routes/access-import');
const importIssuesRoutes = require('./routes/import-issues');
const transcriptsRoutes = require('./routes/transcripts');
const formStateRoutes = require('./routes/form-state');
const appRoutes = require('./routes/app');
const pipelineRoutes = require('./routes/pipeline');
const notesRoutes = require('./routes/notes');

function createApp({
  pool,
  secrets = {},
  settingsDir = path.join(__dirname, '..', 'settings'),
  uiPublicDir = path.join(__dirname, '..', 'ui', 'resources', 'public'),
} = {}) {
  if (!pool) {
    throw new Error('createApp requires a pg Pool instance');
  }

  const app = express();

  // Initialize databases router first to get currentDatabaseId getter
  const databasesRouter = databasesRoutes(pool);

  // ============================================================
  // MIDDLEWARE
  // ============================================================
  app.use(cors());
  app.use(express.json({ limit: '50mb' }));

  // Serve UI static files (CSS, JS)
  app.use(express.static(uiPublicDir));

  // ============================================================
  // DATABASE SCHEMA ROUTING MIDDLEWARE
  // ============================================================
  /**
   * Middleware to set search_path based on X-Database-ID header
   */
  app.use('/api', async (req, res, next) => {
    // Skip for endpoints that query shared schema or don't need database context
    if (req.path === '/databases' || req.path.startsWith('/databases') ||
        req.path.startsWith('/access-import') ||
        req.path.startsWith('/import-issues') ||
        req.path.startsWith('/form-state') ||
        req.path.startsWith('/app') ||
        req.path.startsWith('/pipeline') ||
        req.path.startsWith('/notes')) {
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
      const quoted = '"' + schemaName.replace(/"/g, '""') + '"';
      await pool.query(`SET search_path = ${quoted}, shared, public`);

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
  app.use('/api/modules', modulesRoutes(pool));
  app.use('/api/macros', macrosRoutes(pool));
  app.use('/api/config', configRoutes(settingsDir, pool));
  app.use('/api/lint', lintRoutes(pool, secrets));
  app.use('/api/graph', graphRoutes(pool));
  app.use('/api/access-import', accessImportRoutes(pool, secrets));
  app.use('/api/import-issues', importIssuesRoutes(pool));
  app.use('/api/transcripts', transcriptsRoutes(pool));
  app.use('/api/form-state', formStateRoutes(pool));
  app.use('/api/app', appRoutes(pool));
  app.use('/api/pipeline', pipelineRoutes(pool, secrets));
  app.use('/api/notes', notesRoutes(pool, secrets, settingsDir));

  return { app, databasesRouter };
}

module.exports = { createApp };
