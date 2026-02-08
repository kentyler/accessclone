/**
 * Configuration routes
 * Handles app configuration file
 */

const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const router = express.Router();
const { logError } = require('../lib/events');

// Server capabilities — what features are available in this deployment
const capabilities = {
  "file-system": true,   // Local file read/write/copy via backend API
  "powershell": process.platform === 'win32' ||
    (process.platform === 'linux' && require('fs').existsSync('/proc/version') &&
     require('fs').readFileSync('/proc/version', 'utf8').toLowerCase().includes('microsoft')),
  "access-import": true  // Access database import via COM automation
};

module.exports = function(settingsDir, pool) {
  /**
   * GET /api/config
   * Read app configuration from settings/config.json, merged with server capabilities
   */
  router.get('/', async (req, res) => {
    try {
      const filepath = path.join(settingsDir, 'config.json');
      const content = await fs.readFile(filepath, 'utf8');
      const config = JSON.parse(content);
      res.json({ ...config, capabilities });
    } catch (err) {
      if (err.code === 'ENOENT') {
        // Return default config if file doesn't exist
        res.json({ "form-designer": { "grid-size": 8 }, capabilities });
      } else {
        console.error('Error reading config:', err);
        logError(pool, 'GET /api/config', 'Failed to read config', err);
        res.status(500).json({ error: 'Failed to read config' });
      }
    }
  });

  /**
   * PUT /api/config
   * Save app configuration to settings/config.json
   */
  router.put('/', async (req, res) => {
    try {
      const filepath = path.join(settingsDir, 'config.json');

      // Ensure settings directory exists
      await fs.mkdir(settingsDir, { recursive: true });

      const content = JSON.stringify(req.body, null, 2);
      await fs.writeFile(filepath, content, 'utf8');
      console.log('Saved config');
      res.json({ success: true });
    } catch (err) {
      console.error('Error saving config:', err);
      logError(pool, 'PUT /api/config', 'Failed to save config', err);
      res.status(500).json({ error: 'Failed to save config' });
    }
  });

  return router;
};
