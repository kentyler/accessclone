/**
 * Session state and function calling routes
 * Manages execution state and PostgreSQL function calls
 */

const express = require('express');
const router = express.Router();
const { logEvent, logError } = require('../lib/events');

module.exports = function(pool) {
  /**
   * GET /api/ui-state
   * Get saved UI state (open tabs, active database, etc.)
   */
  router.get('/ui-state', async (req, res) => {
    try {
      const result = await pool.query(
        "SELECT setting_value FROM app_config WHERE setting_name = 'ui_state'"
      );
      if (result.rows.length > 0 && result.rows[0].setting_value) {
        res.json(JSON.parse(result.rows[0].setting_value));
      } else {
        res.json({});
      }
    } catch (err) {
      console.error('Error fetching UI state:', err);
      logEvent(pool, 'warning', 'GET /api/session/ui-state', 'Failed to fetch UI state', { databaseId: req.databaseId, details: { error: err.message } });
      res.json({}); // Return empty on error, don't fail
    }
  });

  /**
   * PUT /api/ui-state
   * Save UI state (open tabs, active database, etc.)
   */
  router.put('/ui-state', async (req, res) => {
    try {
      const stateJson = JSON.stringify(req.body);
      await pool.query(
        `INSERT INTO app_config (setting_name, setting_value, description)
         VALUES ('ui_state', $1, 'Saved UI state - open tabs, active database')
         ON CONFLICT (setting_name)
         DO UPDATE SET setting_value = $1`,
        [stateJson]
      );
      res.json({ success: true });
    } catch (err) {
      console.error('Error saving UI state:', err);
      logError(pool, 'PUT /api/session/ui-state', 'Failed to save UI state', err, { databaseId: req.databaseId });
      res.status(500).json({ error: 'Failed to save UI state' });
    }
  });

  /**
   * GET /api/import-state
   * Get saved import state (selected Access DB, object type, target database)
   */
  router.get('/import-state', async (req, res) => {
    try {
      const result = await pool.query(
        "SELECT setting_value FROM app_config WHERE setting_name = 'import_state'"
      );
      if (result.rows.length > 0 && result.rows[0].setting_value) {
        res.json(JSON.parse(result.rows[0].setting_value));
      } else {
        res.json({});
      }
    } catch (err) {
      console.error('Error fetching import state:', err);
      logEvent(pool, 'warning', 'GET /api/session/import-state', 'Failed to fetch import state', { databaseId: req.databaseId, details: { error: err.message } });
      res.json({});
    }
  });

  /**
   * PUT /api/import-state
   * Save import state (selected Access DB, object type, target database)
   */
  router.put('/import-state', async (req, res) => {
    try {
      const stateJson = JSON.stringify(req.body);
      await pool.query(
        `INSERT INTO app_config (setting_name, setting_value, description)
         VALUES ('import_state', $1, 'Saved import state - Access DB path, object type, target database')
         ON CONFLICT (setting_name)
         DO UPDATE SET setting_value = $1`,
        [stateJson]
      );
      res.json({ success: true });
    } catch (err) {
      console.error('Error saving import state:', err);
      logError(pool, 'PUT /api/session/import-state', 'Failed to save import state', err, { databaseId: req.databaseId });
      res.status(500).json({ error: 'Failed to save import state' });
    }
  });

  /**
   * POST /api/session
   * Create a new session for function execution
   */
  router.post('/', async (req, res) => {
    try {
      const result = await pool.query('SELECT create_session() as session_id');
      res.json({ sessionId: result.rows[0].session_id });
    } catch (err) {
      console.error('Error creating session:', err);
      logError(pool, 'POST /api/session', 'Failed to create session', err, { databaseId: req.databaseId });
      res.status(500).json({ error: 'Failed to create session' });
    }
  });

  /**
   * DELETE /api/session/:id
   * Clear a session
   */
  router.delete('/:id', async (req, res) => {
    try {
      await pool.query('SELECT clear_session($1)', [req.params.id]);
      res.json({ success: true });
    } catch (err) {
      console.error('Error clearing session:', err);
      logError(pool, 'DELETE /api/session/:id', 'Failed to clear session', err, { databaseId: req.databaseId });
      res.status(500).json({ error: 'Failed to clear session' });
    }
  });

  /**
   * GET /api/session/:id/state
   * Get all state variables for a session
   */
  router.get('/:id/state', async (req, res) => {
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
      logError(pool, 'GET /api/session/:id/state', 'Failed to fetch session state', err, { databaseId: req.databaseId });
      res.status(500).json({ error: 'Failed to fetch session state' });
    }
  });

  /**
   * PUT /api/session/:id/state
   * Set state variables for a session
   * Body: { varName: { value: "...", type: "text|integer|numeric|boolean|date" }, ... }
   */
  router.put('/:id/state', async (req, res) => {
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
      logError(pool, 'PUT /api/session/:id/state', 'Failed to set session state', err, { databaseId: req.databaseId });
      res.status(500).json({ error: 'Failed to set session state' });
    }
  });

  /**
   * POST /api/function/:name
   * Call a PostgreSQL function with session state
   * Body: { sessionId: "uuid" }
   */
  router.post('/function/:name', async (req, res) => {
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
      logError(pool, 'POST /api/session/function/:name', 'Failed to call function', err, { databaseId: req.databaseId });
      res.status(500).json({ error: 'Failed to call function' });
    }
  });

  return router;
};
