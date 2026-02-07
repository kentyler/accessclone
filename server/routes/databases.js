/**
 * Database switching routes
 * Handles listing and switching between databases
 */

const express = require('express');
const router = express.Router();
const { logError } = require('../lib/events');

module.exports = function(pool) {
  // Track current database (server-side state)
  // Initialized to null, set on first request or via initializeDefault()
  let currentDatabaseId = null;

  // Getter for current database ID (used by middleware)
  router.getCurrentDatabaseId = () => currentDatabaseId;

  /**
   * Initialize default database from shared.databases
   * Called on server startup
   */
  router.initializeDefault = async () => {
    try {
      // Get the most recently accessed database, or first by name
      const result = await pool.query(`
        SELECT database_id FROM shared.databases
        ORDER BY last_accessed DESC NULLS LAST, name
        LIMIT 1
      `);

      if (result.rows.length > 0) {
        currentDatabaseId = result.rows[0].database_id;
        console.log(`Default database: ${currentDatabaseId}`);
      } else {
        console.log('No databases found in shared.databases');
      }
    } catch (err) {
      console.error('Error initializing default database:', err.message);
    }
  };

  /**
   * GET /api/databases
   * List all available databases
   */
  router.get('/', async (req, res) => {
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
      logError(pool, 'GET /api/databases', 'Failed to fetch databases', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/databases
   * Create a new database (schema + shared.databases row)
   */
  router.post('/', async (req, res) => {
    const { name, description } = req.body;

    try {
      if (!name || !name.trim()) {
        return res.status(400).json({ error: 'Name is required' });
      }

      // Generate database_id: lowercase, replace non-alphanumeric with _, collapse multiples, trim edges
      const database_id = name.trim().toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_|_$/g, '');

      if (!database_id) {
        return res.status(400).json({ error: 'Name must contain at least one alphanumeric character' });
      }

      const schema_name = 'db_' + database_id;

      // Check if database_id already exists
      const existing = await pool.query(
        'SELECT database_id FROM shared.databases WHERE database_id = $1',
        [database_id]
      );
      if (existing.rows.length > 0) {
        return res.status(409).json({ error: `Database "${database_id}" already exists` });
      }

      // Create schema (schema_name is generated, not user input)
      await pool.query(`CREATE SCHEMA IF NOT EXISTS ${schema_name}`);

      // Insert into shared.databases
      await pool.query(
        'INSERT INTO shared.databases (database_id, name, schema_name, description) VALUES ($1, $2, $3, $4)',
        [database_id, name.trim(), schema_name, description || null]
      );

      res.json({
        success: true,
        database: { database_id, name: name.trim(), schema_name, description: description || null }
      });
    } catch (err) {
      console.error('Error creating database:', err);
      logError(pool, 'POST /api/databases', 'Failed to create database', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/databases/switch
   * Switch to a different database
   */
  router.post('/switch', async (req, res) => {
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
      logError(pool, 'POST /api/databases/switch', 'Failed to switch database', err, { databaseId: database_id });
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
