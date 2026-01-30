/**
 * Form file routes
 * Handles reading/writing form EDN files
 */

const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const router = express.Router();

module.exports = function(formsDir, { updateFormIndex, removeFromFormIndex, jsonToEdn }, pool) {
  /**
   * GET /api/forms
   * List all form files
   */
  router.get('/', async (req, res) => {
    try {
      const files = await fs.readdir(formsDir);
      const formFiles = files
        .filter(f => f.endsWith('.edn') && f !== '_index.edn')
        .map(f => f.replace('.edn', ''));
      res.json({ forms: formFiles });
    } catch (err) {
      console.error('Error listing forms:', err);
      res.status(500).json({ error: 'Failed to list forms' });
    }
  });

  /**
   * GET /api/forms/:name
   * Read a single form file
   */
  router.get('/:name', async (req, res) => {
    try {
      const filename = `${req.params.name}.edn`;
      const filepath = path.join(formsDir, filename);
      const content = await fs.readFile(filepath, 'utf8');
      res.type('application/edn').send(content);
    } catch (err) {
      if (err.code === 'ENOENT') {
        res.status(404).json({ error: 'Form not found' });
      } else {
        console.error('Error reading form:', err);
        res.status(500).json({ error: 'Failed to read form' });
      }
    }
  });

  /**
   * PUT /api/forms/:name
   * Save a form file (create or update)
   */
  router.put('/:name', async (req, res) => {
    try {
      const filename = `${req.params.name}.edn`;
      const filepath = path.join(formsDir, filename);

      let content;
      if (typeof req.body === 'string') {
        content = req.body;
      } else {
        content = jsonToEdn(req.body);
      }

      await fs.writeFile(filepath, content, 'utf8');
      await updateFormIndex(formsDir, req.params.name);

      // Populate graph from form if pool is available
      if (pool) {
        try {
          const { populateFromForm } = require('../graph/populate');
          const databaseId = req.headers['x-database-id'] || req.databaseId || 'default';
          await populateFromForm(pool, req.params.name, content, databaseId);
        } catch (graphErr) {
          console.error('Error populating graph from form:', graphErr.message);
          // Don't fail the save if graph population fails
        }
      }

      console.log(`Saved form: ${filename}`);
      res.json({ success: true, filename });
    } catch (err) {
      console.error('Error saving form:', err);
      res.status(500).json({ error: 'Failed to save form' });
    }
  });

  /**
   * DELETE /api/forms/:name
   * Delete a form file
   */
  router.delete('/:name', async (req, res) => {
    try {
      const filename = `${req.params.name}.edn`;
      const filepath = path.join(formsDir, filename);

      await fs.unlink(filepath);
      await removeFromFormIndex(formsDir, req.params.name);

      console.log(`Deleted form: ${filename}`);
      res.json({ success: true });
    } catch (err) {
      if (err.code === 'ENOENT') {
        res.status(404).json({ error: 'Form not found' });
      } else {
        console.error('Error deleting form:', err);
        res.status(500).json({ error: 'Failed to delete form' });
      }
    }
  });

  return router;
};
