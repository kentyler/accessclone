/**
 * Capability Deriver — synthesizes capability nodes from extracted intents
 * and structural context.
 *
 * Given all the extracted VBA intents for an application plus its structural
 * graph (tables, views, forms, reports), asks the LLM to propose high-level
 * capability nodes that describe what this business system does.
 */

/**
 * Build a compact summary of all module intents for a database.
 * Returns a text block suitable for an LLM prompt.
 */
function summarizeModuleIntents(modules) {
  const lines = [];
  for (const mod of modules) {
    if (!mod.intents?.mapped?.procedures?.length) continue;
    lines.push(`Module: ${mod.name}`);
    for (const proc of mod.intents.mapped.procedures) {
      const intentList = (proc.intents || [])
        .filter(i => i.type !== 'error-handler')
        .map(i => {
          let desc = i.type;
          if (i.target) desc += ` → ${i.target}`;
          if (i.field) desc += ` (${i.field})`;
          if (i.message) desc += ` "${i.message}"`;
          return desc;
        });
      if (intentList.length > 0) {
        lines.push(`  ${proc.name} [${proc.trigger || 'unknown'}]: ${intentList.join(', ')}`);
      }
    }
  }
  return lines.join('\n');
}

/**
 * Derive capability nodes from extracted intents + structural context.
 *
 * @param {Object} params
 * @param {Array} params.modules - Module rows with intents JSONB
 * @param {string} params.structuralContext - Formatted graph context text
 * @param {string} params.databaseName - Name of the application/database
 * @param {string} params.apiKey - Anthropic API key
 * @returns {Promise<Array>} - Array of { name, description, related_structures, related_intents }
 */
async function deriveCapabilities({ modules, structuralContext, databaseName, apiKey }) {
  const intentSummary = summarizeModuleIntents(modules);

  if (!intentSummary.trim()) {
    return [];
  }

  const systemPrompt = `You are analyzing a business application to identify its high-level capabilities.

A "capability" is an abstract business function that the application supports — not code, not a feature, but a concept like "customer inactivity detection" or "vendor reliability tracking" or "credential compliance enforcement".

Capabilities are:
- Abstract: independent of any specific implementation
- Business-oriented: described in terms of what the business does, not how the code works
- Durable: they survive migration between platforms
- Composable: a complex capability may relate to simpler ones

You will be given:
1. The structural context (tables, views, forms, reports) of a database
2. A summary of extracted VBA intents across all modules (validation, navigation, data operations, etc.)

Your job: synthesize these into a set of capability nodes. Look for patterns:
- Multiple validations on related fields → a data quality capability
- Navigation between related forms → a workflow capability
- DLookup/DCount patterns → a data retrieval/analysis capability
- Filters and record source changes → a data exploration capability
- Groups of intents that serve a common business purpose

Return a JSON array of capability objects. Each has:
- "name": short kebab-case identifier (e.g. "customer-data-quality")
- "description": one or two sentences describing the business capability in plain language
- "evidence": brief note on what intents/structures led you to this conclusion
- "related_structures": array of table/form/report names this capability touches
- "related_procedures": array of {"module": "ModuleName", "procedure": "ProcName"} identifying the specific VBA procedures whose intents support this capability
- "confidence": "high" (clear pattern across multiple modules), "medium" (visible pattern), or "low" (inferred)

Return ONLY the JSON array. No markdown, no explanation.`;

  const userPrompt = `Application: "${databaseName}"

Structural context:
${structuralContext}

Extracted intents across all modules:
${intentSummary}

Identify the high-level business capabilities this application supports.`;

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
      messages: [{ role: 'user', content: userPrompt }]
    })
  });

  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(errorData.error?.message || 'Capability derivation API request failed');
  }

  const data = await response.json();
  const text = data.content?.[0]?.text || '';

  // Parse JSON from response (may have markdown fences)
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    throw new Error('No JSON array found in LLM response');
  }

  const capabilities = JSON.parse(jsonMatch[0]);

  // Validate structure
  if (!Array.isArray(capabilities)) {
    throw new Error('Expected JSON array of capabilities');
  }

  return capabilities.map(cap => ({
    name: cap.name || 'unnamed',
    description: cap.description || '',
    evidence: cap.evidence || '',
    related_structures: cap.related_structures || [],
    related_procedures: cap.related_procedures || [],
    confidence: cap.confidence || 'medium'
  }));
}

module.exports = { deriveCapabilities, summarizeModuleIntents };
