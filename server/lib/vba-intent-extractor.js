/**
 * VBA Intent Extractor — LLM-powered extraction of structured intents from VBA source.
 *
 * Sends VBA to Claude Sonnet with the intent-extraction prompt and parses
 * the structured JSON response.
 */

const path = require('path');
const fs = require('fs');
const { INTENT_VOCABULARY } = require('./vba-intent-mapper');

// Load the prompt template once at module load
let promptTemplate = '';
try {
  const templatePath = path.join(__dirname, '..', '..', 'skills', 'intent-extraction.md');
  promptTemplate = fs.readFileSync(templatePath, 'utf8');
} catch (err) {
  console.log('Could not load intent-extraction.md skill file');
}

// Known intent types for validation
const KNOWN_INTENT_TYPES = new Set(Object.keys(INTENT_VOCABULARY));

/**
 * Attempt to repair common JSON issues from LLM output.
 * Handles: unescaped quotes in string values (from VBA concatenation),
 * embedded \" that breaks JSON parsing.
 */
function repairJson(text) {
  // Strategy: walk through character by character, tracking JSON state.
  // When inside a string value, fix unescaped quotes that appear to be
  // VBA content (preceded by space or letter, not by backslash).
  let result = '';
  let inString = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];
    const prev = i > 0 ? text[i - 1] : '';

    if (!inString) {
      result += ch;
      if (ch === '"') {
        inString = true;
      }
    } else {
      // Inside a string
      if (ch === '\\' && i + 1 < text.length && text[i + 1] === '"') {
        // \\" — is this a legitimate escape or a VBA artifact?
        // Check if the character after the closing quote looks like JSON structure
        const afterQuote = text.substring(i + 2, i + 20).trimStart();
        if (afterQuote.match(/^[,}\]:\n\r]/)) {
          // This \" is actually the end of the string — output just the quote
          result += '"';
          i += 2;
          inString = false;
          continue;
        } else {
          // This \" is inside the string value — replace with single quote
          result += "'";
          i += 2;
          continue;
        }
      } else if (ch === '"') {
        // Unescaped quote — check if it's truly end of string
        const after = text.substring(i + 1, i + 20).trimStart();
        if (after.match(/^[,}\]:\n\r]/)) {
          // End of string
          result += '"';
          inString = false;
        } else if (after.match(/^\s*"/)) {
          // Looks like end of string followed by key/value
          result += '"';
          inString = false;
        } else {
          // Quote in the middle of a string — replace with single quote
          result += "'";
        }
      } else {
        result += ch;
      }
    }
    i++;
  }

  return result;
}

/**
 * Validate an extracted intent result.
 * Checks structure and flags unknown intent types.
 *
 * @param {Object} result - Parsed JSON from LLM
 * @returns {{ valid: boolean, unknown: string[], warnings: string[] }}
 */
function validateIntents(result) {
  const warnings = [];
  const unknown = [];

  if (!result || typeof result !== 'object') {
    return { valid: false, unknown: [], warnings: ['Result is not an object'] };
  }

  if (!Array.isArray(result.procedures)) {
    return { valid: false, unknown: [], warnings: ['Missing procedures array'] };
  }

  for (const proc of result.procedures) {
    if (!proc.name) {
      warnings.push('Procedure missing name');
    }
    if (!Array.isArray(proc.intents)) {
      warnings.push(`Procedure "${proc.name || '?'}" missing intents array`);
      continue;
    }

    validateIntentList(proc.intents, proc.name, unknown, warnings);
  }

  if (result.gaps && !Array.isArray(result.gaps)) {
    warnings.push('gaps should be an array');
  }

  return {
    valid: warnings.length === 0 && unknown.length === 0,
    unknown: [...new Set(unknown)],
    warnings
  };
}

/**
 * Recursively validate a list of intents.
 */
function validateIntentList(intents, procName, unknown, warnings) {
  for (const intent of intents) {
    if (!intent.type) {
      warnings.push(`Intent in "${procName}" missing type`);
      continue;
    }

    if (!KNOWN_INTENT_TYPES.has(intent.type)) {
      unknown.push(intent.type);
    }

    // Soft warnings for gaps missing question/suggestions
    if (intent.type === 'gap') {
      if (!intent.question) {
        warnings.push(`Gap in "${procName}" missing question field (vba_line: ${(intent.vba_line || '').substring(0, 50)})`);
      }
      if (!Array.isArray(intent.suggestions) || intent.suggestions.length === 0) {
        warnings.push(`Gap in "${procName}" missing suggestions field (vba_line: ${(intent.vba_line || '').substring(0, 50)})`);
      }
    }

    // Validate children of structural intents
    if (intent.then && Array.isArray(intent.then)) {
      validateIntentList(intent.then, procName, unknown, warnings);
    }
    if (intent.else && Array.isArray(intent.else)) {
      validateIntentList(intent.else, procName, unknown, warnings);
    }
    if (intent.children && Array.isArray(intent.children)) {
      validateIntentList(intent.children, procName, unknown, warnings);
    }
  }
}

/**
 * Extract intents from VBA source using Claude Sonnet.
 *
 * @param {string} vbaSource - The VBA source code
 * @param {string} moduleName - Name of the module
 * @param {Object} context - { app_objects, formDefinitions } for additional context
 * @param {string} apiKey - Anthropic API key
 * @returns {Promise<{ procedures: [...], gaps: [...] }>}
 */
async function extractIntents(vbaSource, moduleName, context, apiKey) {
  if (!vbaSource) {
    throw new Error('vbaSource is required');
  }
  if (!apiKey) {
    throw new Error('API key is required');
  }

  // Build context supplements
  let contextStr = '';
  if (context?.app_objects) {
    const parts = [];
    if (context.app_objects.tables?.length)  parts.push(`Tables: ${context.app_objects.tables.join(', ')}`);
    if (context.app_objects.queries?.length) parts.push(`Queries: ${context.app_objects.queries.join(', ')}`);
    if (context.app_objects.forms?.length)   parts.push(`Forms: ${context.app_objects.forms.join(', ')}`);
    if (context.app_objects.reports?.length) parts.push(`Reports: ${context.app_objects.reports.join(', ')}`);
    if (parts.length > 0) {
      contextStr = '\n\nDatabase objects in this application:\n' + parts.join('\n');
    }
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
        content: `Extract intents from this VBA module "${moduleName}":\n\n${vbaSource}`
      }]
    })
  });

  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(errorData.error?.message || 'Intent extraction API request failed');
  }

  const data = await response.json();
  const text = data.content?.find(c => c.type === 'text')?.text || '';

  // Parse JSON — strip code fences if the LLM included them despite instructions
  let jsonText = text.trim();
  jsonText = jsonText.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();

  let result;
  try {
    result = JSON.parse(jsonText);
  } catch (parseErr) {
    // Attempt JSON repair: fix common LLM issues with embedded VBA expressions
    const repaired = repairJson(jsonText);
    try {
      result = JSON.parse(repaired);
    } catch (repairErr) {
      throw new Error(`Failed to parse intent JSON: ${parseErr.message}\nRaw: ${jsonText.substring(0, 500)}`);
    }
  }

  return result;
}

/**
 * Collect all gaps from an intent extraction result.
 * Returns flat array of { procedure, index, vba_line, reason, path }
 */
function collectGaps(intentResult) {
  const gaps = [];

  function walk(intents, procName, path) {
    for (let i = 0; i < intents.length; i++) {
      const intent = intents[i];
      const currentPath = [...path, i];
      if (intent.type === 'gap') {
        gaps.push({
          procedure: procName,
          vba_line: intent.vba_line || '',
          reason: intent.reason || '',
          gap_id: intent.gap_id || null,
          path: currentPath
        });
      }
      if (intent.then) walk(intent.then, procName, [...currentPath, 'then']);
      if (intent.else) walk(intent.else, procName, [...currentPath, 'else']);
      if (intent.children) walk(intent.children, procName, [...currentPath, 'children']);
    }
  }

  if (intentResult.procedures) {
    for (let p = 0; p < intentResult.procedures.length; p++) {
      const proc = intentResult.procedures[p];
      walk(proc.intents || [], proc.name, ['procedures', p, 'intents']);
    }
  }
  if (intentResult.gaps) {
    for (let g = 0; g < intentResult.gaps.length; g++) {
      gaps.push({
        procedure: '(module-level)',
        vba_line: intentResult.gaps[g].vba_line || '',
        reason: intentResult.gaps[g].reason || '',
        path: ['gaps', g]
      });
    }
  }

  return gaps;
}

/**
 * Generate questions and suggestions for gaps via a focused LLM call.
 * Takes the collected gaps and VBA source, returns an array of { question, suggestions }
 * indexed to match the input gaps array.
 *
 * @param {Array} gaps - From collectGaps()
 * @param {string} vbaSource - Original VBA source for context
 * @param {string} moduleName - Module name
 * @param {string} apiKey - Anthropic API key
 * @returns {Promise<Array<{ question: string, suggestions: string[] }>>}
 */
async function generateGapQuestions(gaps, vbaSource, moduleName, apiKey) {
  if (!gaps.length || !apiKey) return [];

  const gapList = gaps.map((g, i) =>
    `${i + 1}. Procedure: ${g.procedure}\n   VBA: ${g.vba_line}\n   Reason: ${g.reason}`
  ).join('\n');

  const systemPrompt = `You generate plain-English questions for a business user about VBA code patterns that can't be directly translated to a web application.

For each gap, produce:
- "question": A clear question describing what the VBA code does and asking how it should work in the web app. Write for a business user, not a developer.
- "suggestions": An array of 2-5 concrete alternatives. Always end with "Skip this functionality".

Output ONLY a JSON array — no markdown, no explanations. Each element corresponds to a gap by index.

Example output:
[
  {
    "question": "This code exports the Orders table to an Excel file. How should this work in the web app?",
    "suggestions": ["Download as CSV file", "Generate Excel server-side", "Skip this functionality"]
  }
]`;

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
      messages: [{
        role: 'user',
        content: `Module "${moduleName}" has ${gaps.length} unmappable VBA patterns. Here is the VBA source for context:\n\n${vbaSource.substring(0, 3000)}\n\nGaps to generate questions for:\n${gapList}`
      }]
    })
  });

  if (!response.ok) {
    console.error('Gap question generation API error');
    return [];
  }

  const data = await response.json();
  let text = data.content?.find(c => c.type === 'text')?.text || '';
  text = text.trim().replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();

  try {
    const questions = JSON.parse(text);
    if (Array.isArray(questions)) return questions;
  } catch (err) {
    try {
      const repaired = repairJson(text);
      const questions = JSON.parse(repaired);
      if (Array.isArray(questions)) return questions;
    } catch (e) {
      console.error('Failed to parse gap questions JSON:', e.message);
    }
  }

  return [];
}

/**
 * Apply generated questions back to the intent result, mutating in place.
 * Uses the path from collectGaps to navigate to each gap intent.
 */
function applyGapQuestions(intentResult, gaps, questions) {
  for (let i = 0; i < gaps.length && i < questions.length; i++) {
    const q = questions[i];
    if (!q || !q.question) continue;

    // Navigate to the gap using its path
    let obj = intentResult;
    const path = gaps[i].path;
    for (const key of path) {
      obj = obj[key];
      if (!obj) break;
    }

    if (obj && obj.type === 'gap') {
      obj.question = q.question;
      if (Array.isArray(q.suggestions) && q.suggestions.length > 0) {
        obj.suggestions = q.suggestions;
      } else {
        obj.suggestions = ['Implement equivalent functionality', 'Skip this functionality'];
      }
    }
  }
}

module.exports = {
  extractIntents,
  validateIntents,
  repairJson,
  collectGaps,
  generateGapQuestions,
  applyGapQuestions,
  KNOWN_INTENT_TYPES
};
