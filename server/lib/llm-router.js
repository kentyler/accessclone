/**
 * LLM Router — registry loading, multi-provider calling, secretary routing
 *
 * Registry lives in settings/config.json under the "llm-registry" key.
 * API keys live in secrets.json keyed by provider name.
 */

const fs = require('fs').promises;
const path = require('path');

/**
 * Load the LLM registry from config.json.
 * Returns the array (possibly empty) from config["llm-registry"].
 */
async function loadRegistry(settingsDir) {
  try {
    const filepath = path.join(settingsDir, 'config.json');
    const content = await fs.readFile(filepath, 'utf8');
    const config = JSON.parse(content);
    return config['llm-registry'] || [];
  } catch (err) {
    // No config file or parse error — empty registry
    return [];
  }
}

/**
 * Look up an API key for a provider from secrets.
 */
function getApiKey(provider, secrets) {
  if (!secrets) return undefined;
  // "google" provider uses "gemini" key in secrets
  const key = provider === 'google' ? 'gemini' : provider;
  return secrets[key]?.api_key;
}

/**
 * Unified LLM caller — supports Anthropic and OpenAI APIs.
 * Returns { content: string, model: string }
 */
async function callLLM(provider, modelId, systemPrompt, messages, config, apiKey) {
  if (!apiKey) {
    throw new Error(`No API key for provider "${provider}"`);
  }

  const maxTokens = config?.max_tokens || 2048;
  const temperature = config?.temperature ?? 1.0;

  if (provider === 'anthropic') {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: modelId,
        max_tokens: maxTokens,
        temperature,
        system: systemPrompt,
        messages
      })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error?.message || `Anthropic API returned ${response.status}`);
    }

    const data = await response.json();
    const content = data.content?.find(c => c.type === 'text')?.text || '';
    return { content, model: modelId };

  } else if (provider === 'openai') {
    // Convert to OpenAI format: system message + user messages
    const openaiMessages = [
      { role: 'system', content: systemPrompt },
      ...messages
    ];

    // GPT-5+ only supports temperature=1; omit it when non-default to avoid API errors
    const openaiBody = {
      model: modelId,
      max_completion_tokens: maxTokens,
      messages: openaiMessages
    };
    if (temperature === 1.0) openaiBody.temperature = temperature;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(openaiBody)
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error?.message || `OpenAI API returned ${response.status}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '';
    return { content, model: modelId };

  } else if (provider === 'google') {
    // Gemini generateContent API
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`;

    // Build contents array: system instruction + messages
    const contents = messages.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }]
    }));

    const body = {
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents,
      generationConfig: {
        maxOutputTokens: maxTokens,
        temperature
      }
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error?.message || `Google API returned ${response.status}`);
    }

    const data = await response.json();
    const content = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    return { content, model: modelId };

  } else {
    throw new Error(`Unsupported provider: "${provider}"`);
  }
}

/**
 * Secretary judgment #1: Model selection.
 * Fast, single-turn call. Reads the entry and picks which model(s)
 * should respond based on what the entry is — no corpus access needed.
 *
 * @param {string} entryText - The user's entry
 * @param {object[]} registry - Full LLM registry
 * @param {object} secrets - API keys
 * @returns {{ selectedModels: object[], reasoning: string }}
 */
async function selectModels(entryText, registry, secrets) {
  const enabledModels = registry.filter(m => m.enabled);
  if (enabledModels.length === 0) return { selectedModels: [], sampling: 'similarity', samplingParams: {}, reasoning: 'no models' };
  if (enabledModels.length === 1) return { selectedModels: enabledModels, sampling: 'similarity', samplingParams: {}, reasoning: 'single model' };

  const secretary = enabledModels.find(m => m.is_secretary) || enabledModels[0];
  const apiKey = getApiKey(secretary.provider, secrets);
  if (!apiKey) {
    return { selectedModels: [secretary], sampling: 'similarity', samplingParams: {}, reasoning: 'no secretary API key' };
  }

  const modelList = enabledModels.map(m =>
    `- id: "${m.id}", name: "${m.name}", description: "${m.description || 'No description'}"`
  ).join('\n');

  const systemPrompt = `You are a secretary. Given a new entry, make two judgments.

JUDGMENT 1: MODEL SELECTION
Which model(s) should respond to this entry?

AVAILABLE MODELS
${modelList}

Choose based on what the entry calls for:
- Sustained reasoning or philosophical depth → a stronger, more careful model
- Quick observation, brief note, working-mode entry → a fast, precise model
- Entry that would benefit from multiple perspectives → two or more models from different providers
- Something that might get an echo-chamber response from one provider → include a model from a different provider

JUDGMENT 2: CORPUS SAMPLING
Which strategy should be used to select context from the corpus?

AVAILABLE STRATEGIES
- similarity: Entries semantically closest to this entry. The default. Useful but tends toward confirmation.
- distance: Entries most semantically DISTANT from this entry. Surfaces material the user would never connect to the current entry. Use for unexpected juxtaposition.
- random: Uniform random sample. Maximum surprise, no relevance guarantee.
- time_range: Entries from a specific period. Use when temporal context matters. Requires start and end dates (ISO 8601).
- mixed: Combine multiple strategies (specify in sampling_params).

Choose based on what the entry is — not on what the corpus contains.

Respond with ONLY a JSON block:

\`\`\`json
{
  "models": ["model-id-1"],
  "sampling": "similarity",
  "sampling_params": {},
  "reasoning": "one sentence on why these models and this sampling"
}
\`\`\`

sampling_params is optional. For time_range, include {"start": "...", "end": "..."}. For mixed, include {"strategies": ["similarity", "random"]}. For others, omit or leave empty.

Do not respond to the entry content. Do not explain your thinking beyond the reasoning field.`;

  try {
    const result = await callLLM(
      secretary.provider,
      secretary.model_id,
      systemPrompt,
      [{ role: 'user', content: entryText }],
      { max_tokens: 256, temperature: 0 },
      apiKey
    );

    const jsonMatch = result.content.match(/```json\s*([\s\S]*?)```/) ||
                      result.content.match(/\{[\s\S]*"models"[\s\S]*\}/);
    if (jsonMatch) {
      const jsonStr = jsonMatch[1] || jsonMatch[0];
      const decision = JSON.parse(jsonStr);
      const selectedIds = decision.models || [];
      const selected = enabledModels.filter(m => selectedIds.includes(m.id));
      if (selected.length > 0) {
        return {
          selectedModels: selected,
          sampling: decision.sampling || 'similarity',
          samplingParams: decision.sampling_params || {},
          reasoning: decision.reasoning || ''
        };
      }
    }
  } catch (err) {
    console.error('Secretary routing failed, falling back:', err.message);
  }

  return { selectedModels: [secretary], sampling: 'similarity', samplingParams: {}, reasoning: 'fallback — routing failed' };
}

module.exports = { loadRegistry, callLLM, selectModels, getApiKey };
