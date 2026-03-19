/**
 * POST /translate-modules — Server-side batch extract→resolve→generate pipeline for all modules.
 * Replaces fragile frontend N-sequential-LLM-call orchestration with a single endpoint.
 */

const { logError } = require('../../lib/events');
const { extractIntents, validateIntents, collectGaps, generateGapQuestions, applyGapQuestions } = require('../../lib/vba-intent-extractor');
const { mapIntentsToTransforms } = require('../../lib/vba-intent-mapper');
const { generateWiring } = require('../../lib/vba-wiring-generator');
const { buildGraphContext, autoResolveGaps, autoResolveGapsLLM } = require('../chat/context');

const activeTranslations = new Set();

module.exports = function(router, pool, secrets) {
  router.post('/translate-modules', async (req, res) => {
    // This endpoint processes all modules sequentially (LLM calls) — can take 5-10 minutes
    req.setTimeout(600000);
    const { database_id, run_id } = req.body;

    if (!database_id) {
      return res.status(400).json({ error: 'database_id is required' });
    }

    if (activeTranslations.has(database_id)) {
      console.log(`[translate-modules] Already running for ${database_id}, ignoring duplicate call`);
      return res.json({ skipped: true, message: 'Translation already in progress for this database' });
    }

    const apiKey = secrets?.anthropic?.api_key || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.json({ skipped: true, message: 'No API key configured' });
    }

    activeTranslations.add(database_id);
    try {
      // 1. Load all modules with VBA source
      const modulesResult = await pool.query(
        `SELECT name, vba_source, intents FROM shared.modules
         WHERE database_id = $1 AND is_current = true AND vba_source IS NOT NULL`,
        [database_id]
      );

      const modules = modulesResult.rows;
      if (modules.length === 0) {
        return res.json({ skipped: true, message: 'No modules with VBA source found' });
      }

      // Build graph context once for all modules
      const graphContext = await buildGraphContext(pool, database_id);
      const appObjects = graphContext ? {
        tables: graphContext.tables.map(t => t.name),
        views: graphContext.views.map(v => v.name),
        forms: graphContext.forms.map(f => f.name),
        reports: graphContext.reports.map(r => r.name)
      } : null;

      const results = {
        extracted: 0,
        mapped: 0,
        gaps_resolved: 0,
        generated: 0,
        failed: []
      };

      // 2. Extract intents for each module
      const moduleIntents = []; // { name, intents, mapped, vba_source }

      for (const mod of modules) {
        try {
          console.log(`[translate-modules] Extracting intents: ${mod.name}`);
          const intentResult = await extractIntents(mod.vba_source, mod.name, { app_objects: appObjects }, apiKey);
          validateIntents(intentResult);

          // Collect gaps and generate questions
          const gaps = collectGaps(intentResult);
          if (gaps.length > 0) {
            const questions = await generateGapQuestions(gaps, mod.vba_source, mod.name, apiKey);
            if (questions.length > 0) {
              applyGapQuestions(intentResult, gaps, questions);
            }
          }

          // Map to transforms (after gap questions applied)
          const mapped = mapIntentsToTransforms(intentResult);

          moduleIntents.push({ name: mod.name, intents: intentResult, mapped, vba_source: mod.vba_source });
          results.extracted++;
        } catch (err) {
          console.error(`[translate-modules] Extract failed for ${mod.name}:`, err.message);
          results.failed.push({ name: mod.name, phase: 'extract', error: err.message });
        }
      }

      // 3. Auto-resolve gaps (deterministic first, then LLM)
      if (graphContext) {
        for (const mi of moduleIntents) {
          autoResolveGaps(mi.mapped, graphContext);
        }
      }

      // Collect remaining unresolved gaps across all modules for LLM resolution
      const allGapQuestions = [];
      const gapOrigins = []; // { miIdx, procIdx, path }

      for (let miIdx = 0; miIdx < moduleIntents.length; miIdx++) {
        const mi = moduleIntents[miIdx];
        for (let procIdx = 0; procIdx < (mi.mapped.procedures || []).length; procIdx++) {
          const proc = mi.mapped.procedures[procIdx];
          collectUnresolvedGaps(proc.intents, mi.name, proc.name, [], allGapQuestions, gapOrigins, miIdx, procIdx);
        }
      }

      if (allGapQuestions.length > 0) {
        try {
          console.log(`[translate-modules] LLM-resolving ${allGapQuestions.length} remaining gaps`);
          const selections = await autoResolveGapsLLM(allGapQuestions, graphContext, apiKey);

          // Apply LLM selections back to mapped intents
          for (const sel of selections) {
            if (sel.index < 0 || sel.index >= gapOrigins.length) continue;
            const origin = gapOrigins[sel.index];
            const mi = moduleIntents[origin.miIdx];
            const intent = navigateToIntent(mi.mapped.procedures[origin.procIdx].intents, origin.path);
            if (intent && intent.type === 'gap') {
              intent.resolution = {
                answer: sel.selected,
                custom_notes: 'Auto-resolved by import pipeline',
                resolved_at: new Date().toISOString(),
                resolved_by: 'auto-import'
              };
              results.gaps_resolved++;
            }
          }
        } catch (err) {
          console.error('[translate-modules] LLM gap resolution failed (non-fatal):', err.message);
        }
      }

      // 4. Save intents for all modules
      for (const mi of moduleIntents) {
        try {
          await pool.query(
            `UPDATE shared.modules SET intents = $1
             WHERE name = $2 AND database_id = $3 AND is_current = true`,
            [JSON.stringify(mi.mapped), mi.name, database_id]
          );
          results.mapped++;
        } catch (err) {
          console.error(`[translate-modules] Save intents failed for ${mi.name}:`, err.message);
        }
      }

      // 5. Generate code for each module
      for (const mi of moduleIntents) {
        try {
          console.log(`[translate-modules] Generating code: ${mi.name}`);
          const { cljs_source } = await generateWiring(mi.mapped, mi.name, {
            apiKey,
            vbaSource: mi.vba_source,
            graphContext,
            useFallback: true
          });

          await pool.query(
            `UPDATE shared.modules SET cljs_source = $1
             WHERE name = $2 AND database_id = $3 AND is_current = true`,
            [cljs_source, mi.name, database_id]
          );

          results.generated++;
        } catch (err) {
          console.error(`[translate-modules] Generate failed for ${mi.name}:`, err.message);
          results.failed.push({ name: mi.name, phase: 'generate', error: err.message });
        }
      }

      // 6. Log to import_log if run_id provided
      if (run_id) {
        try {
          await pool.query(`
            INSERT INTO shared.import_log
              (run_id, pass_number, target_database_id, source_object_name, source_object_type,
               status, severity, category, message, action)
            VALUES ($1, 6, $2, '_translate', 'system', 'issue', 'info', 'module-translation',
                    $3, 'translate')
          `, [run_id, database_id,
              `Translated ${results.extracted} modules: ${results.generated} generated, ${results.failed.length} failed, ${results.gaps_resolved} gaps resolved`]);
        } catch (e) {
          console.error('Error logging translation results:', e.message);
        }
      }

      console.log(`[translate-modules] Complete: ${results.extracted} extracted, ${results.generated} generated, ${results.failed.length} failed`);
      res.json(results);
    } catch (err) {
      console.error('Error in translate-modules:', err);
      logError(pool, 'POST /api/database-import/translate-modules', 'Module translation failed', err, { databaseId: database_id });
      res.status(500).json({ error: err.message });
    } finally {
      activeTranslations.delete(database_id);
    }
  });
};

/**
 * Recursively collect unresolved gap intents that have questions+suggestions.
 */
function collectUnresolvedGaps(intents, moduleName, procName, path, gapQuestions, gapOrigins, miIdx, procIdx) {
  for (let i = 0; i < intents.length; i++) {
    const intent = intents[i];
    if (intent.type === 'gap' && !intent.resolution && intent.question && intent.suggestions?.length > 0) {
      gapQuestions.push({
        module: moduleName,
        procedure: procName,
        vba_line: intent.vba_line || '',
        question: intent.question,
        suggestions: intent.suggestions
      });
      gapOrigins.push({ miIdx, procIdx, path: [...path, i] });
    }
    if (intent.then) collectUnresolvedGaps(intent.then, moduleName, procName, [...path, i, 'then'], gapQuestions, gapOrigins, miIdx, procIdx);
    if (intent.else) collectUnresolvedGaps(intent.else, moduleName, procName, [...path, i, 'else'], gapQuestions, gapOrigins, miIdx, procIdx);
    if (intent.children) collectUnresolvedGaps(intent.children, moduleName, procName, [...path, i, 'children'], gapQuestions, gapOrigins, miIdx, procIdx);
  }
}

/**
 * Navigate to an intent by path (array of numeric indices and string keys like 'then', 'else', 'children').
 */
function navigateToIntent(intents, path) {
  let current = intents;
  for (const key of path) {
    if (current == null) return null;
    current = current[key];
  }
  return current;
}
