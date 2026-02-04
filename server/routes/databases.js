/**
 * Database switching routes
 * Handles listing and switching between databases
 */

const express = require('express');
const router = express.Router();

module.exports = function(pool, logError) {
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
      await logError('/api/databases', 'Failed to fetch databases', err);
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
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
