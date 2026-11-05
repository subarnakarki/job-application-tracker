import { describe, expect, it, vi } from 'vitest';
import { buildApp } from './app';
import type { Db } from './db/types';
import { createTestDb, TEST_DATABASE_URL } from './test/testDb';

function fakeDb(overrides: Partial<Db> = {}): Db {
  return {
    query: vi.fn().mockResolvedValue({ rows: [{ '?column?': 1 }], rowCount: 1 }),
    transaction: vi.fn(),
    end: vi.fn(),
    ...overrides,
  };
}

describe('GET /api/health', () => {
  it('returns ok without touching the database', async () => {
    const query = vi.fn().mockRejectedValue(new Error('database is down'));
    const app = buildApp({ db: fakeDb({ query }) });

    const response = await app.inject({ method: 'GET', url: '/api/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
    expect(query).not.toHaveBeenCalled();
    await app.close();
  });

  it('works with no database configured at all', async () => {
    const app = buildApp();

    expect((await app.inject({ method: 'GET', url: '/api/health' })).json()).toEqual({
      status: 'ok',
    });
    await app.close();
  });
});

describe('GET /api/health/db', () => {
  it('is ok when the database answers', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
    const app = buildApp({ db: fakeDb({ query }) });

    const response = await app.inject({ method: 'GET', url: '/api/health/db' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
    expect(query).toHaveBeenCalledWith('select 1');
    await app.close();
  });

  it('is 503 when no database is configured', async () => {
    const app = buildApp();

    const response = await app.inject({ method: 'GET', url: '/api/health/db' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'unavailable' });
    await app.close();
  });

  it('is 503 when the database fails, and does not reveal why', async () => {
    const db = fakeDb({
      query: vi
        .fn()
        .mockRejectedValue(new Error('password authentication failed for user "jat" at 10.0.0.5')),
    });
    const app = buildApp({ db });

    const response = await app.inject({ method: 'GET', url: '/api/health/db' });

    expect(response.statusCode).toBe(503);
    expect(response.body).toBe('{"status":"unavailable"}');
    await app.close();
  });

  it.skipIf(!TEST_DATABASE_URL)('is ok against a real database', async () => {
    const testDb = await createTestDb();
    try {
      const app = buildApp({ db: testDb.db });

      const response = await app.inject({ method: 'GET', url: '/api/health/db' });

      expect(response.json()).toEqual({ status: 'ok' });
      await app.close();
    } finally {
      await testDb.drop();
    }
  });
});

describe('error handling', () => {
  it('hides the message of an unexpected error and returns a fixed 500 body', async () => {
    const app = buildApp();
    app.get('/boom', { config: { auth: 'public' } }, () => {
      throw new Error('connect ECONNREFUSED 10.0.0.5:5432 password=hunter2');
    });

    const response = await app.inject({ method: 'GET', url: '/boom' });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: 'internal_error' });
    expect(response.body).not.toMatch(/ECONNREFUSED|hunter2|10\.0\.0\.5/);
    await app.close();
  });

  it('hides the message even when the error carries a 5xx status of its own', async () => {
    const app = buildApp();
    app.get('/bad-gateway', { config: { auth: 'public' } }, () => {
      throw Object.assign(new Error('upstream secret detail'), { statusCode: 502 });
    });

    const response = await app.inject({ method: 'GET', url: '/bad-gateway' });

    expect(response.statusCode).toBe(500);
    expect(response.body).toBe('{"error":"internal_error"}');
    await app.close();
  });

  it('keeps the message of a deliberate 4xx error', async () => {
    const app = buildApp();
    app.get('/teapot', { config: { auth: 'public' } }, () => {
      throw Object.assign(new Error('Not allowed here'), { statusCode: 403, code: 'FORBIDDEN' });
    });

    const response = await app.inject({ method: 'GET', url: '/teapot' });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'FORBIDDEN', message: 'Not allowed here' });
    await app.close();
  });

  it('returns 404 JSON for unknown routes', async () => {
    const app = buildApp();

    const response = await app.inject({ method: 'GET', url: '/api/nope' });

    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it('rejects malformed JSON bodies with a 4xx, not a 500', async () => {
    const app = buildApp();
    app.post('/echo', { config: { auth: 'public' } }, (request) => request.body);

    const response = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{"broken":',
    });

    expect(response.statusCode).toBe(400);
    await app.close();
  });
});
