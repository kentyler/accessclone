/**
 * Contract Test Templates — generates locked test assertions from route and function nodes.
 *
 * For each route node: route_accepts_fields predicate with current field list.
 * For each function node with a calls edge: function_sends_fields + contract_fields_match.
 */

/**
 * Generate contract assertions from route and function graph nodes.
 *
 * @param {Pool} pool
 * @returns {Promise<Array<{ name: string, type: string, intent_type: string, assertions: Array }>>}
 */
async function generateContractAssertions(pool) {
  const objects = [];

  // Load all route and function nodes
  const nodesResult = await pool.query(
    `SELECT id, name, node_type, metadata FROM shared._nodes WHERE node_type IN ('route', 'function') AND database_id = '_system'`
  );

  const routeNodes = [];
  const functionNodes = [];
  for (const row of nodesResult.rows) {
    const meta = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata || {});
    if (row.node_type === 'route') {
      routeNodes.push({ id: row.id, name: row.name, ...meta });
    } else {
      functionNodes.push({ id: row.id, name: row.name, ...meta });
    }
  }

  // Load 'calls' edges (function → route)
  const edgesResult = await pool.query(
    `SELECT e.from_id, e.to_id FROM shared._edges e
     JOIN shared._nodes nf ON nf.id = e.from_id AND nf.node_type = 'function'
     JOIN shared._nodes nr ON nr.id = e.to_id AND nr.node_type = 'route'
     WHERE e.rel_type = 'calls'`
  );
  const callsMap = new Map(); // function_id → route_id
  for (const edge of edgesResult.rows) {
    callsMap.set(edge.from_id, edge.to_id);
  }

  // Generate route assertions
  for (const route of routeNodes) {
    const bodyFields = route.fields?.body || [];
    if (bodyFields.length === 0) continue; // skip routes with no body fields

    const assertions = [];
    assertions.push({
      id: `route:${route.name}:contract:0`,
      description: `Route ${route.name} accepts fields: ${bodyFields.join(', ')}`,
      predicate: {
        type: 'route_accepts_fields',
        route: route.name,
        fields: bodyFields
      }
    });

    objects.push({
      name: route.name,
      type: 'route',
      intent_type: 'contract',
      assertions
    });
  }

  // Generate function assertions
  for (const fn of functionNodes) {
    const fnFields = fn.fields || [];
    if (fnFields.length === 0) continue;

    const assertions = [];
    let idx = 0;

    // function_sends_fields
    assertions.push({
      id: `function:${fn.name}:contract:${idx++}`,
      description: `Function ${fn.name} sends fields: ${fnFields.join(', ')}`,
      predicate: {
        type: 'function_sends_fields',
        function: fn.name,
        fields: fnFields
      }
    });

    // contract_fields_match (if this function calls a known route)
    const targetRouteId = callsMap.get(fn.id);
    if (targetRouteId) {
      const targetRoute = routeNodes.find(r => r.id === targetRouteId);
      if (targetRoute) {
        assertions.push({
          id: `function:${fn.name}:contract:${idx++}`,
          description: `Function ${fn.name} fields match route ${targetRoute.name}`,
          predicate: {
            type: 'contract_fields_match',
            function: fn.name,
            route: targetRoute.name
          }
        });
      }
    }

    objects.push({
      name: fn.name,
      type: 'function',
      intent_type: 'contract',
      assertions
    });
  }

  return objects;
}

module.exports = { generateContractAssertions };
