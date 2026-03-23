/**
 * LLM Chat routes — main endpoint and translate endpoint.
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { logError } = require('../../lib/events');
const { dataTools, graphTools, queryTools, designCheckTools } = require('./tools');
const { summarizeDefinition, checkImportCompleteness, formatMissingList, buildAppInventory, buildGraphContext, formatGraphContext, checkIntentDependencies, autoResolveGaps, autoResolveGapsLLM, loadObjectIntents, formatObjectIntents } = require('./context');
const { executeTool } = require('./tool-handlers');
const { deriveCapabilities } = require('../../lib/capability-deriver');
const { upsertNode, upsertEdge, findNode } = require('../../graph/query');

/**
 * Extract structured issues JSON from LLM response text.
 * Returns { cleaned, issues } where cleaned has the JSON block removed.
 */
function extractIssuesJson(text) {
  const match = text.match(/```issues\s*\n?([\s\S]*?)```/);
  if (!match) return { cleaned: text, issues: [] };
  try {
    const issues = JSON.parse(match[1].trim());
    const cleaned = text.replace(/```issues\s*\n?[\s\S]*?```/, '').trim();
    return { cleaned, issues: Array.isArray(issues) ? issues : [] };
  } catch {
    return { cleaned: text, issues: [] };
  }
}

/**
 * UPSERT issues into shared.issues table.
 */
async function persistIssues(pool, databaseId, objectType, objectName, issues) {
  const validSeverities = ['error', 'warning', 'info'];
  let count = 0;
  for (const issue of issues) {
    if (!issue.message) continue;
    const severity = validSeverities.includes(issue.severity) ? issue.severity : 'warning';
    try {
      await pool.query(`
        INSERT INTO shared.issues (database_id, object_type, object_name, category, severity, message, suggestion)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (database_id, object_type, object_name, category, message)
        DO UPDATE SET severity = EXCLUDED.severity, suggestion = EXCLUDED.suggestion
      `, [databaseId, objectType, objectName, issue.category || 'other', severity, issue.message, issue.suggestion || null]);
      count++;
    } catch (err) {
      // Log but don't fail the chat response
      console.error('Error persisting issue:', err.message);
    }
  }
  return count;
}

module.exports = function(pool, secrets) {
  /**
   * POST /api/chat
   * Send a message to the LLM and get a response
   */
  router.post('/', async (req, res) => {
    const { message, history, database_id, form_context, report_context, module_context, macro_context, sql_function_context, table_context, query_context, app_context, issue_context, assessment_context, extract_issues, auto_analyze_object } = req.body;

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
          const summary = summarizeDefinition(form_context.definition, 'form', form_context.form_name);
          formContext = `\n\nThe user is currently viewing this form in Design view. Here is the form structure:\n${summary}`;
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
        const summary = summarizeDefinition(report_context.definition, 'report', report_context.report_name);
        reportContext = `\n\nThe user is currently viewing this report in Design view. Here is the report structure:\n${summary}`;
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
- query_potential: Find the business potential/purpose of structures, or find structures serving a business goal
- propose_potential: Document the business purpose of database objects

Use these when users ask about dependencies, impact of changes, or what structures are for.`;

      // Module context (when viewing a VBA module translation)
      let moduleContext = '';
      if (module_context?.module_name) {
        const appInventory = buildAppInventory(module_context.app_objects);

        moduleContext = `\n\nThe user is viewing VBA module "${module_context.module_name}".${appInventory}`;
        if (module_context.vba_source) {
          moduleContext += `\n\nOriginal VBA source:\n${module_context.vba_source}`;
        }
        moduleContext += `\n\nVBA event handlers are compiled to JavaScript at import time (vba-to-js.js) and executed via the window.AC runtime API. Help the user understand the VBA code, its extracted intents, and the generated JS handlers.`;
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
        macroContext += `\n\nThis is a Microsoft Access macro exported as XML. Help the user understand the macro's actions, conditions, and flow.`;

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

      // Assessment context (pre-import database analysis)
      let assessmentContextStr = '';
      if (assessment_context?.findings) {
        const f = assessment_context.findings;
        const scan = assessment_context.scan_summary || {};
        assessmentContextStr = `\n\nThe user is in Import mode, preparing to import an Access database into PostgreSQL.`;
        if (scan.table_count || scan.query_count) {
          assessmentContextStr += `\nSource database summary: ${scan.table_count || 0} tables, ${scan.query_count || 0} queries, ${scan.form_count || 0} forms, ${scan.report_count || 0} reports, ${scan.module_count || 0} modules.`;
          if (scan.relationship_count != null) {
            assessmentContextStr += ` ${scan.relationship_count} defined relationships.`;
          }
        }
        if (scan.table_names) {
          assessmentContextStr += `\nTable names: ${scan.table_names.join(', ')}`;
        }
        assessmentContextStr += `\n\nDeterministic pre-import assessment found:`;
        if (f.structural?.length) {
          assessmentContextStr += `\n\nSTRUCTURAL (${f.structural.length}):`;
          for (const s of f.structural) {
            assessmentContextStr += `\n- ${s.object}: ${s.message}`;
          }
        }
        if (f.design?.length) {
          assessmentContextStr += `\n\nDESIGN (${f.design.length}):`;
          for (const d of f.design) {
            assessmentContextStr += `\n- ${d.object}: ${d.message}`;
          }
        }
        if (f.complexity?.length) {
          assessmentContextStr += `\n\nCOMPLEXITY (${f.complexity.length}):`;
          for (const c of f.complexity) {
            assessmentContextStr += `\n- ${c.object}: ${c.message}`;
          }
        }
        assessmentContextStr += `\n\nProvide a concise analysis of this database. Identify the domain/purpose from the table and object names. For the findings above, add domain-aware context: which empty tables might be used by VBA code, which missing relationships are likely real, and what the wide table's columns probably represent. Prioritize which issues matter most for a clean import.`;
      }

      // Check import completeness for module/macro contexts (informational only)
      let completenessWarning = '';
      if ((module_context?.module_name || macro_context?.macro_name) && database_id) {
        const completeness = await checkImportCompleteness(pool, database_id);
        if (completeness?.has_discovery && !completeness.complete) {
          completenessWarning = `\n\nNOTE — Some objects have not been imported yet:\n${formatMissingList(completeness.missing)}\nYou may still analyze and translate this module. If translation references unimported objects, note them as potential issues but proceed with best-effort translation.`;
        }
      }

      // Load business intents if available for the active object
      let intentContext = '';
      if (database_id) {
        let intents = null;
        if (form_context?.form_name) {
          intents = await loadObjectIntents(pool, 'form', form_context.form_name, database_id);
        } else if (report_context?.report_name) {
          intents = await loadObjectIntents(pool, 'report', report_context.report_name, database_id);
        } else if (query_context?.query_name) {
          intents = await loadObjectIntents(pool, 'query', query_context.query_name, database_id);
        }
        if (intents) {
          intentContext = '\n\nExtracted business intent for this object:\n' + formatObjectIntents(intents);
        }
      }

      // Combine all available tools
      const availableTools = [
        ...(form_context?.record_source ? dataTools : []),
        ...((query_context?.query_name || sql_function_context?.function_name) ? queryTools : []),
        ...graphTools,
        ...designCheckTools
      ];

      // Build system prompt — Three Horse gets its own context
      let systemPrompt;
      if (database_id === 'threehorse' && threeHorseContext) {
        // Page-specific context based on which form is open
        let pageContext = '';
        if (form_context?.definition?.name) {
          const pageName = form_context.definition.name;
          if (pageName === 'Qualifying Analysis') {
            pageContext = '\n\nThe user is currently on the Qualifying Analysis page. Focus answers on the diagnostic tool, how to get it, what the report contains, and what to do with results.';
          } else if (pageName === 'How It Works') {
            pageContext = '\n\nThe user is currently on the How It Works page. Focus answers on the migration process, what each step involves, and what the output looks like.';
          } else if (pageName === 'About') {
            pageContext = '\n\nThe user is currently on the About page. Focus answers on what Three Horse is, the problem it solves, and the AI partner concept.';
          }
        }
        systemPrompt = `${threeHorseContext}${pageContext}

Keep responses concise. Use concrete details rather than marketing language.`;
      } else {
        systemPrompt = `You are a helpful assistant for a database application called AccessClone. You help users understand their data, create forms, write queries, and work with their databases. ${dbContext}${tableContext}${queryContext}${formContext}${reportContext}${moduleContext}${macroContext}${sqlFunctionContext}${appContextStr}${issueContextStr}${assessmentContextStr}${graphContext}${intentContext}${completenessWarning}

When you encounter naming confusion, structural problems, or UX issues, you can use the run_design_check tool to analyze the database against configurable design patterns.

Keep responses concise and helpful. When discussing code or SQL, use markdown code blocks.`;
      }

      // Call Anthropic API with tools
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: database_id === 'threehorse' ? 'claude-haiku-4-5-20251001' : 'claude-sonnet-4-20250514',
          max_tokens: (module_context?.module_name || macro_context?.macro_name || sql_function_context?.function_name || query_context?.query_name || assessment_context?.findings) ? 4096 : 1024,
          tools: database_id === 'threehorse' ? [] : availableTools,
          system: systemPrompt,
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
        const { toolResult, navigationCommand, updateQuery } = await executeTool(
          toolUse.name, toolUse.input,
          { pool, database_id, form_context, module_context, query_context, sql_function_context, req }
        );

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
          let assistantMessage = data.content.find(c => c.type === 'text')?.text || 'No response';
          if (extract_issues && auto_analyze_object) {
            const { cleaned, issues } = extractIssuesJson(assistantMessage);
            const dbId = database_id || req.headers['x-database-id'];
            if (issues.length > 0 && dbId) {
              await persistIssues(pool, dbId, auto_analyze_object.type, auto_analyze_object.name, issues);
            }
            return res.json({ message: cleaned, issues });
          }
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

      let assistantMessage = data.content.find(c => c.type === 'text')?.text || 'No response';
      if (extract_issues && auto_analyze_object) {
        const { cleaned, issues } = extractIssuesJson(assistantMessage);
        const dbId = database_id || req.headers['x-database-id'];
        if (issues.length > 0 && dbId) {
          await persistIssues(pool, dbId, auto_analyze_object.type, auto_analyze_object.name, issues);
        }
        return res.json({ message: cleaned, issues });
      }
      res.json({ message: assistantMessage });
    } catch (err) {
      console.error('Error in chat:', err);
      logError(pool, 'POST /api/chat', 'Chat request failed', err, { databaseId: req.databaseId });
      res.status(500).json({ error: err.message });
    }
  });

  // Load VBA-to-JS translation guide for the translate endpoint
  let translationGuide = '';
  try {
    const guidePath = path.join(__dirname, '..', '..', '..', 'skills', 'conversion-vba-js.md');
    translationGuide = fs.readFileSync(guidePath, 'utf8');
  } catch (err) {
    console.log('Could not load conversion-vba-js.md skill file');
  }

  // Load Three Horse chat context for the threehorse database
  let threeHorseContext = '';
  try {
    const thPath = path.join(__dirname, '..', '..', '..', 'skills', 'three-horse-chat.md');
    threeHorseContext = fs.readFileSync(thPath, 'utf8');
  } catch (err) {
    console.log('Could not load three-horse-chat.md skill file');
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

    const databaseId = database_id || req.headers['x-database-id'];

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

  /**
   * POST /api/chat/extract-intents
   * Extract structured intents from VBA source and map to transforms/flows
   */
  router.post('/extract-intents', async (req, res) => {
    const { vba_source, module_name, app_objects, database_id } = req.body;

    if (!vba_source) {
      return res.status(400).json({ error: 'vba_source is required' });
    }

    const databaseId = database_id || req.headers['x-database-id'];

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

        // Link existing graph potential nodes via proposed 'actualizes' edges
        let linkedPotentials = 0;
        const potentialNodes = await pool.query(
          `SELECT id, name FROM shared._nodes WHERE node_type = 'potential'`
        );
        if (potentialNodes.rows.length > 0) {
          // Check each potential's serves edges — if it serves structures that
          // also serve this capability, propose an actualizes link
          for (const potential of potentialNodes.rows) {
            const potentialEdges = await pool.query(
              `SELECT e.from_id FROM shared._edges e
               JOIN shared._nodes n ON n.id = e.from_id
               WHERE e.to_id = $1 AND e.rel_type = 'serves'
                 AND n.database_id = $2`,
              [potential.id, databaseId]
            );
            // If any structure serving this potential also serves the capability
            for (const edge of potentialEdges.rows) {
              const alsoServesCapability = await pool.query(
                `SELECT 1 FROM shared._edges
                 WHERE from_id = $1 AND to_id = $2 AND rel_type = 'serves'`,
                [edge.from_id, capNode.id]
              );
              if (alsoServesCapability.rows.length > 0) {
                await upsertEdge(pool, {
                  from_id: potential.id,
                  to_id: capNode.id,
                  rel_type: 'actualizes',
                  status: 'proposed',
                  proposed_by: 'llm'
                });
                linkedPotentials++;
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
          linked_potentials: linkedPotentials
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
      const databaseId = database_id || req.headers['x-database-id'];
      const graphCtx = databaseId ? await buildGraphContext(pool, databaseId) : null;

      const allSelections = await autoResolveGapsLLM(gap_questions, graphCtx, apiKey);
      res.json({ selections: allSelections });
    } catch (err) {
      console.error('Error in auto-resolve-gaps:', err);
      logError(pool, 'POST /api/chat/auto-resolve-gaps', 'Auto-resolve gaps failed', err, { databaseId: database_id });
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};

// Export helpers for testing
module.exports.extractIssuesJson = extractIssuesJson;
module.exports.persistIssues = persistIssues;
