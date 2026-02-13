/**
 * VBA Stub Function Generator
 *
 * Parses VBA function/sub declarations from module source code and creates
 * PostgreSQL stub functions (RETURN NULL) so that views referencing user-defined
 * functions can be created before the real implementations are translated.
 */

const { sanitizeName, findCloseParen, parseArguments } = require('./query-converter/utils');

// VBA type → PostgreSQL type mapping
const VBA_TYPE_MAP = {
  'long':     'bigint',
  'integer':  'integer',
  'int':      'integer',
  'string':   'text',
  'double':   'double precision',
  'single':   'real',
  'boolean':  'boolean',
  'currency': 'numeric(19,4)',
  'date':     'timestamp',
  'byte':     'smallint',
  'variant':  'text',
  'object':   'text',
};

/**
 * Map a VBA type name to a PostgreSQL type.
 * Returns 'text' for unknown or missing types.
 */
function mapVbaTypeToPg(vbaType) {
  if (!vbaType) return 'text';
  return VBA_TYPE_MAP[vbaType.toLowerCase()] || 'text';
}

/**
 * Parse VBA function and sub declarations from source code.
 * Returns array of { name, params: [{ name, type }], returnType, isSub }
 */
function parseVbaDeclarations(vbaSource) {
  if (!vbaSource) return [];

  const declarations = [];
  // Match: [Public|Private] [Static] Function|Sub Name(params) [As Type]
  const pattern = /(?:^|\n)\s*(?:(?:Public|Private)\s+)?(?:Static\s+)?(?:Function|Sub)\s+(\w+)\s*\(([^)]*)\)(?:\s+As\s+(\w+))?/gi;

  let match;
  while ((match = pattern.exec(vbaSource)) !== null) {
    const name = match[1];
    const paramStr = match[2].trim();
    const returnType = match[3] || null;
    const isSub = /\bSub\b/i.test(match[0]);

    // Parse parameters: "ByVal x As Long, Optional y As String = """
    const params = [];
    if (paramStr) {
      const paramParts = paramStr.split(',');
      for (const part of paramParts) {
        const trimmed = part.trim();
        if (!trimmed) continue;

        // Remove Optional, ByVal, ByRef prefixes
        const cleaned = trimmed.replace(/^(Optional\s+|ByVal\s+|ByRef\s+)+/i, '');

        // Match: paramName [As Type] [= default]
        const paramMatch = cleaned.match(/^(\w+)(?:\s+As\s+(\w+))?/i);
        if (paramMatch) {
          params.push({
            name: paramMatch[1],
            type: paramMatch[2] || null
          });
        }
      }
    }

    declarations.push({ name, params, returnType, isSub });
  }

  return declarations;
}

/**
 * Build a CREATE OR REPLACE FUNCTION statement for a stub.
 * Subs become void functions. Functions return NULL of the appropriate type.
 */
function buildStubDDL(schemaName, decl) {
  const pgName = sanitizeName(decl.name);
  const pgReturnType = decl.isSub ? 'void' : mapVbaTypeToPg(decl.returnType);

  const pgParams = decl.params.map(p => {
    const pName = sanitizeName(p.name);
    const pType = mapVbaTypeToPg(p.type);
    return `${pName} ${pType}`;
  }).join(', ');

  const body = decl.isSub
    ? 'BEGIN\n  -- Stub: no-op\nEND;'
    : 'BEGIN\n  RETURN NULL;\nEND;';

  return `CREATE OR REPLACE FUNCTION "${schemaName}"."${pgName}"(${pgParams}) RETURNS ${pgReturnType} AS $$\n${body}\n$$ LANGUAGE plpgsql;`;
}

/**
 * Create stub functions in the target schema from all VBA modules.
 * Skips functions that already exist in the schema (to avoid overwriting real translations).
 *
 * @param {Pool} pool - PostgreSQL connection pool
 * @param {string} schemaName - Target schema name
 * @param {string|number} databaseId - Target database ID
 * @returns {{ created: string[], skipped: string[], warnings: string[] }}
 */
async function createStubFunctions(pool, schemaName, databaseId) {
  const created = [];
  const skipped = [];
  const warnings = [];

  // 1. Load all current modules for this database
  const modulesResult = await pool.query(
    `SELECT name, vba_source FROM shared.modules
     WHERE database_id = $1 AND is_current = true AND vba_source IS NOT NULL`,
    [databaseId]
  );

  if (modulesResult.rows.length === 0) {
    return { created, skipped, warnings };
  }

  // 2. Get all existing functions in the schema
  const existingResult = await pool.query(
    `SELECT routine_name FROM information_schema.routines
     WHERE routine_schema = $1`,
    [schemaName]
  );
  const existingFunctions = new Set(existingResult.rows.map(r => r.routine_name));

  // 3. Parse declarations from each module
  const allDeclarations = [];
  for (const mod of modulesResult.rows) {
    const decls = parseVbaDeclarations(mod.vba_source);
    for (const decl of decls) {
      allDeclarations.push({ ...decl, moduleName: mod.name });
    }
  }

  if (allDeclarations.length === 0) {
    return { created, skipped, warnings };
  }

  // 4. Create stubs for functions that don't already exist
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const decl of allDeclarations) {
      const pgName = sanitizeName(decl.name);

      if (existingFunctions.has(pgName)) {
        skipped.push(pgName);
        continue;
      }

      try {
        const ddl = buildStubDDL(schemaName, decl);
        await client.query(ddl);
        created.push(pgName);
        existingFunctions.add(pgName); // prevent duplicates across modules
      } catch (err) {
        warnings.push(`Failed to create stub for ${pgName} (module: ${decl.moduleName}): ${err.message}`);
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    warnings.push(`Transaction failed: ${err.message}`);
  } finally {
    client.release();
  }

  return { created, skipped, warnings };
}

/**
 * Scan converted SQL statements for schema-qualified function calls that
 * don't exist in PG, and create zero-arg or N-arg text stubs on the fly.
 * Catches functions referenced in query SQL that aren't in any VBA module
 * (e.g. Access parameter-provider functions, form code-behind functions).
 *
 * @param {Pool} pool
 * @param {string} schemaName
 * @param {string[]} statements - The converted SQL statements to scan
 * @returns {{ created: string[], warnings: string[] }}
 */
async function ensureStubsForSQL(pool, schemaName, statements) {
  const created = [];
  const warnings = [];

  // 1. Find all "schema"."funcname"( calls and parse their arg counts
  const escapedSchema = schemaName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const callPattern = new RegExp(`"${escapedSchema}"\\."(\\w+)"\\s*\\(`, 'g');

  // Map: funcName → argCount (max seen)
  const funcCalls = new Map();

  for (const stmt of statements) {
    let match;
    callPattern.lastIndex = 0;
    while ((match = callPattern.exec(stmt)) !== null) {
      const funcName = match[1];
      // Find the opening paren position
      const parenIdx = stmt.indexOf('(', match.index + match[0].length - 1);
      if (parenIdx === -1) continue;

      const closeIdx = findCloseParen(stmt, parenIdx);
      if (closeIdx === -1) continue;

      const argsStr = stmt.substring(parenIdx + 1, closeIdx).trim();
      const argCount = argsStr === '' ? 0 : parseArguments(argsStr).length;

      const prev = funcCalls.get(funcName);
      if (prev === undefined || argCount > prev) {
        funcCalls.set(funcName, argCount);
      }
    }
  }

  if (funcCalls.size === 0) return { created, warnings };

  // 2. Check which functions already exist
  const existingResult = await pool.query(
    `SELECT routine_name FROM information_schema.routines
     WHERE routine_schema = $1`,
    [schemaName]
  );
  const existingFunctions = new Set(existingResult.rows.map(r => r.routine_name));

  // 3. Create stubs for missing functions
  const toCreate = [];
  for (const [funcName, argCount] of funcCalls) {
    if (!existingFunctions.has(funcName)) {
      toCreate.push({ funcName, argCount });
    }
  }

  if (toCreate.length === 0) return { created, warnings };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const { funcName, argCount } of toCreate) {
      const params = Array.from({ length: argCount }, (_, i) => `p${i + 1} text`).join(', ');
      const ddl = `CREATE OR REPLACE FUNCTION "${schemaName}"."${funcName}"(${params}) RETURNS text AS $$\nBEGIN\n  RETURN NULL;\nEND;\n$$ LANGUAGE plpgsql;`;

      try {
        await client.query(ddl);
        created.push(funcName);
        existingFunctions.add(funcName);
      } catch (err) {
        warnings.push(`Failed to create stub for ${funcName}: ${err.message}`);
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    warnings.push(`Transaction failed: ${err.message}`);
  } finally {
    client.release();
  }

  return { created, warnings };
}

module.exports = {
  parseVbaDeclarations,
  mapVbaTypeToPg,
  buildStubDDL,
  createStubFunctions,
  ensureStubsForSQL
};
