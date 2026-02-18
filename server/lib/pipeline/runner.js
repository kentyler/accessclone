/**
 * Pipeline runner — executes steps sequentially with timing and error handling.
 *
 * - runStep(): Execute a single step with a chosen strategy
 * - runPipeline(): Execute all steps for one module, feeding output forward
 * - getModuleStatus(): Infer pipeline position from module record data
 */

const { getStep } = require('./steps');

/**
 * Execute a single pipeline step.
 *
 * @param {string} stepName - One of: extract, map, gap-questions, resolve-gaps, generate
 * @param {Object} input - Step-specific input data
 * @param {Object} context - Shared context { apiKey, pool, databaseId }
 * @param {string} [strategyName] - Strategy override (default: step's defaultStrategy)
 * @returns {Promise<{ step, strategy, result, duration }>}
 */
async function runStep(stepName, input, context, strategyName) {
  const step = getStep(stepName);
  const strategy = strategyName || step.defaultStrategy;
  const strategyFn = step.strategies[strategy];

  if (!strategyFn) {
    throw new Error(`Unknown strategy "${strategy}" for step "${stepName}". Available: ${Object.keys(step.strategies).join(', ')}`);
  }

  const start = Date.now();
  const result = await strategyFn(input, context || {});
  const duration = Date.now() - start;

  return { step: stepName, strategy, result, duration };
}

/**
 * Pipeline step order.
 */
const STEP_ORDER = ['extract', 'map', 'gap-questions', 'resolve-gaps', 'generate'];

/**
 * Run the full pipeline for one module.
 *
 * Feeds output of each step into the next. Stops on first failure.
 * Skips steps that aren't needed based on module state.
 *
 * @param {Object} moduleData - { vbaSource, moduleName, appObjects?, intents?, mapped? }
 * @param {Object} context - { apiKey, pool, databaseId }
 * @param {Object} [config] - Per-step strategy overrides: { extract: 'mock', generate: 'mechanical', ... }
 * @returns {Promise<{ status: 'complete'|'failed'|'partial', results: Array, failedStep?: string, moduleStatus: Object }>}
 */
async function runPipeline(moduleData, context, config = {}) {
  const results = [];
  let { vbaSource, moduleName, appObjects, intents, mapped } = moduleData;

  for (const stepName of STEP_ORDER) {
    const strategy = config[stepName];

    try {
      let stepResult;

      switch (stepName) {
        case 'extract': {
          if (intents || mapped) {
            // Already have intents or mapped data — skip extraction
            continue;
          }
          stepResult = await runStep('extract', { vbaSource, moduleName, appObjects }, context, strategy);
          intents = stepResult.result.intents;
          break;
        }

        case 'map': {
          if (mapped) {
            // Already have mapped data — skip mapping
            continue;
          }
          if (!intents) {
            return { status: 'failed', results, failedStep: 'map', error: 'No intents available for mapping' };
          }
          stepResult = await runStep('map', { intents }, context, strategy);
          mapped = stepResult.result.mapped;
          break;
        }

        case 'gap-questions': {
          if (!mapped) {
            return { status: 'failed', results, failedStep: 'gap-questions', error: 'No mapped data available' };
          }
          // Collect gaps from the mapped result
          const { collectGaps } = require('../vba-intent-extractor');
          const gaps = collectGaps(mapped);
          if (gaps.length === 0) {
            // No gaps — skip gap-questions and resolve-gaps
            continue;
          }
          stepResult = await runStep('gap-questions', { gaps, vbaSource, moduleName }, context, strategy);
          break;
        }

        case 'resolve-gaps': {
          if (!mapped) continue;
          // Check if there are unresolved gaps
          if (!hasUnresolvedGaps(mapped)) continue;
          stepResult = await runStep('resolve-gaps', { mapped }, context, strategy);
          mapped = stepResult.result.mapped;
          break;
        }

        case 'generate': {
          if (!mapped) {
            return { status: 'failed', results, failedStep: 'generate', error: 'No mapped data available' };
          }
          stepResult = await runStep('generate', { mapped, moduleName, vbaSource }, context, strategy);
          break;
        }
      }

      if (stepResult) {
        results.push(stepResult);
      }
    } catch (err) {
      results.push({
        step: stepName,
        strategy: config[stepName] || getStep(stepName).defaultStrategy,
        error: err.message,
        duration: 0
      });
      return {
        status: 'failed',
        results,
        failedStep: stepName,
        error: err.message,
        moduleStatus: getModuleStatus({ intents, mapped })
      };
    }
  }

  return {
    status: 'complete',
    results,
    moduleStatus: getModuleStatus({ intents, mapped, cljsSource: results.find(r => r.step === 'generate')?.result?.cljsSource })
  };
}

/**
 * Check if a mapped result has any unresolved gap intents.
 *
 * @param {Object} mapped - From mapIntentsToTransforms()
 * @returns {boolean}
 */
function hasUnresolvedGaps(mapped) {
  if (!mapped?.procedures) return false;

  function check(intentList) {
    for (const intent of (intentList || [])) {
      if (intent.type === 'gap' && !intent.resolution) return true;
      if (intent.then && check(intent.then)) return true;
      if (intent.else && check(intent.else)) return true;
      if (intent.children && check(intent.children)) return true;
    }
    return false;
  }

  for (const proc of mapped.procedures) {
    if (check(proc.intents)) return true;
  }
  return false;
}

/**
 * Infer pipeline position from module record data.
 *
 * @param {Object} moduleRecord - { intents, mapped?, cljs_source? / cljsSource? }
 * @returns {{ step: string, status: 'pending'|'complete' }}
 */
function getModuleStatus(moduleRecord) {
  if (!moduleRecord) {
    return { step: 'extract', status: 'pending' };
  }

  // Check for intents (step 1 complete)
  const intents = moduleRecord.intents;
  if (!intents) {
    return { step: 'extract', status: 'pending' };
  }

  // Check for mapped data (step 2 complete)
  const mapped = moduleRecord.mapped || intents?.mapped;
  if (!mapped) {
    return { step: 'map', status: 'pending' };
  }

  // Check for unresolved gaps (steps 3-4)
  if (hasUnresolvedGaps(mapped)) {
    return { step: 'resolve-gaps', status: 'pending' };
  }

  // Check for generated code (step 5 complete)
  const cljsSource = moduleRecord.cljs_source || moduleRecord.cljsSource;
  if (!cljsSource) {
    return { step: 'generate', status: 'pending' };
  }

  return { step: 'complete', status: 'complete' };
}

module.exports = { runStep, runPipeline, getModuleStatus, hasUnresolvedGaps, STEP_ORDER };
