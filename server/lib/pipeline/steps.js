/**
 * Pipeline step definitions with swappable strategy implementations.
 *
 * Each step wraps existing libs (vba-intent-extractor, vba-intent-mapper, etc.)
 * behind a uniform interface: async (input, context) => result
 *
 * Strategies can be swapped at runtime — e.g. 'llm' vs 'mock' for extraction.
 */

const { extractIntents, validateIntents, collectGaps, generateGapQuestions, applyGapQuestions } = require('../vba-intent-extractor');
const { mapIntentsToTransforms, countClassifications, assignGapIds } = require('../vba-intent-mapper');
const { generateWiring, generateMechanical } = require('../vba-wiring-generator');

// ============================================================
// STEP 1: EXTRACT — VBA source → structured intents
// ============================================================

const extractStrategies = {
  /**
   * LLM extraction via Claude Sonnet.
   * Input:  { vbaSource, moduleName, appObjects? }
   * Context: { apiKey }
   * Output: { intents, validation }
   */
  llm: async (input, context) => {
    const { vbaSource, moduleName, appObjects } = input;
    const { apiKey } = context;

    const intents = await extractIntents(
      vbaSource, moduleName,
      { app_objects: appObjects },
      apiKey
    );
    const validation = validateIntents(intents);

    return { intents, validation };
  },

  /**
   * Mock extraction for testing — returns canned intents.
   * Input:  { vbaSource, moduleName }
   * Output: { intents, validation }
   */
  mock: async (input) => {
    const { moduleName } = input;
    const intents = {
      procedures: [{
        name: moduleName || 'MockProcedure',
        trigger: 'on-click',
        intents: [{ type: 'show-message', message: 'Mock intent' }]
      }]
    };
    return { intents, validation: { valid: true, unknown: [], warnings: [] } };
  }
};

// ============================================================
// STEP 2: MAP — intents → mapped transforms/flows
// ============================================================

const mapStrategies = {
  /**
   * Deterministic mapping — no LLM involved.
   * Input:  { intents }
   * Output: { mapped, stats, gaps }
   */
  deterministic: async (input) => {
    const { intents } = input;
    const mapped = mapIntentsToTransforms(intents);

    // Aggregate stats
    let totalMechanical = 0, totalFallback = 0, totalGap = 0;
    for (const proc of mapped.procedures) {
      totalMechanical += proc.stats?.mechanical || 0;
      totalFallback += proc.stats?.llm_fallback || 0;
      totalGap += proc.stats?.gap || 0;
    }

    const stats = {
      total: totalMechanical + totalFallback + totalGap,
      mechanical: totalMechanical,
      llm_fallback: totalFallback,
      gap: totalGap
    };

    // Collect gaps
    const gaps = collectGaps(mapped);

    return { mapped, stats, gaps };
  }
};

// ============================================================
// STEP 3: GAP-QUESTIONS — generate user-facing questions for gaps
// ============================================================

const gapQuestionsStrategies = {
  /**
   * LLM-generated gap questions.
   * Input:  { gaps, vbaSource, moduleName }
   * Context: { apiKey }
   * Output: { gapQuestions }
   */
  llm: async (input, context) => {
    const { gaps, vbaSource, moduleName } = input;
    const { apiKey } = context;

    if (!gaps || gaps.length === 0) {
      return { gapQuestions: [] };
    }

    const questions = await generateGapQuestions(gaps, vbaSource, moduleName, apiKey);

    // Merge questions with gap info
    const gapQuestions = gaps.map((g, i) => ({
      gap_id: g.gap_id,
      procedure: g.procedure,
      vba_line: g.vba_line,
      reason: g.reason,
      question: questions[i]?.question || `This VBA code does: "${g.vba_line}". How should this work in the web app?`,
      suggestions: questions[i]?.suggestions || ['Implement equivalent functionality', 'Skip this functionality']
    }));

    return { gapQuestions };
  },

  /**
   * Skip gap questions entirely.
   * Output: { gapQuestions: [] }
   */
  skip: async () => {
    return { gapQuestions: [] };
  }
};

// ============================================================
// STEP 4: RESOLVE-GAPS — resolve gap intents
// ============================================================

const resolveGapsStrategies = {
  /**
   * Auto-resolve using graph context (existing objects → resolution).
   * Input:  { mapped }
   * Context: { pool, databaseId }
   * Output: { mapped (mutated with resolutions), resolvedCount, remainingGaps }
   */
  auto: async (input, context) => {
    const { mapped } = input;
    const { buildGraphContext, autoResolveGaps } = require('../../routes/chat/context');
    const { pool, databaseId } = context;

    let graphCtx = null;
    if (pool && databaseId) {
      graphCtx = await buildGraphContext(pool, databaseId);
    }

    if (!graphCtx) {
      return { mapped, resolvedCount: 0, remainingGaps: 0 };
    }

    const { resolved_count, remaining_gaps } = autoResolveGaps(mapped, graphCtx);
    return { mapped, resolvedCount: resolved_count, remainingGaps: remaining_gaps };
  },

  /**
   * Skip gap resolution — return mapped unchanged.
   * Input:  { mapped }
   * Output: { mapped, resolvedCount: 0, remainingGaps: 0 }
   */
  skip: async (input) => {
    return { mapped: input.mapped, resolvedCount: 0, remainingGaps: 0 };
  }
};

// ============================================================
// STEP 5: GENERATE — mapped intents → ClojureScript source
// ============================================================

const generateStrategies = {
  /**
   * Full generation: mechanical templates + LLM fallback.
   * Input:  { mapped, moduleName, vbaSource }
   * Context: { apiKey, pool, databaseId }
   * Output: { cljsSource, stats }
   */
  full: async (input, context) => {
    const { mapped, moduleName, vbaSource } = input;
    const { apiKey, pool, databaseId } = context;

    // Build graph context for accurate object references
    let graphCtx = null;
    if (pool && databaseId) {
      const { buildGraphContext } = require('../../routes/chat/context');
      graphCtx = await buildGraphContext(pool, databaseId);
    }

    const result = await generateWiring(mapped, moduleName, {
      vbaSource,
      apiKey,
      useFallback: !!apiKey,
      graphContext: graphCtx
    });

    return { cljsSource: result.cljs_source, stats: result.stats };
  },

  /**
   * Mechanical-only generation — no LLM calls.
   * Input:  { mapped, moduleName }
   * Output: { cljsSource, stats }
   */
  mechanical: async (input) => {
    const { mapped, moduleName } = input;
    const result = generateMechanical(mapped, moduleName);

    // Build stats from mapped data
    let totalMechanical = 0, totalFallback = 0, totalGap = 0;
    for (const proc of (mapped?.procedures || [])) {
      totalMechanical += proc.stats?.mechanical || 0;
      totalFallback += proc.stats?.llm_fallback || 0;
      totalGap += proc.stats?.gap || 0;
    }

    return {
      cljsSource: result.cljs_source,
      stats: {
        total_procedures: (mapped?.procedures || []).length,
        mechanical_count: totalMechanical,
        fallback_count: totalFallback,
        gap_count: totalGap,
        fallback_procedures: result.fallback_procedures
      }
    };
  }
};

// ============================================================
// STEP REGISTRY
// ============================================================

const steps = {
  extract: {
    name: 'extract',
    strategies: extractStrategies,
    defaultStrategy: 'llm'
  },
  map: {
    name: 'map',
    strategies: mapStrategies,
    defaultStrategy: 'deterministic'
  },
  'gap-questions': {
    name: 'gap-questions',
    strategies: gapQuestionsStrategies,
    defaultStrategy: 'llm'
  },
  'resolve-gaps': {
    name: 'resolve-gaps',
    strategies: resolveGapsStrategies,
    defaultStrategy: 'auto'
  },
  generate: {
    name: 'generate',
    strategies: generateStrategies,
    defaultStrategy: 'full'
  }
};

/**
 * Get a step definition by name.
 * @param {string} stepName
 * @returns {Object} step definition with .name, .strategies, .defaultStrategy
 */
function getStep(stepName) {
  const step = steps[stepName];
  if (!step) throw new Error(`Unknown pipeline step: ${stepName}`);
  return step;
}

/**
 * List available strategies for a step.
 * @param {string} stepName
 * @returns {string[]} strategy names
 */
function listStrategies(stepName) {
  return Object.keys(getStep(stepName).strategies);
}

module.exports = { steps, getStep, listStrategies };
