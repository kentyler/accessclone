/**
 * Pipeline evaluation routes — reconnaissance, intent generation, and evaluation
 * for the self-healing import pipeline.
 *
 * Phase 1: Forms only.
 */

const { logError, logEvent } = require('../../lib/events');
const { summarizeDefinition } = require('../chat/context');
const {
  runFormDeterministicChecks,
  checkArtifactInvariants,
  runSemanticEvaluation,
  classifyFailure
} = require('../../lib/pipeline-evaluator');
const { getSchemaInfo } = require('../lint/cross-object');

module.exports = function(router, pool, secrets) {

  /**
   * POST /reconnaissance
   * Reads source_discovery + all objects, calls LLM to produce app_profile,
   * creates pipeline_tasks rows for all objects.
   */
  router.post('/reconnaissance', async (req, res) => {
    const { database_id, run_id } = req.body;
    if (!database_id || !run_id) {
      return res.status(400).json({ error: 'database_id and run_id required' });
    }

    try {
      // Load source discovery
      const discoveryRes = await pool.query(
        'SELECT discovery FROM shared.source_discovery WHERE database_id = $1',
        [database_id]
      );
      const discovery = discoveryRes.rows[0]?.discovery || {};

      // Load all current objects
      const objectsRes = await pool.query(
        `SELECT name, type, record_source, definition
         FROM shared.objects
         WHERE database_id = $1 AND is_current = true AND owner = 'standard'
         ORDER BY type, name`,
        [database_id]
      );

      // Build compact inventory for the LLM
      const inventory = buildInventorySummary(discovery, objectsRes.rows);

      // Get API key
      const apiKey = secrets?.anthropic?.api_key || process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        return res.status(500).json({ error: 'No Anthropic API key configured' });
      }

      // One LLM call → app profile
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 2048,
          system: `You are analyzing an Access database that has been imported into a web application platform. Based on the inventory of tables, queries, forms, reports, modules, and macros, write a concise application profile (500-1000 words) covering:
1. Business domain and purpose
2. Key entities and relationships
3. Form patterns (data entry, lookup, navigation, dialog)
4. Complexity signals (VBA modules, macros, cross-references)
5. Potential conversion challenges

Be specific about what you observe, not generic advice.`,
          messages: [{ role: 'user', content: inventory }]
        })
      });

      if (!response.ok) {
        throw new Error(`Anthropic API error: ${response.status}`);
      }

      const data = await response.json();
      const appProfile = data.content?.[0]?.text || 'Profile generation failed';

      // Store on import_runs
      await pool.query(
        'UPDATE shared.import_runs SET app_profile = $1 WHERE id = $2',
        [appProfile, run_id]
      );

      // Create pipeline_tasks for all objects
      // Load step IDs we need
      const stepsRes = await pool.query(
        `SELECT id, name FROM shared.pipeline_steps WHERE name IN ('forms', 'reports', 'modules', 'queries', 'macros')`
      );
      const stepMap = {};
      for (const s of stepsRes.rows) stepMap[s.name] = s.id;

      // Map object types to step names
      const typeToStep = { form: 'forms', report: 'reports', module: 'modules', macro: 'macros' };

      let taskCount = 0;
      for (const obj of objectsRes.rows) {
        const stepName = typeToStep[obj.type];
        const stepId = stepMap[stepName];
        if (!stepId) continue;

        await pool.query(`
          INSERT INTO shared.pipeline_tasks (run_id, step_id, object_name, object_type, status)
          VALUES ($1, $2, $3, $4, 'pending')
          ON CONFLICT DO NOTHING
        `, [run_id, stepId, obj.name, obj.type]);
        taskCount++;
      }

      // Also create tasks for queries from source_discovery
      const queryNames = discovery.queries?.map(q => q.name || q) || [];
      const queryStepId = stepMap.queries;
      if (queryStepId) {
        for (const qName of queryNames) {
          await pool.query(`
            INSERT INTO shared.pipeline_tasks (run_id, step_id, object_name, object_type, status)
            VALUES ($1, $2, $3, 'query', 'pending')
            ON CONFLICT DO NOTHING
          `, [run_id, queryStepId, qName]);
          taskCount++;
        }
      }

      await logEvent(pool, 'info', 'POST /api/database-import/reconnaissance',
        `App profile generated, ${taskCount} pipeline tasks created`, { databaseId: database_id });

      res.json({
        app_profile: appProfile,
        tasks_created: taskCount,
        object_count: objectsRes.rows.length
      });
    } catch (err) {
      logError(pool, 'POST /api/database-import/reconnaissance', 'Reconnaissance failed', err, { databaseId: database_id });
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /capture-source-artifacts
   * Bulk-updates pipeline_tasks.source_artifact for objects in a run.
   */
  router.post('/capture-source-artifacts', async (req, res) => {
    const { run_id, database_id, artifacts } = req.body;
    if (!run_id || !database_id || !Array.isArray(artifacts)) {
      return res.status(400).json({ error: 'run_id, database_id, and artifacts[] required' });
    }

    try {
      let updated = 0;
      for (const { name, type, source_text } of artifacts) {
        if (!name || !type || !source_text) continue;
        const result = await pool.query(`
          UPDATE shared.pipeline_tasks
          SET source_artifact = $1, updated_at = NOW()
          WHERE run_id = $2 AND object_name = $3 AND object_type = $4
        `, [source_text, run_id, name, type]);
        if (result.rowCount > 0) updated++;
      }

      // For modules/macros, pull from shared.objects if not provided
      const missingRes = await pool.query(`
        SELECT pt.id, pt.object_name, pt.object_type
        FROM shared.pipeline_tasks pt
        WHERE pt.run_id = $1 AND pt.source_artifact IS NULL
          AND pt.object_type IN ('module', 'macro')
      `, [run_id]);

      for (const task of missingRes.rows) {
        const field = task.object_type === 'module' ? 'vba_source' : 'macro_xml';
        const objRes = await pool.query(`
          SELECT definition->>'${field}' AS src
          FROM shared.objects
          WHERE database_id = $1 AND type = $2 AND name = $3 AND is_current = true
        `, [database_id, task.object_type, task.object_name]);
        if (objRes.rows[0]?.src) {
          await pool.query(
            'UPDATE shared.pipeline_tasks SET source_artifact = $1, updated_at = NOW() WHERE id = $2',
            [objRes.rows[0].src, task.id]
          );
          updated++;
        }
      }

      res.json({ updated });
    } catch (err) {
      logError(pool, 'POST /api/database-import/capture-source-artifacts', 'Artifact capture failed', err, { databaseId: database_id });
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /generate-intents
   * Per-object LLM call to generate testable intents.
   * Phase 1: forms only.
   */
  router.post('/generate-intents', async (req, res) => {
    const { run_id, database_id, object_types } = req.body;
    if (!run_id || !database_id) {
      return res.status(400).json({ error: 'run_id and database_id required' });
    }

    try {
      const apiKey = secrets?.anthropic?.api_key || process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        return res.status(500).json({ error: 'No Anthropic API key configured' });
      }

      // Load app profile
      const runRes = await pool.query('SELECT app_profile FROM shared.import_runs WHERE id = $1', [run_id]);
      const appProfile = runRes.rows[0]?.app_profile || '';

      // Load tasks needing intents (Phase 1: forms only unless overridden)
      const types = object_types || ['form'];
      const tasksRes = await pool.query(`
        SELECT pt.id, pt.object_name, pt.object_type, pt.source_artifact, ps.intent_prompt
        FROM shared.pipeline_tasks pt
        JOIN shared.pipeline_steps ps ON ps.id = pt.step_id
        WHERE pt.run_id = $1 AND pt.intents IS NULL
          AND pt.object_type = ANY($2)
          AND ps.intent_prompt IS NOT NULL
      `, [run_id, types]);

      let generated = 0;
      const errors = [];

      for (const task of tasksRes.rows) {
        if (!task.source_artifact && !task.intent_prompt) continue;

        try {
          // Fill template
          const prompt = task.intent_prompt
            .replace('{app_profile}', appProfile)
            .replace('{object_name}', task.object_name)
            .replace('{source_artifact}', (task.source_artifact || 'No source available').substring(0, 6000));

          const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': apiKey,
              'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
              model: 'claude-sonnet-4-20250514',
              max_tokens: 2048,
              messages: [{ role: 'user', content: prompt }]
            }),
            signal: AbortSignal.timeout(120000)
          });

          if (!response.ok) {
            errors.push({ object: task.object_name, error: `API ${response.status}` });
            continue;
          }

          const data = await response.json();
          const text = data.content?.[0]?.text || '{}';
          const jsonMatch = text.match(/\{[\s\S]*\}/);
          let intents = [];
          if (jsonMatch) {
            try {
              const parsed = JSON.parse(jsonMatch[0]);
              intents = parsed.intents || [];
            } catch { /* keep empty */ }
          }

          await pool.query(
            'UPDATE shared.pipeline_tasks SET intents = $1, updated_at = NOW() WHERE id = $2',
            [JSON.stringify(intents), task.id]
          );
          generated++;
        } catch (err) {
          errors.push({ object: task.object_name, error: err.message });
        }
      }

      res.json({ generated, total: tasksRes.rows.length, errors });
    } catch (err) {
      logError(pool, 'POST /api/database-import/generate-intents', 'Intent generation failed', err, { databaseId: database_id });
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /evaluate
   * Runs deterministic checks → invariant checks → optional LLM evaluation.
   * Phase 1: forms only.
   */
  router.post('/evaluate', async (req, res) => {
    const { run_id, database_id, task_ids } = req.body;
    if (!run_id || !database_id) {
      return res.status(400).json({ error: 'run_id and database_id required' });
    }

    try {
      // Get schema info
      const dbRes = await pool.query(
        'SELECT schema_name FROM shared.databases WHERE database_id = $1',
        [database_id]
      );
      if (dbRes.rows.length === 0) {
        return res.status(404).json({ error: 'Database not found' });
      }
      const schemaName = dbRes.rows[0].schema_name;
      const schemaInfo = await getSchemaInfo(pool, schemaName);

      // Load app profile
      const runRes = await pool.query('SELECT app_profile FROM shared.import_runs WHERE id = $1', [run_id]);
      const appProfile = runRes.rows[0]?.app_profile || '';

      // Load form step with invariants
      const formStepRes = await pool.query(
        `SELECT id, artifact_invariants, deterministic_checks FROM shared.pipeline_steps WHERE name = 'forms'`
      );
      const formStep = formStepRes.rows[0];
      const invariants = formStep?.artifact_invariants || [];

      // Load tasks to evaluate
      let tasksQuery = `
        SELECT pt.id, pt.object_name, pt.object_type, pt.source_artifact, pt.intents
        FROM shared.pipeline_tasks pt
        WHERE pt.run_id = $1 AND pt.object_type = 'form'
      `;
      const params = [run_id];
      if (Array.isArray(task_ids) && task_ids.length > 0) {
        tasksQuery += ' AND pt.id = ANY($2)';
        params.push(task_ids);
      }
      const tasksRes = await pool.query(tasksQuery, params);

      const apiKey = secrets?.anthropic?.api_key || process.env.ANTHROPIC_API_KEY;
      const results = [];

      for (const task of tasksRes.rows) {
        const startTime = Date.now();

        // Update status to in_progress
        await pool.query(
          "UPDATE shared.pipeline_tasks SET status = 'in_progress', updated_at = NOW() WHERE id = $1",
          [task.id]
        );

        // Load the converted form definition
        const formRes = await pool.query(`
          SELECT definition, record_source
          FROM shared.objects
          WHERE database_id = $1 AND type = 'form' AND name = $2 AND is_current = true AND owner = 'standard'
        `, [database_id, task.object_name]);

        if (formRes.rows.length === 0) {
          await pool.query(
            "UPDATE shared.pipeline_tasks SET status = 'skipped', updated_at = NOW() WHERE id = $1",
            [task.id]
          );
          results.push({ object: task.object_name, status: 'skipped', reason: 'Form not found in objects' });
          continue;
        }

        const definition = formRes.rows[0].definition;
        let allCheckResults = [];
        let overallPassed = true;
        let failureClass = null;

        // 1. Deterministic checks
        try {
          const detChecks = await runFormDeterministicChecks(pool, schemaName, task, definition, schemaInfo);
          allCheckResults.push(...detChecks);

          // Record attempt
          const duration = Date.now() - startTime;
          const attemptRes = await pool.query(`
            INSERT INTO shared.pipeline_task_attempts (task_id, attempt_number, attempt_type, output_summary, result, duration_ms)
            VALUES ($1, 1, 'deterministic_check', $2, $3, $4) RETURNING id
          `, [task.id, `${detChecks.filter(c => c.passed).length}/${detChecks.length} passed`, JSON.stringify(detChecks), duration]);
          const attemptId = attemptRes.rows[0].id;

          // Record evaluations
          for (const check of detChecks) {
            await pool.query(`
              INSERT INTO shared.pipeline_task_evaluations (task_id, attempt_id, evaluation_type, passed, failure_class, details, evaluator)
              VALUES ($1, $2, 'deterministic', $3, $4, $5, $6)
            `, [task.id, attemptId, check.passed, check.passed ? null : classifyFailure([check]), JSON.stringify(check.details), check.check]);

            if (!check.passed) overallPassed = false;
          }
        } catch (err) {
          console.warn(`Deterministic check failed for ${task.object_name}:`, err.message);
        }

        // 2. Artifact invariant checks
        if (task.source_artifact && invariants.length > 0) {
          try {
            const invChecks = checkArtifactInvariants(task, definition, invariants);
            allCheckResults.push(...invChecks);

            const invAttemptRes = await pool.query(`
              INSERT INTO shared.pipeline_task_attempts (task_id, attempt_number, attempt_type, output_summary, result, duration_ms)
              VALUES ($1, 2, 'invariant_check', $2, $3, $4) RETURNING id
            `, [task.id, `${invChecks.filter(c => c.passed).length}/${invChecks.length} passed`, JSON.stringify(invChecks), Date.now() - startTime]);
            const invAttemptId = invAttemptRes.rows[0].id;

            for (const check of invChecks) {
              await pool.query(`
                INSERT INTO shared.pipeline_task_evaluations (task_id, attempt_id, evaluation_type, passed, failure_class, details, evaluator)
                VALUES ($1, $2, 'invariant', $3, $4, $5, 'invariant')
              `, [task.id, invAttemptId, check.passed, check.passed ? null : classifyFailure([check]), JSON.stringify(check.details)]);

              if (!check.passed) overallPassed = false;
            }
          } catch (err) {
            console.warn(`Invariant check failed for ${task.object_name}:`, err.message);
          }
        }

        // 3. LLM semantic evaluation (only if deterministic passed and intents exist)
        if (overallPassed && apiKey && task.intents && task.intents.length > 0) {
          try {
            const semResult = await runSemanticEvaluation(apiKey, task, definition, appProfile);

            const semAttemptRes = await pool.query(`
              INSERT INTO shared.pipeline_task_attempts (task_id, attempt_number, attempt_type, output_summary, result, duration_ms)
              VALUES ($1, 3, 'semantic_evaluation', $2, $3, $4) RETURNING id
            `, [task.id, semResult.passed ? 'passed' : 'failed', JSON.stringify(semResult.details), Date.now() - startTime]);

            await pool.query(`
              INSERT INTO shared.pipeline_task_evaluations (task_id, attempt_id, evaluation_type, passed, failure_class, details, evaluator)
              VALUES ($1, $2, 'semantic', $3, $4, $5, 'llm_sonnet')
            `, [task.id, semAttemptRes.rows[0].id, semResult.passed, semResult.failure_class, JSON.stringify(semResult.details)]);

            if (!semResult.passed) {
              overallPassed = false;
              failureClass = semResult.failure_class;
            }
          } catch (err) {
            console.warn(`Semantic evaluation failed for ${task.object_name}:`, err.message);
            // Don't fail the task for LLM errors — deterministic results stand
          }
        }

        // Update task status
        if (!failureClass) {
          failureClass = classifyFailure(allCheckResults);
        }
        const finalStatus = overallPassed ? 'passed' : 'failed';
        await pool.query(
          'UPDATE shared.pipeline_tasks SET status = $1, updated_at = NOW() WHERE id = $2',
          [finalStatus, task.id]
        );

        results.push({
          object: task.object_name,
          status: finalStatus,
          failure_class: failureClass,
          checks: allCheckResults.length,
          passed_checks: allCheckResults.filter(c => c.passed).length,
          failed_checks: allCheckResults.filter(c => !c.passed).map(c => c.check)
        });
      }

      // Summary
      const passed = results.filter(r => r.status === 'passed').length;
      const failed = results.filter(r => r.status === 'failed').length;
      const skipped = results.filter(r => r.status === 'skipped').length;

      await logEvent(pool, 'info', 'POST /api/database-import/evaluate',
        `Evaluation complete: ${passed} passed, ${failed} failed, ${skipped} skipped`,
        { databaseId: database_id });

      res.json({
        summary: { passed, failed, skipped, total: results.length },
        results
      });
    } catch (err) {
      logError(pool, 'POST /api/database-import/evaluate', 'Evaluation failed', err, { databaseId: database_id });
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /pipeline-status/:runId
   * Returns full task status for a run.
   */
  router.get('/pipeline-status/:runId', async (req, res) => {
    try {
      const runId = parseInt(req.params.runId);
      if (isNaN(runId)) return res.status(400).json({ error: 'Invalid runId' });

      const runRes = await pool.query(
        'SELECT id, database_id, status, app_profile, started_at, completed_at FROM shared.import_runs WHERE id = $1',
        [runId]
      );
      if (runRes.rows.length === 0) return res.status(404).json({ error: 'Run not found' });

      const tasksRes = await pool.query(`
        SELECT pt.id, pt.object_name, pt.object_type, pt.status, pt.intents IS NOT NULL AS has_intents,
               pt.source_artifact IS NOT NULL AS has_source, ps.name AS step_name
        FROM shared.pipeline_tasks pt
        JOIN shared.pipeline_steps ps ON ps.id = pt.step_id
        WHERE pt.run_id = $1
        ORDER BY ps.sort_order, pt.object_name
      `, [runId]);

      // Count evaluations per task
      const evalRes = await pool.query(`
        SELECT pt.id AS task_id,
               COUNT(*) FILTER (WHERE pe.passed = true) AS passed_evals,
               COUNT(*) FILTER (WHERE pe.passed = false) AS failed_evals,
               array_agg(DISTINCT pe.failure_class) FILTER (WHERE pe.failure_class IS NOT NULL) AS failure_classes
        FROM shared.pipeline_tasks pt
        LEFT JOIN shared.pipeline_task_evaluations pe ON pe.task_id = pt.id
        WHERE pt.run_id = $1
        GROUP BY pt.id
      `, [runId]);
      const evalMap = {};
      for (const e of evalRes.rows) evalMap[e.task_id] = e;

      const tasks = tasksRes.rows.map(t => ({
        ...t,
        evaluations: evalMap[t.id] || { passed_evals: 0, failed_evals: 0, failure_classes: [] }
      }));

      // Summary
      const summary = {
        total: tasks.length,
        by_status: {},
        by_type: {}
      };
      for (const t of tasks) {
        summary.by_status[t.status] = (summary.by_status[t.status] || 0) + 1;
        summary.by_type[t.object_type] = (summary.by_type[t.object_type] || 0) + 1;
      }

      res.json({
        run: runRes.rows[0],
        summary,
        tasks
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /pipeline-task/:taskId
   * Returns detail for one task with attempts + evaluations.
   */
  router.get('/pipeline-task/:taskId', async (req, res) => {
    try {
      const taskId = parseInt(req.params.taskId);
      if (isNaN(taskId)) return res.status(400).json({ error: 'Invalid taskId' });

      const taskRes = await pool.query(`
        SELECT pt.*, ps.name AS step_name, ps.description AS step_description
        FROM shared.pipeline_tasks pt
        JOIN shared.pipeline_steps ps ON ps.id = pt.step_id
        WHERE pt.id = $1
      `, [taskId]);
      if (taskRes.rows.length === 0) return res.status(404).json({ error: 'Task not found' });

      const attemptsRes = await pool.query(
        'SELECT * FROM shared.pipeline_task_attempts WHERE task_id = $1 ORDER BY attempt_number',
        [taskId]
      );

      const evalsRes = await pool.query(
        'SELECT * FROM shared.pipeline_task_evaluations WHERE task_id = $1 ORDER BY created_at',
        [taskId]
      );

      res.json({
        task: taskRes.rows[0],
        attempts: attemptsRes.rows,
        evaluations: evalsRes.rows
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

};

/**
 * Build a compact inventory summary for the LLM reconnaissance call.
 */
function buildInventorySummary(discovery, objects) {
  const lines = [];

  // Source discovery summary
  if (discovery.tables) {
    lines.push(`## Tables (${discovery.tables.length})`);
    for (const t of discovery.tables.slice(0, 50)) {
      const name = t.name || t;
      lines.push(`- ${name}`);
    }
  }

  if (discovery.queries) {
    lines.push(`\n## Queries (${discovery.queries.length})`);
    for (const q of discovery.queries.slice(0, 50)) {
      const name = q.name || q;
      const sql = q.sql ? ` — ${q.sql.substring(0, 100)}` : '';
      lines.push(`- ${name}${sql}`);
    }
  }

  // Group imported objects by type
  const byType = {};
  for (const obj of objects) {
    if (!byType[obj.type]) byType[obj.type] = [];
    byType[obj.type].push(obj);
  }

  for (const [type, objs] of Object.entries(byType)) {
    lines.push(`\n## ${type.charAt(0).toUpperCase() + type.slice(1)}s (${objs.length})`);
    for (const obj of objs.slice(0, 50)) {
      const rs = obj.record_source ? ` → ${obj.record_source}` : '';
      const def = obj.definition || {};
      const controlCount = countControls(def);
      const extra = controlCount > 0 ? ` (${controlCount} controls)` : '';
      lines.push(`- ${obj.name}${rs}${extra}`);
    }
  }

  return lines.join('\n');
}

/**
 * Count controls across all sections of a form/report definition.
 */
function countControls(definition) {
  let count = 0;
  for (const section of ['header', 'detail', 'footer']) {
    const controls = definition[section]?.controls;
    if (Array.isArray(controls)) count += controls.length;
  }
  // Also check banded sections (reports)
  for (const key of Object.keys(definition)) {
    if (key.startsWith('group-header') || key.startsWith('group-footer') ||
        key === 'report-header' || key === 'report-footer' ||
        key === 'page-header' || key === 'page-footer') {
      const controls = definition[key]?.controls;
      if (Array.isArray(controls)) count += controls.length;
    }
  }
  return count;
}
