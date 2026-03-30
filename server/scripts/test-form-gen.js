/**
 * Quick test script for the form generation pipeline.
 * Usage: cd server && set PGPASSWORD=7297 && node scripts/test-form-gen.js [formName] [databaseId]
 */

const { Pool } = require('pg');
const config = require('../config');
const fs = require('fs');
const path = require('path');

const { writeGeneratedForm, normalizeFormName } = require('../lib/form-gen/writer');
const {
  buildStep1Prompt,
  buildStep2Prompt,
  buildStep3Prompt,
  buildStep4Prompt,
  buildStep5Prompt,
} = require('../lib/form-gen/prompts');
const { buildGraphContext } = require('../routes/chat/context');

const formName = process.argv[2] || 'frmLogin';
const databaseId = process.argv[3] || 'northwind4';

const pool = new Pool({ connectionString: config.database.connectionString });

let secrets = {};
try {
  secrets = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'secrets.json'), 'utf8'));
} catch (e) {
  console.log('No secrets.json, checking ANTHROPIC_API_KEY env var');
}
const apiKey = secrets.anthropic?.api_key || process.env.ANTHROPIC_API_KEY;

if (!apiKey) {
  console.error('No API key found. Set ANTHROPIC_API_KEY or add to secrets.json');
  process.exit(1);
}

async function callLLM(systemPrompt, userPrompt) {
  console.log(`  Calling LLM (${userPrompt.substring(0, 80)}...)`);
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 16000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    }),
    signal: AbortSignal.timeout(120000)
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`API error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const text = data.content?.[0]?.text || '';
  return text.replace(/^```(?:tsx?|javascript)?\n?/, '').replace(/\n?```$/, '').trim();
}

async function main() {
  console.log(`Generating form: ${formName} (database: ${databaseId})`);

  // Load form definition
  const result = await pool.query(
    `SELECT definition FROM shared.objects
     WHERE database_id = $1 AND type = 'form' AND name = $2 AND is_current = true
     ORDER BY version DESC LIMIT 1`,
    [databaseId, formName]
  );

  if (result.rows.length === 0) {
    console.error(`Form "${formName}" not found in ${databaseId}`);
    await pool.end();
    process.exit(1);
  }

  const formDef = result.rows[0].definition;
  const sections = ['header', 'detail', 'footer'];
  const controlCount = sections.reduce((n, s) => n + (formDef[s]?.controls?.length || 0), 0);
  console.log(`  Definition loaded: ${controlCount} controls, record-source: ${formDef['record-source'] || '(none)'}`);

  // Load schema context (for steps 3-4)
  const schema = await buildGraphContext(pool, databaseId);

  // Load JS handlers (for step 5)
  const moduleName = `Form_${formName}`;
  const modResult = await pool.query(
    `SELECT definition FROM shared.objects
     WHERE database_id = $1 AND type = 'module' AND name = $2 AND is_current = true
     ORDER BY version DESC LIMIT 1`,
    [databaseId, moduleName]
  );
  const jsHandlers = modResult.rows[0]?.definition?.js_handlers || null;
  console.log(`  JS handlers: ${jsHandlers ? Object.keys(jsHandlers).length + ' entries' : 'none'}`);

  let tsx = '';

  for (let step = 1; step <= 5; step++) {
    console.log(`\nStep ${step}/5...`);
    const startTime = Date.now();

    let prompt;
    switch (step) {
      case 1: prompt = buildStep1Prompt(formDef, formName); break;
      case 2: prompt = buildStep2Prompt(formDef, formName, tsx); break;
      case 3: prompt = buildStep3Prompt(formDef, formName, tsx, schema); break;
      case 4: prompt = buildStep4Prompt(formDef, formName, tsx, schema); break;
      case 5: prompt = buildStep5Prompt(formDef, formName, tsx, jsHandlers); break;
    }

    tsx = await callLLM(prompt.system, prompt.user);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`  Done (${elapsed}s, ${tsx.length} chars)`);

    // Write debug file
    const { relativePath } = writeGeneratedForm(databaseId, formName, tsx, step);
    console.log(`  Wrote: ${relativePath}`);
  }

  // Write final file
  const { relativePath } = writeGeneratedForm(databaseId, formName, tsx);
  console.log(`\nFinal: ${relativePath}`);

  await pool.end();
  console.log('\nDone! Rebuild the UI with: cd ui-react && npm run build');
}

main().catch(err => {
  console.error('Error:', err.message);
  pool.end();
  process.exit(1);
});
