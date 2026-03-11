/**
 * Design Check routes — load/save design patterns, run LLM-based design review.
 * GET /api/design-check/patterns — Load design patterns
 * PUT /api/design-check/patterns — Save design patterns
 * POST /api/design-check/run — Run design checks against a database
 */

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { logError } = require('../lib/events');
const { getSchemaInfo } = require('./lint');

const PATTERNS_PATH = path.join(__dirname, '..', '..', 'settings', 'design-patterns.json');

module.exports = function(pool, secrets) {

  /**
   * GET /api/design-check/patterns
   */
  router.get('/patterns', (req, res) => {
    try {
      const raw = fs.readFileSync(PATTERNS_PATH, 'utf8');
      res.json(JSON.parse(raw));
    } catch (err) {
      console.error('Error loading design patterns:', err);
      res.status(500).json({ error: 'Failed to load design patterns' });
    }
  });

  /**
   * PUT /api/design-check/patterns
   */
  router.put('/patterns', (req, res) => {
    try {
      fs.writeFileSync(PATTERNS_PATH, JSON.stringify(req.body, null, 2), 'utf8');
      res.json({ success: true });
    } catch (err) {
      console.error('Error saving design patterns:', err);
      res.status(500).json({ error: 'Failed to save design patterns' });
    }
  });

  /**
   * POST /api/design-check/run
   * Run design checks against a database using LLM analysis.
   */
  router.post('/run', async (req, res) => {
    try {
      const { database_id, scope, run_id, pass_number } = req.body;
      if (!database_id) {
        return res.status(400).json({ error: 'database_id is required' });
      }

      // Load enabled checks
      let patterns;
      try {
        patterns = JSON.parse(fs.readFileSync(PATTERNS_PATH, 'utf8'));
      } catch (e) {
        return res.status(500).json({ error: 'Design patterns file not found' });
      }

      // Build list of enabled checks
      const enabledChecks = [];
      for (const [category, checks] of Object.entries(patterns.checks || {})) {
        for (const [checkId, check] of Object.entries(checks)) {
          if (check.enabled) {
            enabledChecks.push({ id: `${category}.${checkId}`, category, description: check.description });
          }
        }
      }

      if (enabledChecks.length === 0) {
        return res.json({ recommendations: [], message: 'No design checks enabled' });
      }

      // Look up schema
      const dbResult = await pool.query(
        'SELECT schema_name FROM shared.databases WHERE database_id = $1',
        [database_id]
      );
      if (dbResult.rows.length === 0) {
        return res.status(404).json({ error: 'Database not found' });
      }
      const schemaName = dbResult.rows[0].schema_name;

      // Load context
      const schemaInfo = await getSchemaInfo(pool, schemaName);

      // Build schema summary
      const schemaSummary = [];
      for (const [tableName, columns] of schemaInfo) {
        schemaSummary.push(`${tableName}: ${columns.join(', ')}`);
      }

      // Load forms/reports (names + record sources)
      const [formsRes, reportsRes] = await Promise.all([
        pool.query(`SELECT name, record_source FROM shared.forms WHERE database_id = $1 AND is_current = true AND owner = 'standard'`, [database_id]),
        pool.query(`SELECT name, record_source FROM shared.reports WHERE database_id = $1 AND is_current = true AND owner = 'standard'`, [database_id])
      ]);

      // Load import log summary if run_id provided
      let importSummary = '';
      if (run_id) {
        const logRes = await pool.query(`
          SELECT severity, category, COUNT(*) AS cnt
          FROM shared.import_log
          WHERE run_id = $1 AND severity IN ('warning', 'error')
          GROUP BY severity, category
          ORDER BY severity, category
        `, [run_id]);
        if (logRes.rows.length > 0) {
          importSummary = '\n\nImport issues from this run:\n' +
            logRes.rows.map(r => `- ${r.severity}: ${r.category} (${r.cnt})`).join('\n');
        }
      }

      // Build prompt
      const checksDescription = enabledChecks.map(c => `- ${c.id}: ${c.description}`).join('\n');

      const contextText = [
        `Database: ${database_id} (schema: ${schemaName})`,
        `\nTables and columns:\n${schemaSummary.slice(0, 50).join('\n')}`,
        schemaSummary.length > 50 ? `\n... and ${schemaSummary.length - 50} more tables` : '',
        `\nForms (${formsRes.rows.length}): ${formsRes.rows.map(f => `${f.name} → ${f.record_source || 'none'}`).join(', ')}`,
        `\nReports (${reportsRes.rows.length}): ${reportsRes.rows.map(r => `${r.name} → ${r.record_source || 'none'}`).join(', ')}`,
        importSummary
      ].join('');

      // Scope filtering
      let scopeNote = '';
      if (scope && scope !== 'full') {
        scopeNote = `\n\nScope: Focus only on ${scope}.`;
      }

      const apiKey = secrets?.anthropic?.api_key || process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        return res.json({
          recommendations: [],
          message: 'No API key configured — design checks require an LLM'
        });
      }

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 4096,
          system: `You are reviewing a database application that was migrated from MS Access to PostgreSQL. Evaluate it against the enabled design checks. For each finding, respond with a JSON array of objects, each with: check_id, category, object_type, object_name, finding, recommendation, effort (low/medium/high). Only include findings where there is a clear issue. Respond ONLY with the JSON array, no other text.`,
          messages: [{
            role: 'user',
            content: `Enabled design checks:\n${checksDescription}\n\nDatabase context:\n${contextText}${scopeNote}\n\nAnalyze this database against the enabled checks and return findings as a JSON array.`
          }]
        })
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Anthropic API error: ${response.status} ${errText}`);
      }

      const data = await response.json();
      const text = data.content?.[0]?.text || '[]';

      // Parse LLM response
      let recommendations = [];
      try {
        // Extract JSON array from response (may have markdown code block wrapper)
        const jsonMatch = text.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          recommendations = JSON.parse(jsonMatch[0]);
        }
      } catch (parseErr) {
        console.error('Error parsing design check response:', parseErr.message);
        recommendations = [{ check_id: 'parse-error', finding: 'Could not parse LLM response', recommendation: text }];
      }

      // Log recommendations to import_log if run_id provided
      if (run_id) {
        for (const rec of recommendations) {
          try {
            await pool.query(`
              INSERT INTO shared.import_log
                (run_id, pass_number, target_database_id, source_object_name, source_object_type,
                 status, severity, category, message, suggestion, action)
              VALUES ($1, $2, $3, $4, $5, 'issue', 'info', $6, $7, $8, 'recommendation')
            `, [run_id, pass_number || 4, database_id,
                rec.object_name || '_design', rec.object_type || 'database',
                rec.check_id || 'design-check', rec.finding || '', rec.recommendation || '']);
          } catch (e) {
            // ignore logging errors
          }
        }
      }

      res.json({ recommendations });
    } catch (err) {
      console.error('Error running design check:', err);
      logError(pool, 'POST /api/design-check/run', 'Failed to run design check', err);
      res.status(500).json({ error: err.message || 'Failed to run design check' });
    }
  });

  return router;
};
