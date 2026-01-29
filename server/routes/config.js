/**
 * Configuration routes
 * Handles app configuration file
 */

const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const router = express.Router();

module.exports = function(settingsDir, { jsonToEdn }) {
  /**
   * GET /api/config
   * Read app configuration from settings/config.edn
   */
  router.get('/', async (req, res) => {
    try {
      const filepath = path.join(settingsDir, 'config.edn');
      const content = await fs.readFile(filepath, 'utf8');
      res.type('application/edn').send(content);
    } catch (err) {
      if (err.code === 'ENOENT') {
        // Return default config if file doesn't exist
        res.type('application/edn').send('{:form-designer {:grid-size 8}}');
      } else {
        console.error('Error reading config:', err);
        res.status(500).json({ error: 'Failed to read config' });
      }
    }
  });

  /**
   * PUT /api/config
   * Save app configuration to settings/config.edn
   */
  router.put('/', async (req, res) => {
    try {
      const filepath = path.join(settingsDir, 'config.edn');

      // Ensure settings directory exists
      await fs.mkdir(settingsDir, { recursive: true });

      let content;
      if (typeof req.body === 'string') {
        content = req.body;
      } else {
        content = jsonToEdn(req.body);
      }

      await fs.writeFile(filepath, content, 'utf8');
      console.log('Saved config');
      res.json({ success: true });
    } catch (err) {
      console.error('Error saving config:', err);
      res.status(500).json({ error: 'Failed to save config' });
    }
  });

  return router;
};
