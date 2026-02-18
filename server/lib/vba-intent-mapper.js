/**
 * VBA Intent Vocabulary & Deterministic Mapper
 *
 * Maps structured intents (from LLM extraction) to transforms/flows
 * in the AccessClone framework. No LLM involved — fully testable.
 */

// ============================================================
// INTENT VOCABULARY
// ============================================================

const INTENT_VOCABULARY = {
  'open-form':           { description: 'DoCmd.OpenForm "X"', type: 'flow', target: 'open-object-flow' },
  'open-form-filtered':  { description: 'DoCmd.OpenForm "X", , , "filter"', type: 'flow', target: 'open-object-flow' },
  'open-report':         { description: 'DoCmd.OpenReport "X"', type: 'flow', target: 'open-object-flow' },
  'close-form':          { description: 'DoCmd.Close acForm, "X"', type: 'flow', target: 'close-tab-flow' },
  'close-current':       { description: 'DoCmd.Close (no args)', type: 'flow', target: 'close-current-tab-flow' },
  'goto-record':         { description: 'DoCmd.GoToRecord , , acNewRec/acNext/etc', type: 'flow', target: 'navigate-to-record-flow' },
  'requery':             { description: 'Me.Requery', type: 'flow', target: 'set-view-mode-flow' },
  'save-record':         { description: 'DoCmd.RunCommand acCmdSaveRecord', type: 'flow', target: 'save-current-record-flow' },
  'delete-record':       { description: 'DoCmd.RunCommand acCmdDeleteRecord', type: 'flow', target: 'delete-current-record-flow' },
  'new-record':          { description: 'DoCmd.GoToRecord , , acNewRec', type: 'transform', target: 'new-record' },
  'validate-required':   { description: 'If IsNull(Me.Field) Then MsgBox... Exit Sub', type: 'template', target: 'branch-alert-abort' },
  'validate-condition':  { description: 'If condition Then MsgBox... Exit Sub', type: 'template', target: 'branch-alert-abort' },
  'show-message':        { description: 'MsgBox "Info"', type: 'effect', target: 'js/alert' },
  'confirm-action':      { description: 'If MsgBox(..., vbYesNo) = vbYes', type: 'template', target: 'branch-confirm' },
  'set-control-visible': { description: 'Me.Control.Visible = False', type: 'transform', target: 'update-control' },
  'set-control-enabled': { description: 'Me.Control.Enabled = False', type: 'transform', target: 'update-control' },
  'set-control-value':   { description: 'Me.Control = value', type: 'transform', target: 'update-control' },
  'set-filter':          { description: 'Me.Filter = "..." / Me.FilterOn', type: 'transform', target: 'set-form-definition' },
  'set-record-source':   { description: 'Me.RecordSource = "..."', type: 'transform', target: 'set-form-definition' },
  'read-field':          { description: 'Me.txtField / Me!FieldName', type: 'state-read', target: null },
  'write-field':         { description: 'Me.txtField = value', type: 'state-write', target: 'current-record' },
  'set-tempvar':         { description: 'TempVars!VarName = value', type: 'flow', target: 'sync-form-state-flow' },
  'dlookup':             { description: 'DLookup(...)', type: 'effect', target: 'fetch-data' },
  'dcount':              { description: 'DCount(...)', type: 'effect', target: 'run-query' },
  'dsum':                { description: 'DSum(...)', type: 'effect', target: 'run-query' },
  'run-sql':             { description: 'DoCmd.RunSQL "INSERT..."', type: 'effect', target: 'data-crud' },
  'branch':              { description: 'If/ElseIf/Else', type: 'structural', target: null },
  'loop':                { description: 'For/Do While', type: 'structural', target: null },
  'error-handler':       { description: 'On Error GoTo/Resume', type: 'structural', target: null },
  'gap':                 { description: 'Unmappable pattern', type: 'gap', target: null }
};

// Intent types that can be generated mechanically (no LLM needed)
const MECHANICAL_INTENTS = new Set([
  'open-form', 'open-form-filtered', 'open-report',
  'close-form', 'close-current',
  'goto-record', 'new-record',
  'requery', 'save-record', 'delete-record',
  'validate-required', 'validate-condition',
  'show-message', 'confirm-action',
  'set-control-visible', 'set-control-enabled', 'set-control-value',
  'set-filter', 'set-record-source',
  'read-field', 'write-field', 'set-tempvar'
]);

// Intent types that need LLM assistance for code generation
const LLM_FALLBACK_INTENTS = new Set([
  'dlookup', 'dcount', 'dsum', 'run-sql', 'loop'
]);

// ============================================================
// CLASSIFICATION
// ============================================================

/**
 * Classify an intent as 'mechanical', 'llm-fallback', or 'gap'.
 * Structural intents (branch, error-handler) are classified based on their children.
 */
function classifyIntent(intent) {
  if (!intent || !intent.type) return 'gap';

  if (intent.type === 'gap') return 'gap';

  if (intent.type === 'branch' || intent.type === 'error-handler') {
    // Structural: classify based on children
    const children = [
      ...(intent.then || []),
      ...(intent.else || []),
      ...(intent.children || [])
    ];
    if (children.length === 0) return 'mechanical';

    const childClasses = children.map(classifyIntent);
    if (childClasses.includes('gap')) return 'gap';
    if (childClasses.includes('llm-fallback')) return 'llm-fallback';
    return 'mechanical';
  }

  if (MECHANICAL_INTENTS.has(intent.type)) return 'mechanical';
  if (LLM_FALLBACK_INTENTS.has(intent.type)) return 'llm-fallback';

  return 'gap';
}

// ============================================================
// MAPPER
// ============================================================

/**
 * Map a single intent to its transform/flow target.
 * Returns { type, target, template, classification, ...intent }
 */
function mapSingleIntent(intent) {
  const vocab = INTENT_VOCABULARY[intent.type];
  if (!vocab) {
    return {
      ...intent,
      classification: 'gap',
      mapping: null,
      warning: `Unknown intent type: ${intent.type}`
    };
  }

  const classification = classifyIntent(intent);
  const mapped = {
    ...intent,
    classification,
    mapping: {
      type: vocab.type,
      target: vocab.target
    }
  };

  // Recursively map children for structural intents
  if (intent.type === 'branch' || intent.type === 'confirm-action') {
    if (intent.then) mapped.then = intent.then.map(mapSingleIntent);
    if (intent.else) mapped.else = intent.else.map(mapSingleIntent);
  }
  if (intent.type === 'loop' || intent.type === 'error-handler') {
    if (intent.children) mapped.children = intent.children.map(mapSingleIntent);
  }

  return mapped;
}

/**
 * Assign gap_id to all gap intents in a list, recursively.
 * gap_id format: {procedureName}:{gapIndex}
 * @returns {number} the next gapIndex after assignment
 */
function assignGapIds(intents, procName, startIndex) {
  let idx = startIndex;
  for (const intent of intents) {
    if (intent.type === 'gap' || (intent.classification === 'gap' && intent.type === 'gap')) {
      intent.gap_id = `${procName}:${idx}`;
      idx++;
    }
    // Recurse into structural children
    if (intent.then) idx = assignGapIds(intent.then, procName, idx);
    if (intent.else) idx = assignGapIds(intent.else, procName, idx);
    if (intent.children) idx = assignGapIds(intent.children, procName, idx);
  }
  return idx;
}

/**
 * Map an entire intent extraction result to transforms/flows.
 *
 * @param {Object} intentResult - { procedures: [{ name, trigger, intents: [...] }], gaps: [...] }
 * @param {Object} context - { formDefinitions, tableSchemas } (optional, for resolving references)
 * @returns {{ procedures: [...], unmapped: [...], warnings: [...] }}
 */
function mapIntentsToTransforms(intentResult, context) {
  if (!intentResult || !intentResult.procedures) {
    return { procedures: [], unmapped: [], warnings: ['No intent result provided'] };
  }

  const warnings = [];
  const unmapped = [];

  const procedures = intentResult.procedures.map(proc => {
    const mappedIntents = (proc.intents || []).map(mapSingleIntent);

    // Assign gap_id to all gap intents in this procedure
    assignGapIds(mappedIntents, proc.name, 0);

    // Collect unmapped/gap intents
    const gaps = mappedIntents.filter(i => i.classification === 'gap');
    if (gaps.length > 0) {
      unmapped.push({
        procedure: proc.name,
        gaps: gaps.map(g => ({
          type: g.type,
          vba_line: g.vba_line,
          reason: g.warning || g.reason || 'No mapping available'
        }))
      });
    }

    // Count classifications
    const stats = countClassifications(mappedIntents);

    return {
      name: proc.name,
      trigger: proc.trigger || null,
      intents: mappedIntents,
      stats
    };
  });

  // Include gaps from the extraction
  if (intentResult.gaps) {
    for (const gap of intentResult.gaps) {
      unmapped.push({
        procedure: gap.procedure || '(module-level)',
        gaps: [{ type: 'gap', vba_line: gap.vba_line, reason: gap.reason }]
      });
    }
  }

  return { procedures, unmapped, warnings };
}

/**
 * Count classification types across a list of mapped intents (recursive).
 */
function countClassifications(intents) {
  let mechanical = 0, llm_fallback = 0, gap = 0;

  for (const intent of intents) {
    switch (intent.classification) {
      case 'mechanical': mechanical++; break;
      case 'llm-fallback': llm_fallback++; break;
      case 'gap': gap++; break;
    }
    // Count children too
    const children = [
      ...(intent.then || []),
      ...(intent.else || []),
      ...(intent.children || [])
    ];
    if (children.length > 0) {
      const childStats = countClassifications(children);
      mechanical += childStats.mechanical;
      llm_fallback += childStats.llm_fallback;
      gap += childStats.gap;
    }
  }

  return { mechanical, llm_fallback, gap, total: mechanical + llm_fallback + gap };
}

module.exports = {
  INTENT_VOCABULARY,
  MECHANICAL_INTENTS,
  LLM_FALLBACK_INTENTS,
  classifyIntent,
  mapSingleIntent,
  mapIntentsToTransforms,
  countClassifications,
  assignGapIds
};
