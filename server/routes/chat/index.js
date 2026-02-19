/**
 * LLM Chat routes — main endpoint and translate endpoint.
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const { logError } = require('../../lib/events');
const { dataTools, graphTools, moduleTools, queryTools } = require('./tools');
const { summarizeDefinition, checkImportCompleteness, formatMissingList, buildAppInventory, buildGraphContext, formatGraphContext, checkIntentDependencies, autoResolveGaps } = require('./context');
const { executeTool } = require('./tool-handlers');
const { deriveCapabilities } = require('../../lib/capability-deriver');
const { upsertNode, upsertEdge, findNode } = require('../../graph/query');

module.exports = function(pool, secrets) {
  /**
   * POST /api/chat
   * Send a message to the LLM and get a response
   */
  router.post('/', async (req, res) => {
    const { message, history, database_id, form_context, report_context, module_context, macro_context, sql_function_context, table_context, query_context, app_context, issue_context } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    const apiKey = secrets.anthropic?.api_key || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'Anthropic API key not configured in secrets.json' });
    }

    try {
      // Get context about current database
      let dbContext = '';
      if (database_id) {
        const dbResult = await pool.query(
          'SELECT name, description FROM shared.databases WHERE database_id = $1',
          [database_id]
        );
        if (dbResult.rows[0]) {
          dbContext = `Current database: ${dbResult.rows[0].name} - ${dbResult.rows[0].description || 'No description'}`;
        }
      }

      // Build form context for the system prompt
      let formContext = '';
      if (form_context) {
        if (form_context.definition) {
          const summary = summarizeDefinition(form_context.definition, 'form');
          formContext = `\n\nThe user is currently viewing a form in Design view. Here is the form structure:\n${summary}`;
        }
        if (form_context.record_source) {
          formContext += `\n\nThe form's record source is "${form_context.record_source}". You have tools available:
- search_records: Find specific records by name/value and navigate to them
- analyze_data: Answer questions about totals, counts, averages, comparisons, and data insights
- navigate_to_record: Go to a specific record by ID

Use search_records when users want to FIND specific items. Use analyze_data when users want INSIGHTS about the data (how many, total, average, which is biggest, etc).`;
        }
      }

      // Build report context for the system prompt
      let reportContext = '';
      if (report_context?.definition) {
        const summary = summarizeDefinition(report_context.definition, 'report');
        reportContext = `\n\nThe user is currently viewing a report in Design view. Here is the report structure:\n${summary}`;
      }

      // Table context (when viewing a table)
      let tableContext = '';
      if (table_context?.table_name) {
        const fields = (table_context.fields || []).map(f => {
          let desc = `${f.name} (${f.type}`;
          if (f.pk) desc += ', PK';
          if (f.nullable === false) desc += ', NOT NULL';
          desc += ')';
          return desc;
        }).join(', ');
        tableContext = `\n\nThe user is viewing table "${table_context.table_name}".`;
        if (table_context.description) {
          tableContext += ` Description: ${table_context.description}`;
        }
        tableContext += `\nColumns: ${fields}`;
        tableContext += `\n\nHelp the user understand the table structure, identify issues, or answer questions about the data.`;
      }

      // Query context (when viewing a query/view)
      let queryContext = '';
      if (query_context?.query_name) {
        queryContext = `\n\nThe user is viewing query/view "${query_context.query_name}".`;
        if (query_context.sql) {
          queryContext += `\nSQL: ${query_context.sql}`;
        }
        if (query_context.fields?.length) {
          const fieldList = query_context.fields.map(f => `${f.name} (${f.type})`).join(', ');
          queryContext += `\nFields: ${fieldList}`;
        }
        queryContext += `\n\nYou have a tool available:
- update_query: Create or replace a PostgreSQL view or function by executing DDL. When the user asks to save or update this query, use this tool with the appropriate CREATE OR REPLACE VIEW statement.

Help the user understand this query, identify issues, or suggest improvements. When asked to save changes, use the update_query tool.`;
      }

      // Graph tools context
      const graphContext = `\n\nYou also have dependency graph tools available:
- query_dependencies: Find what depends on a database object (tables, columns, forms, controls)
- query_intent: Find the business purpose/intent of structures, or find structures serving a business goal
- propose_intent: Document the business purpose of database objects

Use these when users ask about dependencies, impact of changes, or what structures are for.`;

      // Module context (when viewing a VBA module translation)
      let moduleContext = '';
      if (module_context?.module_name) {
        const appInventory = buildAppInventory(module_context.app_objects);

        moduleContext = `\n\nThe user is viewing VBA module "${module_context.module_name}". You are helping with the VBA-to-ClojureScript translation.${appInventory}`;
        if (module_context.cljs_source) {
          moduleContext += `\n\nCurrent ClojureScript translation:\n${module_context.cljs_source}`;
        }
        if (module_context.vba_source) {
          moduleContext += `\n\nOriginal VBA source:\n${module_context.vba_source}`;
        }
        moduleContext += `\n\nYou have a tool available:
- update_translation: Use this to provide revised ClojureScript code when the user asks for changes. Always include the COMPLETE updated source.

IMPORTANT — AccessClone architecture context for reviews:
- Forms carry their own configuration: popup, modal, dimensions, record-source, default-view, etc. are properties in the form definition JSON. The framework renders them accordingly.
- state/open-object! handles opening any object type — it reads the form definition and renders popups, modals, continuous forms, etc. automatically based on the form's properties.
- Do NOT suggest adding modal handling, z-index management, positioning, focus trapping, or other rendering concerns — the framework already does this.
- Do NOT suggest adding error handling, input validation, or extra functions that weren't in the original VBA. A correct translation that delegates to the framework is complete.
- A simple translation that correctly maps VBA operations to existing framework functions IS the right answer. Fewer lines is better.
- Focus reviews on: incorrect API usage, SQL injection, wrong state paths, missing forward declarations, async issues, wrong response shape access. These are real bugs.
- Do NOT flag: missing features the VBA didn't have, missing error handling the VBA didn't have, "assumed state functions" (they exist), or suggest expanding simple correct translations.

When the user asks you to make changes, use the update_translation tool to apply them.`;
      }

      // SQL function context (when viewing an imported query/function)
      let sqlFunctionContext = '';
      if (sql_function_context?.function_name) {
        sqlFunctionContext = `\n\nThe user is viewing a SQL function "${sql_function_context.function_name}"`;
        if (sql_function_context.arguments) {
          sqlFunctionContext += ` with arguments (${sql_function_context.arguments})`;
        }
        if (sql_function_context.return_type) {
          sqlFunctionContext += ` returning ${sql_function_context.return_type}`;
        }
        sqlFunctionContext += '.';
        if (sql_function_context.source) {
          sqlFunctionContext += `\n\nFunction definition:\n${sql_function_context.source}`;
        }
        sqlFunctionContext += `\n\nYou have a tool available:
- update_query: Create or replace a PostgreSQL function by executing DDL. When the user asks to save or update this function, use this tool with ddl_type "function" and the full CREATE OR REPLACE FUNCTION statement.

This function was imported from a Microsoft Access query and converted to PostgreSQL. Help the user understand it, identify issues, or suggest improvements. When asked to save changes, use the update_query tool.`;
      }

      // Macro context (when viewing an Access macro)
      let macroContext = '';
      if (macro_context?.macro_name) {
        macroContext = `\n\nThe user is viewing an Access macro "${macro_context.macro_name}".`;
        if (macro_context.macro_xml) {
          macroContext += `\n\nMacro XML definition:\n${macro_context.macro_xml}`;
        }
        if (macro_context.cljs_source) {
          macroContext += `\n\nCurrent ClojureScript translation:\n${macro_context.cljs_source}`;
        }
        macroContext += `\n\nThis is a Microsoft Access macro exported as XML. Help the user understand the macro's actions, conditions, and flow. If asked, translate the macro logic to ClojureScript event handlers that work with the AccessClone framework.`;

        const macroInventory = buildAppInventory(macro_context.app_objects);
        if (macroInventory) macroContext += macroInventory;
      }

      // App context (when viewing the Application dashboard)
      let appContextStr = '';
      if (app_context?.database_id) {
        const appInventory = buildAppInventory(app_context.app_objects);
        appContextStr = `\n\nThe user is viewing the Application dashboard — a whole-application overview.${appInventory}

You can see all objects in this application. Help the user understand cross-object relationships, find which modules reference a table, identify missing imports, or plan migration steps.`;
      }

      // Issue context (when in Logs mode reviewing import issues)
      let issueContextStr = '';
      if (issue_context?.object_name) {
        issueContextStr = `\n\nThe user is reviewing import issues for ${issue_context.object_type} "${issue_context.object_name}".`;
        if (Array.isArray(issue_context.issues) && issue_context.issues.length > 0) {
          issueContextStr += '\nIssues found during import:';
          for (const issue of issue_context.issues) {
            const resolved = issue.resolved ? ' [RESOLVED]' : '';
            issueContextStr += `\n- [${issue.severity}] ${issue.message}${issue.location ? ` (at ${issue.location})` : ''}${resolved}`;
            if (issue.suggestion) issueContextStr += `\n  Suggestion: ${issue.suggestion}`;
          }
        }
        issueContextStr += '\n\nHelp the user understand and resolve these import issues. Suggest concrete fixes when possible.';
      }

      // Check import completeness for module/macro contexts
      let completenessWarning = '';
      if ((module_context?.module_name || macro_context?.macro_name) && database_id) {
        const completeness = await checkImportCompleteness(pool, database_id);
        if (completeness?.has_discovery && !completeness.complete) {
          completenessWarning = `\n\nIMPORTANT — INCOMPLETE IMPORT:\nThe following objects have NOT been imported from the Access source:\n${formatMissingList(completeness.missing)}\nYou MUST NOT produce ClojureScript code translations. You may analyze structure, identify dependencies, and explain logic, but do NOT generate translation code until all objects are imported.`;
        }
      }

      // Combine all available tools
      const availableTools = [
        ...(form_context?.record_source ? dataTools : []),
        ...(module_context?.module_name ? moduleTools : []),
        ...((query_context?.query_name || sql_function_context?.function_name) ? queryTools : []),
        ...graphTools
      ];

      // Call Anthropic API with tools
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: (module_context?.module_name || macro_context?.macro_name || sql_function_context?.function_name || query_context?.query_name) ? 4096 : 1024,
          tools: availableTools,
          system: `You are a helpful assistant for a database application called AccessClone. You help users understand their data, create forms, write queries, and work with their databases. ${dbContext}${tableContext}${queryContext}${formContext}${reportContext}${moduleContext}${macroContext}${sqlFunctionContext}${appContextStr}${issueContextStr}${graphContext}${completenessWarning}

Keep responses concise and helpful. When discussing code or SQL, use markdown code blocks.`,
          messages: [
            ...(history || []).map(m => ({ role: m.role, content: m.content })),
            { role: 'user', content: message }
          ]
        })
      });

      if (!response.ok) {
        const errorData = await response.json();
        console.error('Anthropic API error:', errorData);
        return res.status(500).json({ error: errorData.error?.message || 'API request failed' });
      }

      const data = await response.json();

      // Check if the AI wants to use a tool
      const toolUse = data.content.find(c => c.type === 'tool_use');

      if (toolUse) {
        const { toolResult, navigationCommand, updateTranslation, updateQuery } = await executeTool(
          toolUse.name, toolUse.input,
          { pool, database_id, form_context, module_context, query_context, sql_function_context, req }
        );

        // Special handling for update_translation — needs followup API call
        if (updateTranslation) {
          const followupResponse2 = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': apiKey,
              'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
              model: 'claude-sonnet-4-20250514',
              max_tokens: 1024,
              system: `You are a helpful assistant. The user asked for changes to a code translation and you've applied them. Briefly confirm what you changed.`,
              messages: [
                ...(history || []).map(m => ({ role: m.role, content: m.content })),
                { role: 'user', content: message },
                { role: 'assistant', content: data.content },
                { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: JSON.stringify(toolResult) }] }
              ]
            })
          });
          const followupData2 = await followupResponse2.json();
          const assistantMsg = followupData2.content?.find(c => c.type === 'text')?.text || `Updated: ${updateTranslation.summary}`;
          return res.json({
            message: assistantMsg,
            updated_code: updateTranslation.cljs_source
          });
        }

        // Special handling for update_query — needs followup API call
        if (updateQuery) {
          const followupResponse3 = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': apiKey,
              'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
              model: 'claude-sonnet-4-20250514',
              max_tokens: 1024,
              system: `You are a helpful assistant. The user asked to save/update a ${updateQuery.ddl_type} and you executed the DDL. Briefly confirm what was done.`,
              messages: [
                ...(history || []).map(m => ({ role: m.role, content: m.content })),
                { role: 'user', content: message },
                { role: 'assistant', content: data.content },
                { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: JSON.stringify(toolResult) }] }
              ]
            })
          });
          const followupData3 = await followupResponse3.json();
          const assistantMsg3 = followupData3.content?.find(c => c.type === 'text')?.text || `Successfully updated ${updateQuery.ddl_type} "${updateQuery.query_name}"`;
          return res.json({
            message: assistantMsg3,
            updated_query: { query_name: updateQuery.query_name, ddl_type: updateQuery.ddl_type }
          });
        }

        // If no tool was matched, return without followup
        if (toolResult === null) {
          const assistantMessage = data.content.find(c => c.type === 'text')?.text || 'No response';
          return res.json({ message: assistantMessage });
        }

        // Send tool result back to AI for final response
        const followupResponse = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 1024,
            system: `You are a helpful assistant for a database application. Summarize the results concisely:
- For search results: mention key details of found records and offer to navigate to one
- For analysis results: present the insights clearly with the numbers
- If an error occurred, explain what went wrong`,
            messages: [
              { role: 'user', content: message },
              { role: 'assistant', content: data.content },
              { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: JSON.stringify(toolResult) }] }
            ]
          })
        });

        const followupData = await followupResponse.json();
        const assistantMessage = followupData.content?.find(c => c.type === 'text')?.text || 'Search complete.';

        // Check if followup also has a tool use (for navigation)
        const followupToolUse = followupData.content?.find(c => c.type === 'tool_use');
        if (followupToolUse?.name === 'navigate_to_record') {
          return res.json({
            message: assistantMessage,
            navigation: { action: 'navigate', record_id: followupToolUse.input.record_id },
            search_results: toolUse.name === 'search_records' ? toolResult : null
          });
        }

        return res.json({
          message: assistantMessage,
          navigation: navigationCommand,
          search_results: toolUse.name === 'search_records' ? toolResult : null
        });
      }

      const assistantMessage = data.content.find(c => c.type === 'text')?.text || 'No response';
      res.json({ message: assistantMessage });
    } catch (err) {
      console.error('Error in chat:', err);
      logError(pool, 'POST /api/chat', 'Chat request failed', err, { databaseId: req.databaseId });
      res.status(500).json({ error: err.message });
    }
  });

  // Load VBA-to-ClojureScript translation guide for the translate endpoint
  let translationGuide = '';
  try {
    const guidePath = path.join(__dirname, '..', '..', '..', 'skills', 'conversion-vba-cljs.md');
    translationGuide = require('fs').readFileSync(guidePath, 'utf8');
  } catch (err) {
    console.log('Could not load conversion-vba-cljs.md skill file');
  }

  /**
   * POST /api/chat/translate
   * Translate VBA source code to ClojureScript
   */
  router.post('/translate', async (req, res) => {
    const { vba_source, module_name, app_objects, database_id } = req.body;

    if (!vba_source) {
      return res.status(400).json({ error: 'vba_source is required' });
    }

    // Hard block: refuse translation if import is incomplete
    const databaseId = database_id || req.headers['x-database-id'];
    if (databaseId) {
      const completeness = await checkImportCompleteness(pool, databaseId);
      if (completeness?.has_discovery && !completeness.complete) {
        return res.status(400).json({
          error: 'Cannot translate until all Access objects are imported.',
          missing: completeness.missing,
          missing_count: completeness.missing_count
        });
      }
    }

    const apiKey = secrets.anthropic?.api_key || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'Anthropic API key not configured in secrets.json' });
    }

    try {
      const appInventory = buildAppInventory(app_objects);

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
          system: `You are an expert at translating Microsoft Access VBA code to ClojureScript for the AccessClone web application framework.

Follow this translation guide precisely:

${translationGuide}
${appInventory}

Return ONLY the ClojureScript code, no markdown code fences, no explanations. Include a namespace declaration and require statements. Add brief comments for non-obvious translations.`,
          messages: [{
            role: 'user',
            content: `Translate this VBA module "${module_name || 'unknown'}" to ClojureScript:\n\n${vba_source}`
          }]
        })
      });

      if (!response.ok) {
        const errorData = await response.json();
        console.error('Anthropic API error:', errorData);
        return res.status(500).json({ error: errorData.error?.message || 'Translation API request failed' });
      }

      const data = await response.json();
      const cljs_source = data.content?.find(c => c.type === 'text')?.text || '';

      res.json({ success: true, cljs_source });
    } catch (err) {
      console.error('Error translating module:', err);
      logError(pool, 'POST /api/chat/translate', 'Module translation failed', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Load intent extraction dependencies
  const { extractIntents, validateIntents, collectGaps, generateGapQuestions, applyGapQuestions } = require('../../lib/vba-intent-extractor');
  const { mapIntentsToTransforms, countClassifications } = require('../../lib/vba-intent-mapper');
  const { generateWiring } = require('../../lib/vba-wiring-generator');

  /**
   * POST /api/chat/extract-intents
   * Extract structured intents from VBA source and map to transforms/flows
   */
  router.post('/extract-intents', async (req, res) => {
    const { vba_source, module_name, app_objects, database_id } = req.body;

    if (!vba_source) {
      return res.status(400).json({ error: 'vba_source is required' });
    }

    // Hard block: refuse if import is incomplete
    const databaseId = database_id || req.headers['x-database-id'];
    if (databaseId) {
      const completeness = await checkImportCompleteness(pool, databaseId);
      if (completeness?.has_discovery && !completeness.complete) {
        return res.status(400).json({
          error: 'Cannot extract intents until all Access objects are imported.',
          missing: completeness.missing,
          missing_count: completeness.missing_count
        });
      }
    }

    const apiKey = secrets.anthropic?.api_key || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'Anthropic API key not configured in secrets.json' });
    }

    try {
      // Step 1: Extract intents via LLM
      const intentResult = await extractIntents(
        vba_source, module_name || 'unknown',
        { app_objects },
        apiKey
      );

      // Step 2: Validate
      const validation = validateIntents(intentResult);

      // Step 4: Map to transforms/flows
      const mapped = mapIntentsToTransforms(intentResult);

      // Step 5: Carry forward previous resolutions
      const moduleName = module_name || 'unknown';
      if (databaseId) {
        try {
          const existing = await pool.query(
            `SELECT intents FROM shared.modules WHERE name = $1 AND database_id = $2 ORDER BY version DESC LIMIT 1`,
            [moduleName, databaseId]
          );
          if (existing.rows[0]?.intents?.mapped?.procedures) {
            const oldResolutions = {};
            function collectOldResolutions(intents) {
              for (const intent of intents) {
                if (intent.type === 'gap' && intent.resolution && intent.vba_line) {
                  oldResolutions[intent.vba_line] = {
                    resolution: intent.resolution,
                    resolution_history: intent.resolution_history || []
                  };
                }
                if (intent.then) collectOldResolutions(intent.then);
                if (intent.else) collectOldResolutions(intent.else);
                if (intent.children) collectOldResolutions(intent.children);
              }
            }
            for (const proc of existing.rows[0].intents.mapped.procedures) {
              collectOldResolutions(proc.intents || []);
            }
            // Apply old resolutions to new gaps with matching vba_line
            function applyResolutions(intents) {
              for (const intent of intents) {
                if (intent.type === 'gap' && intent.vba_line && oldResolutions[intent.vba_line]) {
                  intent.resolution = oldResolutions[intent.vba_line].resolution;
                  intent.resolution_history = oldResolutions[intent.vba_line].resolution_history;
                }
                if (intent.then) applyResolutions(intent.then);
                if (intent.else) applyResolutions(intent.else);
                if (intent.children) applyResolutions(intent.children);
              }
            }
            for (const proc of mapped.procedures) {
              applyResolutions(proc.intents || []);
            }
          }
        } catch (carryErr) {
          // Non-fatal: just skip carry-forward
          console.log('Gap carry-forward skipped:', carryErr.message);
        }
      }

      // Aggregate stats
      let totalMechanical = 0, totalFallback = 0, totalGap = 0;
      for (const proc of mapped.procedures) {
        totalMechanical += proc.stats?.mechanical || 0;
        totalFallback += proc.stats?.llm_fallback || 0;
        totalGap += proc.stats?.gap || 0;
      }

      // Generate gap questions via focused LLM call
      let gapQuestions = [];
      if (totalGap > 0) {
        try {
          const gaps = collectGaps(mapped);
          console.log(`Found ${gaps.length} gaps, generating questions...`);
          if (gaps.length > 0) {
            const questions = await generateGapQuestions(gaps, vba_source, moduleName, apiKey);
            // Merge questions with gap info for the response
            gapQuestions = gaps.map((g, i) => ({
              gap_id: g.gap_id,
              procedure: g.procedure,
              vba_line: g.vba_line,
              reason: g.reason,
              question: questions[i]?.question || `This VBA code does: "${g.vba_line}". How should this work in the web app?`,
              suggestions: questions[i]?.suggestions || ['Implement equivalent functionality', 'Skip this functionality']
            }));
          }
        } catch (gapErr) {
          // Non-fatal: just skip gap questions
          console.log('Gap question generation skipped:', gapErr.message);
        }
      }

      res.json({
        intents: intentResult,
        mapped,
        validation,
        stats: {
          total: totalMechanical + totalFallback + totalGap,
          mechanical: totalMechanical,
          llm_fallback: totalFallback,
          gap: totalGap
        },
        gap_questions: gapQuestions
      });
    } catch (err) {
      console.error('Error extracting intents:', err);
      logError(pool, 'POST /api/chat/extract-intents', 'Intent extraction failed', err, { databaseId });
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/chat/generate-wiring
   * Generate ClojureScript wiring from mapped intents
   */
  router.post('/generate-wiring', async (req, res) => {
    const { mapped_intents, module_name, vba_source, database_id, check_deps } = req.body;

    if (!mapped_intents) {
      return res.status(400).json({ error: 'mapped_intents is required' });
    }

    const apiKey = secrets.anthropic?.api_key || process.env.ANTHROPIC_API_KEY;

    try {
      // Build graph context so generated code references real objects
      let graphCtx = null;
      const databaseId = database_id || req.headers['x-database-id'];
      if (databaseId) {
        graphCtx = await buildGraphContext(pool, databaseId);
      }

      // Dependency check: if check_deps is true, verify all referenced objects exist
      if (check_deps && graphCtx) {
        const depCheck = checkIntentDependencies(mapped_intents, graphCtx);
        if (!depCheck.satisfied) {
          return res.json({ skipped: true, missing_deps: depCheck.missing });
        }
      }

      const result = await generateWiring(mapped_intents, module_name || 'unknown', {
        vbaSource: vba_source,
        apiKey,
        useFallback: !!apiKey,
        graphContext: graphCtx
      });

      res.json({
        cljs_source: result.cljs_source,
        stats: result.stats
      });
    } catch (err) {
      console.error('Error generating wiring:', err);
      logError(pool, 'POST /api/chat/generate-wiring', 'Wiring generation failed', err, { databaseId: database_id });
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/chat/derive-capabilities
   * Synthesize capability nodes from extracted intents + structural context.
   * Loads all modules with intents for the database, sends to LLM, creates
   * proposed capability nodes in the graph.
   */
  router.post('/derive-capabilities', async (req, res) => {
    const databaseId = req.body.database_id || req.headers['x-database-id'];
    if (!databaseId) {
      return res.status(400).json({ error: 'database_id is required' });
    }

    const apiKey = secrets.anthropic?.api_key || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'Anthropic API key not configured in secrets.json' });
    }

    try {
      // Load all modules with intents
      const modulesRes = await pool.query(
        `SELECT DISTINCT ON (name) name, intents
         FROM shared.modules
         WHERE database_id = $1 AND is_current = true AND intents IS NOT NULL
         ORDER BY name, version DESC`,
        [databaseId]
      );

      if (modulesRes.rows.length === 0) {
        return res.json({ capabilities: [], message: 'No modules with extracted intents found. Extract intents first.' });
      }

      // Build structural context
      const graphContext = await buildGraphContext(pool, databaseId);
      const structuralText = graphContext ? formatGraphContext(graphContext) : 'No structural context available.';

      // Get database name
      const dbRes = await pool.query(
        'SELECT name FROM shared.databases WHERE database_id = $1',
        [databaseId]
      );
      const databaseName = dbRes.rows[0]?.name || databaseId;

      // Derive capabilities via LLM
      const capabilities = await deriveCapabilities({
        modules: modulesRes.rows,
        structuralContext: structuralText,
        databaseName,
        apiKey
      });

      // Create capability nodes in the graph
      const created = [];
      for (const cap of capabilities) {
        const capNode = await upsertNode(pool, {
          node_type: 'capability',
          name: cap.name,
          database_id: null,
          scope: 'global',
          origin: 'llm',
          metadata: {
            description: cap.description,
            evidence: cap.evidence,
            confidence: cap.confidence,
            derived_from: databaseId,
            source_procedures: cap.related_procedures,
            history: [{ event: 'derived', source: databaseId, at: new Date().toISOString() }]
          }
        });

        // Link related structures via proposed 'serves' edges
        let linkedStructures = 0;
        for (const structName of cap.related_structures) {
          // Try as form, table, or report
          for (const nodeType of ['form', 'table', 'report']) {
            const structNode = await findNode(pool, nodeType, structName, databaseId);
            if (structNode) {
              await upsertEdge(pool, {
                from_id: structNode.id,
                to_id: capNode.id,
                rel_type: 'serves',
                status: 'proposed',
                proposed_by: 'llm'
              });
              linkedStructures++;
              break;
            }
          }
        }

        // Link existing graph intent nodes via proposed 'actualizes' edges
        let linkedIntents = 0;
        const intentNodes = await pool.query(
          `SELECT id, name FROM shared._nodes WHERE node_type = 'intent'`
        );
        if (intentNodes.rows.length > 0) {
          // Check each intent's serves edges — if it serves structures that
          // also serve this capability, propose an actualizes link
          for (const intent of intentNodes.rows) {
            const intentEdges = await pool.query(
              `SELECT e.from_id FROM shared._edges e
               JOIN shared._nodes n ON n.id = e.from_id
               WHERE e.to_id = $1 AND e.rel_type = 'serves'
                 AND n.database_id = $2`,
              [intent.id, databaseId]
            );
            // If any structure serving this intent also serves the capability
            for (const edge of intentEdges.rows) {
              const alsoServesCapability = await pool.query(
                `SELECT 1 FROM shared._edges
                 WHERE from_id = $1 AND to_id = $2 AND rel_type = 'serves'`,
                [edge.from_id, capNode.id]
              );
              if (alsoServesCapability.rows.length > 0) {
                await upsertEdge(pool, {
                  from_id: intent.id,
                  to_id: capNode.id,
                  rel_type: 'actualizes',
                  status: 'proposed',
                  proposed_by: 'llm'
                });
                linkedIntents++;
                break;
              }
            }
          }
        }

        created.push({
          id: capNode.id,
          name: cap.name,
          description: cap.description,
          evidence: cap.evidence,
          confidence: cap.confidence,
          related_procedures: cap.related_procedures,
          linked_structures: linkedStructures,
          linked_intents: linkedIntents
        });
      }

      console.log(`Derived ${created.length} capabilities for ${databaseName}`);
      res.json({ capabilities: created });
    } catch (err) {
      console.error('Error deriving capabilities:', err);
      logError(pool, 'POST /api/chat/derive-capabilities', 'Capability derivation failed', err, { databaseId });
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/chat/resolve-gap
   * Resolve a gap intent with a user answer
   */
  router.post('/resolve-gap', async (req, res) => {
    const { module_name, gap_id, answer, custom_notes, database_id } = req.body;

    if (!module_name || !gap_id || !answer) {
      return res.status(400).json({ error: 'module_name, gap_id, and answer are required' });
    }

    const databaseId = database_id || req.headers['x-database-id'];
    if (!databaseId) {
      return res.status(400).json({ error: 'database_id is required' });
    }

    try {
      // Load current intents from DB
      const result = await pool.query(
        `SELECT intents FROM shared.modules WHERE name = $1 AND database_id = $2 ORDER BY version DESC LIMIT 1`,
        [module_name, databaseId]
      );

      if (!result.rows[0]?.intents) {
        return res.status(404).json({ error: 'No intents found for this module' });
      }

      const intents = result.rows[0].intents;

      // Find and resolve the gap by gap_id
      let found = false;
      function resolveInList(intentList) {
        for (const intent of intentList) {
          if (intent.type === 'gap' && intent.gap_id === gap_id) {
            const entry = {
              answer,
              custom_notes: custom_notes || null,
              resolved_at: new Date().toISOString(),
              resolved_by: 'user'
            };
            intent.resolution = entry;
            if (!Array.isArray(intent.resolution_history)) {
              intent.resolution_history = [];
            }
            intent.resolution_history.push(entry);
            found = true;
            return;
          }
          if (intent.then) resolveInList(intent.then);
          if (intent.else) resolveInList(intent.else);
          if (intent.children) resolveInList(intent.children);
          if (found) return;
        }
      }

      if (intents.mapped?.procedures) {
        for (const proc of intents.mapped.procedures) {
          resolveInList(proc.intents || []);
          if (found) break;
        }
      }

      if (!found) {
        return res.status(404).json({ error: `Gap with id "${gap_id}" not found` });
      }

      // Update intents in DB
      await pool.query(
        `UPDATE shared.modules SET intents = $1 WHERE name = $2 AND database_id = $3 AND version = (SELECT MAX(version) FROM shared.modules WHERE name = $2 AND database_id = $3)`,
        [JSON.stringify(intents), module_name, databaseId]
      );

      res.json({ success: true, updated_intents: intents });
    } catch (err) {
      console.error('Error resolving gap:', err);
      logError(pool, 'POST /api/chat/resolve-gap', 'Gap resolution failed', err, { databaseId });
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/chat/auto-resolve-gaps
   * Send all gap questions to the LLM to pick the best option for each.
   */
  router.post('/auto-resolve-gaps', async (req, res) => {
    const { gap_questions, database_id } = req.body;

    if (!Array.isArray(gap_questions) || gap_questions.length === 0) {
      return res.status(400).json({ error: 'gap_questions array is required' });
    }

    const apiKey = secrets.anthropic?.api_key || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'Anthropic API key not configured in secrets.json' });
    }

    try {
      // Build database context for the LLM
      let inventoryText = '';
      const databaseId = database_id || req.headers['x-database-id'];
      if (databaseId) {
        const graphCtx = await buildGraphContext(pool, databaseId);
        if (graphCtx) {
          inventoryText = formatGraphContext(graphCtx);
        }
      }

      // Chunk into batches of 80 to stay within output token limits
      const BATCH_SIZE = 80;
      const allSelections = [];

      for (let batchStart = 0; batchStart < gap_questions.length; batchStart += BATCH_SIZE) {
        const batch = gap_questions.slice(batchStart, batchStart + BATCH_SIZE);

        // Format each gap for the user message
        const gapLines = batch.map((gq, i) => {
          const globalIdx = batchStart + i;
          const opts = (gq.suggestions || []).map((s, j) => `  ${j + 1}. ${s}`).join('\n');
          return `[Gap ${globalIdx}] Module: ${gq.module || '?'}, Procedure: ${gq.procedure || '?'}
VBA: ${gq.vba_line || '(unknown)'}
Question: ${gq.question}
Options:
${opts}`;
        }).join('\n\n');

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
            system: `You are an expert at converting Microsoft Access applications to modern web applications.

You are given a list of "gap questions" — decisions that need to be made during the conversion from VBA to a web app. For each gap, you must pick the best option from the numbered suggestions.

${inventoryText ? `Database inventory:\n${inventoryText}\n\n` : ''}Consider the database context and pick the option that best preserves the original Access application's behavior in a web environment. Prefer options that use existing framework functions, API endpoints, or table data over options that skip functionality.

Respond with ONLY a JSON array of objects, each with "index" (the gap number) and "selected" (the exact text of the chosen option). Example:
[{"index": 0, "selected": "Use API call to fetch data"}, {"index": 1, "selected": "Skip this functionality"}]

No explanation, no markdown fences — just the JSON array.`,
            messages: [{
              role: 'user',
              content: `Pick the best option for each gap question:\n\n${gapLines}`
            }]
          })
        });

        if (!response.ok) {
          const errorData = await response.json();
          console.error('Anthropic API error in auto-resolve:', errorData);
          return res.status(500).json({ error: errorData.error?.message || 'Auto-resolve API request failed' });
        }

        const data = await response.json();
        const text = data.content?.find(c => c.type === 'text')?.text || '[]';

        // Parse JSON — strip markdown fences if present
        const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
        try {
          const parsed = JSON.parse(cleaned);
          if (Array.isArray(parsed)) {
            // Validate each selection matches an actual suggestion
            for (const sel of parsed) {
              const gq = gap_questions[sel.index];
              if (gq && gq.suggestions?.includes(sel.selected)) {
                allSelections.push(sel);
              } else if (gq) {
                // LLM returned text that doesn't exactly match — find closest suggestion
                const match = gq.suggestions?.find(s =>
                  s.toLowerCase().trim() === (sel.selected || '').toLowerCase().trim()
                );
                if (match) {
                  allSelections.push({ index: sel.index, selected: match });
                }
                // else skip this gap — no valid match
              }
            }
          }
        } catch (parseErr) {
          console.error('Failed to parse auto-resolve response:', parseErr.message, text.substring(0, 200));
          // Continue with partial results rather than failing entirely
        }
      }

      res.json({ selections: allSelections });
    } catch (err) {
      console.error('Error in auto-resolve-gaps:', err);
      logError(pool, 'POST /api/chat/auto-resolve-gaps', 'Auto-resolve gaps failed', err, { databaseId: database_id });
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
