/**
 * Form routes with append-only versioning
 * Handles reading/writing forms from shared.forms table
 * Each save creates a new version; old versions are preserved
 */

const express = require('express');
const router = express.Router();

/**
 * Extract record-source from EDN content
 * @param {string} edn - EDN content
 * @returns {string|null} - record source or null
 */
function extractRecordSource(edn) {
  const match = edn.match(/:record-source\s+"([^"]+)"/);
  return match ? match[1] : null;
}

module.exports = function(pool, { jsonToEdn }) {
  /**
   * GET /api/forms
   * List all current forms for current database
   */
  router.get('/', async (req, res) => {
    try {
      const databaseId = req.databaseId;

      const result = await pool.query(
        `SELECT name, record_source, description, version, created_at
         FROM shared.forms
         WHERE database_id = $1 AND is_current = true
         ORDER BY name`,
        [databaseId]
      );

      const forms = result.rows.map(r => r.name);
      res.json({ forms, details: result.rows });
    } catch (err) {
      console.error('Error listing forms:', err);
      res.status(500).json({ error: 'Failed to list forms' });
    }
  });

  /**
   * GET /api/forms/:name
   * Read the current version of a form definition
   */
  router.get('/:name', async (req, res) => {
    try {
      const databaseId = req.databaseId;

      const result = await pool.query(
        `SELECT definition, version FROM shared.forms
         WHERE database_id = $1 AND name = $2 AND is_current = true`,
        [databaseId, req.params.name]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Form not found' });
      }

      res.type('application/edn').send(result.rows[0].definition);
    } catch (err) {
      console.error('Error reading form:', err);
      res.status(500).json({ error: 'Failed to read form' });
    }
  });

  /**
   * GET /api/forms/:name/versions
   * List all versions of a form
   */
  router.get('/:name/versions', async (req, res) => {
    try {
      const databaseId = req.databaseId;

      const result = await pool.query(
        `SELECT version, is_current, created_at
         FROM shared.forms
         WHERE database_id = $1 AND name = $2
         ORDER BY version DESC`,
        [databaseId, req.params.name]
      );

      res.json({ versions: result.rows });
    } catch (err) {
      console.error('Error listing form versions:', err);
      res.status(500).json({ error: 'Failed to list versions' });
    }
  });

  /**
   * GET /api/forms/:name/versions/:version
   * Read a specific version of a form
   */
  router.get('/:name/versions/:version', async (req, res) => {
    try {
      const databaseId = req.databaseId;
      const version = parseInt(req.params.version);

      const result = await pool.query(
        `SELECT definition, version, is_current, created_at
         FROM shared.forms
         WHERE database_id = $1 AND name = $2 AND version = $3`,
        [databaseId, req.params.name, version]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Form version not found' });
      }

      res.type('application/edn').send(result.rows[0].definition);
    } catch (err) {
      console.error('Error reading form version:', err);
      res.status(500).json({ error: 'Failed to read form version' });
    }
  });

  /**
   * PUT /api/forms/:name
   * Save a form (creates new version, marks old as not current)
   */
  router.put('/:name', async (req, res) => {
    try {
      const databaseId = req.databaseId;
      const formName = req.params.name;

      let content;
      if (typeof req.body === 'string') {
        content = req.body;
      } else {
        content = jsonToEdn(req.body);
      }

      const recordSource = extractRecordSource(content);

      // Get current max version for this form
      const versionResult = await pool.query(
        `SELECT COALESCE(MAX(version), 0) as max_version
         FROM shared.forms
         WHERE database_id = $1 AND name = $2`,
        [databaseId, formName]
      );
      const newVersion = versionResult.rows[0].max_version + 1;

      // Mark all existing versions as not current
      await pool.query(
        `UPDATE shared.forms
         SET is_current = false
         WHERE database_id = $1 AND name = $2 AND is_current = true`,
        [databaseId, formName]
      );

      // Insert new version as current
      await pool.query(
        `INSERT INTO shared.forms (database_id, name, definition, record_source, version, is_current)
         VALUES ($1, $2, $3, $4, $5, true)`,
        [databaseId, formName, content, recordSource, newVersion]
      );

      // Populate graph from form
      try {
        const { populateFromForm } = require('../graph/populate');
        await populateFromForm(pool, formName, content, databaseId);
      } catch (graphErr) {
        console.error('Error populating graph from form:', graphErr.message);
        // Don't fail the save if graph population fails
      }

      console.log(`Saved form: ${formName} v${newVersion} (database: ${databaseId})`);
      res.json({ success: true, name: formName, version: newVersion, database_id: databaseId });
    } catch (err) {
      console.error('Error saving form:', err);
      res.status(500).json({ error: 'Failed to save form' });
    }
  });

  /**
   * POST /api/forms/:name/rollback/:version
   * Rollback to a specific version (makes that version current again)
   */
  router.post('/:name/rollback/:version', async (req, res) => {
    try {
      const databaseId = req.databaseId;
      const formName = req.params.name;
      const targetVersion = parseInt(req.params.version);

      // Check target version exists
      const checkResult = await pool.query(
        `SELECT definition FROM shared.forms
         WHERE database_id = $1 AND name = $2 AND version = $3`,
        [databaseId, formName, targetVersion]
      );

      if (checkResult.rows.length === 0) {
        return res.status(404).json({ error: 'Version not found' });
      }

      // Get current max version
      const versionResult = await pool.query(
        `SELECT MAX(version) as max_version FROM shared.forms
         WHERE database_id = $1 AND name = $2`,
        [databaseId, formName]
      );
      const newVersion = versionResult.rows[0].max_version + 1;

      // Mark current version as not current
      await pool.query(
        `UPDATE shared.forms
         SET is_current = false
         WHERE database_id = $1 AND name = $2 AND is_current = true`,
        [databaseId, formName]
      );

      // Insert rollback as new version (copy of target version's definition)
      const targetDefinition = checkResult.rows[0].definition;
      const recordSource = extractRecordSource(targetDefinition);

      await pool.query(
        `INSERT INTO shared.forms (database_id, name, definition, record_source, version, is_current)
         VALUES ($1, $2, $3, $4, $5, true)`,
        [databaseId, formName, targetDefinition, recordSource, newVersion]
      );

      console.log(`Rolled back form: ${formName} to v${targetVersion} (now v${newVersion})`);
      res.json({
        success: true,
        name: formName,
        rolled_back_to: targetVersion,
        new_version: newVersion
      });
    } catch (err) {
      console.error('Error rolling back form:', err);
      res.status(500).json({ error: 'Failed to rollback form' });
    }
  });

  /**
   * DELETE /api/forms/:name
   * Delete a form (marks all versions as not current)
   */
  router.delete('/:name', async (req, res) => {
    try {
      const databaseId = req.databaseId;

      const result = await pool.query(
        `UPDATE shared.forms
         SET is_current = false
         WHERE database_id = $1 AND name = $2 AND is_current = true
         RETURNING version`,
        [databaseId, req.params.name]
      );

      if (result.rowCount === 0) {
        return res.status(404).json({ error: 'Form not found' });
      }

      console.log(`Deleted form: ${req.params.name} (database: ${databaseId})`);
      res.json({ success: true });
    } catch (err) {
      console.error('Error deleting form:', err);
      res.status(500).json({ error: 'Failed to delete form' });
    }
  });

  return router;
};
