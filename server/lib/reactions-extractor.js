/**
 * Extract reaction specs from mapped module procedures.
 *
 * A reaction spec describes how a field change (trigger) should update
 * control state (visibility, enabled, caption) in the projection.
 *
 * Two patterns are recognised:
 *   1. Flat — AfterUpdate body is entirely set-control-* intents (no branching).
 *      Produces: { trigger, ctrl, prop, value }
 *
 *   2. Value-switch — AfterUpdate body is a single value-switch intent.
 *      All cases test the trigger field against literals; all effects are set-control-*.
 *      Produces: { trigger, ctrl, prop, cases: [{ when, then }] }
 *
 * Everything else (branches with conditions, async effects, gaps) is skipped.
 */

const SIMPLE_TYPES = new Set(['set-control-visible', 'set-control-enabled', 'set-control-value']);
const ASYNC_TYPES  = new Set(['dlookup', 'dcount', 'dsum', 'run-sql', 'loop', 'gap']);

/**
 * Convert a control or field name to a keyword string using the same algorithm
 * as the wiring generator (toClojureName) and projection/ctrl->kw:
 * split camelCase, lowercase, collapse non-alphanumeric to hyphens.
 * e.g. SubformCustomers → "subform-customers", OptionGroup1 → "option-group1"
 */
function toKw(s) {
  return (s || '')
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function propFor(type) {
  return type === 'set-control-visible' ? 'visible'
       : type === 'set-control-enabled' ? 'enabled'
       : 'caption';
}

/**
 * @param {Array} procedures - mapped.procedures from a module's intents JSONB
 * @returns {Array} reaction specs
 */
function extractReactions(procedures) {
  const reactions = [];

  for (const proc of (procedures || [])) {
    if (proc.trigger !== 'after-update') continue;
    const match = (proc.name || '').match(/^(.+)_AfterUpdate$/i);
    if (!match) continue;
    const trigger = toKw(match[1]);

    const allIntents = proc.intents || [];
    const hasAsync = allIntents.some(i => ASYNC_TYPES.has(i.type));
    if (hasAsync) continue;

    // Path 1: flat set-control-* intents only
    const isAllSimple = allIntents.every(i =>
      SIMPLE_TYPES.has(i.type) && i.classification !== 'gap'
    );
    if (isAllSimple) {
      for (const intent of allIntents) {
        if (!SIMPLE_TYPES.has(intent.type)) continue;
        reactions.push({
          trigger,
          ctrl: toKw(intent.control),
          prop: propFor(intent.type),
          value: intent.value ?? null
        });
      }
      continue;
    }

    // Path 2: single value-switch intent
    if (allIntents.length === 1 && allIntents[0].type === 'value-switch') {
      const vs = allIntents[0];
      const cases = vs.cases || [];
      const allEffectsSimple = cases
        .flatMap(c => c.then || [])
        .every(i => SIMPLE_TYPES.has(i.type));
      if (!allEffectsSimple) continue;

      // Transpose: {case → [effects]} into {(ctrl, prop) → [{when, then}]}
      const effectMap = {};
      for (const c of cases) {
        for (const eff of (c.then || [])) {
          const key = `${eff.control}|${propFor(eff.type)}`;
          if (!effectMap[key]) {
            effectMap[key] = {
              trigger,
              ctrl: toKw(eff.control),
              prop: propFor(eff.type),
              cases: []
            };
          }
          effectMap[key].cases.push({ when: c.when, then: eff.value ?? null });
        }
      }
      reactions.push(...Object.values(effectMap));
    }
  }

  return reactions;
}

module.exports = { extractReactions, toKw };
