/**
 * Graph Test Templates — generates locked test assertions from graph nodes and edges.
 *
 * Walks all nodes in shared._nodes for a database, groups by type,
 * and emits conformance predicates that verify code matches the graph.
 *
 * Pattern follows contract-test-templates.js.
 */

/**
 * Generate graph-sourced conformance assertions for all objects in a database.
 *
 * @param {Pool} pool
 * @param {string} databaseId
 * @returns {Promise<Array<{ name: string, type: string, intent_type: string, assertions: Array }>>}
 */
async function generateGraphAssertions(pool, databaseId) {
  const objects = [];

  // Load all nodes for this database
  const nodesResult = await pool.query(
    `SELECT id, node_type, name, metadata FROM shared._nodes WHERE database_id = $1`,
    [databaseId]
  );

  // Load all edges between nodes in this database
  const edgesResult = await pool.query(
    `SELECT e.from_id, e.to_id, e.rel_type, e.metadata
     FROM shared._edges e
     JOIN shared._nodes nf ON nf.id = e.from_id AND nf.database_id = $1
     JOIN shared._nodes nt ON nt.id = e.to_id
     WHERE nf.database_id = $1`,
    [databaseId]
  );

  // Index nodes by id and group by type
  const nodesById = new Map();
  const nodesByType = { table: [], column: [], form: [], control: [], query: [], module: [], macro: [] };
  for (const row of nodesResult.rows) {
    const meta = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata || {});
    const node = { id: row.id, node_type: row.node_type, name: row.name, ...meta };
    nodesById.set(row.id, node);
    if (nodesByType[row.node_type]) {
      nodesByType[row.node_type].push(node);
    }
  }

  // Index edges by from_id (outgoing) and to_id (incoming)
  const edgesFrom = new Map(); // from_id → [{ to_id, rel_type, metadata }]
  for (const edge of edgesResult.rows) {
    const meta = typeof edge.metadata === 'string' ? JSON.parse(edge.metadata) : (edge.metadata || {});
    const entry = { from_id: edge.from_id, to_id: edge.to_id, rel_type: edge.rel_type, ...meta };
    if (!edgesFrom.has(edge.from_id)) edgesFrom.set(edge.from_id, []);
    edgesFrom.get(edge.from_id).push(entry);
  }

  // ---- Tables: column existence, nullable, default, FK ----
  for (const table of nodesByType.table) {
    const assertions = [];
    let idx = 0;
    const tableEdges = edgesFrom.get(table.id) || [];

    // Find column nodes via 'contains' edges
    const columnIds = tableEdges.filter(e => e.rel_type === 'contains').map(e => e.to_id);
    for (const colId of columnIds) {
      const col = nodesById.get(colId);
      if (!col || col.node_type !== 'column') continue;

      // table_has_column
      assertions.push({
        id: `graph:table:${table.name}:${idx++}`,
        description: `Table "${table.name}" has column "${col.name}"`,
        predicate: { type: 'table_has_column', table: table.name, column: col.name }
      });

      // column_nullable (if metadata present)
      if (col.nullable !== undefined) {
        assertions.push({
          id: `graph:table:${table.name}:${idx++}`,
          description: `Column "${table.name}.${col.name}" nullable=${col.nullable}`,
          predicate: { type: 'column_nullable', table: table.name, column: col.name, nullable: col.nullable }
        });
      }

      // column_has_default (if metadata indicates a default)
      if (col.default !== null && col.default !== undefined) {
        assertions.push({
          id: `graph:table:${table.name}:${idx++}`,
          description: `Column "${table.name}.${col.name}" has a default value`,
          predicate: { type: 'column_has_default', table: table.name, column: col.name }
        });
      }

      // column_has_fk (from column's 'references' edges)
      const colEdges = edgesFrom.get(colId) || [];
      for (const refEdge of colEdges) {
        if (refEdge.rel_type !== 'references') continue;
        const refTable = nodesById.get(refEdge.to_id);
        if (refTable && refTable.node_type === 'table') {
          assertions.push({
            id: `graph:table:${table.name}:${idx++}`,
            description: `Column "${table.name}.${col.name}" references table "${refTable.name}"`,
            predicate: { type: 'column_has_fk', table: table.name, column: col.name, references_table: refTable.name }
          });
        }
      }
    }

    if (assertions.length > 0) {
      objects.push({
        name: table.name,
        type: 'table',
        intent_type: 'graph',
        assertions
      });
    }
  }

  // ---- Forms and Reports ----
  // Reports are stored with node_type='form' but metadata.object_type='report'
  for (const formNode of nodesByType.form) {
    const isReport = formNode.object_type === 'report';
    const objType = isReport ? 'report' : 'form';
    const assertions = [];
    let idx = 0;
    const formEdges = edgesFrom.get(formNode.id) || [];

    // form_record_source_matches (from bound_to edge to a table)
    const boundToEdges = formEdges.filter(e => e.rel_type === 'bound_to');
    for (const edge of boundToEdges) {
      const tableNode = nodesById.get(edge.to_id);
      if (tableNode && tableNode.node_type === 'table') {
        assertions.push({
          id: `graph:${objType}:${formNode.name}:${idx++}`,
          description: `${isReport ? 'Report' : 'Form'} "${formNode.name}" record-source is "${tableNode.name}"`,
          predicate: { type: 'form_record_source_matches', table: tableNode.name }
        });
      }
    }

    // Controls via 'contains' edges
    const controlEdges = formEdges.filter(e => e.rel_type === 'contains');
    for (const edge of controlEdges) {
      const controlNode = nodesById.get(edge.to_id);
      if (!controlNode || controlNode.node_type !== 'control') continue;

      // definition_has_control (reuse existing predicate)
      assertions.push({
        id: `graph:${objType}:${formNode.name}:${idx++}`,
        description: `${isReport ? 'Report' : 'Form'} "${formNode.name}" has control "${controlNode.name}"`,
        predicate: { type: 'definition_has_control', control_name: controlNode.name }
      });

      // control_field_matches (from control's bound_to edge to a column)
      if (controlNode.binding) {
        const ctrlEdges = edgesFrom.get(controlNode.id) || [];
        const colEdge = ctrlEdges.find(e => e.rel_type === 'bound_to');
        if (colEdge) {
          const colNode = nodesById.get(colEdge.to_id);
          if (colNode && colNode.node_type === 'column') {
            assertions.push({
              id: `graph:${objType}:${formNode.name}:${idx++}`,
              description: `Control "${controlNode.name}" in "${formNode.name}" bound to column "${colNode.name}"`,
              predicate: { type: 'control_field_matches', control_name: controlNode.name, column: colNode.name }
            });
          }
        }
      }
    }

    if (assertions.length > 0) {
      objects.push({
        name: formNode.name,
        type: objType,
        intent_type: 'graph',
        assertions
      });
    }
  }

  // ---- Queries ----
  for (const queryNode of nodesByType.query) {
    const assertions = [];
    let idx = 0;
    const queryEdges = edgesFrom.get(queryNode.id) || [];

    // query_references_table (from 'references' edges)
    const refEdges = queryEdges.filter(e => e.rel_type === 'references');
    for (const edge of refEdges) {
      const tableNode = nodesById.get(edge.to_id);
      if (tableNode && tableNode.node_type === 'table') {
        assertions.push({
          id: `graph:query:${queryNode.name}:${idx++}`,
          description: `Query "${queryNode.name}" references table "${tableNode.name}"`,
          predicate: { type: 'query_references_table', query: queryNode.name, table: tableNode.name }
        });
      }
    }

    // query_object_type (from metadata.pgObjectType)
    if (queryNode.pgObjectType) {
      assertions.push({
        id: `graph:query:${queryNode.name}:${idx++}`,
        description: `Query "${queryNode.name}" is a ${queryNode.pgObjectType}`,
        predicate: { type: 'query_object_type', query: queryNode.name, expected_type: queryNode.pgObjectType }
      });
    }

    if (assertions.length > 0) {
      objects.push({
        name: queryNode.name,
        type: 'query',
        intent_type: 'graph',
        assertions
      });
    }
  }

  // ---- Modules ----
  for (const modNode of nodesByType.module) {
    const assertions = [];
    let idx = 0;

    // module_has_vba
    if (modNode.has_vba !== undefined) {
      assertions.push({
        id: `graph:module:${modNode.name}:${idx++}`,
        description: `Module "${modNode.name}" has_vba=${modNode.has_vba}`,
        predicate: { type: 'module_has_vba', expected: modNode.has_vba }
      });
    }

    // module_handler_count
    if (modNode.handler_count !== undefined) {
      assertions.push({
        id: `graph:module:${modNode.name}:${idx++}`,
        description: `Module "${modNode.name}" has ${modNode.handler_count} handlers`,
        predicate: { type: 'module_handler_count', expected_count: modNode.handler_count }
      });
    }

    if (assertions.length > 0) {
      objects.push({
        name: modNode.name,
        type: 'module',
        intent_type: 'graph',
        assertions
      });
    }
  }

  // ---- Macros ----
  for (const macroNode of nodesByType.macro) {
    const assertions = [];
    let idx = 0;

    // macro_has_xml
    if (macroNode.has_xml !== undefined) {
      assertions.push({
        id: `graph:macro:${macroNode.name}:${idx++}`,
        description: `Macro "${macroNode.name}" has_xml=${macroNode.has_xml}`,
        predicate: { type: 'macro_has_xml', expected: macroNode.has_xml }
      });
    }

    if (assertions.length > 0) {
      objects.push({
        name: macroNode.name,
        type: 'macro',
        intent_type: 'graph',
        assertions
      });
    }
  }

  return objects;
}

module.exports = { generateGraphAssertions };
