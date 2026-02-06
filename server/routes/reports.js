/**
 * Report routes with append-only versioning
 * Handles reading/writing reports from shared.reports table
 * Each save creates a new version; old versions are preserved
 */

const express = require('express');
const router = express.Router();

/**
 * Extract record-source from JSON content string
 * @param {string} json - JSON content
 * @returns {string|null} - record source or null
 */
function extractRecordSource(json) {
  try {
    const obj = JSON.parse(json);
    return obj['record-source'] || obj['record_source'] || null;
  } catch (e) {
    return null;
  }
}

function createRouter(pool) {
  /**
   * GET /api/reports
   * List all current reports for current database
   */
  router.get('/', async (req, res) => {
    try {
      const databaseId = req.databaseId;

      const result = await pool.query(
        `SELECT name, record_source, description, version, created_at
         FROM shared.reports
         WHERE database_id = $1 AND is_current = true
         ORDER BY name`,
        [databaseId]
      );

      const reports = result.rows.map(r => r.name);
      res.json({ reports, details: result.rows });
    } catch (err) {
      console.error('Error listing reports:', err);
      res.status(500).json({ error: 'Failed to list reports' });
    }
  });

  /**
   * GET /api/reports/:name
   * Read the current version of a report definition
   */
  router.get('/:name', async (req, res) => {
    try {
      const databaseId = req.databaseId;

      const result = await pool.query(
        `SELECT definition, version FROM shared.reports
         WHERE database_id = $1 AND name = $2 AND is_current = true`,
        [databaseId, req.params.name]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Report not found' });
      }

      const raw = result.rows[0].definition;

      // Try JSON parse; if it fails, return as EDN string
      try {
        res.json(JSON.parse(raw));
      } catch (e) {
        res.json({ _raw_edn: raw, _format: 'edn' });
      }
    } catch (err) {
      console.error('Error reading report:', err);
      res.status(500).json({ error: 'Failed to read report' });
    }
  });

  /**
   * GET /api/reports/:name/versions
   * List all versions of a report
   */
  router.get('/:name/versions', async (req, res) => {
    try {
      const databaseId = req.databaseId;

      const result = await pool.query(
        `SELECT version, is_current, created_at
         FROM shared.reports
         WHERE database_id = $1 AND name = $2
         ORDER BY version DESC`,
        [databaseId, req.params.name]
      );

      res.json({ versions: result.rows });
    } catch (err) {
      console.error('Error listing report versions:', err);
      res.status(500).json({ error: 'Failed to list versions' });
    }
  });

  /**
   * GET /api/reports/:name/versions/:version
   * Read a specific version of a report
   */
  router.get('/:name/versions/:version', async (req, res) => {
    try {
      const databaseId = req.databaseId;
      const version = parseInt(req.params.version);

      const result = await pool.query(
        `SELECT definition, version, is_current, created_at
         FROM shared.reports
         WHERE database_id = $1 AND name = $2 AND version = $3`,
        [databaseId, req.params.name, version]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Report version not found' });
      }

      const raw = result.rows[0].definition;
      try {
        res.json(JSON.parse(raw));
      } catch (e) {
        res.json({ _raw_edn: raw, _format: 'edn' });
      }
    } catch (err) {
      console.error('Error reading report version:', err);
      res.status(500).json({ error: 'Failed to read report version' });
    }
  });

  /**
   * PUT /api/reports/:name
   * Save a report (creates new version, marks old as not current)
   */
  router.put('/:name', async (req, res) => {
    try {
      const databaseId = req.databaseId;
      const reportName = req.params.name;

      let content;
      if (typeof req.body === 'string') {
        content = req.body;
      } else {
        content = JSON.stringify(req.body);
      }

      const recordSource = extractRecordSource(content);

      // Get current max version for this report
      const versionResult = await pool.query(
        `SELECT COALESCE(MAX(version), 0) as max_version
         FROM shared.reports
         WHERE database_id = $1 AND name = $2`,
        [databaseId, reportName]
      );
      const newVersion = versionResult.rows[0].max_version + 1;

      // Mark all existing versions as not current
      await pool.query(
        `UPDATE shared.reports
         SET is_current = false
         WHERE database_id = $1 AND name = $2 AND is_current = true`,
        [databaseId, reportName]
      );

      // Insert new version as current
      await pool.query(
        `INSERT INTO shared.reports (database_id, name, definition, record_source, version, is_current)
         VALUES ($1, $2, $3, $4, $5, true)`,
        [databaseId, reportName, content, recordSource, newVersion]
      );

      // Populate graph from report
      try {
        const { populateFromReport } = require('../graph/populate');
        if (populateFromReport) {
          await populateFromReport(pool, reportName, content, databaseId);
        }
      } catch (graphErr) {
        // populateFromReport may not exist yet - that's fine
        if (graphErr.code !== 'MODULE_NOT_FOUND' && !graphErr.message.includes('populateFromReport')) {
          console.error('Error populating graph from report:', graphErr.message);
        }
      }

      console.log(`Saved report: ${reportName} v${newVersion} (database: ${databaseId})`);
      res.json({ success: true, name: reportName, version: newVersion, database_id: databaseId });
    } catch (err) {
      console.error('Error saving report:', err);
      res.status(500).json({ error: 'Failed to save report' });
    }
  });

  /**
   * POST /api/reports/:name/rollback/:version
   * Rollback to a specific version (makes that version current again)
   */
  router.post('/:name/rollback/:version', async (req, res) => {
    try {
      const databaseId = req.databaseId;
      const reportName = req.params.name;
      const targetVersion = parseInt(req.params.version);

      // Check target version exists
      const checkResult = await pool.query(
        `SELECT definition FROM shared.reports
         WHERE database_id = $1 AND name = $2 AND version = $3`,
        [databaseId, reportName, targetVersion]
      );

      if (checkResult.rows.length === 0) {
        return res.status(404).json({ error: 'Version not found' });
      }

      // Get current max version
      const versionResult = await pool.query(
        `SELECT MAX(version) as max_version FROM shared.reports
         WHERE database_id = $1 AND name = $2`,
        [databaseId, reportName]
      );
      const newVersion = versionResult.rows[0].max_version + 1;

      // Mark current version as not current
      await pool.query(
        `UPDATE shared.reports
         SET is_current = false
         WHERE database_id = $1 AND name = $2 AND is_current = true`,
        [databaseId, reportName]
      );

      // Insert rollback as new version (copy of target version's definition)
      const targetDefinition = checkResult.rows[0].definition;
      const recordSource = extractRecordSource(targetDefinition);

      await pool.query(
        `INSERT INTO shared.reports (database_id, name, definition, record_source, version, is_current)
         VALUES ($1, $2, $3, $4, $5, true)`,
        [databaseId, reportName, targetDefinition, recordSource, newVersion]
      );

      console.log(`Rolled back report: ${reportName} to v${targetVersion} (now v${newVersion})`);
      res.json({
        success: true,
        name: reportName,
        rolled_back_to: targetVersion,
        new_version: newVersion
      });
    } catch (err) {
      console.error('Error rolling back report:', err);
      res.status(500).json({ error: 'Failed to rollback report' });
    }
  });

  /**
   * DELETE /api/reports/:name
   * Delete a report (marks all versions as not current)
   */
  router.delete('/:name', async (req, res) => {
    try {
      const databaseId = req.databaseId;

      const result = await pool.query(
        `UPDATE shared.reports
         SET is_current = false
         WHERE database_id = $1 AND name = $2 AND is_current = true
         RETURNING version`,
        [databaseId, req.params.name]
      );

      if (result.rowCount === 0) {
        return res.status(404).json({ error: 'Report not found' });
      }

      console.log(`Deleted report: ${req.params.name} (database: ${databaseId})`);
      res.json({ success: true });
    } catch (err) {
      console.error('Error deleting report:', err);
      res.status(500).json({ error: 'Failed to delete report' });
    }
  });

  return router;
}

module.exports = createRouter;
module.exports.extractRecordSource = extractRecordSource;
