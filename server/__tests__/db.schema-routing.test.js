const path = require('path');
const { Pool } = require('pg');
const request = require('supertest');
const config = require('../config');
const { createApp } = require('../app');

const shouldRun = process.env.ACCESSCLONE_DB_TESTS === '1';
const describeDb = shouldRun ? describe : describe.skip;

const DB_A = 'test_db_a';
const DB_B = 'test_db_b';
const TABLE = 'items';

describeDb('Schema routing isolation (db)', () => {
  let pool;
  let app;

  beforeAll(async () => {
    pool = new Pool({
      connectionString: config.database.connectionString
    });

    // Shared schema + databases table (minimal)
    await pool.query('CREATE SCHEMA IF NOT EXISTS shared');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS shared.databases (
        database_id VARCHAR(100) PRIMARY KEY,
        name VARCHAR(255),
        schema_name VARCHAR(255) NOT NULL,
        description TEXT,
        last_accessed TIMESTAMPTZ
      )
    `);

    // Create test schemas + tables
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${DB_A}"`);
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${DB_B}"`);

    await pool.query(`CREATE TABLE IF NOT EXISTS "${DB_A}"."${TABLE}" (
      id SERIAL PRIMARY KEY,
      label TEXT NOT NULL
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS "${DB_B}"."${TABLE}" (
      id SERIAL PRIMARY KEY,
      label TEXT NOT NULL
    )`);

    // Reset data
    await pool.query(`TRUNCATE "${DB_A}"."${TABLE}" RESTART IDENTITY`);
    await pool.query(`TRUNCATE "${DB_B}"."${TABLE}" RESTART IDENTITY`);
    await pool.query(`INSERT INTO "${DB_A}"."${TABLE}" (label) VALUES ('A1')`);
    await pool.query(`INSERT INTO "${DB_B}"."${TABLE}" (label) VALUES ('B1')`);

    // Register databases for schema routing
    await pool.query(
      `INSERT INTO shared.databases (database_id, name, schema_name)
       VALUES ($1, $2, $3)
       ON CONFLICT (database_id) DO UPDATE SET
         name = EXCLUDED.name,
         schema_name = EXCLUDED.schema_name`,
      [DB_A, 'Test DB A', DB_A]
    );
    await pool.query(
      `INSERT INTO shared.databases (database_id, name, schema_name)
       VALUES ($1, $2, $3)
       ON CONFLICT (database_id) DO UPDATE SET
         name = EXCLUDED.name,
         schema_name = EXCLUDED.schema_name`,
      [DB_B, 'Test DB B', DB_B]
    );

    const { app: createdApp } = createApp({
      pool,
      secrets: {},
      settingsDir: path.join(__dirname, '..', '..', 'tmp', 'test-settings'),
      uiPublicDir: path.join(__dirname, '..', '..', 'ui', 'resources', 'public')
    });
    app = createdApp;
  }, 30000);

  afterAll(async () => {
    if (!pool) return;
    await pool.query('DELETE FROM shared.databases WHERE database_id IN ($1, $2)', [DB_A, DB_B]);
    await pool.query(`DROP SCHEMA IF EXISTS "${DB_A}" CASCADE`);
    await pool.query(`DROP SCHEMA IF EXISTS "${DB_B}" CASCADE`);
    await pool.end();
  });

  test('reads are isolated by X-Database-ID', async () => {
    const resA = await request(app)
      .get(`/api/data/${TABLE}`)
      .set('X-Database-ID', DB_A)
      .expect(200);

    const resB = await request(app)
      .get(`/api/data/${TABLE}`)
      .set('X-Database-ID', DB_B)
      .expect(200);

    expect(resA.body.data.map(r => r.label)).toContain('A1');
    expect(resA.body.data.map(r => r.label)).not.toContain('B1');

    expect(resB.body.data.map(r => r.label)).toContain('B1');
    expect(resB.body.data.map(r => r.label)).not.toContain('A1');
  });

  test('writes are isolated by X-Database-ID', async () => {
    await request(app)
      .post(`/api/data/${TABLE}`)
      .set('X-Database-ID', DB_A)
      .send({ label: 'A2' })
      .expect(201);

    const countA = await pool.query(`SELECT COUNT(*) FROM "${DB_A}"."${TABLE}" WHERE label = 'A2'`);
    const countB = await pool.query(`SELECT COUNT(*) FROM "${DB_B}"."${TABLE}" WHERE label = 'A2'`);

    expect(parseInt(countA.rows[0].count)).toBe(1);
    expect(parseInt(countB.rows[0].count)).toBe(0);
  });
});
