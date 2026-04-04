/**
 * Intent Pipeline — orchestrates intent extraction for all object types.
 * Called by import routes after each object is stored.
 *
 * LLM is allowed in the generation path (intents are one-time governed events).
 * What cannot use LLM: running tests, measuring coverage/heterogeneity.
 *
 * Non-blocking: failures are logged to events, never block import.
 */

const { parseMacroIntents } = require('./macro-intent-parser');
const { logEvent, logError } = require('./events');

/**
 * Extract and store intents for a single object.
 * Called by import routes after object storage succeeds.
 *
 * @param {Pool} pool
 * @param {Object} params
 * @param {string} params.databaseId
 * @param {string} params.schemaName
 * @param {string} params.objectType - 'form' | 'report' | 'module' | 'macro' | 'table'
 * @param {string} params.objectName
 * @param {number} params.objectId - shared.objects row id (null for tables)
 * @param {Object} params.definition - parsed definition (JSONB content)
 * @param {string} [params.apiKey] - Anthropic API key (required for LLM extraction)
 * @returns {Promise<{extracted: boolean, intent_type: string, error?: string}>}
 */
async function extractIntentsForObject(pool, { databaseId, schemaName, objectType, objectName, objectId, definition, apiKey }) {
  try {
    switch (objectType) {
      case 'macro':
        return await extractMacroIntents(pool, { databaseId, objectId, objectName, definition });

      case 'module':
        return await extractModuleIntents(pool, { databaseId, schemaName, objectId, objectName, definition, apiKey });

      case 'table':
        return await extractSchemaSnapshot(pool, { databaseId, schemaName, objectName });

      case 'form':
        return await extractFormIntents(pool, { databaseId, objectId, objectName, definition, apiKey });

      case 'report':
        return await extractReportIntents(pool, { databaseId, objectId, objectName, definition, apiKey });

      default:
        return { extracted: false, intent_type: 'unknown', error: `Unknown object type: ${objectType}` };
    }
  } catch (err) {
    await logError(pool, `intent-pipeline/${objectType}`, `Intent extraction failed for ${objectName}`, err, {
      databaseId, objectType, objectName
    }).catch(() => {});
    return { extracted: false, intent_type: objectType, error: err.message };
  }
}

/**
 * Extract gesture intents from a macro (deterministic, no LLM).
 */
async function extractMacroIntents(pool, { databaseId, objectId, objectName, definition }) {
  let macroXml = definition?.macro_xml;
  if (!macroXml) {
    return { extracted: false, intent_type: 'gesture', error: 'No macro_xml in definition' };
  }

  // macro_xml may be stored as {"value": "..."} or as a raw string
  if (typeof macroXml === 'object' && macroXml.value) {
    macroXml = macroXml.value;
  } else if (typeof macroXml === 'string') {
    try {
      const parsed = JSON.parse(macroXml);
      if (parsed && parsed.value) macroXml = parsed.value;
    } catch (_) { /* already a raw string */ }
  }

  const intents = parseMacroIntents(objectName, macroXml);
  if (intents.procedures.length === 0) {
    return { extracted: false, intent_type: 'gesture', error: 'No actions parsed from macro' };
  }

  await storeIntents(pool, objectId, 'gesture', intents, 'macro-parser');
  return { extracted: true, intent_type: 'gesture' };
}

/**
 * Extract gesture intents from a module (LLM-based via existing extractor).
 */
async function extractModuleIntents(pool, { databaseId, schemaName, objectId, objectName, definition, apiKey }) {
  if (!apiKey) {
    return { extracted: false, intent_type: 'gesture', error: 'No API key for LLM extraction' };
  }

  const vbaSource = definition?.vba_source;
  if (!vbaSource) {
    return { extracted: false, intent_type: 'gesture', error: 'No vba_source in definition' };
  }

  // Use existing extractor
  const { extractIntents } = require('./vba-intent-extractor');

  // Build minimal context
  const objectsResult = await pool.query(
    `SELECT name, type FROM shared.objects WHERE database_id = $1 AND is_current = true ORDER BY type, name`,
    [databaseId]
  );
  const context = {
    objects: objectsResult.rows.map(r => `${r.type}: ${r.name}`).join('\n')
  };

  const result = await extractIntents(vbaSource, objectName, context, apiKey);
  if (result && result.procedures) {
    await storeIntents(pool, objectId, 'gesture', result, 'vba-intent-extractor');
    return { extracted: true, intent_type: 'gesture' };
  }

  return { extracted: false, intent_type: 'gesture', error: 'Extractor returned no procedures' };
}

/**
 * Extract schema snapshot for a table (deterministic, no LLM).
 * Stores column names, types, nullability, FKs, check constraints.
 */
async function extractSchemaSnapshot(pool, { databaseId, schemaName, objectName }) {
  const tableName = objectName;

  // Get columns
  const colResult = await pool.query(`
    SELECT column_name, data_type, is_nullable, column_default,
           character_maximum_length, numeric_precision, numeric_scale
    FROM information_schema.columns
    WHERE table_schema = $1 AND table_name = $2
    ORDER BY ordinal_position
  `, [schemaName, tableName]);

  if (colResult.rows.length === 0) {
    return { extracted: false, intent_type: 'schema', error: `No columns found for ${tableName}` };
  }

  // Get foreign keys
  const fkResult = await pool.query(`
    SELECT kcu.column_name,
           ccu.table_name AS referenced_table,
           ccu.column_name AS referenced_column
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage ccu
      ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema = $1 AND tc.table_name = $2
  `, [schemaName, tableName]);

  // Get check constraints
  const checkResult = await pool.query(`
    SELECT cc.constraint_name, cc.check_clause
    FROM information_schema.check_constraints cc
    JOIN information_schema.table_constraints tc
      ON cc.constraint_name = tc.constraint_name AND cc.constraint_schema = tc.table_schema
    WHERE tc.table_schema = $1 AND tc.table_name = $2
      AND tc.constraint_type = 'CHECK'
      AND cc.check_clause NOT LIKE '%IS NOT NULL%'
  `, [schemaName, tableName]);

  const columns = colResult.rows.map(c => ({
    name: c.column_name,
    type: c.data_type,
    nullable: c.is_nullable === 'YES',
    default: c.column_default,
    max_length: c.character_maximum_length,
    precision: c.numeric_precision,
    scale: c.numeric_scale
  }));

  const foreignKeys = fkResult.rows.map(fk => ({
    column: fk.column_name,
    references_table: fk.referenced_table,
    references_column: fk.referenced_column
  }));

  const checkConstraints = checkResult.rows.map(cc => ({
    name: cc.constraint_name,
    clause: cc.check_clause
  }));

  const snapshot = { columns, foreignKeys, checkConstraints };

  // Store as an intent on a virtual object — find or create a table object entry
  // Tables don't have shared.objects entries, so we store with a synthetic approach
  // Use object_id = 0 convention or find the table object if it exists
  let objectId = null;
  const objResult = await pool.query(
    `SELECT id FROM shared.objects WHERE database_id = $1 AND type = 'table' AND name = $2 AND is_current = true LIMIT 1`,
    [databaseId, tableName]
  );
  if (objResult.rows.length > 0) {
    objectId = objResult.rows[0].id;
  } else {
    // Create a minimal table object entry so we can FK to it
    const insertResult = await pool.query(
      `INSERT INTO shared.objects (database_id, type, name, definition, version, is_current, owner)
       VALUES ($1, 'table', $2, '{}', 1, true, 'standard')
       RETURNING id`,
      [databaseId, tableName]
    );
    objectId = insertResult.rows[0].id;
  }

  await storeIntents(pool, objectId, 'schema', snapshot, 'schema-snapshot');
  return { extracted: true, intent_type: 'schema' };
}

/**
 * Extract business + structure intents for a form (LLM-based).
 * Uses existing chat extract-intents infrastructure.
 */
async function extractFormIntents(pool, { databaseId, objectId, objectName, definition, apiKey }) {
  if (!apiKey) {
    return { extracted: false, intent_type: 'business', error: 'No API key for LLM extraction' };
  }

  // Structure extraction via LLM
  const fs = require('fs');
  const path = require('path');
  const { summarizeDefinition } = require('../routes/chat/context');

  const structurePrompt = fs.readFileSync(
    path.join(__dirname, '..', '..', 'skills', 'structure-intent-extraction.md'), 'utf-8'
  );
  const summary = summarizeDefinition(definition, 'form', objectName);

  try {
    const structureResult = await callLLM(apiKey, structurePrompt, `Form: ${objectName}\n\nDefinition summary:\n${summary}`);
    if (structureResult) {
      await storeIntents(pool, objectId, 'structure', structureResult, 'llm-structure-extractor');
    }
  } catch (err) {
    // Log but don't fail — business intent is more important
    console.warn(`Structure extraction failed for form ${objectName}: ${err.message}`);
  }

  // Business intent extraction via LLM
  try {
    const businessResult = await callLLM(apiKey,
      'You are an expert at analyzing Access forms. Given the form definition, extract its business purpose. Return JSON: { "purpose": "one sentence", "category": "one of: data-entry, search, navigation, reporting, settings, dialog", "entities": ["table/entity names involved"], "workflows": ["user workflow descriptions"], "data_flows": [{"direction": "read|write|both", "target": "table name", "via": "mechanism"}] }',
      `Form: ${objectName}\n\nDefinition summary:\n${summary}`
    );
    if (businessResult) {
      await storeIntents(pool, objectId, 'business', businessResult, 'llm-business-extractor');
    }
  } catch (err) {
    console.warn(`Business extraction failed for form ${objectName}: ${err.message}`);
  }

  return { extracted: true, intent_type: 'business+structure' };
}

/**
 * Extract business + structure intents for a report (LLM-based).
 */
async function extractReportIntents(pool, { databaseId, objectId, objectName, definition, apiKey }) {
  if (!apiKey) {
    return { extracted: false, intent_type: 'business', error: 'No API key for LLM extraction' };
  }

  const fs = require('fs');
  const path = require('path');
  const { summarizeDefinition } = require('../routes/chat/context');

  const structurePrompt = fs.readFileSync(
    path.join(__dirname, '..', '..', 'skills', 'report-structure-intent-extraction.md'), 'utf-8'
  );
  const summary = summarizeDefinition(definition, 'report', objectName);

  try {
    const structureResult = await callLLM(apiKey, structurePrompt, `Report: ${objectName}\n\nDefinition summary:\n${summary}`);
    if (structureResult) {
      await storeIntents(pool, objectId, 'structure', structureResult, 'llm-structure-extractor');
    }
  } catch (err) {
    console.warn(`Structure extraction failed for report ${objectName}: ${err.message}`);
  }

  try {
    const businessResult = await callLLM(apiKey,
      'You are an expert at analyzing Access reports. Given the report definition, extract its business purpose. Return JSON: { "purpose": "one sentence", "category": "one of: listing, summary, detail, label, letter, invoice, dashboard", "entities": ["table/entity names involved"], "consumers": [{"type": "role or process", "name": "who uses this", "usage": "how"}], "grouping_purpose": "why data is grouped this way" }',
      `Report: ${objectName}\n\nDefinition summary:\n${summary}`
    );
    if (businessResult) {
      await storeIntents(pool, objectId, 'business', businessResult, 'llm-business-extractor');
    }
  } catch (err) {
    console.warn(`Business extraction failed for report ${objectName}: ${err.message}`);
  }

  return { extracted: true, intent_type: 'business+structure' };
}

/**
 * Store intents in shared.intents, replacing any existing for same object+type.
 */
async function storeIntents(pool, objectId, intentType, content, generatedBy) {
  // Delete previous intents for this object+type
  await pool.query(
    'DELETE FROM shared.intents WHERE object_id = $1 AND intent_type = $2',
    [objectId, intentType]
  );

  await pool.query(
    `INSERT INTO shared.intents (object_id, intent_type, content, generated_by)
     VALUES ($1, $2, $3, $4)`,
    [objectId, intentType, JSON.stringify(content), generatedBy]
  );

  // Invalidate any active locked tests for this object — opens the cord until re-freeze
  try {
    // Look up the object's name/type/database_id to find matching locked tests
    const objResult = await pool.query(
      'SELECT database_id, type, name FROM shared.objects WHERE id = $1',
      [objectId]
    );
    if (objResult.rows.length > 0) {
      const { database_id, type, name } = objResult.rows[0];
      await pool.query(
        `UPDATE shared.locked_tests SET invalidated_at = NOW()
         WHERE database_id = $1 AND object_type = $2 AND object_name = $3
           AND intent_type = $4 AND invalidated_at IS NULL`,
        [database_id, type, name, intentType]
      );
    }
  } catch (err) {
    // Non-blocking — don't fail intent storage if invalidation fails
    console.warn('Locked test invalidation failed:', err.message);
  }
}

/**
 * Call Anthropic API for LLM extraction. Returns parsed JSON or null.
 */
async function callLLM(apiKey, systemPrompt, userPrompt) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    })
  });

  if (!response.ok) {
    throw new Error(`Anthropic API error: ${response.status}`);
  }

  const data = await response.json();
  const text = data.content?.[0]?.text || '';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  try {
    return JSON.parse(jsonMatch[0]);
  } catch {
    return null;
  }
}

/**
 * Batch extract intents for all objects in a database.
 * Used by the completeness endpoint and freeze flow.
 *
 * @param {Pool} pool
 * @param {string} databaseId
 * @param {string} [apiKey] - for LLM extraction
 * @returns {Promise<{results: Array, summary: Object}>}
 */
async function extractAllIntents(pool, databaseId, apiKey) {
  const dbResult = await pool.query(
    'SELECT schema_name FROM shared.databases WHERE database_id = $1', [databaseId]
  );
  if (dbResult.rows.length === 0) {
    throw new Error(`Database ${databaseId} not found`);
  }
  const schemaName = dbResult.rows[0].schema_name;

  const results = [];

  // Forms + Reports + Modules + Macros from shared.objects
  const objectsResult = await pool.query(
    `SELECT id, type, name, definition FROM shared.objects
     WHERE database_id = $1 AND is_current = true AND type IN ('form', 'report', 'module', 'macro')
     ORDER BY type, name`,
    [databaseId]
  );

  for (const obj of objectsResult.rows) {
    const def = typeof obj.definition === 'string' ? JSON.parse(obj.definition) : obj.definition;
    const result = await extractIntentsForObject(pool, {
      databaseId, schemaName,
      objectType: obj.type,
      objectName: obj.name,
      objectId: obj.id,
      definition: def,
      apiKey
    });
    results.push({ type: obj.type, name: obj.name, ...result });
  }

  // Tables from information_schema
  const tableResult = await pool.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY table_name`,
    [schemaName]
  );

  for (const row of tableResult.rows) {
    const result = await extractIntentsForObject(pool, {
      databaseId, schemaName,
      objectType: 'table',
      objectName: row.table_name,
      objectId: null,
      definition: null,
      apiKey
    });
    results.push({ type: 'table', name: row.table_name, ...result });
  }

  const extracted = results.filter(r => r.extracted).length;
  const failed = results.filter(r => !r.extracted).length;

  return {
    results,
    summary: { total: results.length, extracted, failed }
  };
}

module.exports = {
  extractIntentsForObject,
  extractAllIntents,
  extractSchemaSnapshot,
  storeIntents
};
