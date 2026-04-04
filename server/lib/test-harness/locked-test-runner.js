/**
 * Locked Test Runner — loads active locked_tests, evaluates each predicate,
 * computes coverage + heterogeneity signals. No LLM.
 */

const { evaluatePredicate, classifyPredicate } = require('./predicate-evaluator');
const { getSchemaInfo } = require('../../routes/lint/cross-object');

/**
 * Build evaluation context for an object.
 *
 * @param {Pool} pool
 * @param {string} databaseId
 * @param {string} schemaName
 * @param {string} objectType
 * @param {string} objectName
 * @returns {Promise<Object>} context for predicate evaluation
 */
async function buildContext(pool, databaseId, schemaName, objectType, objectName) {
  const context = { definition: null, schemaInfo: null, objectsMap: new Map(), handlers: null, macroXml: null, structureIntent: null, columnDetails: new Map(), foreignKeys: [], queryDependencies: null, queryType: null };

  // Schema info (tables + columns)
  try {
    context.schemaInfo = await getSchemaInfo(pool, schemaName);
  } catch { /* ok */ }

  // Objects map
  try {
    const objResult = await pool.query(
      `SELECT name, type FROM shared.objects WHERE database_id = $1 AND is_current = true`,
      [databaseId]
    );
    for (const row of objResult.rows) {
      context.objectsMap.set(row.name, { type: row.type, name: row.name });
      context.objectsMap.set(`${row.type}:${row.name}`, { type: row.type, name: row.name });
    }
  } catch { /* ok */ }

  if (objectType === 'table') {
    // Build column details and FK data for schema predicates
    try {
      const colResult = await pool.query(`
        SELECT column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2
        ORDER BY ordinal_position
      `, [schemaName, objectName]);
      for (const col of colResult.rows) {
        context.columnDetails.set(`${objectName}.${col.column_name}`, {
          type: col.data_type,
          nullable: col.is_nullable === 'YES',
          default: col.column_default
        });
      }

      const fkResult = await pool.query(`
        SELECT kcu.column_name, ccu.table_name AS references_table, ccu.column_name AS references_column
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
        JOIN information_schema.constraint_column_usage ccu
          ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
        WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = $1 AND tc.table_name = $2
      `, [schemaName, objectName]);
      context.foreignKeys = fkResult.rows.map(fk => ({
        table: objectName,
        column: fk.column_name,
        references_table: fk.references_table,
        references_column: fk.references_column
      }));
    } catch { /* ok */ }
  } else {
    // Load definition from shared.objects
    try {
      const defResult = await pool.query(
        `SELECT definition FROM shared.objects WHERE database_id = $1 AND type = $2 AND name = $3 AND is_current = true LIMIT 1`,
        [databaseId, objectType, objectName]
      );
      if (defResult.rows.length > 0) {
        const def = defResult.rows[0].definition;
        context.definition = typeof def === 'string' ? JSON.parse(def) : def;
      }
    } catch { /* ok */ }

    // Load handlers (for modules)
    if (objectType === 'module') {
      try {
        const handlerResult = await pool.query(
          `SELECT definition->'js_handlers' as handlers FROM shared.objects
           WHERE database_id = $1 AND type = 'module' AND name = $2 AND is_current = true LIMIT 1`,
          [databaseId, objectName]
        );
        if (handlerResult.rows.length > 0) {
          const h = handlerResult.rows[0].handlers;
          context.handlers = typeof h === 'string' ? JSON.parse(h) : h;
        }
      } catch { /* ok */ }
    }

    // Load macro_xml
    if (objectType === 'macro' && context.definition) {
      context.macroXml = context.definition.macro_xml || null;
    }

    // Load query dependencies and type
    if (objectType === 'query') {
      try {
        // Check if it's a view
        const viewResult = await pool.query(
          `SELECT table_name FROM information_schema.views WHERE table_schema = $1 AND table_name = $2`,
          [schemaName, objectName]
        );
        if (viewResult.rows.length > 0) {
          context.queryType = 'view';
          // Get referenced tables via view_column_usage
          const depResult = await pool.query(
            `SELECT DISTINCT table_name FROM information_schema.view_column_usage
             WHERE view_schema = $1 AND view_name = $2 AND table_schema = $1 AND table_name != $2`,
            [schemaName, objectName]
          );
          context.queryDependencies = depResult.rows.map(r => r.table_name);
        } else {
          // Check if it's a function
          const fnResult = await pool.query(
            `SELECT routine_name FROM information_schema.routines WHERE routine_schema = $1 AND routine_name = $2`,
            [schemaName, objectName]
          );
          if (fnResult.rows.length > 0) {
            context.queryType = 'function';
            context.queryDependencies = [];
          }
        }
      } catch { /* ok */ }
    }

    // Load structure intent
    try {
      const siResult = await pool.query(`
        SELECT i.content FROM shared.intents i
        JOIN shared.objects o ON i.object_id = o.id
        WHERE o.database_id = $1 AND o.type = $2 AND o.name = $3 AND o.is_current = true
          AND i.intent_type = 'structure'
        ORDER BY i.created_at DESC LIMIT 1
      `, [databaseId, objectType, objectName]);
      if (siResult.rows.length > 0) {
        const si = siResult.rows[0].content;
        context.structureIntent = typeof si === 'string' ? JSON.parse(si) : si;
      }
    } catch { /* ok */ }
  }

  return context;
}

/**
 * Build route and function context maps from graph nodes.
 * Used by contract predicates (route_accepts_fields, function_sends_fields, contract_fields_match).
 *
 * @param {Pool} pool
 * @returns {Promise<{ routeMap: Map, functionMap: Map }>}
 */
async function buildRouteContext(pool) {
  const routeMap = new Map();
  const functionMap = new Map();
  try {
    const result = await pool.query(
      `SELECT name, node_type, metadata FROM shared._nodes WHERE node_type IN ('route', 'function') AND database_id = '_system'`
    );
    for (const row of result.rows) {
      const meta = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata || {});
      if (row.node_type === 'route') {
        routeMap.set(row.name, meta);
      } else {
        functionMap.set(row.name, meta);
      }
    }
  } catch { /* ok */ }
  return { routeMap, functionMap };
}

/**
 * Run all active locked tests for a database.
 *
 * @param {Pool} pool
 * @param {string} databaseId
 * @returns {Promise<{perObject: Array, coverage: number, heterogeneity: number, totalAssertions: number, passedAssertions: number, failedAssertions: number, failureCategories: Object}>}
 */
async function runLockedTests(pool, databaseId) {
  // Get schema name
  const dbResult = await pool.query(
    'SELECT schema_name FROM shared.databases WHERE database_id = $1', [databaseId]
  );
  if (dbResult.rows.length === 0) {
    throw new Error(`Database ${databaseId} not found`);
  }
  const schemaName = dbResult.rows[0].schema_name;

  // Load active locked tests
  const testsResult = await pool.query(
    `SELECT id, object_type, object_name, intent_type, assertions, assertion_count
     FROM shared.locked_tests
     WHERE database_id = $1 AND invalidated_at IS NULL
     ORDER BY object_type, object_name, intent_type`,
    [databaseId]
  );

  if (testsResult.rows.length === 0) {
    return {
      perObject: [],
      coverage: 1.0,
      heterogeneity: 0.0,
      totalAssertions: 0,
      passedAssertions: 0,
      failedAssertions: 0,
      failureCategories: {}
    };
  }

  // Check if any tests have contract predicates — refresh route nodes if so
  const hasContractTests = testsResult.rows.some(row => {
    const a = typeof row.assertions === 'string' ? JSON.parse(row.assertions) : row.assertions;
    return a.some(x => ['route_accepts_fields', 'function_sends_fields', 'contract_fields_match'].includes(x.predicate?.type));
  });
  let routeContext = { routeMap: new Map(), functionMap: new Map() };
  if (hasContractTests) {
    try {
      const { populateFromRoutes } = require('../../graph/populate');
      await populateFromRoutes(pool);
    } catch { /* non-fatal */ }
    routeContext = await buildRouteContext(pool);
  }

  const perObject = [];
  let totalAssertions = 0;
  let passedAssertions = 0;
  const failureCategoryCounts = { boundary: 0, transduction: 0, resolution: 0, trace: 0 };

  // Cache contexts per object to avoid redundant queries
  const contextCache = new Map();

  for (const testRow of testsResult.rows) {
    const assertions = typeof testRow.assertions === 'string'
      ? JSON.parse(testRow.assertions) : testRow.assertions;

    const contextKey = `${testRow.object_type}:${testRow.object_name}`;
    if (!contextCache.has(contextKey)) {
      const ctx = await buildContext(pool, databaseId, schemaName, testRow.object_type, testRow.object_name);
      // Attach route context for contract predicates
      ctx.routeMap = routeContext.routeMap;
      ctx.functionMap = routeContext.functionMap;
      contextCache.set(contextKey, ctx);
    }
    const context = contextCache.get(contextKey);

    const results = [];
    let passed = 0;
    let failed = 0;

    for (const assertion of assertions) {
      const predicateResult = evaluatePredicate(assertion.predicate, context);
      totalAssertions++;
      if (predicateResult) {
        passedAssertions++;
        passed++;
      } else {
        failed++;
        const category = classifyPredicate(assertion.predicate);
        failureCategoryCounts[category] = (failureCategoryCounts[category] || 0) + 1;
      }
      results.push({
        id: assertion.id,
        description: assertion.description,
        passed: predicateResult
      });
    }

    perObject.push({
      object_type: testRow.object_type,
      object_name: testRow.object_name,
      intent_type: testRow.intent_type,
      total: assertions.length,
      passed,
      failed,
      results
    });
  }

  const failedAssertions = totalAssertions - passedAssertions;
  const coverage = totalAssertions > 0 ? passedAssertions / totalAssertions : 1.0;
  const heterogeneity = computeHeterogeneity(failureCategoryCounts);

  return {
    perObject,
    coverage,
    heterogeneity,
    totalAssertions,
    passedAssertions,
    failedAssertions,
    failureCategories: failureCategoryCounts
  };
}

/**
 * Compute Shannon entropy of failure distribution, normalized to [0,1].
 * High entropy = systemic drift across categories.
 *
 * @param {Object} categoryCounts - { boundary, transduction, resolution, trace }
 * @returns {number} - [0, 1]
 */
function computeHeterogeneity(categoryCounts) {
  const counts = Object.values(categoryCounts).filter(c => c > 0);
  if (counts.length === 0) return 0;

  const total = counts.reduce((a, b) => a + b, 0);
  if (total === 0) return 0;

  const maxEntropy = Math.log2(4); // 4 categories
  let entropy = 0;
  for (const count of counts) {
    const p = count / total;
    if (p > 0) entropy -= p * Math.log2(p);
  }

  return entropy / maxEntropy; // normalize to [0, 1]
}

/**
 * Run locked tests for a single object (per-object drift detection).
 *
 * @param {Pool} pool
 * @param {string} databaseId
 * @param {string} objectType - 'form', 'report', 'module', 'macro', 'table'
 * @param {string} objectName
 * @returns {Promise<{passed: number, failed: number, total: number, results: Array, drifted: boolean}|null>}
 *   null if no locked tests exist for this object
 */
async function runLockedTestsForObject(pool, databaseId, objectType, objectName) {
  // Load active locked tests for this specific object
  const testsResult = await pool.query(
    `SELECT id, intent_type, assertions, assertion_count
     FROM shared.locked_tests
     WHERE database_id = $1 AND object_type = $2 AND object_name = $3 AND invalidated_at IS NULL
     ORDER BY intent_type`,
    [databaseId, objectType, objectName]
  );

  if (testsResult.rows.length === 0) {
    return null;
  }

  // Get schema name
  const dbResult = await pool.query(
    'SELECT schema_name FROM shared.databases WHERE database_id = $1', [databaseId]
  );
  if (dbResult.rows.length === 0) {
    return null;
  }
  const schemaName = dbResult.rows[0].schema_name;

  const context = await buildContext(pool, databaseId, schemaName, objectType, objectName);

  // Check if this object has contract predicates — attach route context if so
  const allAssertions = testsResult.rows.flatMap(row => {
    const a = typeof row.assertions === 'string' ? JSON.parse(row.assertions) : row.assertions;
    return a;
  });
  const needsRouteContext = allAssertions.some(x =>
    ['route_accepts_fields', 'function_sends_fields', 'contract_fields_match'].includes(x.predicate?.type)
  );
  if (needsRouteContext) {
    try {
      const { populateFromRoutes } = require('../../graph/populate');
      await populateFromRoutes(pool);
    } catch { /* non-fatal */ }
    const rc = await buildRouteContext(pool);
    context.routeMap = rc.routeMap;
    context.functionMap = rc.functionMap;
  }

  let passed = 0;
  let failed = 0;
  const results = [];

  for (const testRow of testsResult.rows) {
    const assertions = typeof testRow.assertions === 'string'
      ? JSON.parse(testRow.assertions) : testRow.assertions;

    for (const assertion of assertions) {
      const predicateResult = evaluatePredicate(assertion.predicate, context);
      if (predicateResult) {
        passed++;
      } else {
        failed++;
      }
      results.push({
        id: assertion.id,
        description: assertion.description,
        intent_type: testRow.intent_type,
        passed: predicateResult
      });
    }
  }

  const total = passed + failed;
  return { passed, failed, total, results, drifted: failed > 0 };
}

module.exports = {
  runLockedTests,
  runLockedTestsForObject,
  buildContext,
  buildRouteContext,
  computeHeterogeneity
};
