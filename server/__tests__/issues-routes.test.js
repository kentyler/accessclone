/**
 * Tests for issues CRUD routes (server/routes/issues.js)
 * Uses supertest with mock pool — no real database needed.
 */

const express = require('express');
const request = require('supertest');

function createApp(mockPool) {
  const app = express();
  app.use(express.json());
  const router = require('../routes/issues')(mockPool);
  app.use('/api/issues', router);
  return app;
}

describe('GET /api/issues', () => {
  test('returns 400 when database_id is missing', async () => {
    const app = createApp({ query: jest.fn() });
    const res = await request(app).get('/api/issues');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/database_id/);
  });

  test('returns issues for a database', async () => {
    const mockPool = {
      query: jest.fn().mockResolvedValue({
        rows: [
          { id: 1, database_id: 'db1', object_type: 'form', object_name: 'F1',
            category: 'empty-section', severity: 'warning', message: 'Footer empty',
            suggestion: null, resolution: 'open', resolution_notes: null,
            created_at: '2026-01-01', resolved_at: null }
        ]
      })
    };
    const app = createApp(mockPool);
    const res = await request(app).get('/api/issues?database_id=db1');
    expect(res.status).toBe(200);
    expect(res.body.issues).toHaveLength(1);
    expect(res.body.issues[0].object_name).toBe('F1');
  });

  test('passes optional filters to query', async () => {
    const mockPool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    const app = createApp(mockPool);
    await request(app).get('/api/issues?database_id=db1&object_type=form&severity=error&resolution=open&category=empty-section&object_name=F1');
    const sql = mockPool.query.mock.calls[0][0];
    const params = mockPool.query.mock.calls[0][1];
    expect(sql).toContain('object_type = $2');
    expect(sql).toContain('object_name = $3');
    expect(sql).toContain('resolution = $4');
    expect(sql).toContain('category = $5');
    expect(sql).toContain('severity = $6');
    expect(params).toContain('db1');
    expect(params).toContain('form');
    expect(params).toContain('error');
  });

  test('returns 500 on database error', async () => {
    const mockPool = { query: jest.fn().mockRejectedValue(new Error('DB down')) };
    const app = createApp(mockPool);
    const res = await request(app).get('/api/issues?database_id=db1');
    expect(res.status).toBe(500);
  });
});

describe('GET /api/issues/summary', () => {
  test('returns 400 when database_id is missing', async () => {
    const app = createApp({ query: jest.fn() });
    const res = await request(app).get('/api/issues/summary');
    expect(res.status).toBe(400);
  });

  test('returns aggregate counts', async () => {
    const mockPool = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ total: '5' }] })
        .mockResolvedValueOnce({ rows: [{ open: '3' }] })
        .mockResolvedValueOnce({ rows: [{ object_type: 'form', count: '2' }, { object_type: 'report', count: '1' }] })
        .mockResolvedValueOnce({ rows: [{ severity: 'warning', count: '2' }, { severity: 'error', count: '1' }] })
        .mockResolvedValueOnce({ rows: [{ category: 'empty-section', count: '3' }] })
    };
    const app = createApp(mockPool);
    const res = await request(app).get('/api/issues/summary?database_id=db1');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(5);
    expect(res.body.open).toBe(3);
    expect(res.body.by_type).toEqual({ form: 2, report: 1 });
    expect(res.body.by_severity).toEqual({ warning: 2, error: 1 });
    expect(res.body.by_category).toEqual({ 'empty-section': 3 });
  });

  test('returns 500 on database error', async () => {
    const mockPool = { query: jest.fn().mockRejectedValue(new Error('DB down')) };
    const app = createApp(mockPool);
    const res = await request(app).get('/api/issues/summary?database_id=db1');
    expect(res.status).toBe(500);
  });
});

describe('PATCH /api/issues/:id', () => {
  test('returns 400 when resolution is missing', async () => {
    const app = createApp({ query: jest.fn() });
    const res = await request(app).patch('/api/issues/1').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/resolution/);
  });

  test('returns 400 for invalid resolution value', async () => {
    const app = createApp({ query: jest.fn() });
    const res = await request(app).patch('/api/issues/1').send({ resolution: 'invalid' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/must be one of/);
  });

  test('accepts valid resolution values', async () => {
    for (const resolution of ['open', 'fixed', 'dismissed', 'deferred']) {
      const mockPool = {
        query: jest.fn().mockResolvedValue({
          rows: [{ id: 1, resolution, resolved_at: resolution !== 'open' ? '2026-01-01' : null }]
        })
      };
      const app = createApp(mockPool);
      const res = await request(app).patch('/api/issues/1').send({ resolution });
      expect(res.status).toBe(200);
      expect(res.body.issue.resolution).toBe(resolution);
    }
  });

  test('passes resolution_notes to query', async () => {
    const mockPool = {
      query: jest.fn().mockResolvedValue({
        rows: [{ id: 1, resolution: 'dismissed', resolution_notes: 'Intentional' }]
      })
    };
    const app = createApp(mockPool);
    await request(app).patch('/api/issues/1').send({ resolution: 'dismissed', resolution_notes: 'Intentional' });
    const params = mockPool.query.mock.calls[0][1];
    expect(params[0]).toBe('dismissed');
    expect(params[1]).toBe('Intentional');
  });

  test('returns 404 when issue not found', async () => {
    const mockPool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    const app = createApp(mockPool);
    const res = await request(app).patch('/api/issues/999').send({ resolution: 'fixed' });
    expect(res.status).toBe(404);
  });

  test('returns 500 on database error', async () => {
    const mockPool = { query: jest.fn().mockRejectedValue(new Error('DB down')) };
    const app = createApp(mockPool);
    const res = await request(app).patch('/api/issues/1').send({ resolution: 'fixed' });
    expect(res.status).toBe(500);
  });
});

describe('DELETE /api/issues/:id', () => {
  test('deletes an issue and returns id', async () => {
    const mockPool = { query: jest.fn().mockResolvedValue({ rows: [{ id: 1 }] }) };
    const app = createApp(mockPool);
    const res = await request(app).delete('/api/issues/1');
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
    expect(res.body.id).toBe(1);
  });

  test('returns 404 when issue not found', async () => {
    const mockPool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    const app = createApp(mockPool);
    const res = await request(app).delete('/api/issues/999');
    expect(res.status).toBe(404);
  });

  test('returns 500 on database error', async () => {
    const mockPool = { query: jest.fn().mockRejectedValue(new Error('DB down')) };
    const app = createApp(mockPool);
    const res = await request(app).delete('/api/issues/1');
    expect(res.status).toBe(500);
  });
});
