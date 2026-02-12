/**
 * LLM Chat routes — main endpoint and translate endpoint.
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const { logError } = require('../../lib/events');
const { dataTools, graphTools, moduleTools } = require('./tools');
const { summarizeDefinition, checkImportCompleteness, formatMissingList, buildAppInventory } = require('./context');
const { executeTool } = require('./tool-handlers');

module.exports = function(pool, secrets) {
  /**
   * POST /api/chat
   * Send a message to the LLM and get a response
   */
  router.post('/', async (req, res) => {
    const { message, history, database_id, form_context, report_context, module_context, macro_context, sql_function_context, table_context, query_context, issue_context } = req.body;

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
        queryContext += `\n\nHelp the user understand this query, identify issues, or suggest improvements.`;
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
        sqlFunctionContext += `\n\nThis function was imported from a Microsoft Access query and converted to PostgreSQL. Help the user understand it, identify issues, or suggest improvements.`;
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
          system: `You are a helpful assistant for a database application called AccessClone. You help users understand their data, create forms, write queries, and work with their databases. ${dbContext}${tableContext}${queryContext}${formContext}${reportContext}${moduleContext}${macroContext}${sqlFunctionContext}${issueContextStr}${graphContext}${completenessWarning}

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
        const { toolResult, navigationCommand, updateTranslation } = await executeTool(
          toolUse.name, toolUse.input,
          { pool, database_id, form_context, module_context, req }
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

  return router;
};
