/**
 * Andon Cord Routes — intent graph as fixed point.
 * Freeze tests from intents, evaluate coverage + heterogeneity, pull the cord.
 */

const express = require('express');
const { logEvent } = require('../lib/events');
const { generateLockedTests } = require('../lib/test-harness/generate-locked-tests');
const { runLockedTests, runLockedTestsForObject } = require('../lib/test-harness/locked-test-runner');

function createRouter(pool) {
  const router = express.Router();

  /**
   * GET /api/intents/:database_id/completeness
   * Per-type intent coverage — gate for declaring a freeze point.
   */
  router.get('/intents/:database_id/completeness', async (req, res) => {
    try {
      const databaseId = req.params.database_id;

      // Get schema name
      const dbResult = await pool.query(
        'SELECT schema_name FROM shared.databases WHERE database_id = $1', [databaseId]
      );
      if (dbResult.rows.length === 0) {
        return res.status(404).json({ error: 'Database not found' });
      }
      const schemaName = dbResult.rows[0].schema_name;

      // Count objects by type
      const objectsResult = await pool.query(`
        SELECT type, COUNT(DISTINCT name) as count
        FROM shared.objects
        WHERE database_id = $1 AND is_current = true AND type IN ('form', 'report', 'module', 'macro')
        GROUP BY type
      `, [databaseId]);

      const objectCounts = {};
      for (const row of objectsResult.rows) {
        objectCounts[row.type] = parseInt(row.count);
      }

      // Count tables from information_schema
      const tableResult = await pool.query(
        `SELECT COUNT(*) as count FROM information_schema.tables
         WHERE table_schema = $1 AND table_type = 'BASE TABLE'`,
        [schemaName]
      );
      objectCounts.table = parseInt(tableResult.rows[0].count);

      // Count intents by object type + intent type
      const intentsResult = await pool.query(`
        SELECT o.type as object_type, i.intent_type, COUNT(DISTINCT o.name) as object_count
        FROM shared.intents i
        JOIN shared.objects o ON i.object_id = o.id
        WHERE o.database_id = $1 AND o.is_current = true
        GROUP BY o.type, i.intent_type
      `, [databaseId]);

      const intentCoverage = {};
      for (const row of intentsResult.rows) {
        if (!intentCoverage[row.object_type]) intentCoverage[row.object_type] = {};
        intentCoverage[row.object_type][row.intent_type] = parseInt(row.object_count);
      }

      // Required intents per object type
      const required = {
        form: ['business', 'structure'],
        report: ['business', 'structure'],
        module: ['gesture'],
        macro: ['gesture'],
        table: ['schema']
      };

      const coverage = {};
      let allComplete = true;

      for (const [objType, requiredTypes] of Object.entries(required)) {
        const total = objectCounts[objType] || 0;
        if (total === 0) {
          coverage[objType] = { total: 0, required_types: requiredTypes, status: 'empty' };
          continue;
        }

        const typeStatus = {};
        for (const intentType of requiredTypes) {
          const covered = intentCoverage[objType]?.[intentType] || 0;
          typeStatus[intentType] = { covered, total, complete: covered >= total };
          if (covered < total) allComplete = false;
        }
        coverage[objType] = { total, required_types: requiredTypes, intents: typeStatus };
      }

      res.json({
        database_id: databaseId,
        all_complete: allComplete,
        coverage
      });
    } catch (err) {
      console.error('Error checking completeness:', err);
      res.status(500).json({ error: 'Failed to check completeness' });
    }
  });

  /**
   * GET /api/andon/:database_id/status
   * Cord state: clear, pulled, no-freeze.
   */
  router.get('/:database_id/status', async (req, res) => {
    try {
      const databaseId = req.params.database_id;

      // Check for active freeze point
      const freezeResult = await pool.query(
        `SELECT id, frozen_at, snapshot FROM shared.freeze_points
         WHERE database_id = $1 AND status = 'active'
         ORDER BY frozen_at DESC LIMIT 1`,
        [databaseId]
      );

      if (freezeResult.rows.length === 0) {
        return res.json({ status: 'no-freeze', database_id: databaseId });
      }

      const freeze = freezeResult.rows[0];

      // Check for recent andon pulls
      const pullResult = await pool.query(
        `SELECT id, signal_type, coverage_value, heterogeneity_value, created_at
         FROM shared.andon_pulls
         WHERE database_id = $1
         ORDER BY created_at DESC LIMIT 1`,
        [databaseId]
      );

      // Check if any locked tests are invalidated
      const invalidatedResult = await pool.query(
        `SELECT COUNT(*) as count FROM shared.locked_tests
         WHERE database_id = $1 AND invalidated_at IS NOT NULL
           AND frozen_at >= $2`,
        [databaseId, freeze.frozen_at]
      );
      const hasInvalidated = parseInt(invalidatedResult.rows[0].count) > 0;

      const lastPull = pullResult.rows[0] || null;
      const isPulled = hasInvalidated || (lastPull && lastPull.created_at > freeze.frozen_at);

      res.json({
        status: isPulled ? 'pulled' : 'clear',
        database_id: databaseId,
        freeze_point: {
          id: freeze.id,
          frozen_at: freeze.frozen_at,
          snapshot: freeze.snapshot
        },
        last_pull: lastPull,
        has_invalidated_tests: hasInvalidated
      });
    } catch (err) {
      console.error('Error getting andon status:', err);
      res.status(500).json({ error: 'Failed to get status' });
    }
  });

  /**
   * POST /api/andon/:database_id/freeze
   * Declare a freeze point — generate and lock all test assertions.
   */
  router.post('/:database_id/freeze', async (req, res) => {
    try {
      const databaseId = req.params.database_id;

      // Generate all test assertions
      const { objects } = await generateLockedTests(pool, databaseId);

      if (objects.length === 0) {
        return res.status(400).json({ error: 'No intents found — cannot freeze' });
      }

      // Supersede previous active freeze points
      await pool.query(
        `UPDATE shared.freeze_points SET status = 'superseded'
         WHERE database_id = $1 AND status = 'active'`,
        [databaseId]
      );

      // Invalidate all existing locked tests for this database
      await pool.query(
        `UPDATE shared.locked_tests SET invalidated_at = NOW()
         WHERE database_id = $1 AND invalidated_at IS NULL`,
        [databaseId]
      );

      // Store locked tests
      let totalAssertions = 0;
      const frozenAt = new Date();

      for (const obj of objects) {
        await pool.query(
          `INSERT INTO shared.locked_tests
            (database_id, object_type, object_name, intent_type, assertions, assertion_count, frozen_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [databaseId, obj.type, obj.name, obj.intent_type, JSON.stringify(obj.assertions), obj.assertions.length, frozenAt]
        );
        totalAssertions += obj.assertions.length;
      }

      // Create freeze point record
      const snapshot = {
        objects: objects.length,
        assertions: totalAssertions,
        by_type: {}
      };
      for (const obj of objects) {
        const key = `${obj.type}:${obj.intent_type}`;
        snapshot.by_type[key] = (snapshot.by_type[key] || 0) + obj.assertions.length;
      }

      await pool.query(
        `INSERT INTO shared.freeze_points (database_id, frozen_at, status, snapshot)
         VALUES ($1, $2, 'active', $3)`,
        [databaseId, frozenAt, JSON.stringify(snapshot)]
      );

      await logEvent(pool, 'freeze', `POST /api/andon/${databaseId}/freeze`, 'Freeze point declared', {
        databaseId,
        details: { objects: objects.length, assertions: totalAssertions }
      });

      res.json({
        frozen_at: frozenAt,
        objects: objects.length,
        total_assertions: totalAssertions,
        snapshot
      });
    } catch (err) {
      console.error('Error freezing:', err);
      res.status(500).json({ error: 'Failed to freeze' });
    }
  });

  /**
   * POST /api/andon/:database_id/evaluate
   * Run all locked tests, compute coverage + heterogeneity.
   * If threshold breached → insert andon_pulls record.
   */
  router.post('/:database_id/evaluate', async (req, res) => {
    try {
      const databaseId = req.params.database_id;
      const coverageThreshold = req.body.coverage_threshold || 0.90;
      const heterogeneityThreshold = req.body.heterogeneity_threshold || 0.75;

      const results = await runLockedTests(pool, databaseId);

      if (results.totalAssertions === 0) {
        return res.json({
          status: 'no-tests',
          message: 'No active locked tests found. Run freeze first.'
        });
      }

      // Check thresholds
      const cordPulled = results.coverage < coverageThreshold || results.heterogeneity > heterogeneityThreshold;

      if (cordPulled) {
        // Determine signal type
        let signalType = 'coverage';
        if (results.coverage < coverageThreshold && results.heterogeneity > heterogeneityThreshold) {
          signalType = 'both';
        } else if (results.heterogeneity > heterogeneityThreshold) {
          signalType = 'heterogeneity';
        }

        // Build affected objects list
        const affectedObjects = results.perObject
          .filter(o => o.failed > 0)
          .map(o => ({
            type: o.object_type,
            name: o.object_name,
            intent_type: o.intent_type,
            failed: o.failed,
            total: o.total
          }));

        await pool.query(
          `INSERT INTO shared.andon_pulls
            (database_id, signal_type, coverage_value, heterogeneity_value, thresholds, affected_objects)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            databaseId, signalType,
            results.coverage, results.heterogeneity,
            JSON.stringify({ coverage: coverageThreshold, heterogeneity: heterogeneityThreshold }),
            JSON.stringify(affectedObjects)
          ]
        );

        await logEvent(pool, 'andon-pull', `POST /api/andon/${databaseId}/evaluate`, 'Andon cord pulled', {
          databaseId,
          details: {
            signal_type: signalType,
            coverage: results.coverage,
            heterogeneity: results.heterogeneity,
            affected_count: affectedObjects.length
          }
        });
      }

      res.json({
        cord_status: cordPulled ? 'pulled' : 'clear',
        coverage: results.coverage,
        heterogeneity: results.heterogeneity,
        thresholds: { coverage: coverageThreshold, heterogeneity: heterogeneityThreshold },
        total_assertions: results.totalAssertions,
        passed: results.passedAssertions,
        failed: results.failedAssertions,
        failure_categories: results.failureCategories,
        per_object: results.perObject
      });
    } catch (err) {
      console.error('Error evaluating:', err);
      res.status(500).json({ error: 'Failed to evaluate' });
    }
  });

  /**
   * GET /api/andon/:database_id/history
   * Past andon pulls.
   */
  router.get('/:database_id/history', async (req, res) => {
    try {
      const databaseId = req.params.database_id;
      const limit = Math.min(parseInt(req.query.limit) || 20, 100);
      const offset = parseInt(req.query.offset) || 0;

      const result = await pool.query(
        `SELECT id, signal_type, coverage_value, heterogeneity_value, thresholds, affected_objects, created_at
         FROM shared.andon_pulls
         WHERE database_id = $1
         ORDER BY created_at DESC
         LIMIT $2 OFFSET $3`,
        [databaseId, limit, offset]
      );

      const countResult = await pool.query(
        'SELECT COUNT(*) FROM shared.andon_pulls WHERE database_id = $1',
        [databaseId]
      );

      res.json({
        pulls: result.rows,
        total: parseInt(countResult.rows[0].count),
        limit,
        offset
      });
    } catch (err) {
      console.error('Error fetching history:', err);
      res.status(500).json({ error: 'Failed to fetch history' });
    }
  });

  /**
   * POST /api/andon/:database_id/check-schema
   * Run locked tests for ALL tables in the database (schema drift detection).
   */
  router.post('/:database_id/check-schema', async (req, res) => {
    try {
      const databaseId = req.params.database_id;

      // Get schema name
      const dbResult = await pool.query(
        'SELECT schema_name FROM shared.databases WHERE database_id = $1', [databaseId]
      );
      if (dbResult.rows.length === 0) {
        return res.status(404).json({ error: 'Database not found' });
      }
      const schemaName = dbResult.rows[0].schema_name;

      // Find all tables with locked tests
      const tablesResult = await pool.query(
        `SELECT DISTINCT object_name FROM shared.locked_tests
         WHERE database_id = $1 AND object_type = 'table' AND invalidated_at IS NULL
         ORDER BY object_name`,
        [databaseId]
      );

      if (tablesResult.rows.length === 0) {
        return res.json({ status: 'no-tests', tables: [], total: 0, passed: 0, failed: 0 });
      }

      const tables = [];
      let totalPassed = 0;
      let totalFailed = 0;

      for (const row of tablesResult.rows) {
        const result = await runLockedTestsForObject(pool, databaseId, 'table', row.object_name);
        if (result) {
          tables.push({
            name: row.object_name,
            passed: result.passed,
            failed: result.failed,
            total: result.total,
            drifted: result.drifted
          });
          totalPassed += result.passed;
          totalFailed += result.failed;
        }
      }

      const driftedTables = tables.filter(t => t.drifted);
      if (driftedTables.length > 0) {
        await logEvent(pool, 'drift', `POST /api/andon/${databaseId}/check-schema`,
          `Schema drift detected in ${driftedTables.length} table(s): ${driftedTables.map(t => t.name).join(', ')}`, {
            databaseId,
            propagation: { drift: { passed: totalPassed, failed: totalFailed, total: totalPassed + totalFailed, tables: driftedTables.length } }
          });
      }

      res.json({
        status: driftedTables.length > 0 ? 'drifted' : 'clean',
        tables,
        total: totalPassed + totalFailed,
        passed: totalPassed,
        failed: totalFailed,
        drifted_count: driftedTables.length
      });
    } catch (err) {
      console.error('Error checking schema drift:', err);
      res.status(500).json({ error: 'Failed to check schema drift' });
    }
  });

  return router;
}

module.exports = createRouter;
