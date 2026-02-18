/**
 * VBA Wiring Generator — Mechanical CLJS templates + LLM fallback.
 *
 * Takes mapped intents (from vba-intent-mapper.js) and produces
 * ClojureScript flow definitions that use t/dispatch! and f/run-fire-and-forget!.
 */

// ============================================================
// MECHANICAL TEMPLATES
// ============================================================

/**
 * Convert a procedure name to a ClojureScript-safe identifier.
 * e.g., "btnSave_Click" → "btn-save-click"
 */
function toClojureName(vbaName) {
  return vbaName
    .replace(/_/g, '-')
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .toLowerCase();
}

/**
 * Escape a string for use in ClojureScript string literals.
 */
function escapeCljs(str) {
  if (!str) return '';
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Generate CLJS for a single intent (mechanical only).
 * Returns null if the intent requires LLM fallback.
 */
function generateIntentCljs(intent, indent) {
  const pad = ' '.repeat(indent);

  switch (intent.type) {
    case 'open-form':
      return `${pad}(state/open-object! :forms "${escapeCljs(intent.form)}")`;

    case 'open-form-filtered':
      return `${pad}(state/open-object! :forms "${escapeCljs(intent.form)}")\n` +
             `${pad};; TODO: apply filter "${escapeCljs(intent.filter)}"`;

    case 'open-report':
      return `${pad}(state/open-object! :reports "${escapeCljs(intent.report)}")`;

    case 'close-form':
      return `${pad}(state/close-tab! :forms "${escapeCljs(intent.form)}")`;

    case 'close-current':
      return `${pad}(let [tab (:active-tab @state/app-state)]\n` +
             `${pad}  (state/close-tab! (:type tab) (:id tab)))`;

    case 'goto-record': {
      const posMap = { next: ':next', previous: ':previous', first: ':first', last: ':last' };
      const pos = posMap[intent.position] || ':next';
      return `${pad}(state-form/navigate-to-record! ${pos})`;
    }

    case 'new-record':
      return `${pad}(t/dispatch! :new-record)`;

    case 'requery':
      return `${pad}(state-form/load-records!)`;

    case 'save-record':
      return `${pad}(state-form/save-current-record!)`;

    case 'delete-record':
      return `${pad}(state-form/delete-current-record!)`;

    case 'show-message':
      return `${pad}(js/alert "${escapeCljs(intent.message)}")`;

    case 'validate-required':
      return `${pad}(when (nil? (get-in @state/app-state [:form-editor :current-record :${toClojureName(intent.field)}]))\n` +
             `${pad}  (js/alert "${escapeCljs(intent.message)}")\n` +
             `${pad}  (throw (js/Error. "validation")))`;

    case 'validate-condition':
      return `${pad};; Validation: ${escapeCljs(intent.condition)}\n` +
             `${pad}(when ${intent.condition || 'false'}\n` +
             `${pad}  (js/alert "${escapeCljs(intent.message)}")\n` +
             `${pad}  (throw (js/Error. "validation")))`;

    case 'confirm-action': {
      const thenCljs = (intent.then || [])
        .map(i => generateIntentCljs(i, indent + 2))
        .filter(Boolean)
        .join('\n');
      const elseCljs = (intent.else || [])
        .map(i => generateIntentCljs(i, indent + 2))
        .filter(Boolean);
      let code = `${pad}(when (js/confirm "${escapeCljs(intent.message)}")\n${thenCljs})`;
      if (elseCljs.length > 0) {
        code = `${pad}(if (js/confirm "${escapeCljs(intent.message)}")\n` +
               `${pad}  (do\n${thenCljs})\n` +
               `${pad}  (do\n${elseCljs.join('\n')}))`;
      }
      return code;
    }

    case 'set-control-visible':
      return `${pad};; Set ${intent.control} visible=${intent.value}\n` +
             `${pad}(t/dispatch! :update-control :detail nil :visible ${intent.value ? '1' : '0'})`;

    case 'set-control-enabled':
      return `${pad};; Set ${intent.control} enabled=${intent.value}\n` +
             `${pad}(t/dispatch! :update-control :detail nil :enabled ${intent.value ? '1' : '0'})`;

    case 'set-control-value':
      return `${pad};; Set ${intent.control} = ${intent.value}\n` +
             `${pad}(t/dispatch! :update-control :detail nil :value ${intent.value || 'nil'})`;

    case 'set-filter':
      return `${pad};; Set filter: ${escapeCljs(intent.filter)}\n` +
             `${pad}(t/dispatch! :set-form-definition\n` +
             `${pad}  (assoc (get-in @state/app-state [:form-editor :current]) :filter "${escapeCljs(intent.filter)}"))`;

    case 'set-record-source':
      return `${pad};; Set record source: ${escapeCljs(intent.record_source)}\n` +
             `${pad}(t/dispatch! :set-form-definition\n` +
             `${pad}  (assoc (get-in @state/app-state [:form-editor :current]) :record-source "${escapeCljs(intent.record_source)}"))`;

    case 'read-field':
      return `${pad}(get-in @state/app-state [:form-editor :current-record :${toClojureName(intent.field)}])`;

    case 'write-field':
      return `${pad}(swap! state/app-state assoc-in [:form-editor :current-record :${toClojureName(intent.field)}] ${intent.value || 'nil'})`;

    case 'set-tempvar':
      return `${pad};; TempVar: ${intent.name} = ${intent.value}\n` +
             `${pad}(state/sync-form-state! {"_tempvars" {"${escapeCljs(intent.name)}" ${intent.value || 'nil'}}})`;

    case 'branch': {
      const thenCljs = (intent.then || [])
        .map(i => generateIntentCljs(i, indent + 2))
        .filter(Boolean)
        .join('\n');
      const elseCljs = (intent.else || [])
        .map(i => generateIntentCljs(i, indent + 2))
        .filter(Boolean);

      if (elseCljs.length > 0) {
        return `${pad}(if ${intent.condition || 'true'}\n` +
               `${pad}  (do\n${thenCljs})\n` +
               `${pad}  (do\n${elseCljs.join('\n')}))`;
      }
      return `${pad}(when ${intent.condition || 'true'}\n${thenCljs})`;
    }

    case 'error-handler':
      return `${pad};; Error handler: ${intent.label || 'default'}\n` +
             `${pad}(try\n` +
             (intent.children || [])
               .map(i => generateIntentCljs(i, indent + 2))
               .filter(Boolean)
               .join('\n') + '\n' +
             `${pad}  (catch js/Error e\n` +
             `${pad}    (when-not (= (.-message e) "validation")\n` +
             `${pad}      (state/log-error! (.-message e) "${escapeCljs(intent.label || 'error-handler')}"))))`;

    // LLM fallback types — return comment placeholder
    case 'dlookup':
      return `${pad};; NEEDS LLM: DLookup("${escapeCljs(intent.field)}", "${escapeCljs(intent.table)}", "${escapeCljs(intent.criteria)}")`;

    case 'dcount':
      return `${pad};; NEEDS LLM: DCount("${escapeCljs(intent.field)}", "${escapeCljs(intent.table)}", "${escapeCljs(intent.criteria)}")`;

    case 'dsum':
      return `${pad};; NEEDS LLM: DSum("${escapeCljs(intent.field)}", "${escapeCljs(intent.table)}", "${escapeCljs(intent.criteria)}")`;

    case 'run-sql':
      return `${pad};; NEEDS LLM: RunSQL ${escapeCljs((intent.sql || '').substring(0, 60))}`;

    case 'loop':
      return `${pad};; NEEDS LLM: Loop — ${escapeCljs(intent.description || 'iteration')}`;

    case 'gap':
      if (intent.resolution) {
        const answer = escapeCljs(intent.resolution.answer || '');
        const notes = intent.resolution.custom_notes ? `\n${pad};; Notes: ${escapeCljs(intent.resolution.custom_notes)}` : '';
        return `${pad};; GAP RESOLVED: ${escapeCljs(intent.vba_line || intent.reason || 'unknown pattern')}\n` +
               `${pad};; User decision: ${answer}${notes}\n` +
               `${pad};; TODO: Implement "${answer}"`;
      }
      return `${pad};; UNMAPPED: ${escapeCljs(intent.vba_line || intent.reason || 'unknown pattern')}`;

    default:
      return `${pad};; UNKNOWN INTENT: ${intent.type}`;
  }
}

// ============================================================
// NAMESPACE + REQUIRES GENERATION
// ============================================================

/**
 * Determine which namespaces are needed based on intents.
 */
function collectRequires(procedures) {
  const needs = {
    state: false,
    'state-form': false,
    transforms: false,
  };

  function scan(intents) {
    for (const intent of intents) {
      switch (intent.type) {
        case 'open-form': case 'open-form-filtered': case 'open-report':
        case 'close-form': case 'close-current':
        case 'read-field': case 'write-field':
        case 'set-tempvar':
          needs.state = true;
          break;
        case 'goto-record': case 'new-record': case 'requery':
        case 'save-record': case 'delete-record':
          needs['state-form'] = true;
          break;
        case 'validate-required': case 'set-filter':
        case 'set-record-source':
          needs.state = true;
          needs.transforms = true;
          break;
        case 'set-control-visible': case 'set-control-enabled': case 'set-control-value':
          needs.transforms = true;
          break;
        case 'error-handler':
          needs.state = true;
          break;
      }
      // Recurse into children
      if (intent.then) scan(intent.then);
      if (intent.else) scan(intent.else);
      if (intent.children) scan(intent.children);
    }
  }

  for (const proc of procedures) {
    scan(proc.intents || []);
  }

  return needs;
}

/**
 * Generate the (ns ...) form.
 */
function generateNamespace(moduleName, needs) {
  const nsName = `app.modules.${toClojureName(moduleName)}`;
  const requires = [];

  requires.push('[app.state :as state :refer [app-state]]');
  if (needs['state-form']) {
    requires.push('[app.state-form :as state-form]');
  }
  if (needs.transforms) {
    requires.push('[app.transforms.core :as t]');
  }

  return `(ns ${nsName}\n` +
         `  "Generated from VBA module: ${moduleName}"\n` +
         `  (:require ${requires.join('\n            ')}))`;
}

// ============================================================
// PROCEDURE GENERATION
// ============================================================

/**
 * Generate CLJS for a single procedure.
 */
function generateProcedure(proc) {
  const fnName = toClojureName(proc.name);
  const intentsCljs = (proc.intents || [])
    .map(i => generateIntentCljs(i, 4))
    .filter(Boolean)
    .join('\n');

  return `(defn ${fnName}\n` +
         `  "Generated from VBA: ${proc.name}${proc.trigger ? ` (${proc.trigger})` : ''}"\n` +
         `  []\n` +
         (intentsCljs || '  ;; (no intents)') + ')';
}

/**
 * Generate the event-handlers map.
 */
function generateEventHandlers(procedures) {
  const entries = procedures
    .filter(p => p.trigger)
    .map(p => {
      // Derive the control name and event from the VBA procedure name
      const parts = p.name.split('_');
      const event = p.trigger;
      const control = parts.length > 1 ? parts[0] : 'Form';
      return `   "${control}.${event}" ${toClojureName(p.name)}`;
    });

  if (entries.length === 0) return '';

  return `(def event-handlers\n` +
         `  "Map control events to handler functions"\n` +
         `  {${entries.join('\n')}})\n`;
}

// ============================================================
// MAIN GENERATION FUNCTIONS
// ============================================================

/**
 * Generate CLJS mechanically (no LLM) for all mapped intents.
 * Returns { cljs_source, fallback_procedures }
 *
 * fallback_procedures is a list of procedure names that contain
 * intents needing LLM assistance.
 */
function generateMechanical(mappedResult, moduleName) {
  if (!mappedResult || !mappedResult.procedures) {
    return { cljs_source: '', fallback_procedures: [] };
  }

  const procedures = mappedResult.procedures;
  const needs = collectRequires(procedures);
  const fallbackProcedures = [];

  // Check which procedures need LLM help
  for (const proc of procedures) {
    const hasLlm = (proc.intents || []).some(i =>
      i.classification === 'llm-fallback' || i.classification === 'gap'
    );
    if (hasLlm) {
      fallbackProcedures.push(proc.name);
    }
  }

  // Generate pieces
  const ns = generateNamespace(moduleName, needs);
  const procs = procedures.map(generateProcedure).join('\n\n');
  const handlers = generateEventHandlers(procedures);

  const source = [ns, '', procs, '', handlers].filter(Boolean).join('\n');

  return { cljs_source: source, fallback_procedures: fallbackProcedures };
}

/**
 * Generate CLJS using LLM fallback for complex procedures.
 *
 * @param {string[]} procedureNames - Names of procedures needing LLM help
 * @param {string} mechanicalSource - Already-generated mechanical CLJS
 * @param {string} vbaSource - Original VBA source
 * @param {string} moduleName - Module name
 * @param {string} apiKey - Anthropic API key
 * @returns {Promise<{ cljs_source: string }>}
 */
async function generateFallback(procedureNames, mechanicalSource, vbaSource, moduleName, apiKey, mappedResult) {
  if (!procedureNames.length) {
    return { cljs_source: mechanicalSource };
  }

  // Collect resolved gap context for the LLM
  let resolvedGapContext = '';
  if (mappedResult?.procedures) {
    const resolvedGaps = [];
    function collectResolved(intents) {
      for (const intent of intents) {
        if (intent.type === 'gap' && intent.resolution) {
          resolvedGaps.push({
            vba_line: intent.vba_line,
            question: intent.question,
            answer: intent.resolution.answer,
            notes: intent.resolution.custom_notes
          });
        }
        if (intent.then) collectResolved(intent.then);
        if (intent.else) collectResolved(intent.else);
        if (intent.children) collectResolved(intent.children);
      }
    }
    for (const proc of mappedResult.procedures) {
      collectResolved(proc.intents || []);
    }
    if (resolvedGaps.length > 0) {
      resolvedGapContext = '\n\nResolved gaps (user decisions for unmappable patterns):\n' +
        resolvedGaps.map(g =>
          `- VBA: ${g.vba_line}\n  Question: ${g.question || 'N/A'}\n  User answer: ${g.answer}${g.notes ? `\n  Notes: ${g.notes}` : ''}`
        ).join('\n');
    }
  }

  const systemPrompt = `You are an expert at translating VBA to ClojureScript for the AccessClone framework.

You are given:
1. A VBA module
2. A partially-generated ClojureScript translation (mechanical portions are done)
3. A list of procedures that need your help

Your job: Replace the comment placeholders (;; NEEDS LLM: ... and ;; GAP RESOLVED: ...) in the mechanical output with working ClojureScript code that uses the AccessClone framework.

For resolved gaps (;; GAP RESOLVED), implement the user's chosen approach. The user's decision and any notes are provided below.

Rules:
- Use \`go\` blocks and \`<!\` for async operations (DLookup, DCount, RunSQL, etc.)
- DLookup/DCount/DSum → API call to \`/api/data/tablename\` with query params
- RunSQL → API call to \`/api/data/tablename\` with POST/PUT/DELETE
- Keep the existing namespace and function structure
- Return ONLY the complete ClojureScript source — no markdown, no explanations${resolvedGapContext}`;

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
      system: systemPrompt,
      messages: [{
        role: 'user',
        content: `VBA Module "${moduleName}":\n\n${vbaSource}\n\nPartially-generated ClojureScript:\n\n${mechanicalSource}\n\nProcedures needing help: ${procedureNames.join(', ')}`
      }]
    })
  });

  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(errorData.error?.message || 'Fallback generation API request failed');
  }

  const data = await response.json();
  let cljs = data.content?.find(c => c.type === 'text')?.text || '';
  cljs = cljs.replace(/^```(?:clojure|clojurescript)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();

  return { cljs_source: cljs || mechanicalSource };
}

/**
 * Full wiring generation: mechanical templates + optional LLM fallback.
 *
 * @param {Object} mappedResult - From mapIntentsToTransforms()
 * @param {string} moduleName - Module name
 * @param {Object} options - { vbaSource, apiKey, useFallback: true }
 * @returns {Promise<{ cljs_source: string, stats: Object }>}
 */
async function generateWiring(mappedResult, moduleName, options = {}) {
  const { cljs_source: mechanicalSource, fallback_procedures } = generateMechanical(mappedResult, moduleName);

  // Aggregate stats
  let totalMechanical = 0, totalFallback = 0, totalGap = 0;
  for (const proc of (mappedResult?.procedures || [])) {
    totalMechanical += proc.stats?.mechanical || 0;
    totalFallback += proc.stats?.llm_fallback || 0;
    totalGap += proc.stats?.gap || 0;
  }

  const stats = {
    total_procedures: (mappedResult?.procedures || []).length,
    mechanical_count: totalMechanical,
    fallback_count: totalFallback,
    gap_count: totalGap,
    fallback_procedures
  };

  // If there are fallback procedures and we have an API key, use LLM
  if (fallback_procedures.length > 0 && options.apiKey && options.useFallback !== false) {
    try {
      const result = await generateFallback(
        fallback_procedures, mechanicalSource,
        options.vbaSource || '', moduleName, options.apiKey, mappedResult
      );
      return { cljs_source: result.cljs_source, stats };
    } catch (err) {
      // On LLM failure, return mechanical output with placeholders
      console.error('LLM fallback failed:', err.message);
      return { cljs_source: mechanicalSource, stats };
    }
  }

  return { cljs_source: mechanicalSource, stats };
}

module.exports = {
  toClojureName,
  escapeCljs,
  generateIntentCljs,
  generateMechanical,
  generateFallback,
  generateWiring,
  generateNamespace,
  generateProcedure,
  generateEventHandlers,
  collectRequires
};
