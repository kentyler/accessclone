const { getApiKey, selectModels } = require('../lib/llm-router');

// ============================================================
// getApiKey
// ============================================================

describe('getApiKey', () => {
  const secrets = {
    anthropic: { api_key: 'sk-ant-test' },
    openai: { api_key: 'sk-openai-test' },
    gemini: { api_key: 'AIza-test' }
  };

  test('returns anthropic key for anthropic provider', () => {
    expect(getApiKey('anthropic', secrets)).toBe('sk-ant-test');
  });

  test('returns openai key for openai provider', () => {
    expect(getApiKey('openai', secrets)).toBe('sk-openai-test');
  });

  test('maps google provider to gemini key in secrets', () => {
    expect(getApiKey('google', secrets)).toBe('AIza-test');
  });

  test('returns undefined for unknown provider', () => {
    expect(getApiKey('unknown', secrets)).toBeUndefined();
  });

  test('returns undefined when secrets is empty', () => {
    expect(getApiKey('anthropic', {})).toBeUndefined();
  });

  test('handles null secrets gracefully', () => {
    expect(getApiKey('anthropic', null)).toBeUndefined();
  });
});

// ============================================================
// selectModels — edge cases (no LLM calls)
// ============================================================

describe('selectModels edge cases', () => {
  test('returns empty when no models in registry', async () => {
    const result = await selectModels('test entry', [], {});
    expect(result.selectedModels).toEqual([]);
    expect(result.reasoning).toBe('no models');
  });

  test('returns single model when only one enabled', async () => {
    const registry = [
      { id: 'model-a', enabled: true, is_secretary: true, provider: 'anthropic', model_id: 'test' }
    ];
    const result = await selectModels('test entry', registry, {});
    expect(result.selectedModels).toHaveLength(1);
    expect(result.selectedModels[0].id).toBe('model-a');
    expect(result.reasoning).toBe('single model');
  });

  test('skips disabled models', async () => {
    const registry = [
      { id: 'model-a', enabled: true, is_secretary: true, provider: 'anthropic', model_id: 'test' },
      { id: 'model-b', enabled: false, provider: 'openai', model_id: 'test2' }
    ];
    const result = await selectModels('test entry', registry, {});
    expect(result.selectedModels).toHaveLength(1);
    expect(result.selectedModels[0].id).toBe('model-a');
  });

  test('falls back to secretary when no API key', async () => {
    const registry = [
      { id: 'model-a', enabled: true, is_secretary: true, provider: 'anthropic', model_id: 'test' },
      { id: 'model-b', enabled: true, provider: 'openai', model_id: 'test2' }
    ];
    const result = await selectModels('test entry', registry, {});
    expect(result.selectedModels).toHaveLength(1);
    expect(result.selectedModels[0].id).toBe('model-a');
    expect(result.reasoning).toBe('no secretary API key');
  });

  test('falls back to first model when no is_secretary flag', async () => {
    const registry = [
      { id: 'model-a', enabled: true, provider: 'anthropic', model_id: 'test' },
      { id: 'model-b', enabled: true, provider: 'openai', model_id: 'test2' }
    ];
    const result = await selectModels('test entry', registry, {});
    expect(result.selectedModels[0].id).toBe('model-a');
  });

  test('default sampling is similarity', async () => {
    const registry = [
      { id: 'model-a', enabled: true, is_secretary: true, provider: 'anthropic', model_id: 'test' }
    ];
    const result = await selectModels('test entry', registry, {});
    expect(result.sampling).toBe('similarity');
  });
});

// ============================================================
// selectModels — response parsing (mocked LLM call)
// ============================================================

describe('selectModels response parsing', () => {
  const registry = [
    { id: 'claude-opus', enabled: true, is_secretary: true, provider: 'anthropic', model_id: 'claude-opus-4-6', description: 'Deep reasoning' },
    { id: 'claude-sonnet', enabled: true, provider: 'anthropic', model_id: 'claude-sonnet-4-6', description: 'Fast' },
    { id: 'gpt-5', enabled: true, provider: 'openai', model_id: 'gpt-5', description: 'Different perspective' }
  ];
  const secrets = { anthropic: { api_key: 'sk-test' } };

  let mockFetch;

  beforeEach(() => {
    mockFetch = jest.fn();
    global.fetch = mockFetch;
  });

  afterEach(() => {
    delete global.fetch;
  });

  function mockLLMResponse(content) {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        content: [{ type: 'text', text: content }]
      })
    });
  }

  test('parses JSON in code block', async () => {
    mockLLMResponse('```json\n{"models": ["claude-sonnet"], "sampling": "similarity", "reasoning": "quick note"}\n```');
    const result = await selectModels('a brief thought', registry, secrets);
    expect(result.selectedModels).toHaveLength(1);
    expect(result.selectedModels[0].id).toBe('claude-sonnet');
    expect(result.sampling).toBe('similarity');
    expect(result.reasoning).toBe('quick note');
  });

  test('parses bare JSON without code block', async () => {
    mockLLMResponse('{"models": ["claude-opus", "gpt-5"], "sampling": "distance", "reasoning": "triangulate"}');
    const result = await selectModels('a deep question', registry, secrets);
    expect(result.selectedModels).toHaveLength(2);
    expect(result.selectedModels.map(m => m.id)).toEqual(['claude-opus', 'gpt-5']);
    expect(result.sampling).toBe('distance');
  });

  test('parses mixed sampling with params', async () => {
    mockLLMResponse('```json\n{"models": ["claude-opus"], "sampling": "mixed", "sampling_params": {"strategies": ["similarity", "random"]}, "reasoning": "mix it up"}\n```');
    const result = await selectModels('an exploration', registry, secrets);
    expect(result.sampling).toBe('mixed');
    expect(result.samplingParams.strategies).toEqual(['similarity', 'random']);
  });

  test('parses time_range sampling with params', async () => {
    mockLLMResponse('```json\n{"models": ["claude-sonnet"], "sampling": "time_range", "sampling_params": {"start": "2026-02-01", "end": "2026-02-15"}, "reasoning": "recent context"}\n```');
    const result = await selectModels('what was I thinking about?', registry, secrets);
    expect(result.sampling).toBe('time_range');
    expect(result.samplingParams.start).toBe('2026-02-01');
    expect(result.samplingParams.end).toBe('2026-02-15');
  });

  test('defaults sampling to similarity when missing from response', async () => {
    mockLLMResponse('```json\n{"models": ["claude-sonnet"], "reasoning": "quick"}\n```');
    const result = await selectModels('hello', registry, secrets);
    expect(result.sampling).toBe('similarity');
    expect(result.samplingParams).toEqual({});
  });

  test('falls back when response has unknown model ids', async () => {
    mockLLMResponse('```json\n{"models": ["nonexistent-model"], "reasoning": "oops"}\n```');
    const result = await selectModels('test', registry, secrets);
    // No valid models matched — falls back to secretary
    expect(result.selectedModels[0].id).toBe('claude-opus');
    expect(result.reasoning).toContain('fallback');
  });

  test('falls back when response is not valid JSON', async () => {
    mockLLMResponse('I think you should use claude-sonnet for this.');
    const result = await selectModels('test', registry, secrets);
    expect(result.selectedModels[0].id).toBe('claude-opus');
    expect(result.reasoning).toContain('fallback');
  });

  test('falls back when API call fails', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ error: { message: 'Internal error' } })
    });
    const result = await selectModels('test', registry, secrets);
    expect(result.selectedModels[0].id).toBe('claude-opus');
    expect(result.reasoning).toContain('fallback');
  });

  test('falls back when fetch throws', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));
    const result = await selectModels('test', registry, secrets);
    expect(result.selectedModels[0].id).toBe('claude-opus');
  });
});

// ============================================================
// callLLM — request construction
// ============================================================

const { callLLM } = require('../lib/llm-router');

describe('callLLM', () => {
  let mockFetch;

  beforeEach(() => {
    mockFetch = jest.fn();
    global.fetch = mockFetch;
  });

  afterEach(() => {
    delete global.fetch;
  });

  test('throws when no API key provided', async () => {
    await expect(callLLM('anthropic', 'model', 'sys', [], {}, null))
      .rejects.toThrow('No API key');
  });

  test('throws for unsupported provider', async () => {
    await expect(callLLM('unknown', 'model', 'sys', [], {}, 'key'))
      .rejects.toThrow('Unsupported provider');
  });

  test('sends correct Anthropic request structure', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ content: [{ type: 'text', text: 'response' }] })
    });

    await callLLM('anthropic', 'claude-test', 'system prompt',
      [{ role: 'user', content: 'hello' }],
      { max_tokens: 100, temperature: 0.5 },
      'sk-test'
    );

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    const body = JSON.parse(opts.body);
    expect(body.model).toBe('claude-test');
    expect(body.system).toBe('system prompt');
    expect(body.max_tokens).toBe(100);
    expect(body.temperature).toBe(0.5);
    expect(body.messages).toEqual([{ role: 'user', content: 'hello' }]);
    expect(opts.headers['x-api-key']).toBe('sk-test');
  });

  test('sends correct OpenAI request structure', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'response' } }] })
    });

    await callLLM('openai', 'gpt-test', 'system prompt',
      [{ role: 'user', content: 'hello' }],
      { max_tokens: 100 },
      'sk-openai'
    );

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    const body = JSON.parse(opts.body);
    expect(body.model).toBe('gpt-test');
    expect(body.messages[0]).toEqual({ role: 'system', content: 'system prompt' });
    expect(body.messages[1]).toEqual({ role: 'user', content: 'hello' });
    expect(opts.headers['Authorization']).toBe('Bearer sk-openai');
  });

  test('sends correct Google request structure', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: 'response' }] } }]
      })
    });

    await callLLM('google', 'gemini-test', 'system prompt',
      [{ role: 'user', content: 'hello' }],
      { max_tokens: 100 },
      'AIza-test'
    );

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain('generativelanguage.googleapis.com');
    expect(url).toContain('gemini-test');
    expect(url).toContain('key=AIza-test');
    const body = JSON.parse(opts.body);
    expect(body.systemInstruction.parts[0].text).toBe('system prompt');
    expect(body.contents[0].role).toBe('user');
    expect(body.contents[0].parts[0].text).toBe('hello');
    expect(body.generationConfig.maxOutputTokens).toBe(100);
  });

  test('maps assistant role to model for Google', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: 'ok' }] } }]
      })
    });

    await callLLM('google', 'gemini-test', 'sys',
      [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }],
      {},
      'key'
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.contents[1].role).toBe('model');
  });

  test('uses default max_tokens and temperature when config empty', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ content: [{ type: 'text', text: 'ok' }] })
    });

    await callLLM('anthropic', 'test', 'sys', [{ role: 'user', content: 'hi' }], {}, 'key');

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.max_tokens).toBe(2048);
    expect(body.temperature).toBe(1.0);
  });

  test('throws on API error with message', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      json: async () => ({ error: { message: 'Rate limited' } })
    });

    await expect(callLLM('anthropic', 'test', 'sys', [], {}, 'key'))
      .rejects.toThrow('Rate limited');
  });
});
