/**
 * Event logging utilities
 */

/**
 * Log an event to the shared.events table
 * @param {Pool} pool - PostgreSQL connection pool
 * @param {string} eventType - 'error', 'warning', 'info', 'action', etc.
 * @param {string} source - where the event originated ('server', 'api', endpoint name, etc.)
 * @param {string} message - human-readable message
 * @param {object} options - { databaseId, userId, sessionId, details }
 */
async function logEvent(pool, eventType, source, message, options = {}) {
  const { databaseId, userId, sessionId, details } = options;
  try {
    await pool.query(`
      INSERT INTO shared.events (event_type, source, database_id, user_id, session_id, message, details)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [
      eventType,
      source,
      databaseId || null,
      userId || null,
      sessionId || null,
      message,
      details ? JSON.stringify(details) : null
    ]);
  } catch (err) {
    // Don't let logging errors break the app, just console log
    console.error('Failed to log event:', err.message);
  }
}

/**
 * Helper for logging errors with stack trace
 */
async function logError(pool, source, message, error, options = {}) {
  await logEvent(pool, 'error', source, message, {
    ...options,
    details: {
      ...options.details,
      error: error?.message,
      stack: error?.stack
    }
  });
}

module.exports = { logEvent, logError };
