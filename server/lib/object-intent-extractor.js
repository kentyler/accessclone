/**
 * Object Intent Extractor — LLM-powered extraction of business-level intents
 * from forms, reports, and queries.
 *
 * Extracts the semantic "why" layer: what each object is FOR in business terms.
 */

const path = require('path');
const fs = require('fs');
const { summarizeDefinition, formatGraphContext } = require('../routes/chat/context');

// Load the prompt template once at module load
let promptTemplate = '';
try {
  const templatePath = path.join(__dirname, '..', '..', 'skills', 'object-intent-extraction.md');
  promptTemplate = fs.readFileSync(templatePath, 'utf8');
} catch (err) {
  console.log('Could not load object-intent-extraction.md skill file');
}

const VALID_CATEGORIES = new Set([
  'data-entry', 'data-view', 'lookup', 'navigation',
  'summary-report', 'detail-report',
  'calculation', 'data-maintenance', 'data-retrieval'
]);

/**
 * Repair common JSON issues from LLM output.
 * Reuses the same approach as vba-intent-extractor.js.
 */
function repairJson(text) {
  let repaired = text.replace(/,\s*([}\]])/g, '$1');
  try {
    return JSON.parse(repaired), repaired;
  } catch (_) {
    // Try closing unclosed structures
    let fixed = repaired;
    let inStr = false;
    let braces = 0, brackets = 0;
    for (let j = 0; j < fixed.length; j++) {
      const c = fixed[j];
      if (c === '\\' && inStr) { j++; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === '{') braces++;
      else if (c === '}') braces--;
      else if (c === '[') brackets++;
      else if (c === ']') brackets--;
    }
    while (braces > 0) { fixed += '}'; braces--; }
    while (brackets > 0) { fixed += ']'; brackets--; }
    return fixed;
  }
}

/**
 * Call the LLM to extract intents from structural data.
 *
 * @param {string} objectDescription - Text describing the object (from summarizeDefinition or SQL)
 * @param {string} objectType - 'form', 'report', or 'query'
 * @param {string} objectName - Name of the object
 * @param {Object|null} graphContext - Database context (tables, views, forms, reports)
 * @param {string} apiKey - Anthropic API key
 * @returns {Promise<Object>} Parsed intent JSON
 */
async function callLLM(objectDescription, objectType, objectName, graphContext, apiKey) {
  let contextStr = '';
  if (graphContext) {
    contextStr = '\n\nDatabase context:\n' + formatGraphContext(graphContext);
  }

  const systemPrompt = `${promptTemplate}${contextStr}`;

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
        content: `Extract business intents from this ${objectType} "${objectName}":\n\n${objectDescription}`
      }]
    })
  });

  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(errorData.error?.message || 'Intent extraction API request failed');
  }

  const data = await response.json();
  const text = data.content?.find(c => c.type === 'text')?.text || '';

  // Parse JSON — strip code fences if present
  let jsonText = text.trim();
  jsonText = jsonText.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();

  let result;
  try {
    result = JSON.parse(jsonText);
  } catch (parseErr) {
    const repaired = repairJson(jsonText);
    try {
      result = JSON.parse(repaired);
    } catch (repairErr) {
      throw new Error(`Failed to parse intent JSON for ${objectType} "${objectName}": ${parseErr.message}`);
    }
  }

  // Validate category
  if (result.category && !VALID_CATEGORIES.has(result.category)) {
    result.category = 'data-view'; // safe fallback
  }

  // Add timestamp
  result.extracted_at = new Date().toISOString();

  return result;
}

/**
 * Extract business intents from a form definition.
 *
 * @param {Object} definition - Form definition JSON
 * @param {string} formName - Form name
 * @param {Object|null} graphContext - Database context
 * @param {string} apiKey - Anthropic API key
 * @returns {Promise<Object>} Intent JSON with purpose, category, workflows, etc.
 */
async function extractFormIntents(definition, formName, graphContext, apiKey) {
  const description = summarizeDefinition(definition, 'form', formName);
  return callLLM(description, 'form', formName, graphContext, apiKey);
}

/**
 * Extract business intents from a report definition.
 *
 * @param {Object} definition - Report definition JSON
 * @param {string} reportName - Report name
 * @param {Object|null} graphContext - Database context
 * @param {string} apiKey - Anthropic API key
 * @returns {Promise<Object>} Intent JSON with purpose, category, grouping_purpose, etc.
 */
async function extractReportIntents(definition, reportName, graphContext, apiKey) {
  const description = summarizeDefinition(definition, 'report', reportName);
  return callLLM(description, 'report', reportName, graphContext, apiKey);
}

/**
 * Extract business intents from a query (view SQL).
 *
 * @param {string} viewSQL - The SQL definition of the view/function
 * @param {string} queryName - Query/view name
 * @param {Object|null} graphContext - Database context
 * @param {string} apiKey - Anthropic API key
 * @returns {Promise<Object>} Intent JSON with purpose, category, consumers, etc.
 */
async function extractQueryIntents(viewSQL, queryName, graphContext, apiKey) {
  const description = `SQL Definition:\n${viewSQL}`;
  return callLLM(description, 'query', queryName, graphContext, apiKey);
}

module.exports = {
  extractFormIntents,
  extractReportIntents,
  extractQueryIntents
};
