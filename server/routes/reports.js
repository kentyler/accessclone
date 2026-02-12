/**
 * Report routes with append-only versioning
 * Handles reading/writing reports from shared.reports table
 * Each save creates a new version; old versions are preserved
 */

const express = require('express');
const router = express.Router();
const { logEvent, logError } = require('../lib/events');

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
      logError(pool, 'GET /api/reports', 'Failed to list reports', err, { databaseId: req.databaseId });
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
      logError(pool, 'GET /api/reports/:name', 'Failed to read report', err, { databaseId: req.databaseId });
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
      logError(pool, 'GET /api/reports/:name/versions', 'Failed to list report versions', err, { databaseId: req.databaseId });
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
      logError(pool, 'GET /api/reports/:name/versions/:version', 'Failed to read report version', err, { databaseId: req.databaseId });
      res.status(500).json({ error: 'Failed to read report version' });
    }
  });

  /**
   * PUT /api/reports/:name
   * Save a report (creates new version, marks old as not current)
   */
  router.put('/:name', async (req, res) => {
    const client = await pool.connect();
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

      await client.query('BEGIN');

      // Get current max version for this report
      const versionResult = await client.query(
        `SELECT COALESCE(MAX(version), 0) as max_version
         FROM shared.reports
         WHERE database_id = $1 AND name = $2`,
        [databaseId, reportName]
      );
      const newVersion = versionResult.rows[0].max_version + 1;

      // Mark all existing versions as not current
      await client.query(
        `UPDATE shared.reports
         SET is_current = false
         WHERE database_id = $1 AND name = $2 AND is_current = true`,
        [databaseId, reportName]
      );

      // Insert new version as current
      await client.query(
        `INSERT INTO shared.reports (database_id, name, definition, record_source, version, is_current)
         VALUES ($1, $2, $3, $4, $5, true)`,
        [databaseId, reportName, content, recordSource, newVersion]
      );

      await client.query('COMMIT');

      // Populate graph from report (outside transaction — non-critical side effect)
      try {
        const { populateFromReport } = require('../graph/populate');
        if (populateFromReport) {
          await populateFromReport(pool, reportName, content, databaseId);
        }
      } catch (graphErr) {
        if (graphErr.code !== 'MODULE_NOT_FOUND' && !graphErr.message.includes('populateFromReport')) {
          console.error('Error populating graph from report:', graphErr.message);
          logEvent(pool, 'warning', 'PUT /api/reports/:name', 'Graph population failed after report save', { databaseId, details: { error: graphErr.message } });
        }
      }

      // Post-import lint: detect issues for imported reports
      if (req.query.source === 'import' && req.query.import_log_id) {
        try {
          const { validateReport, validateReportCrossObject, getSchemaInfo } = require('./lint');
          const reportDef = JSON.parse(content);
          const issues = validateReport(reportDef);
          const dbResult = await pool.query(
            'SELECT schema_name FROM shared.databases WHERE database_id = $1', [databaseId]
          );
          if (dbResult.rows.length > 0) {
            const schemaInfo = await getSchemaInfo(pool, dbResult.rows[0].schema_name);
            issues.push(...validateReportCrossObject(reportDef, schemaInfo));
          }
          const logId = parseInt(req.query.import_log_id);
          for (const issue of issues) {
            await pool.query(`
              INSERT INTO shared.import_issues
                (import_log_id, database_id, object_name, object_type, severity, category, location, message, suggestion)
              VALUES ($1, $2, $3, 'report', $4, 'lint', $5, $6, $7)
            `, [logId, databaseId, reportName, issue.severity, issue.location || null, issue.message, issue.suggestion || null]);
          }
        } catch (lintErr) {
          console.error('Error running post-import lint for report:', lintErr.message);
        }

        // Create PostgreSQL functions for domain-function expressions (DLookUp, DCount, etc.)
        try {
          const { processDefinitionExpressions } = require('../lib/expression-converter');
          const reportDef = JSON.parse(content);
          const dbResult2 = await pool.query(
            'SELECT schema_name FROM shared.databases WHERE database_id = $1', [databaseId]
          );
          if (dbResult2.rows.length > 0) {
            const schemaName = dbResult2.rows[0].schema_name;
            const { definition: updatedDef, functions, warnings } = await processDefinitionExpressions(
              pool, reportDef, reportName, schemaName, 'report'
            );
            if (functions.length > 0) {
              const updatedContent = JSON.stringify(updatedDef);
              await pool.query(
                `UPDATE shared.reports SET definition = $1
                 WHERE database_id = $2 AND name = $3 AND is_current = true`,
                [updatedContent, databaseId, reportName]
              );
              console.log(`Created ${functions.length} computed functions for report ${reportName}`);
            }
            for (const w of warnings) {
              console.warn(`Report ${reportName} expression warning: ${w}`);
            }
          }
        } catch (exprErr) {
          console.error('Error processing domain expressions for report:', exprErr.message);
          logEvent(pool, 'warning', 'PUT /api/reports/:name', 'Domain expression processing failed', { databaseId, details: { error: exprErr.message } });
        }
      }

      console.log(`Saved report: ${reportName} v${newVersion} (database: ${databaseId})`);
      res.json({ success: true, name: reportName, version: newVersion, database_id: databaseId });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('Error saving report:', err);
      logError(pool, 'PUT /api/reports/:name', 'Failed to save report', err, { databaseId: req.databaseId });
      res.status(500).json({ error: 'Failed to save report' });
    } finally {
      client.release();
    }
  });

  /**
   * POST /api/reports/:name/rollback/:version
   * Rollback to a specific version (makes that version current again)
   */
  router.post('/:name/rollback/:version', async (req, res) => {
    const client = await pool.connect();
    try {
      const databaseId = req.databaseId;
      const reportName = req.params.name;
      const targetVersion = parseInt(req.params.version);

      // Check target version exists (safe to read outside transaction)
      const checkResult = await client.query(
        `SELECT definition FROM shared.reports
         WHERE database_id = $1 AND name = $2 AND version = $3`,
        [databaseId, reportName, targetVersion]
      );

      if (checkResult.rows.length === 0) {
        client.release();
        return res.status(404).json({ error: 'Version not found' });
      }

      await client.query('BEGIN');

      // Get current max version
      const versionResult = await client.query(
        `SELECT MAX(version) as max_version FROM shared.reports
         WHERE database_id = $1 AND name = $2`,
        [databaseId, reportName]
      );
      const newVersion = versionResult.rows[0].max_version + 1;

      // Mark current version as not current
      await client.query(
        `UPDATE shared.reports
         SET is_current = false
         WHERE database_id = $1 AND name = $2 AND is_current = true`,
        [databaseId, reportName]
      );

      // Insert rollback as new version (copy of target version's definition)
      const targetDefinition = checkResult.rows[0].definition;
      const recordSource = extractRecordSource(targetDefinition);

      await client.query(
        `INSERT INTO shared.reports (database_id, name, definition, record_source, version, is_current)
         VALUES ($1, $2, $3, $4, $5, true)`,
        [databaseId, reportName, targetDefinition, recordSource, newVersion]
      );

      await client.query('COMMIT');

      console.log(`Rolled back report: ${reportName} to v${targetVersion} (now v${newVersion})`);
      res.json({
        success: true,
        name: reportName,
        rolled_back_to: targetVersion,
        new_version: newVersion
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('Error rolling back report:', err);
      logError(pool, 'POST /api/reports/:name/rollback/:version', 'Failed to rollback report', err, { databaseId: req.databaseId });
      res.status(500).json({ error: 'Failed to rollback report' });
    } finally {
      client.release();
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
      logError(pool, 'DELETE /api/reports/:name', 'Failed to delete report', err, { databaseId: req.databaseId });
      res.status(500).json({ error: 'Failed to delete report' });
    }
  });

  return router;
}

module.exports = createRouter;
module.exports.extractRecordSource = extractRecordSource;
