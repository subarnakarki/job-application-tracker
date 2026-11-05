import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app';
import { registerSpikeRoutes, SPIKE_COOKIE, type SpikeDeps } from './routes';

function setup(deps: SpikeDeps | null, env: Record<string, string> = {}) {
  const app = buildApp();
  registerSpikeRoutes(app, deps, env);
  return app;
}

const fakeDeps = (): SpikeDeps => ({
  queryNow: vi.fn().mockResolvedValue({ now: '2026-11-05T12:00:00Z', serverVersion: '17.0' }),
  recordPing: vi.fn().mockResolvedValue(3),
});

describe('spike routes', () => {
  it('reports platform info and whether a database is configured', async () => {
    const app = setup(fakeDeps(), { VERCEL_REGION: 'iad1', VERCEL_ENV: 'preview' });
    const response = await app.inject({ method: 'GET', url: '/api/spike/info' });

    expect(response.json()).toMatchObject({
      app: 'Job Application Tracker',
      vercelRegion: 'iad1',
      vercelEnv: 'preview',
      hasDatabaseUrl: true,
    });
    await app.close();
  });

  it('returns 503 on db routes when no database is configured', async () => {
    const app = setup(null);

    expect((await app.inject({ method: 'GET', url: '/api/spike/db' })).statusCode).toBe(503);
    expect((await app.inject({ method: 'POST', url: '/api/spike/db/ping' })).statusCode).toBe(503);
    await app.close();
  });

  it('flags only the first db request of an instance as a cold start', async () => {
    const app = setup(fakeDeps());
    const first = await app.inject({ method: 'GET', url: '/api/spike/db' });
    const second = await app.inject({ method: 'GET', url: '/api/spike/db' });

    expect(first.json<{ coldStart: boolean }>().coldStart).toBe(true);
    expect(second.json<{ coldStart: boolean }>().coldStart).toBe(false);
    await app.close();
  });

  it('records a ping and returns the running total', async () => {
    const app = setup(fakeDeps());
    const response = await app.inject({ method: 'POST', url: '/api/spike/db/ping' });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ total: number }>().total).toBe(3);
    await app.close();
  });

  it('sets a __Host- cookie with the attributes the prefix requires', async () => {
    const app = setup(null);
    const response = await app.inject({ method: 'GET', url: '/api/spike/cookie/set' });
    const header = String(response.headers['set-cookie']);

    expect(header).toContain(`${SPIKE_COOKIE}=1`);
    expect(header).toContain('Secure');
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Lax');
    expect(header).toContain('Path=/');
    expect(header).not.toMatch(/Domain=/i);
    await app.close();
  });

  it('detects the cookie only when it is sent back', async () => {
    const app = setup(null);
    const without = await app.inject({ method: 'GET', url: '/api/spike/cookie/read' });
    const withCookie = await app.inject({
      method: 'GET',
      url: '/api/spike/cookie/read',
      headers: { cookie: `other=1; ${SPIKE_COOKIE}=1` },
    });

    expect(without.json<{ present: boolean }>().present).toBe(false);
    expect(withCookie.json<{ present: boolean }>().present).toBe(true);
    await app.close();
  });
});
