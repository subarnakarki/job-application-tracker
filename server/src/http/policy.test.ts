import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { enforceRoutePolicy } from './policy';

function bare() {
  const app = Fastify();
  enforceRoutePolicy(app);
  return app;
}

describe('route policy: every route must declare who may call it', () => {
  it('refuses to register a route with no auth mode, and names the route', () => {
    const app = bare();

    expect(() => app.get('/api/secret', () => 'x')).toThrow(
      "GET /api/secret must declare config.auth as 'public' or 'user'",
    );
  });

  it('refuses a route that has config but no auth', () => {
    const app = bare();

    expect(() => app.post('/api/things', { config: {} }, () => 'x')).toThrow(
      'must declare config.auth',
    );
  });

  it.each(['admin', 'PUBLIC', '', 'none', 1, null, true])(
    'refuses an unknown auth mode %j',
    (mode) => {
      const app = bare();

      expect(() => app.get('/api/x', { config: { auth: mode as never } }, () => 'x')).toThrow(
        'must declare config.auth',
      );
    },
  );

  it('accepts both modes and records them with whether the method changes state', async () => {
    const app = bare();
    app.get('/api/open', { config: { auth: 'public' } }, () => 'x');
    app.post('/api/closed', { config: { auth: 'user' } }, () => 'x');
    app.delete('/api/closed/:id', { config: { auth: 'user' } }, () => 'x');
    await app.ready();

    expect(app.registeredRoutes).toEqual([
      { method: 'GET', url: '/api/open', auth: 'public', mutating: false },
      { method: 'POST', url: '/api/closed', auth: 'user', mutating: true },
      { method: 'DELETE', url: '/api/closed/:id', auth: 'user', mutating: true },
    ]);
  });

  it('lists a multi-method route once per method', () => {
    const app = bare();
    app.route({
      method: ['GET', 'PUT'],
      url: '/api/multi',
      config: { auth: 'user' },
      handler: () => 'x',
    });

    expect(app.registeredRoutes.map((route) => [route.method, route.mutating])).toEqual([
      ['GET', false],
      ['PUT', true],
    ]);
  });

  it('does not list the HEAD route Fastify derives from a GET', () => {
    const app = bare();
    app.get('/api/open', { config: { auth: 'public' } }, () => 'x');

    expect(app.registeredRoutes.map((route) => route.method)).toEqual(['GET']);
  });

  it('applies to the real app: every route buildApp registers is declared', async () => {
    const app = buildApp();
    await app.ready();

    expect(app.registeredRoutes.length).toBeGreaterThan(0);
    for (const route of app.registeredRoutes) expect(['public', 'user']).toContain(route.auth);
  });
});
