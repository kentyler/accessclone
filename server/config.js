/**
 * Configuration for CloneTemplate backend
 *
 * Override with environment variables:
 *   DATABASE_URL or individual PG* variables
 */

// Detect if running in WSL - if so, use Windows host IP
const isWSL = process.platform === 'linux' &&
  require('fs').existsSync('/proc/version') &&
  require('fs').readFileSync('/proc/version', 'utf8').toLowerCase().includes('microsoft');

// Default host: Windows host IP from WSL, or localhost on Windows
const defaultHost = isWSL ? '10.255.255.254' : '127.0.0.1';

module.exports = {
  // Database connection - connects to the translated application's database
  // Override with DATABASE_URL or individual PG* environment variables
  database: {
    connectionString: process.env.DATABASE_URL ||
      `postgresql://${process.env.PGUSER || 'postgres'}:${process.env.PGPASSWORD || '<password>'}@${process.env.PGHOST || defaultHost}:${process.env.PGPORT || '5432'}/${process.env.PGDATABASE || 'polyaccess'}`,

    // Pool settings
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
  },

  // Server settings
  server: {
    port: process.env.PORT || 3001,
  }
};
