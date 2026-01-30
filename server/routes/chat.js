/**
 * LLM Chat routes
 * Handles chat interactions with Anthropic API
 */

const express = require('express');
const router = express.Router();

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

module.exports = function(pool, secrets) {
  /**
   * POST /api/chat
   * Send a message to the LLM and get a response
   */
  router.post('/', async (req, res) => {
    const { message, database_id, form_context } = req.body;

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
      if (form_context?.record_source) {
        formContext = `\n\nThe user is currently viewing a form with record source: "${form_context.record_source}". You have tools available:
- search_records: Find specific records by name/value and navigate to them
- analyze_data: Answer questions about totals, counts, averages, comparisons, and data insights
- navigate_to_record: Go to a specific record by ID

Use search_records when users want to FIND specific items. Use analyze_data when users want INSIGHTS about the data (how many, total, average, which is biggest, etc).`;
      }

      // Graph tools context
      const graphContext = `\n\nYou also have dependency graph tools available:
- query_dependencies: Find what depends on a database object (tables, columns, forms, controls)
- query_intent: Find the business purpose/intent of structures, or find structures serving a business goal
- propose_intent: Document the business purpose of database objects

Use these when users ask about dependencies, impact of changes, or what structures are for.`;

      // Combine all available tools
      const availableTools = [
        ...(form_context?.record_source ? tools : []),
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
          max_tokens: 1024,
          tools: availableTools,
          system: `You are a helpful assistant for a database application called PolyAccess. You help users understand their data, create forms, write queries, and work with their databases. ${dbContext}${formContext}${graphContext}

Keep responses concise and helpful. When discussing code or SQL, use markdown code blocks.`,
          messages: [{ role: 'user', content: message }]
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

          let query, params = [];
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
              query = `SELECT MIN("${field_name}") as minimum, * FROM "${schema}"."${table}" ${whereClause} GROUP BY id ORDER BY minimum LIMIT 1`;
              break;
            case 'max':
              query = `SELECT MAX("${field_name}") as maximum, * FROM "${schema}"."${table}" ${whereClause} GROUP BY id ORDER BY maximum DESC LIMIT 1`;
              break;
            case 'group_count':
              query = `SELECT "${group_by_field || field_name}", COUNT(*) as count FROM "${schema}"."${table}" ${whereClause} GROUP BY "${group_by_field || field_name}" ORDER BY count DESC LIMIT 20`;
              break;
            default:
              query = `SELECT * FROM "${schema}"."${table}" ${whereClause} LIMIT 100`;
          }

          try {
            const analysisResult = await pool.query(query, params);
            toolResult = {
              analysis_type,
              field: field_name,
              results: analysisResult.rows
            };
          } catch (queryErr) {
            toolResult = { error: queryErr.message };
          }
        } else if (toolUse.name === 'navigate_to_record' && form_context?.record_source) {
          const { record_id } = toolUse.input;
          navigationCommand = { action: 'navigate', record_id };
          toolResult = { success: true, navigating_to: record_id };
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
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
