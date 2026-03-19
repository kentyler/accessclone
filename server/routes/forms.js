/**
 * Form routes with append-only versioning
 * Handles reading/writing forms from shared.forms table
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
   * GET /api/forms
   * List all current forms for current database
   */
  router.get('/', async (req, res) => {
    try {
      const databaseId = req.databaseId;

      const result = await pool.query(
        `SELECT name, record_source, description, version, created_at
         FROM shared.forms
         WHERE database_id = $1 AND is_current = true AND owner = 'standard'
         ORDER BY name`,
        [databaseId]
      );

      const forms = result.rows.map(r => r.name);
      res.json({ forms, details: result.rows });
    } catch (err) {
      console.error('Error listing forms:', err);
      logError(pool, 'GET /api/forms', 'Failed to list forms', err, { databaseId: req.databaseId });
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
      const userId = req.userId;

      const result = await pool.query(
        `SELECT definition, version, owner, intents FROM shared.forms
         WHERE database_id = $1 AND name = $2 AND is_current = true
           AND owner IN ($3, 'standard')
         ORDER BY CASE WHEN owner = 'standard' THEN 1 ELSE 0 END
         LIMIT 1`,
        [databaseId, req.params.name, userId || 'standard']
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Form not found' });
      }

      const row = result.rows[0];
      const personalized = row.owner !== 'standard';
      const response = { ...row.definition, _personalized: personalized };
      if (row.intents) response._intents = row.intents;
      res.json(response);
    } catch (err) {
      console.error('Error reading form:', err);
      logError(pool, 'GET /api/forms/:name', 'Failed to read form', err, { databaseId: req.databaseId });
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
        `SELECT version, is_current, created_at, owner, modified_by
         FROM shared.forms
         WHERE database_id = $1 AND name = $2
         ORDER BY version DESC`,
        [databaseId, req.params.name]
      );

      res.json({ versions: result.rows });
    } catch (err) {
      console.error('Error listing form versions:', err);
      logError(pool, 'GET /api/forms/:name/versions', 'Failed to list form versions', err, { databaseId: req.databaseId });
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

      res.json(result.rows[0].definition);
    } catch (err) {
      console.error('Error reading form version:', err);
      logError(pool, 'GET /api/forms/:name/versions/:version', 'Failed to read form version', err, { databaseId: req.databaseId });
      res.status(500).json({ error: 'Failed to read form version' });
    }
  });

  /**
   * PUT /api/forms/:name
   * Save a form (creates new version, marks old as not current)
   */
  router.put('/:name', async (req, res) => {
    const client = await pool.connect();
    try {
      const databaseId = req.databaseId;
      const formName = req.params.name;
      const userId = req.userId;
      const isStandard = req.query.standard === 'true' || req.query.source === 'import';

      const content = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;

      const recordSource = extractRecordSource(content);

      // Determine owner for this save
      let owner = 'standard';
      if (!isStandard && userId) {
        // Check if a personalized version already exists for this user
        const personalCheck = await client.query(
          `SELECT 1 FROM shared.forms
           WHERE database_id = $1 AND name = $2 AND owner = $3 AND is_current = true`,
          [databaseId, formName, userId]
        );
        // If personalized version exists, or if the loaded version was personalized, keep it personalized
        if (personalCheck.rows.length > 0 || content._personalized) {
          owner = userId;
        }
      }

      // Clean internal flags from definition before saving
      delete content._personalized;

      await client.query('BEGIN');

      // Get current max version for this form (across all owners)
      const versionResult = await client.query(
        `SELECT COALESCE(MAX(version), 0) as max_version
         FROM shared.forms
         WHERE database_id = $1 AND name = $2`,
        [databaseId, formName]
      );
      const newVersion = versionResult.rows[0].max_version + 1;

      // Mark existing current version for same owner as not current
      await client.query(
        `UPDATE shared.forms
         SET is_current = false
         WHERE database_id = $1 AND name = $2 AND owner = $3 AND is_current = true`,
        [databaseId, formName, owner]
      );

      // Insert new version as current
      await client.query(
        `INSERT INTO shared.forms (database_id, name, definition, record_source, version, is_current, owner, modified_by)
         VALUES ($1, $2, $3, $4, $5, true, $6, $7)`,
        [databaseId, formName, content, recordSource, newVersion, owner, userId]
      );

      await client.query('COMMIT');

      // Populate graph from form (outside transaction — non-critical side effect)
      try {
        const { populateFromForm } = require('../graph/populate');
        await populateFromForm(pool, formName, content, databaseId);
      } catch (graphErr) {
        console.error('Error populating graph from form:', graphErr.message);
        logEvent(pool, 'warning', 'PUT /api/forms/:name', 'Graph population failed after form save', { databaseId, details: { error: graphErr.message } });
      }

      // Populate control-column mapping (outside transaction — non-critical side effect)
      try {
        const { populateControlColumnMap } = require('../lib/control-mapping');
        await populateControlColumnMap(pool, databaseId, formName, content);
      } catch (mapErr) {
        console.error('Error populating control-column map for form:', mapErr.message);
        logEvent(pool, 'warning', 'PUT /api/forms/:name', 'Control-column map population failed', { databaseId, details: { error: mapErr.message } });
      }

      // Populate control-event mapping (outside transaction — non-critical side effect)
      try {
        const { populateControlEventMap } = require('../lib/event-mapping');
        await populateControlEventMap(pool, databaseId, formName, content, 'form');
      } catch (evtErr) {
        console.error('Error populating control-event map for form:', evtErr.message);
        logEvent(pool, 'warning', 'PUT /api/forms/:name', 'Control-event map population failed', { databaseId, details: { error: evtErr.message } });
      }

      // Post-import lint: detect issues for imported forms
      if (req.query.source === 'import' && req.query.import_log_id) {
        try {
          const { validateForm, validateFormCrossObject, getSchemaInfo } = require('./lint');
          const formDef = content;
          const issues = validateForm(formDef);
          // Cross-object validation needs schema info
          const dbResult = await pool.query(
            'SELECT schema_name FROM shared.databases WHERE database_id = $1', [databaseId]
          );
          if (dbResult.rows.length > 0) {
            const schemaInfo = await getSchemaInfo(pool, dbResult.rows[0].schema_name);
            issues.push(...validateFormCrossObject(formDef, schemaInfo));
          }
          for (const issue of issues) {
            await pool.query(`
              INSERT INTO shared.import_log
                (target_database_id, source_object_name, source_object_type, status, severity, category, message, suggestion)
              VALUES ($1, $2, 'form', 'issue', $3, 'lint', $4, $5)
            `, [databaseId, formName, issue.severity, issue.message, issue.suggestion || null]);
          }
        } catch (lintErr) {
          console.error('Error running post-import lint for form:', lintErr.message);
        }

        // Create PostgreSQL functions for domain-function expressions (DLookUp, DCount, etc.)
        try {
          const { hasDomainFunctions, processDefinitionExpressions } = require('../lib/expression-converter');
          const formDef = content;
          const dbResult2 = await pool.query(
            'SELECT schema_name FROM shared.databases WHERE database_id = $1', [databaseId]
          );
          if (dbResult2.rows.length > 0) {
            const schemaName = dbResult2.rows[0].schema_name;
            const { definition: updatedDef, functions, warnings } = await processDefinitionExpressions(
              pool, formDef, formName, schemaName, 'form'
            );
            if (functions.length > 0) {
              // Re-save the definition with computed-function annotations
              await pool.query(
                `UPDATE shared.forms SET definition = $1
                 WHERE database_id = $2 AND name = $3 AND is_current = true AND owner = 'standard'`,
                [updatedDef, databaseId, formName]
              );
              console.log(`Created ${functions.length} computed functions for form ${formName}`);
            }
            for (const w of warnings) {
              console.warn(`Form ${formName} expression warning: ${w}`);
            }
          }
        } catch (exprErr) {
          console.error('Error processing domain expressions for form:', exprErr.message);
          logEvent(pool, 'warning', 'PUT /api/forms/:name', 'Domain expression processing failed', { databaseId, details: { error: exprErr.message } });
        }
      }

      console.log(`Saved form: ${formName} v${newVersion} (database: ${databaseId})`);
      res.json({ success: true, name: formName, version: newVersion, database_id: databaseId });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('Error saving form:', err);
      logError(pool, 'PUT /api/forms/:name', 'Failed to save form', err, { databaseId: req.databaseId });
      res.status(500).json({ error: 'Failed to save form' });
    } finally {
      client.release();
    }
  });

  /**
   * POST /api/forms/:name/rollback/:version
   * Rollback to a specific version (makes that version current again)
   */
  router.post('/:name/rollback/:version', async (req, res) => {
    const client = await pool.connect();
    try {
      const databaseId = req.databaseId;
      const formName = req.params.name;
      const targetVersion = parseInt(req.params.version);

      // Check target version exists (safe to read outside transaction)
      const checkResult = await client.query(
        `SELECT definition FROM shared.forms
         WHERE database_id = $1 AND name = $2 AND version = $3`,
        [databaseId, formName, targetVersion]
      );

      if (checkResult.rows.length === 0) {
        client.release();
        return res.status(404).json({ error: 'Version not found' });
      }

      await client.query('BEGIN');

      // Get current max version
      const versionResult = await client.query(
        `SELECT MAX(version) as max_version FROM shared.forms
         WHERE database_id = $1 AND name = $2`,
        [databaseId, formName]
      );
      const newVersion = versionResult.rows[0].max_version + 1;

      // Mark current version as not current
      await client.query(
        `UPDATE shared.forms
         SET is_current = false
         WHERE database_id = $1 AND name = $2 AND is_current = true`,
        [databaseId, formName]
      );

      // Insert rollback as new version (copy of target version's definition)
      const targetDefinition = checkResult.rows[0].definition;
      const recordSource = extractRecordSource(targetDefinition);

      await client.query(
        `INSERT INTO shared.forms (database_id, name, definition, record_source, version, is_current, modified_by)
         VALUES ($1, $2, $3, $4, $5, true, $6)`,
        [databaseId, formName, targetDefinition, recordSource, newVersion, req.userId]
      );

      await client.query('COMMIT');

      console.log(`Rolled back form: ${formName} to v${targetVersion} (now v${newVersion})`);
      res.json({
        success: true,
        name: formName,
        rolled_back_to: targetVersion,
        new_version: newVersion
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('Error rolling back form:', err);
      logError(pool, 'POST /api/forms/:name/rollback/:version', 'Failed to rollback form', err, { databaseId: req.databaseId });
      res.status(500).json({ error: 'Failed to rollback form' });
    } finally {
      client.release();
    }
  });

  /**
   * POST /api/forms/:name/promote
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
        `SELECT definition, record_source FROM shared.forms
         WHERE database_id = $1 AND name = $2 AND owner = $3 AND is_current = true`,
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
        `SELECT COALESCE(MAX(version), 0) as max_version FROM shared.forms
         WHERE database_id = $1 AND name = $2`,
        [databaseId, req.params.name]
      );
      const newVersion = versionResult.rows[0].max_version + 1;

      // Mark current standard version as not current
      await client.query(
        `UPDATE shared.forms SET is_current = false
         WHERE database_id = $1 AND name = $2 AND owner = 'standard' AND is_current = true`,
        [databaseId, req.params.name]
      );

      // Insert copy as new standard version
      await client.query(
        `INSERT INTO shared.forms (database_id, name, definition, record_source, version, is_current, owner, modified_by)
         VALUES ($1, $2, $3, $4, $5, true, 'standard', $6)`,
        [databaseId, req.params.name, definition, record_source, newVersion, userId]
      );

      await client.query('COMMIT');

      console.log(`Promoted personalized form to standard: ${req.params.name} v${newVersion} (by: ${userId})`);
      res.json({ success: true, version: newVersion });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('Error promoting form:', err);
      logError(pool, 'POST /api/forms/:name/promote', 'Failed to promote form', err, { databaseId: req.databaseId });
      res.status(500).json({ error: 'Failed to promote form to standard' });
    } finally {
      client.release();
    }
  });

  /**
   * DELETE /api/forms/:name/personalization
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
        `UPDATE shared.forms
         SET is_current = false
         WHERE database_id = $1 AND name = $2 AND owner = $3 AND is_current = true
         RETURNING version`,
        [databaseId, req.params.name, userId]
      );

      if (result.rowCount === 0) {
        return res.status(404).json({ error: 'No personalized version found' });
      }

      console.log(`Reset personalization for form: ${req.params.name} (user: ${userId})`);
      res.json({ success: true, reset: true });
    } catch (err) {
      console.error('Error resetting form personalization:', err);
      logError(pool, 'DELETE /api/forms/:name/personalization', 'Failed to reset personalization', err, { databaseId: req.databaseId });
      res.status(500).json({ error: 'Failed to reset personalization' });
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
      logError(pool, 'DELETE /api/forms/:name', 'Failed to delete form', err, { databaseId: req.databaseId });
      res.status(500).json({ error: 'Failed to delete form' });
    }
  });

  return router;
}

module.exports = createRouter;
module.exports.extractRecordSource = extractRecordSource;
