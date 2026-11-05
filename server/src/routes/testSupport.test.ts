import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../auth/cookies';
import { createTestApp, SAME_ORIGIN, sessionTokenFrom, T0, type TestApp } from '../test/app';
import { TEST_DATABASE_URL } from '../test/testDb';

const SECRET = 'test-secret-value-1234567890';
const ENV = { ENABLE_TEST_ROUTES: '1', NODE_ENV: 'test', TEST_ROUTES_SECRET: SECRET };
const WITH_SECRET = { ...SAME_ORIGIN, 'x-test-secret': SECRET };

describe.skipIf(!TEST_DATABASE_URL)('test-only routes (real app, real database)', () => {
  describe('when the environment does not allow them', () => {
    it.each([
      ['no test environment flags at all', {}],
      [
        'the flag but a development environment',
        { ENABLE_TEST_ROUTES: '1', NODE_ENV: 'development', TEST_ROUTES_SECRET: SECRET },
      ],
      ['everything right except production', { ...ENV, VERCEL_ENV: 'production' }],
    ])('does not register them: %s', async (_label, env) => {
      const t = await createTestApp({ env });
      try {
        const response = await t.app.inject({
          method: 'POST',
          url: '/api/test/login',
          headers: WITH_SECRET,
          payload: {},
        });

        expect(response.statusCode).toBe(404);
        expect(t.app.registeredRoutes.some((route) => route.url.startsWith('/api/test/'))).toBe(
          false,
        );
        expect((await t.db.query('select 1 from users')).rowCount).toBe(0);
      } finally {
        await t.close();
      }
    });
  });

  describe('per-user clocks are looked up only when test routes are enabled', () => {
    it('leaves a real user on the shared clock even if a stray test_clocks row exists', async () => {
      const probe = (app: FastifyInstance) =>
        app.get('/api/probe/now', { config: { auth: 'user' } }, (request) => ({
          now: request.clock.now().toISOString(),
        }));
      const disabled = await createTestApp({ env: {}, configure: probe });
      const enabled = await createTestApp({ env: ENV, configure: probe });
      try {
        for (const t of [disabled, enabled]) {
          const { user, cookie } = await t.login();
          await t.db.query('insert into test_clocks (user_id, frozen_at) values ($1, $2)', [
            user.id,
            '2001-02-03T04:05:06Z',
          ]);
          const response = await t.app.inject({
            method: 'GET',
            url: '/api/probe/now',
            headers: { cookie },
          });
          const expected = t === disabled ? T0.toISOString() : '2001-02-03T04:05:06.000Z';

          expect(
            response.json(),
            t === disabled ? 'test routes disabled' : 'test routes enabled',
          ).toEqual({ now: expected });
        }
      } finally {
        await disabled.close();
        await enabled.close();
      }
    });
  });

  describe('when allowed', () => {
    let t: TestApp;
    const call = (
      method: 'GET' | 'POST',
      url: string,
      headers: Record<string, string>,
      payload?: object,
    ) => t.app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
    const login = async (payload: object = {}) => {
      const response = await call('POST', '/api/test/login', WITH_SECRET, payload);
      const body = response.json<{ user: { id: string }; token: string }>();
      return {
        response,
        user: body.user,
        token: body.token,
        cookie: `${SESSION_COOKIE}=${body.token}`,
      };
    };

    beforeAll(async () => {
      t = await createTestApp({ env: ENV });
    });
    afterAll(async () => {
      await t.close();
    });

    describe('the secret guard', () => {
      it.each([
        ['no secret', {}],
        ['a wrong secret', { 'x-test-secret': 'definitely-not-the-secret-0000' }],
        ['an empty secret', { 'x-test-secret': '' }],
        ['the secret with a different case', { 'x-test-secret': SECRET.toUpperCase() }],
        ['a prefix of the secret', { 'x-test-secret': SECRET.slice(0, 10) }],
      ])('answers a plain 404 with %s, for every test route', async (_label, extra) => {
        const headers = { ...SAME_ORIGIN, ...extra };
        const before = (await t.db.query('select 1 from users')).rowCount;

        for (const [method, url] of [
          ['POST', '/api/test/login'],
          ['POST', '/api/test/clock'],
          ['GET', '/api/test/now'],
          ['POST', '/api/test/cleanup'],
        ] as const) {
          const response = await call(method, url, headers, method === 'POST' ? {} : undefined);
          expect(response.statusCode, `${method} ${url}`).toBe(404);
          expect(response.json()).toEqual({ error: 'not_found' });
        }
        expect((await t.db.query('select 1 from users')).rowCount).toBe(before);
      });

      it('answers 404, not 401, even for a route that normally needs a session (it does not reveal itself)', async () => {
        const response = await call('GET', '/api/test/now', SAME_ORIGIN);

        expect(response.statusCode).toBe(404);
      });
    });

    describe('POST /api/test/login', () => {
      it('creates a brand-new synthetic user and signs them in', async () => {
        const { response, user, token, cookie } = await login();

        expect(response.statusCode).toBe(200);
        expect(sessionTokenFrom(response)).toBe(token);
        const identity = await t.db.query<{ provider: string; subject: string }>(
          'select provider, subject from identities where user_id = $1',
          [user.id],
        );
        expect(identity.rows).toHaveLength(1);
        expect(identity.rows[0]?.provider).toBe('test');
        expect(identity.rows[0]?.subject).toMatch(/^test:[0-9a-f-]{36}$/);
        const profile = await t.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
        expect(profile.statusCode).toBe(200);
        expect(profile.json()).toMatchObject({
          user: { id: user.id, isDemo: false, timeZone: 'UTC' },
        });
      });

      it('gives every test its own user: no shared state to clean up or collide on', async () => {
        const users = await Promise.all(Array.from({ length: 8 }, () => login()));

        expect(new Set(users.map((entry) => entry.user.id)).size).toBe(8);
        expect(new Set(users.map((entry) => entry.token)).size).toBe(8);
      });

      it('lets the test choose the time zone', async () => {
        const { user } = await login({ timeZone: 'Pacific/Auckland' });

        const row = await t.db.query<{ time_zone: string }>(
          'select time_zone from users where id = $1',
          [user.id],
        );
        expect(row.rows[0]?.time_zone).toBe('Pacific/Auckland');
      });

      it.each([
        ['an offset zone', { timeZone: '+05:00' }],
        ['an unknown key', { isDemo: true }],
        ['a server-owned key', { email: 'x@y.z' }],
      ])('rejects %s with 400 and creates no user', async (_label, payload) => {
        const before = (await t.db.query('select 1 from users')).rowCount;

        const response = await call('POST', '/api/test/login', WITH_SECRET, payload);

        expect(response.statusCode).toBe(400);
        expect((await t.db.query('select 1 from users')).rowCount).toBe(before);
      });

      it('is still protected against cross-site requests', async () => {
        const response = await call(
          'POST',
          '/api/test/login',
          { 'sec-fetch-site': 'cross-site', 'x-test-secret': SECRET },
          {},
        );

        expect(response.statusCode).toBe(403);
      });
    });

    describe('per-user clock', () => {
      const now = (cookie: string) => call('GET', '/api/test/now', { ...WITH_SECRET, cookie });
      const setClock = (cookie: string, payload: object) =>
        call('POST', '/api/test/clock', { ...WITH_SECRET, cookie }, payload);

      it('starts as the shared app clock', async () => {
        const { cookie } = await login();

        expect((await now(cookie)).json()).toEqual({ now: T0.toISOString() });
      });

      it('freezes one user at an instant without moving anyone else', async () => {
        const frozen = await login();
        const bystander = await login();

        const set = await setClock(frozen.cookie, { frozenAt: '2030-06-01T08:00:00Z' });
        t.clock.advance(60_000);

        expect(set.json()).toEqual({ now: '2030-06-01T08:00:00.000Z' });
        expect((await now(frozen.cookie)).json()).toEqual({ now: '2030-06-01T08:00:00.000Z' });
        expect((await now(bystander.cookie)).json()).toEqual({
          now: new Date(T0.getTime() + 60_000).toISOString(),
        });
        t.clock.advance(-60_000);
      });

      it('shifts a user by an offset and keeps following the shared clock', async () => {
        const { cookie } = await login();
        const nineDays = 9 * 24 * 60 * 60 * 1000;

        await setClock(cookie, { offsetMs: nineDays });
        const first = (await now(cookie)).json<{ now: string }>().now;
        t.clock.advance(1000);
        const second = (await now(cookie)).json<{ now: string }>().now;

        expect(first).toBe(new Date(T0.getTime() + nineDays).toISOString());
        expect(new Date(second).getTime() - new Date(first).getTime()).toBe(1000);
        t.clock.advance(-1000);
      });

      it('can be unfrozen again', async () => {
        const { cookie } = await login();
        await setClock(cookie, { frozenAt: '2030-06-01T08:00:00Z' });

        await setClock(cookie, { frozenAt: null });

        expect((await now(cookie)).json()).toEqual({ now: T0.toISOString() });
      });

      it('updates only the field that was sent', async () => {
        const { cookie } = await login();
        await setClock(cookie, { frozenAt: '2030-06-01T08:00:00Z' });

        await setClock(cookie, { offsetMs: 5000 });

        expect((await now(cookie)).json()).toEqual({ now: '2030-06-01T08:00:00.000Z' });
      });

      it('never affects whether the session is valid: sessions follow the real clock', async () => {
        const { cookie } = await login();

        await setClock(cookie, { frozenAt: '2000-01-01T00:00:00Z' });
        expect(
          (await t.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode,
        ).toBe(200);
        await setClock(cookie, { frozenAt: '2100-01-01T00:00:00Z' });
        expect(
          (await t.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode,
        ).toBe(200);
      });

      it.each([
        ['nothing to set', {}],
        ['a non-ISO instant', { frozenAt: 'yesterday' }],
        ['a date with no time', { frozenAt: '2030-06-01' }],
        ['a fractional offset', { offsetMs: 1.5 }],
        ['an absurd offset', { offsetMs: 10 ** 15 }],
        ['an unknown key', { frozenAt: null, userId: 'x' }],
      ])('rejects %s', async (_label, payload) => {
        const { cookie } = await login();

        expect((await setClock(cookie, payload)).statusCode).toBe(400);
      });

      it('requires a signed-in user', async () => {
        const response = await call('POST', '/api/test/clock', WITH_SECRET, { offsetMs: 1 });

        expect(response.statusCode).toBe(401);
      });

      it('refuses to move the clock of a real or demo account', async () => {
        const real = await t.login();
        const demo = await t.app.inject({
          method: 'POST',
          url: '/api/auth/demo',
          headers: SAME_ORIGIN,
          remoteAddress: '203.0.113.5',
        });
        const demoCookie = `${SESSION_COOKIE}=${sessionTokenFrom(demo)}`;

        for (const cookie of [real.cookie, demoCookie]) {
          const response = await setClock(cookie, { offsetMs: 1000 });
          expect(response.statusCode).toBe(403);
        }
        expect(
          (await t.db.query('select 1 from test_clocks where user_id = $1', [real.user.id]))
            .rowCount,
        ).toBe(0);
      });
    });

    describe('POST /api/test/cleanup', () => {
      const cleanup = (minutes: number) =>
        call('POST', '/api/test/cleanup', WITH_SECRET, { olderThanMinutes: minutes });

      it('removes old synthetic users with everything they own, and nobody else', async () => {
        const oldTest = await login();
        const real = await t.login();
        const demo = await t.app.inject({
          method: 'POST',
          url: '/api/auth/demo',
          headers: SAME_ORIGIN,
          remoteAddress: '203.0.113.6',
        });
        t.clock.advance(2 * 60 * 60 * 1000);
        const recentTest = await login();

        const response = await cleanup(60);

        expect(response.statusCode).toBe(200);
        expect(response.json<{ deleted: number }>().deleted).toBeGreaterThanOrEqual(1);
        const exists = async (id: string) =>
          (await t.db.query('select 1 from users where id = $1', [id])).rowCount === 1;
        expect(await exists(oldTest.user.id)).toBe(false);
        expect(await exists(recentTest.user.id)).toBe(true);
        expect(await exists(real.user.id)).toBe(true);
        expect(demo.statusCode).toBe(200);
        expect((await t.db.query('select 1 from users where is_demo')).rowCount).toBe(1);
        expect(
          (await t.db.query('select 1 from sessions where user_id = $1', [oldTest.user.id]))
            .rowCount,
        ).toBe(0);
        t.clock.advance(-2 * 60 * 60 * 1000);
      });

      it.each([
        [{}],
        [{ olderThanMinutes: -1 }],
        [{ olderThanMinutes: 1.5 }],
        [{ olderThanMinutes: 'all' }],
        [{ olderThanMinutes: 5, x: 1 }],
      ])('rejects the body %j', async (payload) => {
        const response = await call('POST', '/api/test/cleanup', WITH_SECRET, payload);

        expect(response.statusCode).toBe(400);
      });
    });
  });
});
