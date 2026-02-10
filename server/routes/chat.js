/**
 * LLM Chat routes
 * Handles chat interactions with Anthropic API
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const { logEvent, logError } = require('../lib/events');

/**
 * Summarize a form or report definition into compact text for the LLM.
 * @param {Object} definition - The form/report definition object
 * @param {string} objectType - 'form' or 'report'
 * @returns {string} Compact text summary
 */
function summarizeDefinition(definition, objectType) {
  if (!definition) return '';

  const name = definition.name || definition.caption || '(unnamed)';
  const recordSource = definition['record-source'] || definition.recordSource || '';
  const lines = [];

  lines.push(`${objectType === 'report' ? 'Report' : 'Form'} "${name}"${recordSource ? ` (record-source: ${recordSource})` : ''}`);

  // Form-level / report-level properties of interest
  if (objectType === 'form') {
    const dv = definition['default-view'] || definition.defaultView;
    if (dv) lines.push(`  Default view: ${dv}`);
    if (definition.filter) lines.push(`  Filter: ${definition.filter}`);
    if (definition['order-by']) lines.push(`  Order by: ${definition['order-by']}`);
    if (Number(definition.popup) === 1) lines.push(`  Popup: yes`);
    if (Number(definition.modal) === 1) lines.push(`  Modal: yes`);
  } else {
    // Report-level
    if (definition.filter) lines.push(`  Filter: ${definition.filter}`);
    if (definition['order-by']) lines.push(`  Order by: ${definition['order-by']}`);
    // Grouping summary
    const grouping = definition.grouping;
    if (Array.isArray(grouping) && grouping.length > 0) {
      lines.push(`  Grouping:`);
      grouping.forEach((g, i) => {
        const parts = [`field="${g.field || '?'}"`];
        if (g['sort-order'] || g.sortOrder) parts.push(`sort=${g['sort-order'] || g.sortOrder}`);
        if (g['group-on'] && g['group-on'] !== 'Each Value') parts.push(`group-on=${g['group-on']}`);
        lines.push(`    Level ${i}: ${parts.join(', ')}`);
      });
    }
  }

  // Determine which sections/bands to iterate
  const sectionKeys = objectType === 'form'
    ? ['header', 'detail', 'footer']
    : Object.keys(definition).filter(k =>
        ['report-header', 'page-header', 'detail', 'page-footer', 'report-footer'].includes(k) ||
        k.startsWith('group-header-') || k.startsWith('group-footer-')
      ).sort((a, b) => {
        // Sort bands in logical render order
        const order = { 'report-header': 0, 'page-header': 1, 'detail': 50, 'page-footer': 90, 'report-footer': 99 };
        const rank = (k) => {
          if (order[k] !== undefined) return order[k];
          if (k.startsWith('group-header-')) return 10 + parseInt(k.split('-')[2]) || 0;
          if (k.startsWith('group-footer-')) return 60 + parseInt(k.split('-')[2]) || 0;
          return 50;
        };
        return rank(a) - rank(b);
      });

  const sectionLabel = objectType === 'form' ? 'Sections' : 'Bands';
  lines.push(`${sectionLabel}:`);

  for (const key of sectionKeys) {
    const section = definition[key];
    if (!section || typeof section !== 'object') continue;

    const height = section.height;
    const controls = section.controls || [];
    const vis = section.visible === 0 ? ' [hidden]' : '';
    lines.push(`  ${key} (height: ${height || '?'})${vis}:`);

    if (controls.length === 0) {
      lines.push(`    (no controls)`);
    } else {
      for (const ctrl of controls) {
        const type = ctrl.type || '?';
        const parts = [];
        // Field binding
        const binding = ctrl['control-source'] || ctrl.controlSource || ctrl.field;
        if (binding) parts.push(`field="${binding}"`);
        // Caption for labels/buttons
        if ((type === 'label' || type === 'button') && ctrl.caption) {
          parts.push(`"${ctrl.caption}"`);
        }
        // Name if present and different from binding
        if (ctrl.name && ctrl.name !== binding) parts.push(`name="${ctrl.name}"`);
        // Position
        if (ctrl.x != null && ctrl.y != null) parts.push(`at (${ctrl.x}, ${ctrl.y})`);
        // Size
        if (ctrl.width != null && ctrl.height != null) parts.push(`size ${ctrl.width}x${ctrl.height}`);
        // Subform
        if (type === 'subform' && ctrl['source-form-name']) {
          parts.push(`source="${ctrl['source-form-name']}"`);
        }
        // Combo/list row-source
        if ((type === 'combo-box' || type === 'list-box') && ctrl['row-source']) {
          const rs = ctrl['row-source'];
          parts.push(`row-source="${rs.length > 60 ? rs.substring(0, 57) + '...' : rs}"`);
        }
        lines.push(`    - ${type} ${parts.join(' ')}`);
      }
    }
  }

  return lines.join('\n');
}

// Import graph modules for dependency/intent tools
const { findNode, findNodeById, traverseDependencies } = require('../graph/query');
const { proposeIntent } = require('../graph/populate');
const {
  renderDependenciesToProse,
  renderIntentsForStructure,
  renderStructuresForIntent,
  renderImpactAnalysis
} = require('../graph/render');

// Tool definitions for the AI
const tools = [
  {
    name: 'search_records',
    description: 'Search for specific records in the current form\'s data source. Use this when the user asks to find, search for, locate, or go to specific records by name or value.',
    input_schema: {
      type: 'object',
      properties: {
        search_term: {
          type: 'string',
          description: 'The text to search for across all text fields'
        },
        field_name: {
          type: 'string',
          description: 'Optional: specific field/column to search in'
        }
      },
      required: ['search_term']
    }
  },
  {
    name: 'analyze_data',
    description: 'Analyze data in the current form\'s data source. Use this when the user asks questions about aggregates, totals, counts, averages, maximums, minimums, comparisons, or wants insights about the data as a whole rather than finding specific records.',
    input_schema: {
      type: 'object',
      properties: {
        analysis_type: {
          type: 'string',
          enum: ['count', 'sum', 'avg', 'min', 'max', 'group_count', 'custom'],
          description: 'Type of analysis: count (total records), sum/avg/min/max (for numeric fields), group_count (count by category), custom (for complex queries)'
        },
        field_name: {
          type: 'string',
          description: 'The field to analyze (required for sum, avg, min, max, group_count)'
        },
        group_by_field: {
          type: 'string',
          description: 'Field to group by (for group_count analysis)'
        },
        filter_condition: {
          type: 'string',
          description: 'Optional WHERE clause condition, e.g., "amount > 100" or "status = \'active\'"'
        }
      },
      required: ['analysis_type']
    }
  },
  {
    name: 'navigate_to_record',
    description: 'Navigate to a specific record by its ID. Use this after finding a record to take the user directly to it.',
    input_schema: {
      type: 'object',
      properties: {
        record_id: {
          type: 'integer',
          description: 'The primary key ID of the record to navigate to'
        }
      },
      required: ['record_id']
    }
  }
];

// Graph/dependency tools - always available
const graphTools = [
  {
    name: 'query_dependencies',
    description: 'Find what depends on or uses a database object (table, column, form, control). Use this when the user asks about dependencies, impact analysis, or what would be affected by changes.',
    input_schema: {
      type: 'object',
      properties: {
        node_type: {
          type: 'string',
          enum: ['table', 'column', 'form', 'control'],
          description: 'Type of database object to query'
        },
        node_name: {
          type: 'string',
          description: 'Name of the object (e.g., table name, column name)'
        },
        direction: {
          type: 'string',
          enum: ['upstream', 'downstream'],
          description: 'upstream = what this depends on, downstream = what depends on this'
        },
        depth: {
          type: 'integer',
          description: 'How many levels deep to traverse (default 3, max 5)'
        }
      },
      required: ['node_type', 'node_name']
    }
  },
  {
    name: 'query_intent',
    description: 'Find intents a structure serves, or structures serving an intent. Use this to understand the purpose of database objects or find objects related to a business goal.',
    input_schema: {
      type: 'object',
      properties: {
        query_type: {
          type: 'string',
          enum: ['intents_for_structure', 'structures_for_intent'],
          description: 'What to query: intents for a structure, or structures for an intent'
        },
        node_name: {
          type: 'string',
          description: 'Name of the structure or intent to query'
        },
        node_type: {
          type: 'string',
          enum: ['table', 'column', 'form', 'control', 'intent'],
          description: 'Type of node (required for structure queries)'
        }
      },
      required: ['query_type', 'node_name']
    }
  },
  {
    name: 'propose_intent',
    description: 'Create a new intent or link structures to an intent. Use this when the user describes what a table or form is for, or when documenting business purposes.',
    input_schema: {
      type: 'object',
      properties: {
        intent_name: {
          type: 'string',
          description: 'Short name for the intent (e.g., "Track Inventory Costs")'
        },
        description: {
          type: 'string',
          description: 'Longer description of what this intent means'
        },
        structures: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              node_type: { type: 'string', enum: ['table', 'column', 'form', 'control'] },
              name: { type: 'string' }
            }
          },
          description: 'List of structures that serve this intent'
        }
      },
      required: ['intent_name']
    }
  }
];

// Module translation tools - available when viewing a module
const moduleTools = [
  {
    name: 'update_translation',
    description: 'Update the ClojureScript translation with revised code. Use this when the user asks you to fix issues, apply suggestions, or make changes to the translation. Always return the COMPLETE updated source, not just the changed parts.',
    input_schema: {
      type: 'object',
      properties: {
        cljs_source: {
          type: 'string',
          description: 'The complete updated ClojureScript source code'
        },
        summary: {
          type: 'string',
          description: 'Brief summary of what was changed'
        }
      },
      required: ['cljs_source', 'summary']
    }
  }
];

module.exports = function(pool, secrets) {
  /**
   * POST /api/chat
   * Send a message to the LLM and get a response
   */
  router.post('/', async (req, res) => {
    const { message, history, database_id, form_context, report_context, module_context, sql_function_context, table_context, query_context } = req.body;

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
        // Include form definition summary if available
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
        // Build compact app inventory from client-provided object names
        let appInventory = '';
        if (module_context.app_objects) {
          const ao = module_context.app_objects;
          const parts = [];
          if (ao.tables?.length)  parts.push(`Tables: ${ao.tables.join(', ')}`);
          if (ao.queries?.length) parts.push(`Queries: ${ao.queries.join(', ')}`);
          if (ao.forms?.length)   parts.push(`Forms: ${ao.forms.join(', ')}`);
          if (ao.reports?.length) parts.push(`Reports: ${ao.reports.join(', ')}`);
          if (ao.modules?.length) parts.push(`Modules: ${ao.modules.join(', ')}`);
          if (parts.length > 0) {
            appInventory = `\n\nDatabase objects available in this application:\n${parts.join('\n')}`;
          }
        }

        moduleContext = `\n\nThe user is viewing VBA module "${module_context.module_name}". You are helping with the VBA-to-ClojureScript translation.${appInventory}`;
        if (module_context.cljs_source) {
          moduleContext += `\n\nCurrent ClojureScript translation:\n${module_context.cljs_source}`;
        }
        if (module_context.vba_source) {
          moduleContext += `\n\nOriginal VBA source:\n${module_context.vba_source}`;
        }
        moduleContext += `\n\nYou have a tool available:
- update_translation: Use this to provide revised ClojureScript code when the user asks for changes. Always include the COMPLETE updated source.

IMPORTANT — PolyAccess architecture context for reviews:
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

      // Combine all available tools
      const availableTools = [
        ...(form_context?.record_source ? tools : []),
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
          max_tokens: (module_context?.module_name || sql_function_context?.function_name || query_context?.query_name) ? 4096 : 1024,
          tools: availableTools,
          system: `You are a helpful assistant for a database application called PolyAccess. You help users understand their data, create forms, write queries, and work with their databases. ${dbContext}${tableContext}${queryContext}${formContext}${reportContext}${moduleContext}${sqlFunctionContext}${graphContext}

Keep responses concise and helpful. When discussing code or SQL, use markdown code blocks.`,
          messages: [
            // Include conversation history if provided
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
        const schema = database_id || 'public';
        let toolResult = null;
        let navigationCommand = null;

        // Handle graph tools first (always available)
        if (toolUse.name === 'query_dependencies') {
          const { node_type, node_name, direction = 'downstream', depth = 3 } = toolUse.input;
          try {
            const node = await findNode(pool, node_type, node_name, database_id);
            if (node) {
              const prose = await renderDependenciesToProse(pool, node.id, direction, Math.min(depth, 5));
              toolResult = { prose };
            } else {
              toolResult = { error: `${node_type} "${node_name}" not found in the graph` };
            }
          } catch (err) {
            logEvent(pool, 'warning', 'POST /api/chat/tool', 'Chat tool error: query_dependencies', { databaseId: req.databaseId, details: { tool: 'query_dependencies', error: err.message } });
            toolResult = { error: err.message };
          }
        } else if (toolUse.name === 'query_intent') {
          const { query_type, node_name, node_type } = toolUse.input;
          try {
            if (query_type === 'intents_for_structure') {
              const node = await findNode(pool, node_type || 'table', node_name, database_id);
              if (node) {
                const prose = await renderIntentsForStructure(pool, node.id);
                toolResult = { prose };
              } else {
                toolResult = { error: `${node_type || 'structure'} "${node_name}" not found` };
              }
            } else if (query_type === 'structures_for_intent') {
              const node = await findNode(pool, 'intent', node_name, null);
              if (node) {
                const prose = await renderStructuresForIntent(pool, node.id);
                toolResult = { prose };
              } else {
                toolResult = { error: `Intent "${node_name}" not found` };
              }
            }
          } catch (err) {
            logEvent(pool, 'warning', 'POST /api/chat/tool', 'Chat tool error: query_intent', { databaseId: req.databaseId, details: { tool: 'query_intent', error: err.message } });
            toolResult = { error: err.message };
          }
        } else if (toolUse.name === 'propose_intent') {
          const { intent_name, description, structures = [] } = toolUse.input;
          try {
            // Add database_id to structures
            const structsWithDb = structures.map(s => ({ ...s, database_id }));
            const result = await proposeIntent(pool, { name: intent_name, description, origin: 'llm' }, structsWithDb);
            toolResult = {
              success: true,
              intent: result.intent.name,
              linked_structures: result.linked,
              message: `Created intent "${intent_name}" and linked ${result.linked} structure(s)`
            };
          } catch (err) {
            logEvent(pool, 'warning', 'POST /api/chat/tool', 'Chat tool error: propose_intent', { databaseId: req.databaseId, details: { tool: 'propose_intent', error: err.message } });
            toolResult = { error: err.message };
          }
        } else if (toolUse.name === 'search_records' && form_context?.record_source) {
          const { search_term, field_name } = toolUse.input;
          const table = form_context.record_source;

          // Build search query
          let query, params;
          if (field_name) {
            query = `SELECT * FROM "${schema}"."${table}" WHERE "${field_name}"::text ILIKE $1 LIMIT 10`;
            params = [`%${search_term}%`];
          } else {
            // Search all text columns - get column info first
            const colResult = await pool.query(`
              SELECT column_name FROM information_schema.columns
              WHERE table_schema = $1 AND table_name = $2
              AND data_type IN ('character varying', 'text', 'character')
            `, [schema, table]);

            const textCols = colResult.rows.map(r => r.column_name);
            if (textCols.length > 0) {
              const conditions = textCols.map((col, i) => `"${col}"::text ILIKE $1`).join(' OR ');
              query = `SELECT * FROM "${schema}"."${table}" WHERE ${conditions} LIMIT 10`;
              params = [`%${search_term}%`];
            } else {
              query = `SELECT * FROM "${schema}"."${table}" LIMIT 10`;
              params = [];
            }
          }

          const searchResult = await pool.query(query, params);
          toolResult = {
            found: searchResult.rows.length,
            records: searchResult.rows
          };
        } else if (toolUse.name === 'analyze_data') {
          const { analysis_type, field_name, group_by_field, filter_condition } = toolUse.input;
          const table = form_context.record_source;

          // Validate field names to prevent injection
          const fieldNameRe = /^[a-zA-Z_][a-zA-Z0-9_ ]*$/;
          if (field_name && !fieldNameRe.test(field_name)) {
            toolResult = { error: `Invalid field name: ${field_name}` };
          } else if (group_by_field && !fieldNameRe.test(group_by_field)) {
            toolResult = { error: `Invalid group_by field: ${group_by_field}` };
          } else {
            let query;
            const whereClause = filter_condition ? `WHERE ${filter_condition}` : '';

            switch (analysis_type) {
              case 'count':
                query = `SELECT COUNT(*) as count FROM "${schema}"."${table}" ${whereClause}`;
                break;
              case 'sum':
                query = `SELECT SUM("${field_name}") as total FROM "${schema}"."${table}" ${whereClause}`;
                break;
              case 'avg':
                query = `SELECT AVG("${field_name}") as average FROM "${schema}"."${table}" ${whereClause}`;
                break;
              case 'min':
                query = `SELECT * FROM "${schema}"."${table}" ${whereClause} ORDER BY "${field_name}" ASC LIMIT 1`;
                break;
              case 'max':
                query = `SELECT * FROM "${schema}"."${table}" ${whereClause} ORDER BY "${field_name}" DESC LIMIT 1`;
                break;
              case 'group_count':
                query = `SELECT "${group_by_field || field_name}", COUNT(*) as count FROM "${schema}"."${table}" ${whereClause} GROUP BY "${group_by_field || field_name}" ORDER BY count DESC LIMIT 20`;
                break;
              default:
                query = `SELECT * FROM "${schema}"."${table}" ${whereClause} LIMIT 100`;
            }

            // Run in a read-only transaction to prevent mutation via filter_condition
            const client = await pool.connect();
            try {
              await client.query('BEGIN READ ONLY');
              const analysisResult = await client.query(query);
              await client.query('COMMIT');
              toolResult = {
                analysis_type,
                field: field_name,
                results: analysisResult.rows
              };
            } catch (queryErr) {
              await client.query('ROLLBACK').catch(() => {});
              logEvent(pool, 'warning', 'POST /api/chat/tool', 'Chat tool error: analyze_data', { databaseId: req.databaseId, details: { tool: 'analyze_data', error: queryErr.message } });
              toolResult = { error: queryErr.message };
            } finally {
              client.release();
            }
          }
        } else if (toolUse.name === 'navigate_to_record' && form_context?.record_source) {
          const { record_id } = toolUse.input;
          navigationCommand = { action: 'navigate', record_id };
          toolResult = { success: true, navigating_to: record_id };
        } else if (toolUse.name === 'update_translation' && module_context?.module_name) {
          const { cljs_source, summary } = toolUse.input;
          // Return the updated code to the frontend — it will apply it to the editor
          toolResult = { success: true, summary };
          // Send tool result back for final response, then include updated_code in response
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
          const assistantMsg = followupData2.content?.find(c => c.type === 'text')?.text || `Updated: ${summary}`;
          return res.json({
            message: assistantMsg,
            updated_code: cljs_source
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
          navigationCommand = { action: 'navigate', record_id: followupToolUse.input.record_id };
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
    const guidePath = path.join(__dirname, '..', '..', 'skills', 'conversion-vba-cljs.md');
    translationGuide = require('fs').readFileSync(guidePath, 'utf8');
  } catch (err) {
    console.log('Could not load conversion-vba-cljs.md skill file');
  }

  /**
   * POST /api/chat/translate
   * Translate VBA source code to ClojureScript
   */
  router.post('/translate', async (req, res) => {
    const { vba_source, module_name, app_objects } = req.body;

    if (!vba_source) {
      return res.status(400).json({ error: 'vba_source is required' });
    }

    const apiKey = secrets.anthropic?.api_key || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'Anthropic API key not configured in secrets.json' });
    }

    try {
      // Build compact app inventory from client-provided object names
      let appInventory = '';
      if (app_objects) {
        const parts = [];
        if (app_objects.tables?.length)  parts.push(`Tables: ${app_objects.tables.join(', ')}`);
        if (app_objects.queries?.length) parts.push(`Queries: ${app_objects.queries.join(', ')}`);
        if (app_objects.forms?.length)   parts.push(`Forms: ${app_objects.forms.join(', ')}`);
        if (app_objects.reports?.length) parts.push(`Reports: ${app_objects.reports.join(', ')}`);
        if (app_objects.modules?.length) parts.push(`Modules: ${app_objects.modules.join(', ')}`);
        if (parts.length > 0) {
          appInventory = '\n\nDatabase objects available in this application:\n' + parts.join('\n');
        }
      }

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
          system: `You are an expert at translating Microsoft Access VBA code to ClojureScript for the PolyAccess web application framework.

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
