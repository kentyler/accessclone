/**
 * Graph Rendering Functions
 * Convert graph data to human-readable prose for LLM consumption
 */

const {
  findNode,
  findNodeById,
  findNodesByType,
  getEdges,
  traverseDependencies
} = require('./query');

/**
 * Render a node's dependencies to prose
 * @param {Pool} pool
 * @param {string} nodeId - UUID
 * @param {string} direction - 'upstream' or 'downstream'
 * @param {number} maxDepth
 * @returns {Promise<string>}
 */
async function renderDependenciesToProse(pool, nodeId, direction = 'downstream', maxDepth = 3) {
  const node = await findNodeById(pool, nodeId);
  if (!node) return 'Node not found.';

  const deps = await traverseDependencies(pool, nodeId, direction, maxDepth);

  if (deps.length === 0) {
    return direction === 'downstream'
      ? `No other objects depend on ${node.node_type} "${node.name}".`
      : `${node.node_type} "${node.name}" has no dependencies.`;
  }

  const lines = [];
  const directionText = direction === 'downstream' ? 'depends on' : 'is used by';

  lines.push(`**${node.node_type} "${node.name}"** ${directionText}:`);
  lines.push('');

  // Group by depth
  const byDepth = {};
  for (const { node: depNode, edge, depth } of deps) {
    if (!byDepth[depth]) byDepth[depth] = [];
    byDepth[depth].push({ node: depNode, edge });
  }

  for (const depth of Object.keys(byDepth).sort((a, b) => a - b)) {
    const items = byDepth[depth];
    const indent = '  '.repeat(parseInt(depth) - 1);

    for (const { node: depNode, edge } of items) {
      const dbContext = depNode.database_id ? ` (${depNode.database_id})` : '';
      const relContext = edge.rel_type !== 'contains' ? ` [${edge.rel_type}]` : '';
      lines.push(`${indent}- ${depNode.node_type} **${depNode.name}**${dbContext}${relContext}`);
    }
  }

  return lines.join('\n');
}

/**
 * Render a database's structure overview to prose
 * @param {Pool} pool
 * @param {string} databaseId
 * @returns {Promise<string>}
 */
async function renderDatabaseOverview(pool, databaseId) {
  const tables = await findNodesByType(pool, 'table', databaseId);
  const forms = await findNodesByType(pool, 'form', databaseId);

  const lines = [];
  lines.push(`**Database: ${databaseId}**`);
  lines.push('');

  if (tables.length > 0) {
    lines.push(`Tables (${tables.length}):`);
    for (const table of tables) {
      const edges = await getEdges(pool, table.id, 'outgoing');
      const colCount = edges.filter(e => e.rel_type === 'contains').length;
      lines.push(`  - ${table.name} (${colCount} columns)`);
    }
  } else {
    lines.push('No tables found.');
  }

  lines.push('');

  if (forms.length > 0) {
    lines.push(`Forms (${forms.length}):`);
    for (const form of forms) {
      const rs = form.metadata?.record_source || 'unbound';
      lines.push(`  - ${form.name} → ${rs}`);
    }
  } else {
    lines.push('No forms found.');
  }

  return lines.join('\n');
}

/**
 * Render impact analysis for a potential change
 * @param {Pool} pool
 * @param {string} nodeType
 * @param {string} nodeName
 * @param {string} databaseId
 * @returns {Promise<string>}
 */
async function renderImpactAnalysis(pool, nodeType, nodeName, databaseId) {
  const node = await findNode(pool, nodeType, nodeName, databaseId);
  if (!node) return `${nodeType} "${nodeName}" not found in database "${databaseId}".`;

  const downstream = await traverseDependencies(pool, node.id, 'downstream', 5);

  const lines = [];
  lines.push(`**Impact Analysis: ${nodeType} "${nodeName}"**`);
  lines.push('');

  if (downstream.length === 0) {
    lines.push('This object has no known dependents.');
    return lines.join('\n');
  }

  lines.push('**Objects that would be affected:**');

  // Group by type
  const byType = {};
  for (const { node: dep } of downstream) {
    if (!byType[dep.node_type]) byType[dep.node_type] = [];
    byType[dep.node_type].push(dep);
  }

  for (const [type, items] of Object.entries(byType)) {
    lines.push(`\n${type}s (${items.length}):`);
    for (const item of items.slice(0, 10)) {
      lines.push(`  - ${item.name}`);
    }
    if (items.length > 10) {
      lines.push(`  - ... and ${items.length - 10} more`);
    }
  }

  return lines.join('\n');
}

module.exports = {
  renderDependenciesToProse,
  renderDatabaseOverview,
  renderImpactAnalysis
};
