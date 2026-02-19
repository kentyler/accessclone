/**
 * Tool execution handlers for LLM chat tool_use responses.
 */

const { logEvent } = require('../../lib/events');
const { findNode } = require('../../graph/query');
const { proposePotential } = require('../../graph/populate');
const {
  renderDependenciesToProse,
  renderPotentialsForStructure,
  renderStructuresForPotential
} = require('../../graph/render');

/**
 * Execute a tool call and return the result.
 *
 * @param {string} toolName - Name of the tool to execute
 * @param {Object} input - Tool input parameters
 * @param {Object} ctx - Context: { pool, database_id, form_context, module_context, query_context, sql_function_context, req }
 * @returns {{ toolResult: Object|null, navigationCommand: Object|null, updateTranslation: Object|null, updateQuery: Object|null }}
 */
async function executeTool(toolName, input, ctx) {
  const { pool, database_id, form_context, module_context, query_context, sql_function_context, req } = ctx;
  const schema = database_id || 'public';
  let toolResult = null;
  let navigationCommand = null;

  // --- Graph tools (always available) ---
  if (toolName === 'query_dependencies') {
    const { node_type, node_name, direction = 'downstream', depth = 3 } = input;
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

  } else if (toolName === 'query_potential') {
    const { query_type, node_name, node_type } = input;
    try {
      if (query_type === 'potentials_for_structure') {
        const node = await findNode(pool, node_type || 'table', node_name, database_id);
        if (node) {
          const prose = await renderPotentialsForStructure(pool, node.id);
          toolResult = { prose };
        } else {
          toolResult = { error: `${node_type || 'structure'} "${node_name}" not found` };
        }
      } else if (query_type === 'structures_for_potential') {
        const node = await findNode(pool, 'potential', node_name, null);
        if (node) {
          const prose = await renderStructuresForPotential(pool, node.id);
          toolResult = { prose };
        } else {
          toolResult = { error: `Potential "${node_name}" not found` };
        }
      }
    } catch (err) {
      logEvent(pool, 'warning', 'POST /api/chat/tool', 'Chat tool error: query_potential', { databaseId: req.databaseId, details: { tool: 'query_potential', error: err.message } });
      toolResult = { error: err.message };
    }

  } else if (toolName === 'propose_potential') {
    const { potential_name, description, structures = [] } = input;
    try {
      const structsWithDb = structures.map(s => ({ ...s, database_id }));
      const result = await proposePotential(pool, { name: potential_name, description, origin: 'llm' }, structsWithDb);
      toolResult = {
        success: true,
        potential: result.potential.name,
        linked_structures: result.linked,
        message: `Created potential "${potential_name}" and linked ${result.linked} structure(s)`
      };
    } catch (err) {
      logEvent(pool, 'warning', 'POST /api/chat/tool', 'Chat tool error: propose_potential', { databaseId: req.databaseId, details: { tool: 'propose_potential', error: err.message } });
      toolResult = { error: err.message };
    }

  // --- Data tools (form context required) ---
  } else if (toolName === 'search_records' && form_context?.record_source) {
    const { search_term, field_name } = input;
    const table = form_context.record_source;

    let query, params;
    if (field_name) {
      query = `SELECT * FROM "${schema}"."${table}" WHERE "${field_name}"::text ILIKE $1 LIMIT 10`;
      params = [`%${search_term}%`];
    } else {
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

  } else if (toolName === 'analyze_data') {
    const { analysis_type, field_name, group_by_field, filter_condition } = input;
    const table = form_context.record_source;

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

  } else if (toolName === 'navigate_to_record' && form_context?.record_source) {
    const { record_id } = input;
    navigationCommand = { action: 'navigate', record_id };
    toolResult = { success: true, navigating_to: record_id };

  } else if (toolName === 'update_translation' && module_context?.module_name) {
    // Handled specially — returns earlyReturn function
    const { cljs_source, summary } = input;
    toolResult = { success: true, summary };
    return { toolResult, navigationCommand, updateTranslation: { cljs_source, summary } };

  } else if (toolName === 'update_query') {
    const { query_name, sql, ddl_type } = input;
    const client = await pool.connect();
    try {
      await client.query(`SET search_path TO "${schema}", public`);
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('COMMIT');
      toolResult = { success: true, query_name, ddl_type, message: `Successfully created/updated ${ddl_type} "${query_name}"` };
      return { toolResult, navigationCommand, updateTranslation: null, updateQuery: { query_name, ddl_type } };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      logEvent(pool, 'warning', 'POST /api/chat/tool', `Chat tool error: update_query`, { databaseId: req.databaseId, details: { tool: 'update_query', error: err.message } });
      toolResult = { error: err.message, query_name, ddl_type };
    } finally {
      client.release();
    }
  }

  return { toolResult, navigationCommand, updateTranslation: null };
}

module.exports = { executeTool };
