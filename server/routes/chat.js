/**
 * LLM Chat routes
 * Handles chat interactions with Anthropic API
 */

const express = require('express');
const router = express.Router();

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
          tools: form_context?.record_source ? tools : [],
          system: `You are a helpful assistant for a database application called PolyAccess. You help users understand their data, create forms, write queries, and work with their databases. ${dbContext}${formContext}

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

      if (toolUse && form_context?.record_source) {
        const schema = database_id || 'public';
        let toolResult = null;
        let navigationCommand = null;

        if (toolUse.name === 'search_records') {
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
        } else if (toolUse.name === 'navigate_to_record') {
          const { record_id } = toolUse.input;
          navigationCommand = { action: 'navigate', record_id };
          toolResult = { success: true, navigating_to: record_id };
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
