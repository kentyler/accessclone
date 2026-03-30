/**
 * Event logging utilities
 */

/**
 * Log an event to the shared.events table
 * @param {Pool} pool - PostgreSQL connection pool
 * @param {string} eventType - 'error', 'warning', 'info', 'action', etc.
 * @param {string} source - where the event originated ('server', 'api', endpoint name, etc.)
 * @param {string} message - human-readable message
 * @param {object} options - { databaseId, userId, sessionId, details, parentEventId, objectType, objectName, propagation }
 * @returns {Promise<number|null>} - the inserted event's id, or null on failure
 */
async function logEvent(pool, eventType, source, message, options = {}) {
  const { databaseId, userId, sessionId, details, parentEventId, objectType, objectName, propagation } = options;
  try {
    const result = await pool.query(`
      INSERT INTO shared.events (event_type, source, database_id, user_id, session_id, message, details, parent_event_id, object_type, object_name, propagation)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING id
    `, [
      eventType,
      source,
      databaseId || null,
      userId || null,
      sessionId || null,
      message,
      details ? JSON.stringify(details) : null,
      parentEventId || null,
      objectType || null,
      objectName || null,
      propagation ? JSON.stringify(propagation) : null
    ]);
    return result.rows[0]?.id || null;
  } catch (err) {
    // Don't let logging errors break the app, just console log
    console.error('Failed to log event:', err.message);
    return null;
  }
}

/**
 * Helper for logging errors with stack trace
 * @returns {Promise<number|null>} - the inserted event's id, or null on failure
 */
async function logError(pool, source, message, error, options = {}) {
  return logEvent(pool, 'error', source, message, {
    ...options,
    details: {
      ...options.details,
      error: error?.message,
      stack: error?.stack
    }
  });
}

module.exports = { logEvent, logError };
