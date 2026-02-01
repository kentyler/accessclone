/**
 * Database metadata routes
 * Lists tables, queries (views), and functions
 * Also handles special "_access_import" database for Access file browsing
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs').promises;
const { spawn } = require('child_process');

// Access Import helpers
const DEFAULT_SCAN_LOCATIONS = [
  'C:\\Users\\Ken\\Desktop',
  'C:\\Users\\Ken\\Documents'
];

async function scanForAccessDatabases() {
  const results = [];

  async function scanDir(dirPath) {
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          if (!entry.name.startsWith('.') && !entry.name.startsWith('$') &&
              entry.name !== 'node_modules' && entry.name !== 'AppData') {
            try { await scanDir(fullPath); } catch {}
          }
        } else if (entry.name.toLowerCase().endsWith('.accdb') ||
                   entry.name.toLowerCase().endsWith('.mdb')) {
          try {
            const stats = await fs.stat(fullPath);
            results.push({
              name: entry.name,
              path: fullPath,
              size: stats.size,
              modified: stats.mtime
            });
          } catch {}
        }
      }
    } catch {}
  }

  for (const loc of DEFAULT_SCAN_LOCATIONS) {
    await scanDir(loc);
  }
  results.sort((a, b) => new Date(b.modified) - new Date(a.modified));
  return results;
}

module.exports = function(pool) {
  /**
   * GET /api/tables
   * List all tables with their columns
   * For _access_import: returns list of Access databases as "tables"
   */
  router.get('/tables', async (req, res) => {
    try {
      const schemaName = req.schemaName || 'public';

      // Special handling for Access Import database
      if (schemaName === '_access_import') {
        const accessDatabases = await scanForAccessDatabases();
        const tables = accessDatabases.map((db, idx) => ({
          name: db.name,
          path: db.path,
          fields: [
            { name: 'path', type: 'text', isPrimaryKey: true },
            { name: 'size', type: 'integer' },
            { name: 'modified', type: 'timestamp' }
          ],
          size: db.size,
          modified: db.modified
        }));
        return res.json({ tables });
      }

      // Get all tables from the current database schema
      const tablesResult = await pool.query(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = $1
          AND table_type = 'BASE TABLE'
        ORDER BY table_name
      `, [schemaName]);

      const tables = [];
      for (const row of tablesResult.rows) {
        // Get columns for each table
        const columnsResult = await pool.query(`
          SELECT
            c.column_name,
            c.data_type,
            c.is_nullable,
            c.column_default,
            CASE WHEN pk.column_name IS NOT NULL THEN true ELSE false END as is_primary_key,
            CASE WHEN fk.column_name IS NOT NULL THEN true ELSE false END as is_foreign_key,
            fk.foreign_table_name
          FROM information_schema.columns c
          LEFT JOIN (
            SELECT kcu.column_name
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
              ON tc.constraint_name = kcu.constraint_name
            WHERE tc.table_name = $1
              AND tc.constraint_type = 'PRIMARY KEY'
          ) pk ON c.column_name = pk.column_name
          LEFT JOIN (
            SELECT
              kcu.column_name,
              ccu.table_name as foreign_table_name
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
              ON tc.constraint_name = kcu.constraint_name
            JOIN information_schema.constraint_column_usage ccu
              ON tc.constraint_name = ccu.constraint_name
            WHERE tc.table_name = $1
              AND tc.constraint_type = 'FOREIGN KEY'
          ) fk ON c.column_name = fk.column_name
          WHERE c.table_name = $1
            AND c.table_schema = $2
          ORDER BY c.ordinal_position
        `, [row.table_name, schemaName]);

        tables.push({
          name: row.table_name,
          fields: columnsResult.rows.map(col => ({
            name: col.column_name,
            type: col.data_type,
            nullable: col.is_nullable === 'YES',
            default: col.column_default,
            isPrimaryKey: col.is_primary_key,
            isForeignKey: col.is_foreign_key,
            foreignTable: col.foreign_table_name
          }))
        });
      }

      res.json({ tables });
    } catch (err) {
      console.error('Error fetching tables:', err);
      res.status(500).json({ error: 'Failed to fetch tables', details: err.message });
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
      res.status(500).json({ error: 'Failed to fetch queries', details: err.message });
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
      res.status(500).json({ error: 'Failed to fetch functions', details: err.message });
    }
  });

  return router;
};
