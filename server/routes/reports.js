/**
 * Report routes with append-only versioning
 * Handles reading/writing reports from shared.objects table (type='report')
 * Each save creates a new version; old versions are preserved
 */

const express = require('express');
const router = express.Router();
const { logEvent, logError } = require('../lib/events');

/**
 * Extract record-source from a definition (object or JSON string)
 * @param {object|string} def - definition object or JSON string
 * @returns {string|null} - record source or null
 */
function extractRecordSource(def) {
  try {
    const obj = typeof def === 'string' ? JSON.parse(def) : def;
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
         FROM shared.objects
         WHERE database_id = $1 AND type = 'report' AND is_current = true AND owner = 'standard'
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
      const userId = req.userId;

      const result = await pool.query(
        `SELECT o.definition, o.version, o.owner,
                (SELECT i.content FROM shared.intents i WHERE i.object_id = o.id AND i.intent_type = 'business' ORDER BY i.created_at DESC LIMIT 1) as intents
         FROM shared.objects o
         WHERE o.database_id = $1 AND o.type = 'report' AND o.name = $2 AND o.is_current = true
           AND o.owner IN ($3, 'standard')
         ORDER BY CASE WHEN o.owner = 'standard' THEN 1 ELSE 0 END
         LIMIT 1`,
        [databaseId, req.params.name, userId || 'standard']
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Report not found' });
      }

      const row = result.rows[0];
      const personalized = row.owner !== 'standard';
      const response = { ...row.definition, _personalized: personalized };
      if (row.intents) response._intents = row.intents;
      res.json(response);
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
        `SELECT version, is_current, created_at, owner, modified_by
         FROM shared.objects
         WHERE database_id = $1 AND type = 'report' AND name = $2
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
         FROM shared.objects
         WHERE database_id = $1 AND type = 'report' AND name = $2 AND version = $3`,
        [databaseId, req.params.name, version]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Report version not found' });
      }

      res.json(result.rows[0].definition);
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
      const userId = req.userId;
      const isStandard = req.query.standard === 'true' || req.query.source === 'import';

      const content = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;

      const recordSource = extractRecordSource(content);

      // Determine owner for this save
      let owner = 'standard';
      if (!isStandard && userId) {
        const personalCheck = await client.query(
          `SELECT 1 FROM shared.objects
           WHERE database_id = $1 AND type = 'report' AND name = $2 AND owner = $3 AND is_current = true`,
          [databaseId, reportName, userId]
        );
        if (personalCheck.rows.length > 0 || content._personalized) {
          owner = userId;
        }
      }

      // Clean internal flags from definition before saving
      delete content._personalized;

      await client.query('BEGIN');

      // Get current max version for this report (across all owners)
      const versionResult = await client.query(
        `SELECT COALESCE(MAX(version), 0) as max_version
         FROM shared.objects
         WHERE database_id = $1 AND type = 'report' AND name = $2`,
        [databaseId, reportName]
      );
      const newVersion = versionResult.rows[0].max_version + 1;

      // Mark existing current version for same owner as not current
      await client.query(
        `UPDATE shared.objects
         SET is_current = false
         WHERE database_id = $1 AND type = 'report' AND name = $2 AND owner = $3 AND is_current = true`,
        [databaseId, reportName, owner]
      );

      // Insert new version as current
      const insertResult = await client.query(
        `INSERT INTO shared.objects (database_id, type, name, definition, record_source, version, is_current, owner, modified_by)
         VALUES ($1, 'report', $2, $3, $4, $5, true, $6, $7)
         RETURNING id`,
        [databaseId, reportName, content, recordSource, newVersion, owner, userId]
      );
      const objectId = insertResult.rows[0].id;

      await client.query('COMMIT');

      // Propagation tracking for ledger
      const propagation = {};

      // Populate graph from report (outside transaction — non-critical side effect)
      try {
        const { populateFromReport } = require('../graph/populate');
        const graphStats = await populateFromReport(pool, reportName, content, databaseId);
        propagation.graph_nodes = graphStats.controls + 1;
        propagation.graph_edges = graphStats.edges;
      } catch (graphErr) {
        console.error('Error populating graph from report:', graphErr.message);
        logEvent(pool, 'warning', 'PUT /api/reports/:name', 'Graph population failed after report save', { databaseId, objectType: 'report', objectName: reportName, details: { error: graphErr.message } });
      }

      // Populate control-column mapping (outside transaction — non-critical side effect)
      try {
        const { populateControlColumnMap } = require('../lib/control-mapping');
        await populateControlColumnMap(pool, databaseId, reportName, content);
      } catch (mapErr) {
        console.error('Error populating control-column map for report:', mapErr.message);
        logEvent(pool, 'warning', 'PUT /api/reports/:name', 'Control-column map population failed', { databaseId, objectType: 'report', objectName: reportName, details: { error: mapErr.message } });
      }

      // Populate control-event mapping (outside transaction — non-critical side effect)
      try {
        const { populateControlEventMap } = require('../lib/event-mapping');
        await populateControlEventMap(pool, databaseId, reportName, content, 'report');
      } catch (evtErr) {
        console.error('Error populating control-event map for report:', evtErr.message);
        logEvent(pool, 'warning', 'PUT /api/reports/:name', 'Control-event map population failed', { databaseId, objectType: 'report', objectName: reportName, details: { error: evtErr.message } });
      }

      // Post-save evaluation (deterministic checks recorded to shared.evaluations)
      let evaluation = null;
      try {
        const { runAndRecordEvaluation } = require('../lib/pipeline-evaluator');
        evaluation = await runAndRecordEvaluation(pool, {
          objectId, databaseId, objectType: 'report', objectName: reportName,
          version: newVersion, definition: content,
          trigger: req.query.source === 'import' ? 'import' : 'save'
        });
        if (evaluation?.id) {
          propagation.evaluations = [evaluation.id];
        }
      } catch (evalErr) {
        logEvent(pool, 'warning', 'PUT /api/reports/:name', 'Post-save evaluation failed',
          { databaseId, objectType: 'report', objectName: reportName, details: { error: evalErr.message } });
      }

      // Log the save event with propagation signature
      logEvent(pool, 'action', 'PUT /api/reports/:name', `Report "${reportName}" saved (v${newVersion})`, {
        databaseId, objectType: 'report', objectName: reportName,
        propagation: Object.keys(propagation).length > 0 ? propagation : undefined
      });

      // Post-import lint: detect issues for imported reports
      if (req.query.source === 'import' && req.query.import_log_id) {
        try {
          const { validateReport, validateReportCrossObject, getSchemaInfo } = require('./lint');
          const reportDef = content;
          const issues = validateReport(reportDef);
          const dbResult = await pool.query(
            'SELECT schema_name FROM shared.databases WHERE database_id = $1', [databaseId]
          );
          if (dbResult.rows.length > 0) {
            const schemaInfo = await getSchemaInfo(pool, dbResult.rows[0].schema_name);
            issues.push(...validateReportCrossObject(reportDef, schemaInfo));
          }
          for (const issue of issues) {
            await pool.query(`
              INSERT INTO shared.import_log
                (target_database_id, source_object_name, source_object_type, status, severity, category, message, suggestion)
              VALUES ($1, $2, 'report', 'issue', $3, 'lint', $4, $5)
            `, [databaseId, reportName, issue.severity, issue.message, issue.suggestion || null]);
          }
        } catch (lintErr) {
          console.error('Error running post-import lint for report:', lintErr.message);
        }

        // Create PostgreSQL functions for domain-function expressions (DLookUp, DCount, etc.)
        try {
          const { processDefinitionExpressions } = require('../lib/expression-converter');
          const reportDef = content;
          const dbResult2 = await pool.query(
            'SELECT schema_name FROM shared.databases WHERE database_id = $1', [databaseId]
          );
          if (dbResult2.rows.length > 0) {
            const schemaName = dbResult2.rows[0].schema_name;
            const { definition: updatedDef, functions, warnings } = await processDefinitionExpressions(
              pool, reportDef, reportName, schemaName, 'report'
            );
            if (functions.length > 0) {
              await pool.query(
                `UPDATE shared.objects SET definition = $1
                 WHERE database_id = $2 AND type = 'report' AND name = $3 AND is_current = true AND owner = 'standard'`,
                [updatedDef, databaseId, reportName]
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
      res.json({ success: true, name: reportName, version: newVersion, database_id: databaseId, evaluation });
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
        `SELECT definition FROM shared.objects
         WHERE database_id = $1 AND type = 'report' AND name = $2 AND version = $3`,
        [databaseId, reportName, targetVersion]
      );

      if (checkResult.rows.length === 0) {
        client.release();
        return res.status(404).json({ error: 'Version not found' });
      }

      await client.query('BEGIN');

      // Get current max version
      const versionResult = await client.query(
        `SELECT MAX(version) as max_version FROM shared.objects
         WHERE database_id = $1 AND type = 'report' AND name = $2`,
        [databaseId, reportName]
      );
      const newVersion = versionResult.rows[0].max_version + 1;

      // Mark current version as not current
      await client.query(
        `UPDATE shared.objects
         SET is_current = false
         WHERE database_id = $1 AND type = 'report' AND name = $2 AND is_current = true`,
        [databaseId, reportName]
      );

      // Insert rollback as new version (copy of target version's definition)
      const targetDefinition = checkResult.rows[0].definition;
      const recordSource = extractRecordSource(targetDefinition);

      await client.query(
        `INSERT INTO shared.objects (database_id, type, name, definition, record_source, version, is_current, modified_by)
         VALUES ($1, 'report', $2, $3, $4, $5, true, $6)`,
        [databaseId, reportName, targetDefinition, recordSource, newVersion, req.userId]
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
   * POST /api/reports/:name/promote
   * Copy user's personalized version as the new current standard version
   */
  router.post('/:name/promote', async (req, res) => {
    const client = await pool.connect();
    try {
      const databaseId = req.databaseId;
      const userId = req.userId;

      if (!userId) {
        return res.status(400).json({ error: 'No user identity available' });
      }

      // Load the user's personalized current version
      const personalResult = await client.query(
        `SELECT definition, record_source FROM shared.objects
         WHERE database_id = $1 AND type = 'report' AND name = $2 AND owner = $3 AND is_current = true`,
        [databaseId, req.params.name, userId]
      );

      if (personalResult.rows.length === 0) {
        client.release();
        return res.status(404).json({ error: 'No personalized version found to promote' });
      }

      const { definition, record_source } = personalResult.rows[0];

      await client.query('BEGIN');

      // Get next version number
      const versionResult = await client.query(
        `SELECT COALESCE(MAX(version), 0) as max_version FROM shared.objects
         WHERE database_id = $1 AND type = 'report' AND name = $2`,
        [databaseId, req.params.name]
      );
      const newVersion = versionResult.rows[0].max_version + 1;

      // Mark current standard version as not current
      await client.query(
        `UPDATE shared.objects SET is_current = false
         WHERE database_id = $1 AND type = 'report' AND name = $2 AND owner = 'standard' AND is_current = true`,
        [databaseId, req.params.name]
      );

      // Insert copy as new standard version
      await client.query(
        `INSERT INTO shared.objects (database_id, type, name, definition, record_source, version, is_current, owner, modified_by)
         VALUES ($1, 'report', $2, $3, $4, $5, true, 'standard', $6)`,
        [databaseId, req.params.name, definition, record_source, newVersion, userId]
      );

      await client.query('COMMIT');

      console.log(`Promoted personalized report to standard: ${req.params.name} v${newVersion} (by: ${userId})`);
      res.json({ success: true, version: newVersion });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('Error promoting report:', err);
      logError(pool, 'POST /api/reports/:name/promote', 'Failed to promote report', err, { databaseId: req.databaseId });
      res.status(500).json({ error: 'Failed to promote report to standard' });
    } finally {
      client.release();
    }
  });

  /**
   * DELETE /api/reports/:name/personalization
   * Remove user's personalized version (reverts to standard)
   */
  router.delete('/:name/personalization', async (req, res) => {
    try {
      const databaseId = req.databaseId;
      const userId = req.userId;

      if (!userId) {
        return res.status(400).json({ error: 'No user identity available' });
      }

      const result = await pool.query(
        `UPDATE shared.objects
         SET is_current = false
         WHERE database_id = $1 AND type = 'report' AND name = $2 AND owner = $3 AND is_current = true
         RETURNING version`,
        [databaseId, req.params.name, userId]
      );

      if (result.rowCount === 0) {
        return res.status(404).json({ error: 'No personalized version found' });
      }

      console.log(`Reset personalization for report: ${req.params.name} (user: ${userId})`);
      res.json({ success: true, reset: true });
    } catch (err) {
      console.error('Error resetting report personalization:', err);
      logError(pool, 'DELETE /api/reports/:name/personalization', 'Failed to reset personalization', err, { databaseId: req.databaseId });
      res.status(500).json({ error: 'Failed to reset personalization' });
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
        `UPDATE shared.objects
         SET is_current = false
         WHERE database_id = $1 AND type = 'report' AND name = $2 AND is_current = true
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
