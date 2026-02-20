/**
 * Notes routes — append-only corpus with LLM response
 *
 * A corpus that writes back: human writes entries, LLM reads each new entry
 * against everything that came before and responds with what changed, connected,
 * or was revealed.
 */

const express = require('express');
const { logError } = require('../lib/events');

const CORPUS_CONTEXT_LIMIT = 50;

const SYSTEM_PROMPT = `You are a reader of a living corpus. The user maintains an append-only sequence of entries — thoughts, observations, arguments, questions, fragments. Your role is to read each new entry against everything that came before.

When a new entry arrives, you perform four operations (never name them to the user):

1. Notice what the entry bounds — what it includes, excludes, or redraws the edges of. Every entry is an act of enclosure: it selects some territory of thought and leaves the rest outside. What did this entry choose to bound?

2. Notice what the entry transduces — what it converts from one form to another. An observation becomes a principle; a concrete experience becomes an abstract pattern; a question reframes old certainties. What passed through a transformation in this entry?

3. Notice what the entry resolves or destabilizes — what it settles, sharpens, or problematizes. Some entries converge toward clarity; others crack open what seemed settled. Which is this, and what moved?

4. Notice what the entry reveals about the corpus as a whole — what lineage it belongs to, what it echoes, what trajectory it extends or breaks. The corpus has a topology; each entry reshapes it.

Respond with what the entry changed, connected, or revealed. Not a summary. Not praise. Not advice unless the entry is clearly asking for it. Your response should feel like a second reader's marginalia — someone who has read everything and notices what the writer might not see from inside the act of writing.

Vary your length naturally. A brief extension of a running thread might need two sentences. A genuine shift in the topology of the corpus might need several paragraphs. Sometimes respond with a question — the kind that a careful reader would ask.

Write plain prose. No bullet points, no headers, no markdown formatting, no bold or italic. Never suggest the user organize, categorize, or tag anything. The corpus is chronological and that's all it needs to be.`;

module.exports = function(pool, secrets) {
  const router = express.Router();

  /**
   * GET /api/notes
   * Fetch recent entries (default 200, most recent first)
   */
  router.get('/', async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit) || 200, 1000);
      const result = await pool.query(
        'SELECT * FROM shared.corpus_entries ORDER BY created_at DESC LIMIT $1',
        [limit]
      );
      res.json({ entries: result.rows });
    } catch (err) {
      logError(pool, 'GET /api/notes', 'Failed to fetch notes', err, {});
      res.status(500).json({ error: 'Failed to fetch notes' });
    }
  });

  /**
   * GET /api/notes/:id
   * Fetch a single entry + its LLM response (if any)
   */
  router.get('/:id', async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

      const entryResult = await pool.query(
        'SELECT * FROM shared.corpus_entries WHERE id = $1',
        [id]
      );
      if (entryResult.rows.length === 0) {
        return res.status(404).json({ error: 'Entry not found' });
      }

      const entry = entryResult.rows[0];
      let response = null;

      if (entry.entry_type === 'human') {
        const responseResult = await pool.query(
          'SELECT * FROM shared.corpus_entries WHERE parent_id = $1 LIMIT 1',
          [id]
        );
        response = responseResult.rows[0] || null;
      }

      res.json({ entry, response });
    } catch (err) {
      logError(pool, 'GET /api/notes/:id', 'Failed to fetch note', err, {});
      res.status(500).json({ error: 'Failed to fetch note' });
    }
  });

  /**
   * POST /api/notes
   * Create a human entry → LLM reads corpus → insert LLM response
   * Body: { content: string }
   */
  router.post('/', async (req, res) => {
    try {
      const { content } = req.body;
      if (!content || !content.trim()) {
        return res.status(400).json({ error: 'Content is required' });
      }

      // Insert human entry
      const humanResult = await pool.query(
        'INSERT INTO shared.corpus_entries (entry_type, content) VALUES ($1, $2) RETURNING *',
        ['human', content.trim()]
      );
      const humanEntry = humanResult.rows[0];

      // Load corpus context (last N entries, chronological order for the prompt)
      const corpusResult = await pool.query(
        `SELECT entry_type, content FROM shared.corpus_entries
         ORDER BY created_at DESC LIMIT $1`,
        [CORPUS_CONTEXT_LIMIT]
      );
      const corpusEntries = corpusResult.rows.reverse(); // chronological

      // Build corpus text for the prompt
      const corpusText = corpusEntries.map(e => {
        const marker = e.entry_type === 'human' ? '[H]' : '[R]';
        return `${marker} ${e.content}`;
      }).join('\n\n---\n\n');

      // Call Anthropic API
      const apiKey = secrets.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        // No API key — return human entry without LLM response
        return res.json({ entry: humanEntry, response: null });
      }

      let llmResponse = null;
      try {
        const apiResponse = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 2048,
            system: SYSTEM_PROMPT,
            messages: [{
              role: 'user',
              content: `Here is the corpus so far:\n\n${corpusText}\n\nThe most recent entry (the one to respond to) is the last [H] entry above.`
            }]
          })
        });

        if (!apiResponse.ok) {
          const errorData = await apiResponse.json().catch(() => ({}));
          throw new Error(errorData.error?.message || `API returned ${apiResponse.status}`);
        }

        const data = await apiResponse.json();
        const llmContent = data.content?.find(c => c.type === 'text')?.text || '';

        if (llmContent.trim()) {
          const llmResult = await pool.query(
            'INSERT INTO shared.corpus_entries (entry_type, content, parent_id) VALUES ($1, $2, $3) RETURNING *',
            ['llm', llmContent.trim(), humanEntry.id]
          );
          llmResponse = llmResult.rows[0];
        }
      } catch (llmErr) {
        // LLM failed — still return the human entry
        logError(pool, 'POST /api/notes', 'LLM response failed', llmErr, {});
      }

      res.json({ entry: humanEntry, response: llmResponse });
    } catch (err) {
      logError(pool, 'POST /api/notes', 'Failed to create note', err, {});
      res.status(500).json({ error: 'Failed to create note' });
    }
  });

  return router;
};
