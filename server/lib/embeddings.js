/**
 * Embedding utilities — supports OpenAI and Google (Gemini) embedding APIs.
 * Provider selection: uses whichever has an API key in secrets (OpenAI checked first).
 * Both providers normalize to 1536 dimensions for a single pgvector column.
 * OpenAI text-embedding-3-small outputs 1536 natively.
 * Google text-embedding-004 outputs 768 natively — zero-padded to 1536.
 * Graceful: never throws, returns null on failure.
 */

const EMBED_DIMENSIONS = 1536;

/**
 * Embed via Google's Gemini embedding API.
 * Gemini text-embedding-004 maxes out at 768 dims natively.
 * We request its max and pad to EMBED_DIMENSIONS in normalizeDimensions().
 * @returns {number[]|null}
 */
async function embedGoogle(text, apiKey, model) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent?key=${apiKey}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content: { parts: [{ text }] }
    })
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    console.error(`Google embedding error (${response.status}):`, err.error?.message || 'Unknown');
    return null;
  }

  const data = await response.json();
  return data.embedding?.values || null;
}

/**
 * Embed via OpenAI's embedding API.
 * text-embedding-3-small outputs 1536 natively — no truncation needed.
 * @returns {number[]|null}
 */
async function embedOpenAI(text, apiKey, model) {
  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      input: text
    })
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    console.error(`OpenAI embedding error (${response.status}):`, err.error?.message || 'Unknown');
    return null;
  }

  const data = await response.json();
  return data.data?.[0]?.embedding || null;
}

/**
 * Normalize an embedding vector to EMBED_DIMENSIONS.
 * - Truncates if too long (valid for Matryoshka models like text-embedding-3-*)
 * - Zero-pads if too short (valid for cosine similarity — zeros don't contribute)
 * @param {number[]} vec
 * @returns {number[]|null}
 */
function normalizeDimensions(vec) {
  if (!vec || !Array.isArray(vec)) return null;
  if (vec.length === EMBED_DIMENSIONS) return vec;
  if (vec.length > EMBED_DIMENSIONS) {
    console.warn(`Embedding returned ${vec.length} dims, truncating to ${EMBED_DIMENSIONS}`);
    return vec.slice(0, EMBED_DIMENSIONS);
  }
  // Pad with zeros — preserves cosine similarity for the real dimensions
  const padded = new Array(EMBED_DIMENSIONS).fill(0);
  for (let i = 0; i < vec.length; i++) padded[i] = vec[i];
  return padded;
}

/**
 * Embed a text string. Picks provider automatically from secrets:
 *   - secrets.openai.api_key → OpenAI text-embedding-3-small (1536 native)
 *   - secrets.gemini.api_key → Google text-embedding-004 (768 native, zero-padded)
 * Returns null if no key configured or API error.
 *
 * @param {string} text - The text to embed
 * @param {object} secrets - Server secrets
 * @returns {number[]|null} Float array (1536 dimensions) or null
 */
async function embed(text, secrets) {
  try {
    let vec = null;

    // OpenAI — checked first
    const openaiKey = secrets?.openai?.api_key;
    if (openaiKey) {
      const model = secrets.openai.embedding_model || 'text-embedding-3-small';
      vec = await embedOpenAI(text, openaiKey, model);
      return normalizeDimensions(vec);
    }

    // Google (Gemini) fallback
    const googleKey = secrets?.gemini?.api_key;
    if (googleKey) {
      const model = secrets.gemini.embedding_model || 'text-embedding-004';
      vec = await embedGoogle(text, googleKey, model);
      return normalizeDimensions(vec);
    }

    return null;
  } catch (err) {
    console.error('Embedding request failed:', err.message);
    return null;
  }
}

/**
 * Format a float array as a pgvector literal string for SQL parameterization.
 * @param {number[]} embedding - Float array
 * @returns {string} pgvector literal e.g. "[0.1,0.2,...]"
 */
function pgVector(embedding) {
  return '[' + embedding.join(',') + ']';
}

module.exports = { embed, pgVector, EMBED_DIMENSIONS };
