/**
 * Pre-import database assessment.
 * POST /assess — Analyze scan data and return deterministic findings.
 */

const { logError } = require('../../lib/events');

// PostgreSQL reserved words that commonly appear as Access table/query names.
// Full list at https://www.postgresql.org/docs/current/sql-keywords-appendix.html
// We only flag words that are fully reserved or reserved-as-column-name.
const PG_RESERVED_WORDS = new Set([
  'all', 'analyse', 'analyze', 'and', 'any', 'array', 'as', 'asc',
  'asymmetric', 'authorization', 'between', 'binary', 'both', 'case',
  'cast', 'check', 'collate', 'collation', 'column', 'concurrently',
  'constraint', 'create', 'cross', 'current_catalog', 'current_date',
  'current_role', 'current_schema', 'current_time', 'current_timestamp',
  'current_user', 'default', 'deferrable', 'desc', 'distinct', 'do',
  'else', 'end', 'except', 'false', 'fetch', 'for', 'foreign', 'freeze',
  'from', 'full', 'grant', 'group', 'having', 'ilike', 'in', 'initially',
  'inner', 'intersect', 'into', 'is', 'isnull', 'join', 'lateral',
  'leading', 'left', 'like', 'limit', 'localtime', 'localtimestamp',
  'natural', 'not', 'notnull', 'null', 'offset', 'on', 'only', 'or',
  'order', 'outer', 'overlaps', 'placing', 'primary', 'references',
  'returning', 'right', 'select', 'session_user', 'similar', 'some',
  'symmetric', 'table', 'tablesample', 'then', 'to', 'trailing', 'true',
  'union', 'unique', 'user', 'using', 'variadic', 'verbose', 'when',
  'where', 'window', 'with',
  // Common Access names that are PG reserved
  'comment', 'date', 'time', 'timestamp', 'type', 'value', 'values',
  'action', 'admin', 'connection', 'data', 'function', 'index', 'key',
  'level', 'name', 'option', 'password', 'role', 'row', 'schema',
  'sequence', 'session', 'source', 'state', 'status', 'transaction',
  'work', 'zone'
]);

/**
 * Detect the dominant naming convention in a list of names.
 * Returns one of: 'PascalCase', 'camelCase', 'snake_case', 'mixed', 'unknown'
 */
function detectNamingPattern(names) {
  if (!names || names.length < 2) return 'unknown';

  let pascal = 0, camel = 0, snake = 0, space = 0;
  for (const name of names) {
    if (/\s/.test(name)) { space++; continue; }
    if (/^[A-Z][a-zA-Z0-9]*$/.test(name)) pascal++;
    else if (/^[a-z][a-zA-Z0-9]*$/.test(name)) camel++;
    else if (/^[a-z][a-z0-9_]*$/.test(name)) snake++;
  }

  const total = names.length;
  // If >70% follow one pattern, that's the convention
  if (pascal / total > 0.7) return 'PascalCase';
  if (camel / total > 0.7) return 'camelCase';
  if (snake / total > 0.7) return 'snake_case';
  if (space / total > 0.3) return 'spaces';
  return 'mixed';
}

/**
 * Check if a table field name suggests a foreign key relationship.
 * Returns the likely referenced table name, or null.
 */
function inferForeignTable(fieldName, tableNames) {
  const lower = fieldName.toLowerCase();
  // Pattern: <Table>ID or <Table>_ID or <Table>_id
  const match = lower.match(/^(.+?)_?id$/);
  if (!match) return null;
  const stem = match[1];
  // Find a table whose name matches the stem (case-insensitive)
  return tableNames.find(t => {
    const tl = t.toLowerCase();
    return tl === stem || tl === stem + 's' || tl === stem + 'es';
  }) || null;
}

module.exports = function(router, pool) {

  /**
   * POST /api/access-import/assess
   * Analyze Access database scan data and return deterministic findings.
   */
  router.post('/assess', async (req, res) => {
    try {
      const { tables, queries, relationships, forms, reports, modules, macros } = req.body;

      if (!tables || !Array.isArray(tables)) {
        return res.status(400).json({ error: 'tables array required' });
      }

      const structural = [];
      const design = [];
      const complexity = [];
      let sid = 0, did = 0, cid = 0;

      const tableNames = tables.map(t => t.name);

      // Build a set of relationship pairs for quick lookup: "foreignTable:fieldName"
      const relPairs = new Set();
      const relTables = new Set();
      if (relationships && Array.isArray(relationships)) {
        for (const rel of relationships) {
          relTables.add(rel.foreignTable);
          relTables.add(rel.primaryTable);
          if (rel.fields) {
            for (const f of rel.fields) {
              relPairs.add(`${rel.foreignTable}:${f.foreign}`.toLowerCase());
            }
          }
        }
      }

      // ---- TABLE CHECKS ----
      for (const table of tables) {
        const name = table.name;
        const nameLower = name.toLowerCase();
        const fieldCount = table.fieldCount || 0;
        const rowCount = table.rowCount != null ? table.rowCount : -1;

        // Reserved word check
        if (PG_RESERVED_WORDS.has(nameLower)) {
          structural.push({
            id: `s${++sid}`,
            type: 'reserved-word',
            object: name,
            objectType: 'table',
            fixable: true,
            message: `"${name}" is a PostgreSQL reserved word`,
            suggestion: `Rename to "${nameLower}s" or "${nameLower}_data" during import`
          });
        }

        // Wide table check
        if (fieldCount > 30) {
          design.push({
            id: `d${++did}`,
            type: 'wide-table',
            object: name,
            fields: fieldCount,
            message: `${fieldCount} columns \u2014 possible denormalization`
          });
        }

        // Empty table with no relationships (possible junk)
        if (rowCount === 0 && !relTables.has(name)) {
          design.push({
            id: `d${++did}`,
            type: 'empty-table',
            object: name,
            message: 'Empty table with no defined relationships \u2014 may be unused'
          });
        }

        // Missing relationships: look for *ID fields with no corresponding relationship
        // Only check if we have field info (from diagnose or detailed scan)
        // For now, use the simple heuristic on table names
      }

      // Infer missing relationships by scanning all table names for ID-pattern references
      // Since the scan only gives us fieldCount (not field names), we check if tables
      // that look related have no defined relationship
      for (const table of tables) {
        const nameLower = table.name.toLowerCase();
        // Check if any other table name appears as a prefix of this table
        // suggesting it might be a junction/child table
        for (const otherTable of tables) {
          if (otherTable.name === table.name) continue;
          const otherLower = otherTable.name.toLowerCase();
          // Simple heuristic: if table is "OrderDetails" and "Orders" exists
          // but no relationship is defined between them
          if (nameLower.startsWith(otherLower) && nameLower !== otherLower) {
            const hasRel = relationships && relationships.some(r =>
              (r.foreignTable === table.name && r.primaryTable === otherTable.name) ||
              (r.foreignTable === otherTable.name && r.primaryTable === table.name)
            );
            if (!hasRel) {
              design.push({
                id: `d${++did}`,
                type: 'missing-relationship',
                object: table.name,
                relatedTable: otherTable.name,
                message: `"${table.name}" may reference "${otherTable.name}" but no relationship is defined`
              });
            }
          }
        }
      }

      // ---- QUERY CHECKS ----
      if (queries && Array.isArray(queries)) {
        for (const query of queries) {
          const name = query.name;
          const nameLower = name.toLowerCase();
          const qType = (query.type || '').toLowerCase();

          // Reserved word check for query names
          if (PG_RESERVED_WORDS.has(nameLower)) {
            structural.push({
              id: `s${++sid}`,
              type: 'reserved-word',
              object: name,
              objectType: 'query',
              fixable: true,
              message: `"${name}" is a PostgreSQL reserved word`,
              suggestion: `Rename to "vw_${nameLower}" or "${nameLower}_query" during import`
            });
          }

          // Action queries (not select/crosstab)
          if (qType && qType !== 'select' && qType !== 'crosstab') {
            structural.push({
              id: `s${++sid}`,
              type: 'action-query',
              object: name,
              queryType: query.type,
              fixable: false,
              message: `${query.type} query \u2014 cannot be imported as a view`,
              suggestion: 'Will be converted to a PostgreSQL function if possible'
            });
          }

          // Crosstab queries
          if (qType === 'crosstab') {
            complexity.push({
              id: `c${++cid}`,
              type: 'crosstab-query',
              object: name,
              message: 'Crosstab query \u2014 requires tablefunc extension or manual rewrite'
            });
          }

          // PassThrough queries
          if (qType === 'passthrough' || qType === 'pass-through') {
            complexity.push({
              id: `c${++cid}`,
              type: 'passthrough-query',
              object: name,
              message: 'Pass-through query \u2014 SQL targets an external data source'
            });
          }
        }
      }

      // ---- MODULE CHECKS ----
      if (modules && Array.isArray(modules)) {
        for (const mod of modules) {
          const lines = mod.lineCount || mod.lines || 0;
          if (lines > 500) {
            complexity.push({
              id: `c${++cid}`,
              type: 'large-module',
              object: mod.name,
              lines: lines,
              message: `${lines} lines of VBA \u2014 will need careful translation`
            });
          }
        }
      }

      // ---- NAMING CONSISTENCY ----
      const namingPattern = detectNamingPattern(tableNames);
      if (namingPattern === 'mixed' && tableNames.length > 3) {
        design.push({
          id: `d${++did}`,
          type: 'naming-inconsistency',
          object: '(all tables)',
          message: 'Mixed naming conventions across tables (PascalCase, camelCase, spaces, underscores)'
        });
      }

      // ---- SUMMARY ----
      const fixableCount = structural.filter(f => f.fixable).length;
      let recommendation = '';
      if (fixableCount > 0) {
        recommendation = `${fixableCount} structural issue${fixableCount === 1 ? '' : 's'} can be fixed during import.`;
      } else if (structural.length > 0) {
        recommendation = `${structural.length} structural issue${structural.length === 1 ? '' : 's'} found (informational).`;
      } else {
        recommendation = 'No structural issues detected.';
      }

      res.json({
        structural,
        design,
        complexity,
        summary: {
          structural_count: structural.length,
          design_count: design.length,
          complexity_count: complexity.length,
          fixable_count: fixableCount,
          recommendation
        }
      });
    } catch (err) {
      console.error('Error running assessment:', err);
      logError(pool, 'POST /api/access-import/assess', 'Failed to run assessment', err);
      res.status(500).json({ error: 'Failed to run assessment' });
    }
  });

};
