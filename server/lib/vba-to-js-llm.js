/**
 * LLM fallback for VBA-to-JS handler translation.
 * When the deterministic parser produces JS with comment lines (// [VBA] ...),
 * this module sends the handler + intent context to Claude for improved translation.
 *
 * Follows the same pattern as query-converter/llm-fallback.js:
 * deterministic pass first, LLM only for partial failures, with clear context.
 */

const fs = require('fs');
const path = require('path');

// Load system prompt from skills file (same pattern as intent extraction)
const SYSTEM_PROMPT_PATH = path.join(__dirname, '..', '..', 'skills', 'vba-to-js-llm-prompt.md');
let systemPromptCache = null;

function loadSystemPrompt() {
  if (!systemPromptCache) {
    systemPromptCache = fs.readFileSync(SYSTEM_PROMPT_PATH, 'utf8');
  }
  return systemPromptCache;
}

/**
 * Desktop-only patterns that are never worth sending to the LLM.
 * If ALL comment lines match these, skip the handler.
 */
const DESKTOP_NOOP_PATTERNS = [
  /Debug\.Print/i,
  /Debug\.Assert/i,
  /\bDoEvents\b/i,
  /Screen\.MousePointer/i,
  /Me\.Painting/i,
  /Application\.Echo/i,
];

/**
 * Determine if a handler entry needs LLM fallback.
 *
 * Returns true if the handler has a mix of clean JS and comment lines
 * that could potentially be improved by an LLM.
 *
 * @param {Object} handler - Handler entry from parseVbaToHandlers
 * @param {string} handler.js - The generated JS code
 * @returns {boolean}
 */
function needsLLMFallback(handler) {
  if (!handler || !handler.js) return false;

  const lines = handler.js.split('\n').filter(l => l.trim());
  if (lines.length === 0) return false;

  const commentLines = lines.filter(l => l.trim().startsWith('// [VBA]'));
  const cleanLines = lines.filter(l => !l.trim().startsWith('// [VBA]') && !l.trim().startsWith('//'));

  // Fully clean — no fallback needed
  if (commentLines.length === 0) return false;

  // All comments — entire procedure is untranslatable, skip
  if (cleanLines.length === 0) return false;

  // Check if all comment lines are desktop-only no-ops
  const allNoOps = commentLines.every(line => {
    const vbaContent = line.trim().replace(/^\/\/\s*\[VBA\]\s*/, '');
    return DESKTOP_NOOP_PATTERNS.some(pattern => pattern.test(vbaContent));
  });
  if (allNoOps) return false;

  // Mixed handler: some clean + some comments — worth trying LLM
  return true;
}

/**
 * Build system + user messages for the Anthropic API.
 *
 * @param {Object} handler - Handler entry from parseVbaToHandlers
 * @param {string} vbaSource - Raw VBA source for this procedure
 * @param {Object|null} intent - Matching procedure intent from shared.intents
 * @param {Array} allHandlers - All handlers in the module (for context)
 * @returns {{ system: string, user: string }}
 */
function buildLLMPrompt(handler, vbaSource, intent, allHandlers) {
  const system = loadSystemPrompt();

  // Build context about other handlers in the module
  const otherHandlers = (allHandlers || [])
    .filter(h => h.key !== handler.key && h.js && !h.js.includes('// [VBA]'))
    .map(h => h.key)
    .slice(0, 20); // Cap at 20 to avoid token bloat

  const otherHandlersText = otherHandlers.length > 0
    ? otherHandlers.join(', ')
    : '(none)';

  const intentText = intent
    ? JSON.stringify(intent, null, 2)
    : '(no intent data available)';

  const user = `## Procedure: ${handler.procedure || handler.key}
## Event: ${handler.event || 'unknown'} on ${handler.control || 'form'}

## VBA Source:
${vbaSource || '(not available)'}

## Current Translation (deterministic pass):
${handler.js}

## Intent:
${intentText}

## Other Handlers in Module (translated cleanly):
${otherHandlersText}

Improve the translation by replacing comment lines with working AC.* calls where possible.
Keep existing clean translations unchanged. Leave genuinely untranslatable patterns as comments.`;

  return { system, user };
}

/**
 * Validate that LLM output looks like reasonable AC.* code.
 * Returns true if the code passes basic validation.
 */
function validateLLMOutput(jsCode) {
  if (!jsCode || typeof jsCode !== 'string') return false;
  const trimmed = jsCode.trim();
  if (trimmed.length === 0) return false;

  // Reject: contains require/import (trying to load modules)
  if (/\brequire\s*\(/.test(trimmed)) return false;
  if (/\bimport\s+/.test(trimmed)) return false;

  // Reject: contains document.* or window.* (except window.AC)
  if (/\bdocument\./.test(trimmed)) return false;
  if (/\bwindow\.(?!AC\b)/.test(trimmed)) return false;

  // Reject: contains fetch/XMLHttpRequest (trying to make network calls)
  if (/\bfetch\s*\(/.test(trimmed)) return false;
  if (/\bXMLHttpRequest\b/.test(trimmed)) return false;

  // Reject: contains eval (code injection risk)
  if (/\beval\s*\(/.test(trimmed)) return false;

  // Should contain at least one AC.* call or be a reasonable control flow
  const hasACCall = /\bAC\./.test(trimmed);
  const hasControlFlow = /\b(if|for|while|switch|return|let|const|var)\b/.test(trimmed);
  const hasComment = /\/\//.test(trimmed);
  if (!hasACCall && !hasControlFlow && !hasComment) return false;

  return true;
}

/**
 * Translate a single handler using the LLM.
 *
 * @param {Object} handler - Handler entry from parseVbaToHandlers
 * @param {string} vbaSource - Raw VBA source for this procedure
 * @param {Object|null} intent - Matching procedure intent
 * @param {Array} allHandlers - All handlers in the module
 * @param {string} apiKey - Anthropic API key
 * @returns {Promise<{ js: string, llm: true }|null>} Updated handler fields or null on failure
 */
async function translateHandlerWithLLM(handler, vbaSource, intent, allHandlers, apiKey) {
  const { system, user } = buildLLMPrompt(handler, vbaSource, intent, allHandlers);

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
      system,
      messages: [{ role: 'user', content: user }]
    }),
    signal: AbortSignal.timeout(30000) // 30s per handler
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    const errMsg = errorData.error?.message || `API request failed with status ${response.status}`;
    throw new Error(`LLM API error: ${errMsg}`);
  }

  const data = await response.json();

  // Extract text content
  let jsText = '';
  for (const block of data.content) {
    if (block.type === 'text') {
      jsText += block.text;
    }
  }

  if (!jsText.trim()) return null;

  // Strip markdown code fences if present
  jsText = jsText.replace(/^```(?:javascript|js)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();

  // Validate the output
  if (!validateLLMOutput(jsText)) return null;

  return { js: jsText, llm: true };
}

module.exports = {
  needsLLMFallback,
  buildLLMPrompt,
  translateHandlerWithLLM,
  validateLLMOutput,
  // Exposed for testing
  DESKTOP_NOOP_PATTERNS,
  loadSystemPrompt,
};
