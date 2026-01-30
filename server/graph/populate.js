/**
 * Graph Population Functions
 * Scan schemas and forms to populate the dependency graph
 */

const { upsertNode, upsertEdge, findNode } = require('./query');

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
 * Parse EDN form content (simplified parser for form structure)
 * @param {string} ednContent
 * @returns {Object} - { name, record_source, controls: [...] }
 */
function parseFormEdn(ednContent) {
  const form = {
    name: null,
    record_source: null,
    controls: []
  };

  // Extract form name
  const nameMatch = ednContent.match(/:name\s+"([^"]+)"/);
  if (nameMatch) form.name = nameMatch[1];

  // Extract record source
  const rsMatch = ednContent.match(/:record-source\s+"([^"]+)"/);
  if (rsMatch) form.record_source = rsMatch[1];

  // Extract controls with their bindings
  // Look for control patterns with :name and :control-source or :field
  const controlRegex = /\{[^}]*:type\s+:(\w+)[^}]*:name\s+"([^"]+)"[^}]*(?::control-source\s+"([^"]+)"|:field\s+"([^"]+)")?[^}]*\}/g;
  let match;
  while ((match = controlRegex.exec(ednContent)) !== null) {
    const control = {
      type: match[1],
      name: match[2],
      binding: match[3] || match[4] || null
    };
    form.controls.push(control);
  }

  // Also try alternate pattern where field comes before name
  const altRegex = /\{[^}]*(?::control-source\s+"([^"]+)"|:field\s+"([^"]+)")[^}]*:name\s+"([^"]+)"[^}]*:type\s+:(\w+)[^}]*\}/g;
  while ((match = altRegex.exec(ednContent)) !== null) {
    const control = {
      type: match[4],
      name: match[3],
      binding: match[1] || match[2] || null
    };
    // Avoid duplicates
    if (!form.controls.find(c => c.name === control.name)) {
      form.controls.push(control);
    }
  }

  return form;
}

/**
 * Populate graph from a form definition
 * @param {Pool} pool
 * @param {string} formName - Name of the form
 * @param {string} ednContent - EDN content of the form
 * @param {string} databaseId - Database ID the form belongs to
 * @returns {Promise<Object>} - { form: node, controls: number, edges: number }
 */
async function populateFromForm(pool, formName, ednContent, databaseId) {
  const stats = { form: null, controls: 0, edges: 0 };

  try {
    const parsed = parseFormEdn(ednContent);

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
 * Create or update an intent node and optionally link structures to it
 * @param {Pool} pool
 * @param {Object} intent - { name, description, origin }
 * @param {Array} structures - [{ node_type, name, database_id }] to link
 * @returns {Promise<Object>} - { intent: node, linked: number }
 */
async function proposeIntent(pool, intent, structures = []) {
  const { name, description, origin = 'llm' } = intent;

  // Create intent node
  const intentNode = await upsertNode(pool, {
    node_type: 'intent',
    name: name,
    database_id: null,
    scope: 'global',
    origin: origin,
    metadata: { description }
  });

  let linked = 0;

  // Link structures to intent
  for (const struct of structures) {
    const structNode = await findNode(pool, struct.node_type, struct.name, struct.database_id);
    if (structNode) {
      await upsertEdge(pool, {
        from_id: structNode.id,
        to_id: intentNode.id,
        rel_type: 'serves',
        status: 'proposed',
        proposed_by: origin
      });
      linked++;
    }
  }

  console.log(`Intent "${name}" created with ${linked} linked structures`);
  return { intent: intentNode, linked };
}

/**
 * Confirm a proposed intent link
 * @param {Pool} pool
 * @param {string} structureId - UUID of structure node
 * @param {string} intentId - UUID of intent node
 * @returns {Promise<boolean>}
 */
async function confirmIntentLink(pool, structureId, intentId) {
  const result = await pool.query(`
    UPDATE shared._edges
    SET status = 'confirmed'
    WHERE from_id = $1 AND to_id = $2 AND rel_type = 'serves'
    RETURNING *
  `, [structureId, intentId]);
  return result.rowCount > 0;
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
  parseFormEdn,
  proposeIntent,
  confirmIntentLink,
  clearGraph
};
