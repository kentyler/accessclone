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
 * Create or update a potential node and optionally link structures to it
 * @param {Pool} pool
 * @param {Object} potential - { name, description, origin }
 * @param {Array} structures - [{ node_type, name, database_id }] to link
 * @returns {Promise<Object>} - { potential: node, linked: number }
 */
async function proposePotential(pool, potential, structures = []) {
  const { name, description, origin = 'llm' } = potential;

  // Create potential node
  const potentialNode = await upsertNode(pool, {
    node_type: 'potential',
    name: name,
    database_id: null,
    scope: 'global',
    origin: origin,
    metadata: { description }
  });

  let linked = 0;

  // Link structures to potential
  for (const struct of structures) {
    const structNode = await findNode(pool, struct.node_type, struct.name, struct.database_id);
    if (structNode) {
      await upsertEdge(pool, {
        from_id: structNode.id,
        to_id: potentialNode.id,
        rel_type: 'serves',
        status: 'proposed',
        proposed_by: origin
      });
      linked++;
    }
  }

  console.log(`Potential "${name}" created with ${linked} linked structures`);
  return { potential: potentialNode, linked };
}

/**
 * Confirm a proposed potential link
 * @param {Pool} pool
 * @param {string} structureId - UUID of structure node
 * @param {string} potentialId - UUID of potential node
 * @returns {Promise<boolean>}
 */
async function confirmPotentialLink(pool, structureId, potentialId) {
  const result = await pool.query(`
    UPDATE shared._edges
    SET status = 'confirmed'
    WHERE from_id = $1 AND to_id = $2 AND rel_type = 'serves'
    RETURNING *
  `, [structureId, potentialId]);
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

/**
 * Seed the graph with the four architectural primitives (capabilities)
 * and their known manifestations (potentials).
 *
 * Primitives:
 *   Boundary  — Enclosure. Creating a "here" vs "there" where local rules apply.
 *   Transduction — Isomorphism. Carrying shape across a boundary into a new medium.
 *   Resolution — Gradient descent. Using failure as signal to find the path of least resistance.
 *   Trace (invariant) — Lineage. Ensuring the "whence" is never lost during the "what."
 *
 * Idempotent: safe to call multiple times (upsertNode/upsertEdge handle duplicates).
 *
 * @param {Pool} pool
 * @returns {Promise<Object>} - { capabilities: number, potentials: number, edges: number }
 */
async function seedPrimitives(pool) {
  const stats = { capabilities: 0, potentials: 0, edges: 0 };

  // ── Capability nodes (the four primitives) ──────────────────────────
  const primitives = [
    {
      name: 'Boundary',
      description: 'Enclosure. Creating a "here" versus a "there" where local rules apply. The topological action of place.',
      manifestations: [
        { name: 'Schema Isolation', description: 'PostgreSQL schema-per-database separation — each database gets its own namespace.' },
        { name: 'Tab Workspace', description: 'Tab-based workspace isolation — each open object gets its own editing context.' },
        { name: 'Module Namespace', description: 'ClojureScript namespace boundaries — state.cljs, state_form.cljs, state_report.cljs as separate concerns.' },
        { name: 'Form Section Boundary', description: 'Header/detail/footer sections in forms — each section has its own layout rules and rendering behavior.' },
        { name: 'Report Band Boundary', description: 'Banded report sections — report-header, page-header, group bands, detail, footers as distinct rendering zones.' },
      ]
    },
    {
      name: 'Transduction',
      description: 'Isomorphism. Carrying shape across a boundary into a new medium. The topological action of structure-preserving translation.',
      manifestations: [
        { name: 'Access SQL to PostgreSQL Conversion', description: 'Query converter pipeline — regex pass then LLM fallback, preserving query semantics across database dialects.' },
        { name: 'VBA to ClojureScript Translation', description: 'Module translation — intent extraction then mechanical/LLM code generation, carrying behavior across languages.' },
        { name: 'Intent Extraction', description: 'Extracting structured intents from VBA source — carrying the "what it does" across the boundary from imperative code to declarative structure.' },
        { name: 'Form Definition Normalization', description: 'normalize-form-definition coercing types, yes/no values, numbers on load — carrying form structure across the JSON/ClojureScript boundary.' },
        { name: 'Macro XML to Event Handlers', description: 'Macro conversion — carrying Access macro actions across the boundary into web application event handlers.' },
        { name: 'Graph Population from Schema', description: 'populateFromSchemas scanning information_schema and producing graph nodes — carrying database structure into the graph medium.' },
      ]
    },
    {
      name: 'Resolution',
      description: 'Gradient descent. Using failure as a signal to find the path of least resistance. The topological action of navigating a constraint manifold.',
      manifestations: [
        { name: 'Multi-pass Query Import', description: 'Up to 20-pass retry loop — each pass imports what it can, dependency errors signal what to retry next.' },
        { name: 'Batch Code Generation', description: 'Multi-pass batch generation with dependency retry — skipped modules signal missing dependencies, resolved on subsequent passes.' },
        { name: 'Gap Decision Pipeline', description: 'Extract → auto-resolve where graph context satisfies references → present remaining gaps to user. Progressive narrowing of the unknown.' },
        { name: 'LLM Fallback Conversion', description: 'Regex converter tries first; on failure, error message + context sent to LLM. Failure is the signal that selects the next strategy.' },
        { name: 'Cross-object Lint Validation', description: 'Lint checks record-source, field bindings, combo-box SQL — each failure pinpoints a specific structural mismatch to resolve.' },
      ]
    },
    {
      name: 'Trace',
      description: 'Lineage. Ensuring the "whence" is never lost during the "what." The invariant that all three primitives must preserve.',
      manifestations: [
        { name: 'Append-only Versioning', description: 'Forms, reports, modules, macros use append-only versioning — every save creates a new version, previous states are never destroyed.' },
        { name: 'Event Logging', description: 'shared.events table — all errors and significant events logged with source, timestamp, stack trace, database context.' },
        { name: 'Chat Transcript Persistence', description: 'Transcripts saved per-object — the conversation history that produced a translation or analysis is preserved alongside the result.' },
        { name: 'Import History', description: 'Import log entries with issue tracking — every import operation recorded with its outcomes, warnings, and resolutions.' },
        { name: 'Graph Edge Provenance', description: 'Edge status (proposed/confirmed) and proposed_by (llm/user) — the origin and confidence of every relationship is traceable.' },
      ]
    }
  ];

  for (const primitive of primitives) {
    // Create capability node
    const capNode = await upsertNode(pool, {
      node_type: 'capability',
      name: primitive.name,
      database_id: null,
      scope: 'global',
      origin: 'system',
      metadata: { description: primitive.description, layer: 'primitive' }
    });
    stats.capabilities++;

    // Create potential nodes for each manifestation and link them
    for (const manifestation of primitive.manifestations) {
      const potNode = await upsertNode(pool, {
        node_type: 'potential',
        name: manifestation.name,
        database_id: null,
        scope: 'global',
        origin: 'system',
        metadata: { description: manifestation.description }
      });
      stats.potentials++;

      // potential --actualizes--> capability
      await upsertEdge(pool, {
        from_id: potNode.id,
        to_id: capNode.id,
        rel_type: 'actualizes',
        status: 'confirmed',
        proposed_by: 'system'
      });
      stats.edges++;
    }
  }

  // ── Cross-primitive relationships (refines) ─────────────────────────
  // Trace refines all three primitives — it's the invariant they must preserve
  const traceNode = await findNode(pool, 'capability', 'Trace', null);
  for (const name of ['Boundary', 'Transduction', 'Resolution']) {
    const node = await findNode(pool, 'capability', name, null);
    if (traceNode && node) {
      await upsertEdge(pool, {
        from_id: traceNode.id,
        to_id: node.id,
        rel_type: 'refines',
        metadata: { relationship: 'invariant-of' }
      });
      stats.edges++;
    }
  }

  console.log(`Primitives seeded: ${stats.capabilities} capabilities, ${stats.potentials} potentials, ${stats.edges} edges`);
  return stats;
}

module.exports = {
  populateFromSchemas,
  populateFromForm,
  parseFormContent,
  populateFromReport,
  parseReportContent,
  proposePotential,
  confirmPotentialLink,
  clearGraph,
  seedPrimitives
};
