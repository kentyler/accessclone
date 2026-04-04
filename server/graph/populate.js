/**
 * Graph Population Functions
 * Scan schemas and forms to populate the dependency graph
 */

const { upsertNode, upsertEdge, findNode, findNodesByType, deleteNode } = require('./query');

/**
 * Populate graph from all database schemas
 * Scans information_schema to create nodes for tables and columns
 * @param {Pool} pool
 * @returns {Promise<Object>} - { tables: number, columns: number, edges: number }
 */
async function populateFromSchemas(pool) {
  const stats = { tables: 0, columns: 0, edges: 0 };

  try {
    // Get all databases from shared.databases
    const dbResult = await pool.query('SELECT database_id, schema_name FROM shared.databases');

    for (const db of dbResult.rows) {
      const { database_id, schema_name } = db;

      // Get all tables in this schema
      const tableResult = await pool.query(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = $1
        AND table_type = 'BASE TABLE'
        ORDER BY table_name
      `, [schema_name]);

      for (const tableRow of tableResult.rows) {
        const tableName = tableRow.table_name;

        // Create table node
        const tableNode = await upsertNode(pool, {
          node_type: 'table',
          name: tableName,
          database_id: database_id,
          scope: 'local',
          metadata: { schema: schema_name }
        });
        stats.tables++;

        // Get columns for this table
        const colResult = await pool.query(`
          SELECT column_name, data_type, is_nullable, column_default
          FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = $2
          ORDER BY ordinal_position
        `, [schema_name, tableName]);

        for (const colRow of colResult.rows) {
          // Create column node
          const colNode = await upsertNode(pool, {
            node_type: 'column',
            name: colRow.column_name,
            database_id: database_id,
            scope: 'local',
            metadata: {
              table: tableName,
              data_type: colRow.data_type,
              nullable: colRow.is_nullable === 'YES',
              default: colRow.column_default
            }
          });
          stats.columns++;

          // Create contains edge: table -> column
          if (tableNode && colNode) {
            await upsertEdge(pool, {
              from_id: tableNode.id,
              to_id: colNode.id,
              rel_type: 'contains'
            });
            stats.edges++;
          }
        }

        // Get foreign key references
        const fkResult = await pool.query(`
          SELECT
            kcu.column_name,
            ccu.table_name AS referenced_table,
            ccu.column_name AS referenced_column
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON tc.constraint_name = kcu.constraint_name
            AND tc.table_schema = kcu.table_schema
          JOIN information_schema.constraint_column_usage ccu
            ON ccu.constraint_name = tc.constraint_name
            AND ccu.table_schema = tc.table_schema
          WHERE tc.constraint_type = 'FOREIGN KEY'
            AND tc.table_schema = $1
            AND tc.table_name = $2
        `, [schema_name, tableName]);

        for (const fkRow of fkResult.rows) {
          // Find the column and referenced table nodes
          const colNode = await findNode(pool, 'column', fkRow.column_name, database_id);
          const refTableNode = await findNode(pool, 'table', fkRow.referenced_table, database_id);

          if (colNode && refTableNode) {
            // Create references edge: column -> referenced table
            await upsertEdge(pool, {
              from_id: colNode.id,
              to_id: refTableNode.id,
              rel_type: 'references',
              metadata: { referenced_column: fkRow.referenced_column }
            });
            stats.edges++;
          }
        }
      }
    }

    console.log(`Graph populated: ${stats.tables} tables, ${stats.columns} columns, ${stats.edges} edges`);
    return stats;
  } catch (err) {
    console.error('Error populating graph from schemas:', err.message);
    throw err;
  }
}

/**
 * Parse JSON form content to extract structure for graph population
 * @param {string} jsonContent - JSON string of form definition
 * @returns {Object} - { name, record_source, controls: [...] }
 */
function parseFormContent(jsonContent) {
  const form = {
    name: null,
    record_source: null,
    controls: []
  };

  try {
    const obj = typeof jsonContent === 'string' ? JSON.parse(jsonContent) : jsonContent;

    form.name = obj.name || null;
    form.record_source = obj['record-source'] || obj['record_source'] || null;

    // Extract controls from header, detail, and footer sections
    for (const section of ['header', 'detail', 'footer']) {
      const controls = obj[section]?.controls;
      if (Array.isArray(controls)) {
        for (const ctrl of controls) {
          form.controls.push({
            type: ctrl.type || null,
            name: ctrl.name || null,
            binding: ctrl['control-source'] || ctrl['control_source'] || ctrl.field || null
          });
        }
      }
    }
  } catch (e) {
    console.error('Error parsing form content:', e.message);
  }

  return form;
}

/**
 * Populate graph from a form definition
 * @param {Pool} pool
 * @param {string} formName - Name of the form
 * @param {string} content - JSON content of the form
 * @param {string} databaseId - Database ID the form belongs to
 * @returns {Promise<Object>} - { form: node, controls: number, edges: number }
 */
async function populateFromForm(pool, formName, content, databaseId) {
  const stats = { form: null, controls: 0, edges: 0 };

  try {
    const parsed = parseFormContent(content);

    // Create form node
    const formNode = await upsertNode(pool, {
      node_type: 'form',
      name: formName,
      database_id: databaseId,
      scope: 'local',
      metadata: {
        record_source: parsed.record_source,
        control_count: parsed.controls.length
      }
    });
    stats.form = formNode;

    // If form has a record source, link to the table
    if (parsed.record_source) {
      const tableNode = await findNode(pool, 'table', parsed.record_source, databaseId);
      if (tableNode) {
        await upsertEdge(pool, {
          from_id: formNode.id,
          to_id: tableNode.id,
          rel_type: 'bound_to'
        });
        stats.edges++;
      }
    }

    // Create control nodes and edges
    for (const ctrl of parsed.controls) {
      const controlNode = await upsertNode(pool, {
        node_type: 'control',
        name: ctrl.name,
        database_id: databaseId,
        scope: 'local',
        metadata: {
          form: formName,
          control_type: ctrl.type,
          binding: ctrl.binding
        }
      });
      stats.controls++;

      // Form contains control
      await upsertEdge(pool, {
        from_id: formNode.id,
        to_id: controlNode.id,
        rel_type: 'contains'
      });
      stats.edges++;

      // If control is bound to a column, create edge
      if (ctrl.binding) {
        const colNode = await findNode(pool, 'column', ctrl.binding, databaseId);
        if (colNode) {
          await upsertEdge(pool, {
            from_id: controlNode.id,
            to_id: colNode.id,
            rel_type: 'bound_to'
          });
          stats.edges++;
        }
      }
    }

    console.log(`Form "${formName}" populated: ${stats.controls} controls, ${stats.edges} edges`);
    return stats;
  } catch (err) {
    console.error(`Error populating graph from form "${formName}":`, err.message);
    throw err;
  }
}

/**
 * Parse JSON report content to extract structure for graph population
 * Reports are banded: report-header, page-header, group-header-N, detail,
 * group-footer-N, page-footer, report-footer
 * @param {string} jsonContent - JSON string of report definition
 * @returns {Object} - { name, record_source, controls: [...] }
 */
function parseReportContent(jsonContent) {
  const report = {
    name: null,
    record_source: null,
    controls: []
  };

  try {
    const obj = typeof jsonContent === 'string' ? JSON.parse(jsonContent) : jsonContent;

    report.name = obj.name || null;
    report.record_source = obj['record-source'] || obj['record_source'] || null;

    // Extract controls from all band sections
    for (const key of Object.keys(obj)) {
      const section = obj[key];
      if (section && Array.isArray(section.controls)) {
        for (const ctrl of section.controls) {
          report.controls.push({
            type: ctrl.type || null,
            name: ctrl.name || null,
            binding: ctrl['control-source'] || ctrl['control_source'] || ctrl.field || null
          });
        }
      }
    }
  } catch (e) {
    console.error('Error parsing report content:', e.message);
  }

  return report;
}

/**
 * Populate graph from a report definition
 * @param {Pool} pool
 * @param {string} reportName - Name of the report
 * @param {string} content - JSON content of the report
 * @param {string} databaseId - Database ID the report belongs to
 * @returns {Promise<Object>} - { report: node, controls: number, edges: number }
 */
async function populateFromReport(pool, reportName, content, databaseId) {
  const stats = { report: null, controls: 0, edges: 0 };

  try {
    const parsed = parseReportContent(content);

    // Create report node
    const reportNode = await upsertNode(pool, {
      node_type: 'form',  // reuse 'form' node_type for reports (graph treats them the same)
      name: reportName,
      database_id: databaseId,
      scope: 'local',
      metadata: {
        object_type: 'report',
        record_source: parsed.record_source,
        control_count: parsed.controls.length
      }
    });
    stats.report = reportNode;

    // If report has a record source, link to the table
    if (parsed.record_source) {
      const tableNode = await findNode(pool, 'table', parsed.record_source, databaseId);
      if (tableNode) {
        await upsertEdge(pool, {
          from_id: reportNode.id,
          to_id: tableNode.id,
          rel_type: 'bound_to'
        });
        stats.edges++;
      }
    }

    // Create control nodes and edges
    for (const ctrl of parsed.controls) {
      if (!ctrl.name) continue;  // skip unnamed controls

      const controlNode = await upsertNode(pool, {
        node_type: 'control',
        name: ctrl.name,
        database_id: databaseId,
        scope: 'local',
        metadata: {
          form: reportName,
          control_type: ctrl.type,
          binding: ctrl.binding
        }
      });
      stats.controls++;

      // Report contains control
      await upsertEdge(pool, {
        from_id: reportNode.id,
        to_id: controlNode.id,
        rel_type: 'contains'
      });
      stats.edges++;

      // If control is bound to a column, create edge
      if (ctrl.binding) {
        const colNode = await findNode(pool, 'column', ctrl.binding, databaseId);
        if (colNode) {
          await upsertEdge(pool, {
            from_id: controlNode.id,
            to_id: colNode.id,
            rel_type: 'bound_to'
          });
          stats.edges++;
        }
      }
    }

    console.log(`Report "${reportName}" populated: ${stats.controls} controls, ${stats.edges} edges`);
    return stats;
  } catch (err) {
    console.error(`Error populating graph from report "${reportName}":`, err.message);
    throw err;
  }
}

/**
 * Recursively flatten nested intent trees (branch/then/else) into a flat array.
 * @param {Array} intents
 * @returns {Array}
 */
function flattenIntents(intents) {
  const flat = [];
  for (const intent of intents) {
    flat.push(intent);
    if (intent.children) flat.push(...flattenIntents(intent.children));
    if (intent.then) flat.push(...flattenIntents(Array.isArray(intent.then) ? intent.then : [intent.then]));
    if (intent.else) flat.push(...flattenIntents(Array.isArray(intent.else) ? intent.else : [intent.else]));
  }
  return flat;
}

/**
 * Extract the target object name from an intent's params by type.
 * @param {Object} intent
 * @returns {string|null}
 */
function extractTargetObjectName(intent) {
  const type = intent.type || intent.intent_type;
  const params = intent.params || {};
  switch (type) {
    case 'open-form':
    case 'open-form-filtered':
    case 'close-form':
      return params.form_name || params.target || null;
    case 'open-report':
      return params.report_name || params.target || null;
    case 'dlookup':
    case 'dcount':
    case 'dsum':
      return params.domain || null;
    case 'run-sql':
      return null; // SQL string, not an object reference
    case 'set-record-source':
      return params.source || null;
    default:
      return params.target || null;
  }
}

/**
 * Map intent type to the graph node_type of its target.
 * @param {string} intentType
 * @returns {string}
 */
function targetNodeType(intentType) {
  switch (intentType) {
    case 'open-form':
    case 'open-form-filtered':
    case 'close-form':
      return 'form';
    case 'open-report':
      return 'form'; // reports stored as node_type='form' with metadata.object_type='report'
    case 'dlookup':
    case 'dcount':
    case 'dsum':
    case 'set-record-source':
      return 'table';
    default:
      return 'form';
  }
}

/**
 * Populate graph with intent nodes from shared.intents.
 * Creates intent nodes with 'expresses' edges from source modules/forms,
 * and 'targets' edges to referenced objects.
 *
 * @param {Pool} pool
 * @param {string} databaseId
 * @returns {Promise<Object>} - { intents: number, edges: number }
 */
async function populateFromIntents(pool, databaseId) {
  const stats = { intents: 0, edges: 0 };

  try {
    // Load gesture intents with their source objects
    const result = await pool.query(`
      SELECT i.content, o.name as module_name, o.type as object_type
      FROM shared.intents i
      JOIN shared.objects o ON i.object_id = o.id
      WHERE o.database_id = $1 AND i.intent_type = 'gesture' AND o.is_current = true
      ORDER BY o.name
    `, [databaseId]);

    for (const row of result.rows) {
      const data = typeof row.content === 'string' ? JSON.parse(row.content) : row.content;
      const procedures = data.procedures || (Array.isArray(data) ? data : []);

      // Find or create the source module/form node
      const sourceNodeType = row.object_type === 'module' ? 'form' : row.object_type; // modules don't have their own node_type, use form
      let sourceNode = await findNode(pool, 'form', row.module_name, databaseId);

      for (const proc of procedures) {
        const procName = proc.procedure || proc.name;
        const intents = proc.intents || [];
        const flat = flattenIntents(intents);

        for (let idx = 0; idx < flat.length; idx++) {
          const intent = flat[idx];
          const intentType = intent.type || intent.intent_type;
          if (!intentType) continue;

          const nodeName = `${row.module_name}::${procName}::${idx}`;
          const classification = intent.classification || 'unknown';
          const trigger = proc.trigger || null;
          const target = extractTargetObjectName(intent);

          // Create intent node
          const intentNode = await upsertNode(pool, {
            node_type: 'intent',
            name: nodeName,
            database_id: databaseId,
            scope: 'local',
            metadata: {
              intent_type: intentType,
              classification,
              procedure: procName,
              trigger,
              target,
              module: row.module_name
            }
          });
          stats.intents++;

          // Create 'expresses' edge: source module → intent
          if (sourceNode && intentNode) {
            await upsertEdge(pool, {
              from_id: sourceNode.id,
              to_id: intentNode.id,
              rel_type: 'expresses'
            });
            stats.edges++;
          }

          // Create 'targets' edge: intent → referenced object
          if (target && intentNode) {
            const tNodeType = targetNodeType(intentType);
            const targetNode = await findNode(pool, tNodeType, target, databaseId);
            if (targetNode) {
              await upsertEdge(pool, {
                from_id: intentNode.id,
                to_id: targetNode.id,
                rel_type: 'targets'
              });
              stats.edges++;
            }
          }
        }
      }
    }

    console.log(`Intents populated: ${stats.intents} intent nodes, ${stats.edges} edges`);
    return stats;
  } catch (err) {
    console.error('Error populating graph from intents:', err.message);
    throw err;
  }
}

/**
 * Populate graph with route and function contract nodes.
 * Scans source files via regex extractors, creates route/function nodes
 * with field metadata, and creates 'calls' edges from functions to routes.
 *
 * Uses database_id='_system' since routes/functions are system-wide.
 *
 * @param {Pool} pool
 * @returns {Promise<{ routes: number, functions: number, edges: number }>}
 */
async function populateFromRoutes(pool) {
  const { extractRoutes } = require('./extract-routes');
  const { extractFunctions } = require('./extract-functions');

  const stats = { routes: 0, functions: 0, edges: 0 };

  try {
    const routes = extractRoutes();
    const functions = extractFunctions();

    // Build a set of current route/function names for stale cleanup
    const currentRouteNames = new Set();
    const currentFunctionNames = new Set();

    // Create route nodes
    for (const route of routes) {
      const nodeName = `${route.method} ${route.path}`;
      currentRouteNames.add(nodeName);
      await upsertNode(pool, {
        node_type: 'route',
        name: nodeName,
        database_id: '_system',
        scope: 'local',
        metadata: {
          method: route.method,
          path: route.path,
          file: route.file,
          fields: route.fields
        }
      });
      stats.routes++;
    }

    // Create function nodes
    for (const fn of functions) {
      currentFunctionNames.add(fn.name);
      await upsertNode(pool, {
        node_type: 'function',
        name: fn.name,
        database_id: '_system',
        scope: 'local',
        metadata: {
          endpoint: fn.endpoint,
          method: fn.method,
          file: fn.file,
          fields: fn.fields
        }
      });
      stats.functions++;

      // Create 'calls' edge: function → route (matched by endpoint + method)
      const matchingRoute = routes.find(r =>
        r.path === fn.endpoint && r.method === fn.method
      );
      if (matchingRoute) {
        const routeNodeName = `${matchingRoute.method} ${matchingRoute.path}`;
        const routeNode = await findNode(pool, 'route', routeNodeName, '_system');
        const fnNode = await findNode(pool, 'function', fn.name, '_system');
        if (routeNode && fnNode) {
          await upsertEdge(pool, {
            from_id: fnNode.id,
            to_id: routeNode.id,
            rel_type: 'calls'
          });
          stats.edges++;
        }
      }
    }

    // Clean up stale route/function nodes no longer in source
    try {
      const existingRoutes = await findNodesByType(pool, 'route', '_system');
      for (const node of existingRoutes) {
        if (!currentRouteNames.has(node.name)) {
          await deleteNode(pool, node.id);
        }
      }
      const existingFunctions = await findNodesByType(pool, 'function', '_system');
      for (const node of existingFunctions) {
        if (!currentFunctionNames.has(node.name)) {
          await deleteNode(pool, node.id);
        }
      }
    } catch { /* stale cleanup non-fatal */ }

    console.log(`Routes populated: ${stats.routes} routes, ${stats.functions} functions, ${stats.edges} edges`);
    return stats;
  } catch (err) {
    console.error('Error populating graph from routes:', err.message);
    throw err;
  }
}

/**
 * Populate graph from a single table (targeted version of populateFromSchemas).
 * Creates table node, column nodes with contains edges, and FK references edges.
 * @param {Pool} pool
 * @param {string} tableName - PostgreSQL table name
 * @param {string} databaseId - Database ID
 * @param {string} schemaName - PostgreSQL schema name
 * @returns {Promise<Object>} - { table: node, columns: number, edges: number }
 */
async function populateFromTable(pool, tableName, databaseId, schemaName) {
  const stats = { table: null, columns: 0, edges: 0 };

  try {
    // Create table node
    const tableNode = await upsertNode(pool, {
      node_type: 'table',
      name: tableName,
      database_id: databaseId,
      scope: 'local',
      metadata: { schema: schemaName }
    });
    stats.table = tableNode;

    // Get columns for this table
    const colResult = await pool.query(`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2
      ORDER BY ordinal_position
    `, [schemaName, tableName]);

    for (const colRow of colResult.rows) {
      const colNode = await upsertNode(pool, {
        node_type: 'column',
        name: colRow.column_name,
        database_id: databaseId,
        scope: 'local',
        metadata: {
          table: tableName,
          data_type: colRow.data_type,
          nullable: colRow.is_nullable === 'YES',
          default: colRow.column_default
        }
      });
      stats.columns++;

      if (tableNode && colNode) {
        await upsertEdge(pool, {
          from_id: tableNode.id,
          to_id: colNode.id,
          rel_type: 'contains'
        });
        stats.edges++;
      }
    }

    // Get foreign key references
    const fkResult = await pool.query(`
      SELECT
        kcu.column_name,
        ccu.table_name AS referenced_table,
        ccu.column_name AS referenced_column
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name
        AND ccu.table_schema = tc.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema = $1
        AND tc.table_name = $2
    `, [schemaName, tableName]);

    for (const fkRow of fkResult.rows) {
      const colNode = await findNode(pool, 'column', fkRow.column_name, databaseId);
      const refTableNode = await findNode(pool, 'table', fkRow.referenced_table, databaseId);

      if (colNode && refTableNode) {
        await upsertEdge(pool, {
          from_id: colNode.id,
          to_id: refTableNode.id,
          rel_type: 'references',
          metadata: { referenced_column: fkRow.referenced_column }
        });
        stats.edges++;
      }
    }

    console.log(`Table "${tableName}" populated: ${stats.columns} columns, ${stats.edges} edges`);
    return stats;
  } catch (err) {
    console.error(`Error populating graph from table "${tableName}":`, err.message);
    throw err;
  }
}

/**
 * Populate graph from a query/view.
 * Creates a query node and references edges to base tables (for views).
 * @param {Pool} pool
 * @param {string} queryName - PostgreSQL object name
 * @param {string} databaseId - Database ID
 * @param {string} schemaName - PostgreSQL schema name
 * @param {string} pgObjectType - 'view' or 'function'
 * @returns {Promise<Object>} - { query: node, edges: number }
 */
async function populateFromQuery(pool, queryName, databaseId, schemaName, pgObjectType) {
  const stats = { query: null, edges: 0 };

  try {
    const queryNode = await upsertNode(pool, {
      node_type: 'query',
      name: queryName,
      database_id: databaseId,
      scope: 'local',
      metadata: { schema: schemaName, pgObjectType: pgObjectType || 'view' }
    });
    stats.query = queryNode;

    // For views, find referenced tables and create edges
    if (pgObjectType === 'view') {
      const refResult = await pool.query(`
        SELECT DISTINCT table_name
        FROM information_schema.view_column_usage
        WHERE view_schema = $1 AND view_name = $2
          AND table_schema = $1 AND table_name != $2
      `, [schemaName, queryName]);

      for (const row of refResult.rows) {
        const tableNode = await findNode(pool, 'table', row.table_name, databaseId);
        if (tableNode && queryNode) {
          await upsertEdge(pool, {
            from_id: queryNode.id,
            to_id: tableNode.id,
            rel_type: 'references'
          });
          stats.edges++;
        }
      }
    }

    console.log(`Query "${queryName}" populated: ${stats.edges} reference edges`);
    return stats;
  } catch (err) {
    console.error(`Error populating graph from query "${queryName}":`, err.message);
    throw err;
  }
}

/**
 * Populate graph from a module definition.
 * Creates a module node with handler count metadata.
 * @param {Pool} pool
 * @param {string} moduleName - Module name
 * @param {string} databaseId - Database ID
 * @param {Object} definition - Module definition JSONB
 * @returns {Promise<Object>} - { module: node }
 */
async function populateFromModule(pool, moduleName, databaseId, definition) {
  try {
    const jsHandlers = definition?.js_handlers || [];
    const hasVba = !!(definition?.vba_source);

    const moduleNode = await upsertNode(pool, {
      node_type: 'module',
      name: moduleName,
      database_id: databaseId,
      scope: 'local',
      metadata: {
        has_vba: hasVba,
        handler_count: Array.isArray(jsHandlers) ? jsHandlers.length : 0
      }
    });

    console.log(`Module "${moduleName}" populated`);
    return { module: moduleNode };
  } catch (err) {
    console.error(`Error populating graph from module "${moduleName}":`, err.message);
    throw err;
  }
}

/**
 * Populate graph from a macro definition.
 * Creates a macro node with has_xml metadata.
 * @param {Pool} pool
 * @param {string} macroName - Macro name
 * @param {string} databaseId - Database ID
 * @param {Object} definition - Macro definition JSONB
 * @returns {Promise<Object>} - { macro: node }
 */
async function populateFromMacro(pool, macroName, databaseId, definition) {
  try {
    const hasXml = !!(definition?.macro_xml);

    const macroNode = await upsertNode(pool, {
      node_type: 'macro',
      name: macroName,
      database_id: databaseId,
      scope: 'local',
      metadata: { has_xml: hasXml }
    });

    console.log(`Macro "${macroName}" populated`);
    return { macro: macroNode };
  } catch (err) {
    console.error(`Error populating graph from macro "${macroName}":`, err.message);
    throw err;
  }
}

/**
 * Clear all graph data (use with caution!)
 * @param {Pool} pool
 * @returns {Promise<void>}
 */
async function clearGraph(pool) {
  await pool.query('TRUNCATE shared._edges, shared._nodes CASCADE');
  console.log('Graph cleared');
}

module.exports = {
  populateFromSchemas,
  populateFromForm,
  parseFormContent,
  populateFromReport,
  parseReportContent,
  populateFromIntents,
  populateFromRoutes,
  populateFromTable,
  populateFromQuery,
  populateFromModule,
  populateFromMacro,
  flattenIntents,
  extractTargetObjectName,
  clearGraph
};
