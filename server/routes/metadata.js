/**
 * Database metadata routes
 * Lists tables, queries (views), and functions
 */

const express = require('express');
const router = express.Router();
const { logError } = require('../lib/events');
const { clearPkCache } = require('./data');

const NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Map Access-friendly type names to PostgreSQL types
 */
function resolveType(field) {
  const t = (field.type || '').trim();
  switch (t) {
    case 'Short Text':
      return `character varying(${field.maxLength || 255})`;
    case 'Long Text':
      return 'text';
    case 'Number': {
      const fs = (field.fieldSize || 'Long Integer').trim();
      switch (fs) {
        case 'Byte':         return 'smallint';
        case 'Integer':      return 'smallint';
        case 'Long Integer': return 'integer';
        case 'Single':       return 'real';
        case 'Double':       return 'double precision';
        case 'Decimal':      return `numeric(${field.precision || 18},${field.scale || 0})`;
        default:             return 'integer';
      }
    }
    case 'Yes/No':
      return 'boolean';
    case 'Date/Time':
      return 'timestamp without time zone';
    case 'Currency':
      return 'numeric(19,4)';
    case 'AutoNumber':
      return 'integer';
    default:
      // Pass through raw PG types
      return t;
  }
}

function quoteIdent(name) {
  return '"' + name.replace(/"/g, '""') + '"';
}

module.exports = function(pool) {
  /**
   * GET /api/tables
   * List all tables with their columns
   */
  router.get('/tables', async (req, res) => {
    try {
      const schemaName = req.schemaName || 'public';

      // Bulk query: all columns for all tables in schema, with PK/FK info
      const columnsResult = await pool.query(`
        SELECT
          c.table_name,
          c.column_name,
          c.data_type,
          c.is_nullable,
          c.column_default,
          c.character_maximum_length,
          c.numeric_precision,
          c.numeric_scale,
          c.ordinal_position,
          c.is_identity,
          CASE WHEN pk.column_name IS NOT NULL THEN true ELSE false END as is_primary_key,
          CASE WHEN fk.column_name IS NOT NULL THEN true ELSE false END as is_foreign_key,
          fk.foreign_table_name
        FROM information_schema.columns c
        JOIN information_schema.tables t
          ON c.table_name = t.table_name AND c.table_schema = t.table_schema
        LEFT JOIN (
          SELECT kcu.table_name, kcu.column_name
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON tc.constraint_name = kcu.constraint_name
            AND tc.table_schema = kcu.table_schema
          WHERE tc.table_schema = $1
            AND tc.constraint_type = 'PRIMARY KEY'
        ) pk ON c.table_name = pk.table_name AND c.column_name = pk.column_name
        LEFT JOIN (
          SELECT
            kcu.table_name,
            kcu.column_name,
            ccu.table_name as foreign_table_name
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON tc.constraint_name = kcu.constraint_name
            AND tc.table_schema = kcu.table_schema
          JOIN information_schema.constraint_column_usage ccu
            ON tc.constraint_name = ccu.constraint_name
          WHERE tc.table_schema = $1
            AND tc.constraint_type = 'FOREIGN KEY'
        ) fk ON c.table_name = fk.table_name AND c.column_name = fk.column_name
        WHERE c.table_schema = $1
          AND t.table_type = 'BASE TABLE'
        ORDER BY c.table_name, c.ordinal_position
      `, [schemaName]);

      // Bulk query: all column descriptions
      const descResult = await pool.query(`
        SELECT cls.relname as table_name, a.attnum as ordinal, d.description
        FROM pg_description d
        JOIN pg_class cls ON d.objoid = cls.oid
        JOIN pg_namespace n ON cls.relnamespace = n.oid
        JOIN pg_attribute a ON a.attrelid = cls.oid AND a.attnum = d.objsubid
        WHERE n.nspname = $1 AND d.objsubid > 0
      `, [schemaName]);

      // Bulk query: all table descriptions
      const tableDescResult = await pool.query(`
        SELECT cls.relname as table_name, d.description
        FROM pg_description d
        JOIN pg_class cls ON d.objoid = cls.oid
        JOIN pg_namespace n ON cls.relnamespace = n.oid
        WHERE n.nspname = $1 AND d.objsubid = 0
          AND cls.relkind = 'r'
      `, [schemaName]);

      // Bulk query: all check constraints
      const checkResult = await pool.query(`
        SELECT cls.relname as table_name, c.conname, pg_get_constraintdef(c.oid) as def
        FROM pg_constraint c
        JOIN pg_class cls ON c.conrelid = cls.oid
        JOIN pg_namespace n ON cls.relnamespace = n.oid
        WHERE n.nspname = $1 AND c.contype = 'c'
      `, [schemaName]);

      // Bulk query: all indexes
      const indexResult = await pool.query(`
        SELECT tablename, indexname, indexdef
        FROM pg_indexes
        WHERE schemaname = $1
      `, [schemaName]);

      // Build lookup maps keyed by table_name
      // Column descriptions: table_name -> { ordinal -> description }
      const descByTable = {};
      descResult.rows.forEach(r => {
        if (!descByTable[r.table_name]) descByTable[r.table_name] = {};
        descByTable[r.table_name][r.ordinal] = r.description;
      });

      // Table descriptions: table_name -> description
      const tableDescByName = {};
      tableDescResult.rows.forEach(r => { tableDescByName[r.table_name] = r.description; });

      // Check constraints: table_name -> { conname -> def }
      const constraintsByTable = {};
      checkResult.rows.forEach(r => {
        if (!constraintsByTable[r.table_name]) constraintsByTable[r.table_name] = {};
        constraintsByTable[r.table_name][r.conname] = r.def;
      });

      // Indexes: table_name -> { column_name -> "unique" | "yes" }
      const indexesByTable = {};
      indexResult.rows.forEach(r => {
        if (!indexesByTable[r.tablename]) indexesByTable[r.tablename] = {};
        const isUnique = r.indexdef.toUpperCase().includes('UNIQUE');
        const colMatch = r.indexdef.match(/\(([^)]+)\)/);
        if (colMatch) {
          const cols = colMatch[1].split(',').map(c => c.trim().replace(/"/g, ''));
          cols.forEach(col => {
            if (!indexesByTable[r.tablename][col] || isUnique) {
              indexesByTable[r.tablename][col] = isUnique ? 'unique' : 'yes';
            }
          });
        }
      });

      // Group columns by table and build response
      const tableMap = new Map();
      columnsResult.rows.forEach(col => {
        if (!tableMap.has(col.table_name)) {
          tableMap.set(col.table_name, []);
        }
        tableMap.get(col.table_name).push(col);
      });

      const tables = [];
      for (const [tableName, columns] of tableMap) {
        const descMap = descByTable[tableName] || {};
        const constraintMap = constraintsByTable[tableName] || {};
        const indexedMap = indexesByTable[tableName] || {};

        tables.push({
          name: tableName,
          description: tableDescByName[tableName] || null,
          fields: columns.map(col => ({
            name: col.column_name,
            type: col.data_type,
            nullable: col.is_nullable === 'YES',
            default: col.column_default,
            isPrimaryKey: col.is_primary_key,
            isForeignKey: col.is_foreign_key,
            foreignTable: col.foreign_table_name,
            maxLength: col.character_maximum_length,
            precision: col.numeric_precision,
            scale: col.numeric_scale,
            description: descMap[col.ordinal_position] || null,
            indexed: indexedMap[col.column_name] || null,
            checkConstraint: constraintMap[col.column_name] || null,
            isIdentity: col.is_identity === 'YES'
          }))
        });
      }

      res.json({ tables });
    } catch (err) {
      console.error('Error fetching tables:', err);
      logError(pool, 'GET /api/tables', 'Failed to fetch tables', err, { databaseId: req.databaseId });
      res.status(500).json({ error: 'Failed to fetch tables' });
    }
  });

  /**
   * GET /api/queries
   * List all views with their columns and SQL definition
   */
  router.get('/queries', async (req, res) => {
    try {
      const schemaName = req.schemaName || 'public';

      // Get all views with their definitions
      const viewsResult = await pool.query(`
        SELECT
          v.table_name,
          pg_get_viewdef(c.oid, true) as definition
        FROM information_schema.views v
        JOIN pg_class c ON c.relname = v.table_name
        JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = v.table_schema
        WHERE v.table_schema = $1
        ORDER BY v.table_name
      `, [schemaName]);

      const queries = [];
      for (const row of viewsResult.rows) {
        // Get columns for each view
        const columnsResult = await pool.query(`
          SELECT column_name, data_type, is_nullable
          FROM information_schema.columns
          WHERE table_name = $1
            AND table_schema = $2
          ORDER BY ordinal_position
        `, [row.table_name, schemaName]);

        queries.push({
          name: row.table_name,
          sql: row.definition,
          fields: columnsResult.rows.map(col => ({
            name: col.column_name,
            type: col.data_type,
            nullable: col.is_nullable === 'YES'
          }))
        });
      }

      res.json({ queries });
    } catch (err) {
      console.error('Error fetching queries:', err);
      logError(pool, 'GET /api/queries', 'Failed to fetch queries', err, { databaseId: req.databaseId });
      res.status(500).json({ error: 'Failed to fetch queries' });
    }
  });

  /**
   * POST /api/queries/run
   * Execute an arbitrary SQL query and return results
   */
  router.post('/queries/run', async (req, res) => {
    try {
      const { sql } = req.body;
      if (!sql) {
        return res.status(400).json({ error: 'SQL query is required' });
      }

      // Basic safety check - only allow SELECT statements
      const trimmedSql = sql.trim().toLowerCase();
      if (!trimmedSql.startsWith('select')) {
        return res.status(400).json({ error: 'Only SELECT queries are allowed' });
      }

      const result = await pool.query(sql);

      res.json({
        data: result.rows,
        fields: result.fields.map(f => ({
          name: f.name,
          type: f.dataTypeID
        })),
        rowCount: result.rowCount
      });
    } catch (err) {
      console.error('Error running query:', err);
      logError(pool, 'POST /api/queries/run', 'Failed to run query', err, { databaseId: req.databaseId });
      res.status(400).json({ error: err.message });
    }
  });

  /**
   * GET /api/functions
   * List all stored functions (excluding system functions)
   */
  router.get('/functions', async (req, res) => {
    try {
      const schemaName = req.schemaName || 'public';

      const result = await pool.query(`
        SELECT
          p.proname as name,
          pg_get_function_arguments(p.oid) as arguments,
          pg_get_function_result(p.oid) as return_type,
          pg_get_functiondef(p.oid) as definition,
          obj_description(p.oid, 'pg_proc') as description
        FROM pg_proc p
        JOIN pg_namespace n ON p.pronamespace = n.oid
        WHERE n.nspname = $1
          AND p.prokind = 'f'
        ORDER BY p.proname
      `, [schemaName]);

      res.json({
        functions: result.rows.map(row => ({
          name: row.name,
          arguments: row.arguments,
          returnType: row.return_type,
          source: row.definition,
          description: row.description
        }))
      });
    } catch (err) {
      console.error('Error fetching functions:', err);
      logError(pool, 'GET /api/functions', 'Failed to fetch functions', err, { databaseId: req.databaseId });
      res.status(500).json({ error: 'Failed to fetch functions' });
    }
  });

  // ============================================================
  // DDL ENDPOINTS — Create, Modify, Delete tables
  // ============================================================

  /**
   * POST /api/tables — Create a new table
   */
  router.post('/tables', async (req, res) => {
    const client = await pool.connect();
    try {
      const schemaName = req.schemaName || 'public';
      const { name, description, fields } = req.body;

      if (!name || !NAME_RE.test(name)) {
        return res.status(400).json({ error: 'Invalid table name. Use letters, digits, underscores; must start with letter or underscore.' });
      }
      if (!fields || !fields.length) {
        return res.status(400).json({ error: 'At least one field is required.' });
      }

      await client.query('BEGIN');

      // Build column definitions
      const colDefs = fields.map(f => {
        if (!f.name || !NAME_RE.test(f.name)) {
          throw new Error(`Invalid field name: "${f.name}"`);
        }
        const pgType = resolveType(f);
        let def = `${quoteIdent(f.name)} ${pgType}`;
        if (f.type === 'AutoNumber') {
          def += ' GENERATED ALWAYS AS IDENTITY';
        }
        if (!f.nullable && f.type !== 'AutoNumber') {
          def += ' NOT NULL';
        }
        if (f.default != null && f.default !== '' && f.type !== 'AutoNumber') {
          def += ` DEFAULT ${f.default}`;
        }
        return def;
      });

      // Primary key constraint
      const pkFields = fields.filter(f => f.isPrimaryKey);
      if (pkFields.length > 0) {
        colDefs.push(`PRIMARY KEY (${pkFields.map(f => quoteIdent(f.name)).join(', ')})`);
      }

      const createSQL = `CREATE TABLE IF NOT EXISTS ${quoteIdent(schemaName)}.${quoteIdent(name)} (\n  ${colDefs.join(',\n  ')}\n)`;
      await client.query(createSQL);

      // Table description
      if (description) {
        await client.query(`COMMENT ON TABLE ${quoteIdent(schemaName)}.${quoteIdent(name)} IS $1`, [description]);
      }

      // Column descriptions and indexes
      for (const f of fields) {
        if (f.description) {
          await client.query(
            `COMMENT ON COLUMN ${quoteIdent(schemaName)}.${quoteIdent(name)}.${quoteIdent(f.name)} IS $1`,
            [f.description]
          );
        }
        if (f.indexed === 'yes' || f.indexed === 'unique') {
          const unique = f.indexed === 'unique' ? 'UNIQUE ' : '';
          const idxName = `idx_${name}_${f.name}`;
          await client.query(
            `CREATE ${unique}INDEX ${quoteIdent(idxName)} ON ${quoteIdent(schemaName)}.${quoteIdent(name)} (${quoteIdent(f.name)})`
          );
        }
      }

      await client.query('COMMIT');
      clearPkCache(req.databaseId);
      res.json({ success: true, table: name });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('Error creating table:', err);
      logError(pool, 'POST /api/tables', 'Failed to create table', err, { databaseId: req.databaseId });
      res.status(400).json({ error: err.message });
    } finally {
      client.release();
    }
  });

  /**
   * PUT /api/tables/:table — Modify an existing table (diff-based)
   */
  router.put('/tables/:table', async (req, res) => {
    const client = await pool.connect();
    try {
      const schemaName = req.schemaName || 'public';
      const tableName = req.params.table;
      const { fields, renames, description } = req.body;

      if (!NAME_RE.test(tableName)) {
        return res.status(400).json({ error: 'Invalid table name.' });
      }

      await client.query('BEGIN');

      const tbl = `${quoteIdent(schemaName)}.${quoteIdent(tableName)}`;

      // Get current columns from information_schema
      const currentResult = await client.query(`
        SELECT column_name, data_type, is_nullable, column_default,
               character_maximum_length, numeric_precision, numeric_scale, is_identity
        FROM information_schema.columns
        WHERE table_name = $1 AND table_schema = $2
        ORDER BY ordinal_position
      `, [tableName, schemaName]);
      const currentCols = {};
      for (const c of currentResult.rows) {
        currentCols[c.column_name] = c;
      }

      // Get current primary key columns
      const pkResult = await client.query(`
        SELECT kcu.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
        WHERE tc.table_name = $1 AND tc.table_schema = $2 AND tc.constraint_type = 'PRIMARY KEY'
      `, [tableName, schemaName]);
      const currentPKs = new Set(pkResult.rows.map(r => r.column_name));

      // Get current indexes (non-PK, non-unique-constraint)
      const idxResult = await client.query(`
        SELECT indexname, indexdef
        FROM pg_indexes
        WHERE tablename = $1 AND schemaname = $2
      `, [tableName, schemaName]);

      // 1. Apply renames first
      if (renames) {
        for (const [oldName, newName] of Object.entries(renames)) {
          if (oldName !== newName && NAME_RE.test(newName)) {
            await client.query(`ALTER TABLE ${tbl} RENAME COLUMN ${quoteIdent(oldName)} TO ${quoteIdent(newName)}`);
            // Update currentCols key
            if (currentCols[oldName]) {
              currentCols[newName] = currentCols[oldName];
              currentCols[newName].column_name = newName;
              delete currentCols[oldName];
            }
            // Update currentPKs
            if (currentPKs.has(oldName)) {
              currentPKs.delete(oldName);
              currentPKs.add(newName);
            }
          }
        }
      }

      const newColNames = new Set(fields.map(f => f.name));
      const oldColNames = new Set(Object.keys(currentCols));

      // 2. Add new columns
      for (const f of fields) {
        if (!oldColNames.has(f.name)) {
          if (!NAME_RE.test(f.name)) {
            throw new Error(`Invalid field name: "${f.name}"`);
          }
          const pgType = resolveType(f);
          let colDef = `${quoteIdent(f.name)} ${pgType}`;
          if (f.type === 'AutoNumber') {
            colDef += ' GENERATED ALWAYS AS IDENTITY';
          }
          if (!f.nullable && f.type !== 'AutoNumber') {
            colDef += ' NOT NULL';
          }
          if (f.default != null && f.default !== '' && f.type !== 'AutoNumber') {
            colDef += ` DEFAULT ${f.default}`;
          }
          await client.query(`ALTER TABLE ${tbl} ADD COLUMN ${colDef}`);
        }
      }

      // 3. Drop removed columns
      for (const oldName of oldColNames) {
        if (!newColNames.has(oldName)) {
          await client.query(`ALTER TABLE ${tbl} DROP COLUMN ${quoteIdent(oldName)}`);
        }
      }

      // 4. Modify existing columns
      for (const f of fields) {
        const old = currentCols[f.name];
        if (!old) continue; // new column, already handled

        const isIdentity = old.is_identity === 'YES';

        // Skip type/default changes for identity columns — they're managed by PG
        if (!isIdentity) {
          const newPgType = resolveType(f);

          // Type change
          const oldType = old.data_type === 'character varying'
            ? `character varying(${old.character_maximum_length || 255})`
            : old.data_type === 'numeric'
              ? `numeric(${old.numeric_precision || 18},${old.numeric_scale || 0})`
              : old.data_type;

          if (newPgType !== oldType) {
            await client.query(
              `ALTER TABLE ${tbl} ALTER COLUMN ${quoteIdent(f.name)} TYPE ${newPgType} USING ${quoteIdent(f.name)}::${newPgType}`
            );
          }

          // Default change
          const oldDefault = old.column_default;
          const newDefault = (f.default != null && f.default !== '') ? f.default : null;
          if (newDefault !== oldDefault) {
            if (newDefault) {
              await client.query(`ALTER TABLE ${tbl} ALTER COLUMN ${quoteIdent(f.name)} SET DEFAULT ${newDefault}`);
            } else {
              await client.query(`ALTER TABLE ${tbl} ALTER COLUMN ${quoteIdent(f.name)} DROP DEFAULT`);
            }
          }
        }

        // Nullable change (applies to identity columns too)
        const oldNullable = old.is_nullable === 'YES';
        if (f.nullable !== oldNullable) {
          if (f.nullable) {
            await client.query(`ALTER TABLE ${tbl} ALTER COLUMN ${quoteIdent(f.name)} DROP NOT NULL`);
          } else {
            await client.query(`ALTER TABLE ${tbl} ALTER COLUMN ${quoteIdent(f.name)} SET NOT NULL`);
          }
        }
      }

      // 5. Handle primary key changes
      const newPKs = new Set(fields.filter(f => f.isPrimaryKey).map(f => f.name));
      const pkChanged = newPKs.size !== currentPKs.size || [...newPKs].some(k => !currentPKs.has(k));
      if (pkChanged) {
        // Find and drop existing PK constraint
        const pkConstraintResult = await client.query(`
          SELECT constraint_name FROM information_schema.table_constraints
          WHERE table_name = $1 AND table_schema = $2 AND constraint_type = 'PRIMARY KEY'
        `, [tableName, schemaName]);
        for (const row of pkConstraintResult.rows) {
          await client.query(`ALTER TABLE ${tbl} DROP CONSTRAINT ${quoteIdent(row.constraint_name)}`);
        }
        // Add new PK if any
        if (newPKs.size > 0) {
          const pkCols = [...newPKs].map(n => quoteIdent(n)).join(', ');
          await client.query(`ALTER TABLE ${tbl} ADD PRIMARY KEY (${pkCols})`);
        }
      }

      // 6. Handle column descriptions
      for (const f of fields) {
        if (f.description !== undefined) {
          await client.query(
            `COMMENT ON COLUMN ${tbl}.${quoteIdent(f.name)} IS $1`,
            [f.description || null]
          );
        }
      }

      // 7. Handle table description
      if (description !== undefined) {
        await client.query(`COMMENT ON TABLE ${tbl} IS $1`, [description || null]);
      }

      // 8. Handle index changes
      for (const f of fields) {
        if (f.indexed === undefined) continue;
        const idxName = `idx_${tableName}_${f.name}`;
        // Check if index already exists
        const existingIdx = idxResult.rows.find(r => {
          const colMatch = r.indexdef.match(/\(([^)]+)\)/);
          if (!colMatch) return false;
          const cols = colMatch[1].split(',').map(c => c.trim().replace(/"/g, ''));
          return cols.length === 1 && cols[0] === f.name;
        });

        if (!f.indexed || f.indexed === 'No') {
          // Drop index if it exists and is not part of PK
          if (existingIdx && !existingIdx.indexname.endsWith('_pkey')) {
            await client.query(`DROP INDEX IF EXISTS ${quoteIdent(schemaName)}.${quoteIdent(existingIdx.indexname)}`);
          }
        } else {
          // Create or recreate index
          if (existingIdx && !existingIdx.indexname.endsWith('_pkey')) {
            await client.query(`DROP INDEX IF EXISTS ${quoteIdent(schemaName)}.${quoteIdent(existingIdx.indexname)}`);
          }
          const unique = f.indexed === 'unique' ? 'UNIQUE ' : '';
          await client.query(
            `CREATE ${unique}INDEX ${quoteIdent(idxName)} ON ${tbl} (${quoteIdent(f.name)})`
          );
        }
      }

      await client.query('COMMIT');
      clearPkCache(req.databaseId);
      res.json({ success: true });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('Error modifying table:', err);
      logError(pool, 'PUT /api/tables/:table', 'Failed to modify table', err, { databaseId: req.databaseId });
      res.status(400).json({ error: err.message });
    } finally {
      client.release();
    }
  });

  /**
   * DELETE /api/tables/:table — Drop a table
   */
  router.delete('/tables/:table', async (req, res) => {
    try {
      const schemaName = req.schemaName || 'public';
      const tableName = req.params.table;

      if (!NAME_RE.test(tableName)) {
        return res.status(400).json({ error: 'Invalid table name.' });
      }

      await pool.query(`DROP TABLE IF EXISTS ${quoteIdent(schemaName)}.${quoteIdent(tableName)}`);
      res.json({ success: true });
    } catch (err) {
      console.error('Error dropping table:', err);
      logError(pool, 'DELETE /api/tables/:table', 'Failed to drop table', err, { databaseId: req.databaseId });
      res.status(400).json({ error: err.message });
    }
  });

  return router;
};
