/**
 * LLM Form Generation routes.
 * POST /api/form-gen/generate — generate a single form (one step or all 5)
 * POST /api/form-gen/generate-all — batch generate all forms in a database
 */

const express = require('express');
const router = express.Router();
const { logError, logEvent } = require('../lib/events');
const { buildGraphContext } = require('./chat/context');
const { writeGeneratedForm, normalizeFormName } = require('../lib/form-gen/writer');
const {
  buildStep1Prompt,
  buildStep2Prompt,
  buildStep3Prompt,
  buildStep4Prompt,
  buildStep5Prompt,
} = require('../lib/form-gen/prompts');

const LLM_MODEL = 'claude-sonnet-4-20250514';
const MAX_TOKENS = 16000;

module.exports = function(pool, secrets) {

  /**
   * Call the Anthropic Messages API.
   */
  async function callLLM(systemPrompt, userPrompt, apiKey) {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        max_tokens: MAX_TOKENS,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }]
      }),
      signal: AbortSignal.timeout(120000) // 2 minutes per step
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Anthropic API error ${response.status}: ${errText}`);
    }

    const data = await response.json();
    const text = data.content?.[0]?.text || '';
    // Strip any markdown code fences the LLM might have added
    return text.replace(/^```(?:tsx?|javascript)?\n?/, '').replace(/\n?```$/, '').trim();
  }

  /**
   * Load form definition from shared.objects.
   */
  async function loadFormDef(databaseId, formName) {
    const result = await pool.query(
      `SELECT definition FROM shared.objects
       WHERE database_id = $1 AND type = 'form' AND name = $2 AND is_current = true
       ORDER BY version DESC LIMIT 1`,
      [databaseId, formName]
    );
    return result.rows[0]?.definition || null;
  }

  /**
   * Load JS handlers for the form's class module (Form_{name}).
   */
  async function loadJsHandlers(databaseId, formName) {
    const moduleName = `Form_${formName}`;
    const result = await pool.query(
      `SELECT definition FROM shared.objects
       WHERE database_id = $1 AND type = 'module' AND name = $2 AND is_current = true
       ORDER BY version DESC LIMIT 1`,
      [databaseId, moduleName]
    );
    const def = result.rows[0]?.definition;
    return def?.js_handlers || null;
  }

  /**
   * Run one generation step.
   */
  async function runStep(step, formDef, formName, previousTsx, apiKey, databaseId) {
    let prompt;
    switch (step) {
      case 1:
        prompt = buildStep1Prompt(formDef, formName);
        break;
      case 2:
        prompt = buildStep2Prompt(formDef, formName, previousTsx);
        break;
      case 3: {
        const schema = await buildGraphContext(pool, databaseId);
        prompt = buildStep3Prompt(formDef, formName, previousTsx, schema);
        break;
      }
      case 4: {
        const schema = await buildGraphContext(pool, databaseId);
        prompt = buildStep4Prompt(formDef, formName, previousTsx, schema);
        break;
      }
      case 5: {
        const handlers = await loadJsHandlers(databaseId, formName);
        prompt = buildStep5Prompt(formDef, formName, previousTsx, handlers);
        break;
      }
      default:
        throw new Error(`Invalid step: ${step}`);
    }
    return callLLM(prompt.system, prompt.user, apiKey);
  }

  /**
   * POST /api/form-gen/generate
   * Body: { database_id, form_name, step?, previous_output?, debug? }
   */
  router.post('/generate', async (req, res) => {
    const { database_id, form_name, step, previous_output, debug } = req.body;
    const databaseId = database_id || req.databaseId;

    if (!form_name) {
      return res.status(400).json({ error: 'form_name is required' });
    }

    const apiKey = secrets.anthropic?.api_key || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'Anthropic API key not configured' });
    }

    try {
      const formDef = await loadFormDef(databaseId, form_name);
      if (!formDef) {
        return res.status(404).json({ error: `Form "${form_name}" not found` });
      }

      // Single step mode
      if (step) {
        const tsx = await runStep(step, formDef, form_name, previous_output || '', apiKey, databaseId);
        const { relativePath } = writeGeneratedForm(databaseId, form_name, tsx, debug ? step : null);

        // If this is the final step (5) without debug, also write the main file
        if (step === 5 && !debug) {
          writeGeneratedForm(databaseId, form_name, tsx);
        }

        return res.json({ step, tsx, complete: step === 5, file: relativePath });
      }

      // All steps mode
      const debugFiles = [];
      let tsx = '';

      for (let s = 1; s <= 5; s++) {
        tsx = await runStep(s, formDef, form_name, tsx, apiKey, databaseId);

        if (debug) {
          const { relativePath } = writeGeneratedForm(databaseId, form_name, tsx, s);
          debugFiles.push({ step: s, file: relativePath });
        }
      }

      // Write final form
      const { relativePath } = writeGeneratedForm(databaseId, form_name, tsx);

      await logEvent(pool, 'info', 'POST /api/form-gen/generate', `Generated form component: ${form_name}`, {
        databaseId,
        objectType: 'form',
        objectName: form_name,
        details: { debug: !!debug, steps: 5 }
      });

      return res.json({
        step: 5,
        tsx,
        complete: true,
        file: relativePath,
        debugFiles: debug ? debugFiles : undefined
      });

    } catch (err) {
      await logError(pool, 'POST /api/form-gen/generate', `Error generating form: ${form_name}`, err, {
        databaseId,
        objectType: 'form',
        objectName: form_name
      });
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/form-gen/generate-all
   * Body: { database_id, debug? }
   */
  router.post('/generate-all', async (req, res) => {
    const { database_id, debug } = req.body;
    const databaseId = database_id || req.databaseId;

    const apiKey = secrets.anthropic?.api_key || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'Anthropic API key not configured' });
    }

    try {
      // Get all form names
      const formsResult = await pool.query(
        `SELECT DISTINCT name FROM shared.objects
         WHERE database_id = $1 AND type = 'form' AND is_current = true
         ORDER BY name`,
        [databaseId]
      );

      const formNames = formsResult.rows.map(r => r.name);
      const results = [];

      for (const formName of formNames) {
        try {
          const formDef = await loadFormDef(databaseId, formName);
          if (!formDef) {
            results.push({ form: formName, error: 'Definition not found' });
            continue;
          }

          let tsx = '';
          for (let s = 1; s <= 5; s++) {
            tsx = await runStep(s, formDef, formName, tsx, apiKey, databaseId);
            if (debug) {
              writeGeneratedForm(databaseId, formName, tsx, s);
            }
          }
          const { relativePath } = writeGeneratedForm(databaseId, formName, tsx);
          results.push({ form: formName, file: relativePath, success: true });
        } catch (err) {
          results.push({ form: formName, error: err.message });
        }
      }

      const succeeded = results.filter(r => r.success).length;
      const failed = results.filter(r => r.error).length;

      await logEvent(pool, 'info', 'POST /api/form-gen/generate-all',
        `Batch generated ${succeeded}/${formNames.length} forms`, {
          databaseId,
          details: { succeeded, failed, total: formNames.length }
        });

      return res.json({ results, summary: { total: formNames.length, succeeded, failed } });

    } catch (err) {
      await logError(pool, 'POST /api/form-gen/generate-all', 'Batch generation error', err, { databaseId });
      return res.status(500).json({ error: err.message });
    }
  });

  return router;
};
