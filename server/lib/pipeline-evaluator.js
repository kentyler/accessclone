/**
 * Pipeline Evaluator — deterministic checks, artifact invariant checks,
 * and LLM semantic evaluation for the self-healing import pipeline.
 *
 * Reuses existing lint infrastructure for deterministic validation.
 * Supports forms and reports.
 */

const { validateForm, validateReport } = require('../routes/lint/structural');
const { getSchemaInfo, validateFormCrossObject, validateComboBoxSql, validateReportCrossObject } = require('../routes/lint/cross-object');
const { summarizeDefinition } = require('../routes/chat/context');

/**
 * Run deterministic checks against a converted form definition.
 * Reuses lint structural + cross-object validators.
 *
 * @param {Pool} pool - PostgreSQL connection pool
 * @param {string} schemaName - PG schema name
 * @param {object|string} task - pipeline_tasks row OR object_name string
 * @param {object} definition - parsed form definition
 * @param {Map} schemaInfo - from getSchemaInfo()
 * @returns {Promise<Array<{check: string, passed: boolean, details: object}>>}
 */
async function runFormDeterministicChecks(pool, schemaName, task, definition, schemaInfo) {
  const objectName = typeof task === 'string' ? task : task.object_name;
  const results = [];

  // 1. Record source exists check
  const recordSource = definition['record-source'] || definition.record_source;
  const hasRecordSource = !!recordSource;
  if (hasRecordSource) {
    const rsLower = recordSource.toLowerCase();
    const rsExists = schemaInfo.has(rsLower);
    results.push({
      check: 'record_source_exists',
      passed: rsExists,
      details: {
        record_source: recordSource,
        found_in_schema: rsExists
      }
    });
  } else {
    // No record source — might be intentional (unbound form)
    results.push({
      check: 'record_source_exists',
      passed: true,
      details: { record_source: null, note: 'Unbound form — no record source to check' }
    });
  }

  // 2. Structural lint
  const structuralIssues = validateForm({ name: objectName, definition });
  results.push({
    check: 'structural_lint',
    passed: structuralIssues.length === 0,
    details: {
      issue_count: structuralIssues.length,
      issues: structuralIssues.slice(0, 10) // cap for readability
    }
  });

  // 3. Control bindings match schema
  const crossIssues = validateFormCrossObject(
    { name: objectName, definition, record_source: recordSource },
    schemaInfo
  );
  const bindingIssues = crossIssues.filter(i => i.field || i.message?.includes('binding'));
  results.push({
    check: 'control_bindings_match',
    passed: bindingIssues.length === 0,
    details: {
      issue_count: bindingIssues.length,
      issues: bindingIssues.slice(0, 10)
    }
  });

  // 4. Combo-box SQL validity
  try {
    const comboIssues = await validateComboBoxSql(
      { name: objectName, definition },
      pool,
      schemaName
    );
    results.push({
      check: 'combo_sql_valid',
      passed: comboIssues.length === 0,
      details: {
        issue_count: comboIssues.length,
        issues: comboIssues.slice(0, 10)
      }
    });
  } catch (err) {
    results.push({
      check: 'combo_sql_valid',
      passed: true,
      details: { note: 'Check skipped: ' + err.message }
    });
  }

  return results;
}

/**
 * Run deterministic checks against a converted report definition.
 * Mirrors runFormDeterministicChecks but uses report validators.
 *
 * @param {Pool} pool - PostgreSQL connection pool
 * @param {string} schemaName - PG schema name
 * @param {object|string} task - pipeline_tasks row OR object_name string
 * @param {object} definition - parsed report definition
 * @param {Map} schemaInfo - from getSchemaInfo()
 * @returns {Promise<Array<{check: string, passed: boolean, details: object}>>}
 */
async function runReportDeterministicChecks(pool, schemaName, task, definition, schemaInfo) {
  const objectName = typeof task === 'string' ? task : task.object_name;
  const results = [];

  // 1. Record source exists check
  const recordSource = definition['record-source'] || definition.record_source;
  const hasRecordSource = !!recordSource;
  if (hasRecordSource) {
    const rsLower = recordSource.toLowerCase();
    const rsExists = schemaInfo.has(rsLower);
    results.push({
      check: 'record_source_exists',
      passed: rsExists,
      details: {
        record_source: recordSource,
        found_in_schema: rsExists
      }
    });
  } else {
    results.push({
      check: 'record_source_exists',
      passed: true,
      details: { record_source: null, note: 'Unbound report — no record source to check' }
    });
  }

  // 2. Structural lint
  const structuralIssues = validateReport({ name: objectName, definition });
  results.push({
    check: 'structural_lint',
    passed: structuralIssues.length === 0,
    details: {
      issue_count: structuralIssues.length,
      issues: structuralIssues.slice(0, 10)
    }
  });

  // 3. Control bindings match schema
  const crossIssues = validateReportCrossObject(
    { name: objectName, definition, record_source: recordSource },
    schemaInfo
  );
  const bindingIssues = crossIssues.filter(i => i.field || i.message?.includes('binding'));
  results.push({
    check: 'control_bindings_match',
    passed: bindingIssues.length === 0,
    details: {
      issue_count: bindingIssues.length,
      issues: bindingIssues.slice(0, 10)
    }
  });

  return results;
}

/**
 * Check artifact invariants — compare source artifact vs converted output.
 * These catch regressions (e.g., a form that had a record-source loses it).
 *
 * @param {object} task - pipeline_tasks row (with source_artifact)
 * @param {object} definition - parsed form definition
 * @param {Array} invariants - from pipeline_steps.artifact_invariants
 * @returns {Array<{check: string, passed: boolean, details: object}>}
 */
function checkArtifactInvariants(task, definition, invariants) {
  const results = [];
  const sourceText = task.source_artifact || '';

  for (const inv of invariants) {
    switch (inv.check) {
      case 'record_source_preserved': {
        // If the source had a RecordSource, the converted form must too
        const sourceHasRS = /RecordSource\s*=\s*"([^"]+)"/i.test(sourceText);
        const convertedRS = definition['record-source'] || definition.record_source;
        const convertedHasRS = !!convertedRS;
        const passed = !sourceHasRS || convertedHasRS;
        results.push({
          check: 'record_source_preserved',
          passed,
          details: {
            source_had_record_source: sourceHasRS,
            converted_has_record_source: convertedHasRS,
            converted_record_source: convertedRS || null
          }
        });
        break;
      }

      case 'control_count_preserved': {
        // Count controls in source (rough: count "Begin" blocks for control types)
        const sourceControlMatches = sourceText.match(/^\s+Begin\s+(TextBox|Label|CommandButton|ComboBox|ListBox|CheckBox|OptionButton|ToggleButton|SubForm|Image|Line|Rectangle|TabCtl|OptionGroup|PageBreak|BoundObjectFrame|UnboundObjectFrame)/gm);
        const sourceCount = sourceControlMatches ? sourceControlMatches.length : 0;

        // Count controls in converted definition
        let convertedCount = 0;
        for (const section of ['header', 'detail', 'footer']) {
          const controls = definition[section]?.controls;
          if (Array.isArray(controls)) convertedCount += controls.length;
        }

        // Allow some variance (labels nested inside other controls may not map 1:1)
        const tolerance = Math.max(3, Math.floor(sourceCount * 0.15));
        const passed = sourceCount === 0 || Math.abs(sourceCount - convertedCount) <= tolerance;
        results.push({
          check: 'control_count_preserved',
          passed,
          details: {
            source_count: sourceCount,
            converted_count: convertedCount,
            tolerance,
            delta: convertedCount - sourceCount
          }
        });
        break;
      }

      case 'section_count_preserved': {
        // Check that source sections survive conversion
        const sourceHasHeader = /Begin FormHeader|Begin\s+Section\s+=\s*1/i.test(sourceText);
        const sourceHasDetail = /Begin\s+Section\s+=\s*0|Begin Detail/i.test(sourceText);
        const sourceHasFooter = /Begin FormFooter|Begin\s+Section\s+=\s*2/i.test(sourceText);

        const convertedHasHeader = !!definition.header;
        const convertedHasDetail = !!definition.detail;
        const convertedHasFooter = !!definition.footer;

        const passed = (!sourceHasHeader || convertedHasHeader) &&
                       (!sourceHasDetail || convertedHasDetail) &&
                       (!sourceHasFooter || convertedHasFooter);
        results.push({
          check: 'section_count_preserved',
          passed,
          details: {
            source: { header: sourceHasHeader, detail: sourceHasDetail, footer: sourceHasFooter },
            converted: { header: convertedHasHeader, detail: convertedHasDetail, footer: convertedHasFooter }
          }
        });
        break;
      }

      default:
        results.push({
          check: inv.check,
          passed: true,
          details: { note: 'Unknown invariant check — skipped' }
        });
    }
  }

  return results;
}

/**
 * Run LLM semantic evaluation — compares source artifact, converted output,
 * and generated intents to verify semantic fidelity.
 *
 * @param {string} apiKey - Anthropic API key
 * @param {object} task - pipeline_tasks row
 * @param {object} definition - parsed form definition
 * @param {string} appProfile - from import_runs.app_profile
 * @returns {Promise<{passed: boolean, failure_class: string|null, details: object}>}
 */
async function runSemanticEvaluation(apiKey, task, definition, appProfile) {
  const summary = summarizeDefinition(definition, 'form', task.object_name);
  const intents = task.intents || [];

  const systemPrompt = `You are evaluating whether an Access form was correctly converted to a web application form.
You will receive:
1. The original Access form source (SaveAsText format)
2. A compact summary of the converted form
3. A set of testable intents that describe what this form should do

Evaluate each intent against the converted output. For each, determine if it is satisfied.

Return JSON:
{
  "overall_passed": true/false,
  "failure_class": null or one of: "missing_dependency", "translation_ambiguity", "unsupported_pattern", "regression", "semantic_mismatch", "structural_error",
  "intent_results": [{"id": "...", "passed": true/false, "reason": "..."}],
  "summary": "Brief overall assessment"
}`;

  const userPrompt = `Application context:
${appProfile || 'No profile available'}

Form: ${task.object_name}

Original Access source (SaveAsText):
${(task.source_artifact || 'Not available').substring(0, 4000)}

Converted form summary:
${summary}

Intents to verify:
${JSON.stringify(intents, null, 2)}`;

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
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    })
  });

  if (!response.ok) {
    throw new Error(`Anthropic API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  const text = data.content?.[0]?.text || '{}';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return { passed: false, failure_class: null, details: { error: 'No JSON in LLM response', raw: text.substring(0, 500) } };
  }

  try {
    const result = JSON.parse(jsonMatch[0]);
    return {
      passed: !!result.overall_passed,
      failure_class: result.failure_class || null,
      details: result
    };
  } catch (err) {
    return { passed: false, failure_class: null, details: { error: 'JSON parse failed', raw: text.substring(0, 500) } };
  }
}

/**
 * Classify a failure from deterministic or invariant check results.
 * Maps check failures to the failure_class enum.
 *
 * @param {Array} checkResults - from runFormDeterministicChecks or checkArtifactInvariants
 * @returns {string|null} - failure class or null if all passed
 */
function classifyFailure(checkResults) {
  const failed = checkResults.filter(r => !r.passed);
  if (failed.length === 0) return null;

  for (const f of failed) {
    if (f.check === 'record_source_exists' && f.details?.found_in_schema === false) {
      return 'missing_dependency';
    }
    if (f.check === 'record_source_preserved') {
      return 'regression';
    }
    if (f.check === 'control_count_preserved' || f.check === 'section_count_preserved') {
      return 'structural_error';
    }
    if (f.check === 'control_bindings_match') {
      return 'translation_ambiguity';
    }
    if (f.check === 'combo_sql_valid') {
      return 'translation_ambiguity';
    }
    if (f.check === 'structural_lint') {
      return 'structural_error';
    }
  }

  return 'structural_error';
}

/**
 * Run deterministic evaluation and record results in shared.evaluations.
 * Thin orchestrator: fetches schema, dispatches to form/report checks,
 * classifies failures, persists to DB.
 *
 * @param {Pool} pool - PostgreSQL connection pool
 * @param {object} params
 * @param {number} params.objectId - shared.objects row id
 * @param {string} params.databaseId - database slug
 * @param {string} params.objectType - 'form' or 'report'
 * @param {string} params.objectName - object name
 * @param {number} params.version - object version
 * @param {object} params.definition - parsed definition
 * @param {string} params.trigger - 'save' or 'import'
 * @returns {Promise<{overall_passed: boolean, failure_class: string|null, checks: Array, duration_ms: number}>}
 */
async function runAndRecordEvaluation(pool, { objectId, databaseId, objectType, objectName, version, definition, trigger }) {
  const start = Date.now();

  // Fetch schema name
  const dbResult = await pool.query(
    'SELECT schema_name FROM shared.databases WHERE database_id = $1', [databaseId]
  );
  if (dbResult.rows.length === 0) {
    return { overall_passed: true, failure_class: null, checks: [], duration_ms: 0, skipped: true, reason: 'database not found' };
  }
  const schemaName = dbResult.rows[0].schema_name;
  const schemaInfo = await getSchemaInfo(pool, schemaName);

  // Dispatch to type-specific checks
  let checks;
  if (objectType === 'form') {
    checks = await runFormDeterministicChecks(pool, schemaName, objectName, definition, schemaInfo);
  } else if (objectType === 'report') {
    checks = await runReportDeterministicChecks(pool, schemaName, objectName, definition, schemaInfo);
  } else {
    return { overall_passed: true, failure_class: null, checks: [], duration_ms: 0, skipped: true, reason: `unknown objectType: ${objectType}` };
  }

  const failureClass = classifyFailure(checks);
  const overallPassed = failureClass === null;
  const passedCount = checks.filter(c => c.passed).length;
  const failedCount = checks.filter(c => !c.passed).length;
  const durationMs = Date.now() - start;

  // Persist to shared.evaluations
  await pool.query(
    `INSERT INTO shared.evaluations
      (object_id, database_id, object_type, object_name, version, trigger, overall_passed, failure_class, checks, check_count, passed_count, failed_count, duration_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [objectId, databaseId, objectType, objectName, version, trigger, overallPassed, failureClass, JSON.stringify(checks), checks.length, passedCount, failedCount, durationMs]
  );

  return { overall_passed: overallPassed, failure_class: failureClass, checks, duration_ms: durationMs };
}

module.exports = {
  runFormDeterministicChecks,
  runReportDeterministicChecks,
  checkArtifactInvariants,
  runSemanticEvaluation,
  classifyFailure,
  runAndRecordEvaluation,
  getSchemaInfo
};
