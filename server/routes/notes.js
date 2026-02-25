/**
 * Notes routes — append-only corpus with LLM response
 *
 * A corpus that writes back: human writes entries, LLM reads each new entry
 * against everything that came before and responds with what changed, connected,
 * or was revealed.
 *
 * Context selection: semantic retrieval via pgvector embeddings (OpenAI
 * text-embedding-3-small). Falls back to 20 most recent if no embeddings.
 *
 * Supports multi-LLM routing via the registry in settings/config.json.
 * A "secretary" LLM inspects each prompt and decides which registered LLMs
 * should respond. Multiple LLMs can respond to a single entry.
 */

const express = require('express');
const { logError } = require('../lib/events');
const { loadRegistry, callLLM, selectModels, getApiKey } = require('../lib/llm-router');
const { embed, pgVector } = require('../lib/embeddings');

const SEMANTIC_LIMIT = 20;

const SYSTEM_PROMPT = `You are a thoughtful reader and interlocutor. The user writes entries — thoughts, observations, arguments, questions, fragments. You respond to each new entry directly, engaging with its substance.

Your primary job is to respond to what the entry says. Engage with its ideas, implications, tensions, and questions. The corpus context provided is background — it tells you what the writer has been thinking about, so you can connect the new entry to earlier threads when relevant. But the new entry is always the focus. Do not comment on the corpus itself, its patterns, its metadata, or its mechanical properties (duplicates, formatting, structure). Respond to the content.

When you respond, you may:
- Extend or challenge the entry's argument
- Surface implications the writer may not see from inside the act of writing
- Connect the entry to earlier threads in the corpus when doing so illuminates the current entry
- Ask a question — the kind a careful reader would ask

Do not summarize the entry back. Do not praise it. Do not give advice unless the entry clearly asks for it. Do not comment on the state of the corpus, the frequency of entries, or any technical aspects of how entries arrived.

Vary your length naturally. A brief extension of a running thread might need two sentences. A genuine shift might need several paragraphs.

Write plain prose. No bullet points, no headers, no markdown formatting, no bold or italic.`;

module.exports = function(pool, secrets, settingsDir) {
  const router = express.Router();

  /**
   * Embed a text string and store it on a corpus entry.
   * Fully graceful — never throws. Returns vector or null.
   */
  async function embedAndStore(entryId, text) {
    try {
      const vector = await embed(text, secrets);
      if (vector) {
        await pool.query(
          'UPDATE shared.corpus_entries SET embedding = $1 WHERE id = $2',
          [pgVector(vector), entryId]
        );
      }
      return vector;
    } catch (err) {
      // pgvector not installed, column missing, etc. — degrade silently
      console.error('embedAndStore failed (non-fatal):', err.message);
      return null;
    }
  }

  // ================================================================
  // Corpus Access Primitives
  // Building blocks the secretary composes. Each returns
  // rows with { id, entry_type, content } and logs the retrieval.
  // ================================================================

  /**
   * Log a retrieval event: which entry triggered it, which strategy,
   * and which corpus entries (with rank) were sent as context.
   * Non-fatal — never throws.
   */
  async function logRetrieval(entryId, strategy, rows) {
    if (!rows || rows.length === 0) return;
    try {
      const retResult = await pool.query(
        `INSERT INTO shared.corpus_retrievals (entry_id, strategy)
         VALUES ($1, $2) RETURNING id`,
        [entryId, strategy]
      );
      const retrievalId = retResult.rows[0].id;
      const params = [];
      const placeholders = rows.map((r, i) => {
        const base = i * 3;
        params.push(retrievalId, r.id, i + 1);
        return `($${base + 1}, $${base + 2}, $${base + 3})`;
      });
      await pool.query(
        `INSERT INTO shared.corpus_retrieval_entries (retrieval_id, corpus_entry_id, rank)
         VALUES ${placeholders.join(', ')}`,
        params
      );
    } catch (err) {
      console.error('Retrieval logging failed (non-fatal):', err.message);
    }
  }

  /**
   * retrieve_by_similarity — entries closest to the query embedding.
   * The obvious default. Useful but tends toward confirmation.
   */
  async function retrieveBySimilarity(excludeId, queryVector, n) {
    n = n || SEMANTIC_LIMIT;
    const result = await pool.query(
      `SELECT id, entry_type, content FROM shared.corpus_entries
       WHERE id != $1 AND embedding IS NOT NULL
       ORDER BY embedding <=> $2
       LIMIT $3`,
      [excludeId, pgVector(queryVector), n]
    );
    await logRetrieval(excludeId, 'similarity', result.rows);
    return result.rows;
  }

  /**
   * retrieve_by_distance — entries most semantically DISTANT from the prompt.
   * The inverse of similarity search. Surfaces material the user
   * would never have thought to connect to the current prompt.
   */
  async function retrieveByDistance(excludeId, queryVector, n) {
    n = n || SEMANTIC_LIMIT;
    const result = await pool.query(
      `SELECT id, entry_type, content FROM shared.corpus_entries
       WHERE id != $1 AND embedding IS NOT NULL
       ORDER BY embedding <=> $2 DESC
       LIMIT $3`,
      [excludeId, pgVector(queryVector), n]
    );
    await logRetrieval(excludeId, 'distance', result.rows);
    return result.rows;
  }

  /**
   * retrieve_by_time_range — entries from a specific period.
   * Supports recency sampling and historical sampling.
   */
  async function retrieveByTimeRange(excludeId, start, end, n) {
    n = n || SEMANTIC_LIMIT;
    const result = await pool.query(
      `SELECT id, entry_type, content FROM shared.corpus_entries
       WHERE id != $1 AND created_at >= $2 AND created_at <= $3
       ORDER BY created_at DESC
       LIMIT $4`,
      [excludeId, start, end, n]
    );
    await logRetrieval(excludeId, 'time_range', result.rows);
    return result.rows;
  }

  /**
   * retrieve_random — uniform random sample across the entire corpus.
   * Maximum surprise. No relevance guarantee.
   */
  async function retrieveRandom(excludeId, n) {
    n = n || SEMANTIC_LIMIT;
    const result = await pool.query(
      `SELECT id, entry_type, content FROM shared.corpus_entries
       WHERE id != $1
       ORDER BY RANDOM()
       LIMIT $2`,
      [excludeId, n]
    );
    await logRetrieval(excludeId, 'random', result.rows);
    return result.rows;
  }

  /**
   * Default retrieval: similarity with recency fallback.
   * Used by the POST route when no secretary is routing.
   */
  async function retrieveContext(excludeId, queryVector) {
    // Try semantic retrieval first
    if (queryVector) {
      try {
        const rows = await retrieveBySimilarity(excludeId, queryVector);
        if (rows.length > 0) return rows;
      } catch (err) {
        console.error('Semantic retrieval failed (falling back to recency):', err.message);
      }
    }

    // Fallback: most recent entries
    const result = await pool.query(
      `SELECT id, entry_type, content FROM shared.corpus_entries
       WHERE id != $1
       ORDER BY created_at DESC LIMIT $2`,
      [excludeId, SEMANTIC_LIMIT]
    );
    const rows = result.rows.reverse(); // chronological
    await logRetrieval(excludeId, 'recency', rows);
    return rows;
  }

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
   * Fetch a single entry + all its LLM responses
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
      let responses = [];

      if (entry.entry_type === 'human') {
        const responseResult = await pool.query(
          'SELECT * FROM shared.corpus_entries WHERE parent_id = $1 ORDER BY created_at ASC',
          [id]
        );
        responses = responseResult.rows;

        // Backward compat: if no sampling_strategy on the human entry, look it up from retrieval log
        if (!entry.sampling_strategy) {
          try {
            const retResult = await pool.query(
              'SELECT strategy FROM shared.corpus_retrievals WHERE entry_id = $1 ORDER BY created_at DESC LIMIT 1',
              [id]
            );
            if (retResult.rows.length > 0) {
              entry.sampling_strategy = retResult.rows[0].strategy;
            }
          } catch (_) { /* column/table may not exist */ }
        }
      }

      res.json({ entry, responses });
    } catch (err) {
      logError(pool, 'GET /api/notes/:id', 'Failed to fetch note', err, {});
      res.status(500).json({ error: 'Failed to fetch note' });
    }
  });

  /**
   * Execute a sampling strategy chosen by the secretary.
   * Calls the appropriate primitive(s) and returns the entries.
   */
  async function executeSampling(entryId, queryVector, sampling, params) {
    switch (sampling) {
      case 'distance':
        if (!queryVector) break;
        return await retrieveByDistance(entryId, queryVector);
      case 'random':
        return await retrieveRandom(entryId);
      case 'time_range':
        if (params.start && params.end) {
          return await retrieveByTimeRange(entryId, params.start, params.end);
        }
        break;
      case 'mixed': {
        const strategies = params.strategies || ['similarity', 'random'];
        const perStrategy = Math.ceil(SEMANTIC_LIMIT / strategies.length);
        const all = [];
        const seen = new Set();
        for (const s of strategies) {
          const rows = await executeSampling(entryId, queryVector, s, params);
          for (const row of rows.slice(0, perStrategy)) {
            if (!seen.has(row.id)) {
              seen.add(row.id);
              all.push(row);
            }
          }
        }
        return all;
      }
      case 'similarity':
      default:
        if (queryVector) {
          try {
            const rows = await retrieveBySimilarity(entryId, queryVector);
            if (rows.length > 0) return rows;
          } catch (err) {
            console.error('Similarity retrieval failed:', err.message);
          }
        }
        break;
    }
    // Fallback: recency
    return await retrieveContext(entryId, queryVector);
  }

  /**
   * POST /api/notes
   * Create a human entry → embed → secretary samples corpus + picks models → LLM(s) respond → embed responses
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

      // Embed the new entry
      const queryVector = await embedAndStore(humanEntry.id, content.trim());

      // Try registry-based secretary routing
      const registry = await loadRegistry(settingsDir);
      const enabledModels = registry.filter(m => m.enabled);

      let corpusEntries = [];
      let selectedModels = [];
      let reasoning = '';
      let samplingStrategy = null;

      if (enabledModels.length > 0) {
        // Secretary reads the entry and makes both judgments in one call:
        // which model(s) to engage, and which sampling strategy to use.
        try {
          const routing = await selectModels(content.trim(), registry, secrets);
          selectedModels = routing.selectedModels;
          reasoning = routing.reasoning;
          samplingStrategy = routing.sampling || 'similarity';
          // Execute the sampling strategy the secretary chose
          corpusEntries = await executeSampling(
            humanEntry.id, queryVector, routing.sampling, routing.samplingParams
          );
        } catch (routeErr) {
          logError(pool, 'POST /api/notes', 'Secretary routing failed', routeErr, {});
          selectedModels = [enabledModels.find(m => m.is_secretary) || enabledModels[0]];
          samplingStrategy = 'similarity';
          reasoning = 'fallback — routing failed';
          corpusEntries = await retrieveContext(humanEntry.id, queryVector);
        }
      } else {
        // No registry — default retrieval + hardcoded model
        samplingStrategy = 'similarity';
        corpusEntries = await retrieveContext(humanEntry.id, queryVector);
      }

      // Persist routing metadata on the human entry
      if (samplingStrategy || reasoning) {
        try {
          await pool.query(
            'UPDATE shared.corpus_entries SET sampling_strategy = $1, routing_reasoning = $2 WHERE id = $3',
            [samplingStrategy, reasoning || null, humanEntry.id]
          );
          humanEntry.sampling_strategy = samplingStrategy;
          humanEntry.routing_reasoning = reasoning || null;
        } catch (metaErr) {
          // Non-fatal — columns may not exist yet on older schemas
          console.error('Failed to persist routing metadata (non-fatal):', metaErr.message);
        }
      }

      // Build corpus text for the responding model(s)
      const corpusText = corpusEntries.map(e => {
        const marker = e.entry_type === 'human' ? '[H]' : '[R]';
        return `${marker} ${e.content}`;
      }).join('\n\n---\n\n');

      const userMessage = [{
        role: 'user',
        content: `NEW ENTRY:\n\n${content.trim()}\n\n---\n\nBACKGROUND (earlier entries from the corpus for context):\n\n${corpusText}`
      }];

      let responses = [];

      if (selectedModels.length > 0) {
        // Call each selected LLM in parallel
        const llmResults = await Promise.allSettled(
          selectedModels.map(async (model) => {
            const apiKey = getApiKey(model.provider, secrets);
            const modelConfig = model.config || {};
            const result = await callLLM(
              model.provider,
              model.model_id,
              SYSTEM_PROMPT,
              userMessage,
              modelConfig,
              apiKey
            );
            return { ...result, modelName: model.name, temperature: modelConfig.temperature ?? 1.0 };
          })
        );

        // Insert successful responses and embed them
        for (const result of llmResults) {
          if (result.status === 'fulfilled' && result.value.content.trim()) {
            try {
              const llmResult = await pool.query(
                'INSERT INTO shared.corpus_entries (entry_type, content, parent_id, model_name, temperature) VALUES ($1, $2, $3, $4, $5) RETURNING *',
                ['llm', result.value.content.trim(), humanEntry.id, result.value.modelName, result.value.temperature]
              );
              const llmEntry = llmResult.rows[0];
              responses.push(llmEntry);

              // Embed the LLM response (fire-and-forget)
              embedAndStore(llmEntry.id, result.value.content.trim()).catch(() => {});
            } catch (insertErr) {
              logError(pool, 'POST /api/notes', 'Failed to insert LLM response', insertErr, {});
            }
          } else if (result.status === 'rejected') {
            logError(pool, 'POST /api/notes', 'LLM call failed', result.reason, {});
          }
        }
      } else {
        // No registry and no models — try hardcoded Claude Sonnet
        const apiKey = secrets.anthropic?.api_key || process.env.ANTHROPIC_API_KEY;
        if (apiKey) {
          try {
            const result = await callLLM(
              'anthropic',
              'claude-sonnet-4-20250514',
              SYSTEM_PROMPT,
              userMessage,
              { max_tokens: 2048 },
              apiKey
            );

            if (result.content.trim()) {
              const llmResult = await pool.query(
                'INSERT INTO shared.corpus_entries (entry_type, content, parent_id, model_name, temperature) VALUES ($1, $2, $3, $4, $5) RETURNING *',
                ['llm', result.content.trim(), humanEntry.id, 'Claude Sonnet', 1.0]
              );
              const llmEntry = llmResult.rows[0];
              responses.push(llmEntry);

              // Embed the LLM response (fire-and-forget)
              embedAndStore(llmEntry.id, result.content.trim()).catch(() => {});
            }
          } catch (llmErr) {
            logError(pool, 'POST /api/notes', 'LLM response failed', llmErr, {});
          }
        }
      }

      res.json({ entry: humanEntry, responses, reasoning, routing: { sampling: samplingStrategy, reasoning: reasoning || null } });
    } catch (err) {
      logError(pool, 'POST /api/notes', 'Failed to create note', err, {});
      res.status(500).json({ error: 'Failed to create note' });
    }
  });

  /**
   * POST /api/notes/:id/regenerate
   * Re-generate a response for an existing human entry with user-chosen settings.
   * Body: { model_name: string, temperature: number, sampling: string }
   * Returns the new LLM response entry.
   */
  router.post('/:id/regenerate', async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

      const { model_name, temperature, sampling } = req.body;
      console.log('Regenerate request:', { id, model_name, temperature, sampling });
      if (!model_name) return res.status(400).json({ error: 'model_name is required' });

      // Look up the human entry
      const entryResult = await pool.query(
        'SELECT * FROM shared.corpus_entries WHERE id = $1 AND entry_type = $2',
        [id, 'human']
      );
      if (entryResult.rows.length === 0) {
        return res.status(404).json({ error: 'Human entry not found' });
      }
      const humanEntry = entryResult.rows[0];

      // Find model in registry
      const registry = await loadRegistry(settingsDir);
      const model = registry.find(m => m.name === model_name);
      if (!model) {
        return res.status(400).json({ error: `Model "${model_name}" not found in registry` });
      }

      const apiKey = getApiKey(model.provider, secrets);
      if (!apiKey) {
        return res.status(400).json({ error: `No API key for provider "${model.provider}"` });
      }

      // Embed the entry text for corpus retrieval (returns JS array, safe for pgVector())
      const queryVector = await embed(humanEntry.content, secrets).catch(() => null);

      // Execute the user-chosen sampling strategy
      const chosenSampling = sampling || 'similarity';
      const corpusEntries = await executeSampling(id, queryVector, chosenSampling, {});

      // Build corpus text
      const corpusText = corpusEntries.map(e => {
        const marker = e.entry_type === 'human' ? '[H]' : '[R]';
        return `${marker} ${e.content}`;
      }).join('\n\n---\n\n');

      const userMessage = [{
        role: 'user',
        content: `NEW ENTRY:\n\n${humanEntry.content}\n\n---\n\nBACKGROUND (earlier entries from the corpus for context):\n\n${corpusText}`
      }];

      // Call the LLM with user-chosen temperature
      const chosenTemp = (temperature != null) ? temperature : (model.config?.temperature ?? 1.0);
      const modelConfig = { ...(model.config || {}), temperature: chosenTemp };

      let result;
      try {
        result = await callLLM(
          model.provider,
          model.model_id,
          SYSTEM_PROMPT,
          userMessage,
          modelConfig,
          apiKey
        );
      } catch (llmErr) {
        console.error(`Regenerate LLM error (${model.provider}/${model.model_id}):`, llmErr.message);
        return res.status(502).json({ error: llmErr.message });
      }

      if (!result.content.trim()) {
        return res.status(502).json({ error: 'LLM returned empty response' });
      }

      // Insert the new response (graceful fallback if temperature column missing)
      let llmEntry;
      try {
        const llmResult = await pool.query(
          'INSERT INTO shared.corpus_entries (entry_type, content, parent_id, model_name, temperature) VALUES ($1, $2, $3, $4, $5) RETURNING *',
          ['llm', result.content.trim(), id, model.name, chosenTemp]
        );
        llmEntry = llmResult.rows[0];
      } catch (colErr) {
        // temperature column may not exist yet — insert without it
        const llmResult = await pool.query(
          'INSERT INTO shared.corpus_entries (entry_type, content, parent_id, model_name) VALUES ($1, $2, $3, $4) RETURNING *',
          ['llm', result.content.trim(), id, model.name]
        );
        llmEntry = llmResult.rows[0];
        llmEntry.temperature = chosenTemp; // include in response even if not persisted
      }

      // Update the human entry's sampling metadata
      try {
        await pool.query(
          'UPDATE shared.corpus_entries SET sampling_strategy = $1 WHERE id = $2',
          [chosenSampling, id]
        );
      } catch (_) { /* non-fatal — column may not exist */ }

      // Embed the response (fire-and-forget)
      embedAndStore(llmEntry.id, result.content.trim()).catch(() => {});

      res.json({ response: llmEntry });
    } catch (err) {
      console.error('Regenerate error:', err.stack || err.message || err);
      logError(pool, 'POST /api/notes/:id/regenerate', 'Regenerate failed', err, {});
      res.status(500).json({ error: 'Regenerate failed: ' + err.message });
    }
  });

  /**
   * POST /api/notes/backfill-embeddings
   * Embed all entries that don't have embeddings yet.
   * For existing corpora to gain semantic retrieval without re-importing.
   */
  router.post('/backfill-embeddings', async (req, res) => {
    try {
      const countResult = await pool.query(
        'SELECT COUNT(*) as total FROM shared.corpus_entries'
      );
      const total = parseInt(countResult.rows[0].total);

      let toProcess;
      try {
        const nullResult = await pool.query(
          'SELECT id, content FROM shared.corpus_entries WHERE embedding IS NULL ORDER BY id'
        );
        toProcess = nullResult.rows;
      } catch (colErr) {
        // embedding column doesn't exist yet (pgvector not installed)
        return res.status(503).json({ error: 'Embedding column not available — is pgvector installed?' });
      }

      let processed = 0;
      for (const row of toProcess) {
        try {
          const vector = await embed(row.content, secrets);
          if (vector) {
            await pool.query(
              'UPDATE shared.corpus_entries SET embedding = $1 WHERE id = $2',
              [pgVector(vector), row.id]
            );
            processed++;
          }
        } catch (rowErr) {
          console.error(`Backfill entry ${row.id} failed:`, rowErr.message);
        }
      }

      res.json({ processed, total, pending: toProcess.length });
    } catch (err) {
      logError(pool, 'POST /api/notes/backfill-embeddings', 'Backfill failed', err, {});
      res.status(500).json({ error: 'Backfill failed' });
    }
  });

  return router;
};
