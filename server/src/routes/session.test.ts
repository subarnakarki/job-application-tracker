import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../auth/cookies';
import { SESSION_RENEW_AFTER_MS, SESSION_TTL_MS } from '../auth/sessions';
import {
  createTestApp,
  SAME_ORIGIN,
  sessionTokenFrom,
  setCookies,
  type TestApp,
} from '../test/app';
import { TEST_DATABASE_URL } from '../test/testDb';
import { DEMO_LOGIN_RULE } from './session';

const HOUR = 60 * 60 * 1000;

describe.skipIf(!TEST_DATABASE_URL)('demo sign-in and sign-out (real app, real database)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.close();
  });

  const demoLogin = (
    headers: Record<string, string> = SAME_ORIGIN,
    remoteAddress = '203.0.113.50',
  ) => t.app.inject({ method: 'POST', url: '/api/auth/demo', headers, remoteAddress });
  const me = (cookie?: string) =>
    t.app.inject({ method: 'GET', url: '/api/me', headers: cookie ? { cookie } : {} });
  const count = async (sql: string) => (await t.db.query<{ n: number }>(sql)).rows[0]?.n;

  describe('POST /api/auth/demo', () => {
    it('signs in as the demo user and sets a hardened session cookie', async () => {
      const response = await demoLogin();

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        user: { isDemo: true, name: 'Demo', timeZone: 'UTC' },
      });
      const header =
        setCookies(response).find((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`)) ?? '';
      expect(header).toContain('Path=/');
      expect(header).toContain('Secure');
      expect(header).toContain('HttpOnly');
      expect(header).toContain('SameSite=Lax');
      expect(header).toContain(`Max-Age=${SESSION_TTL_MS / 1000}`);
      expect(header).not.toMatch(/Domain=/i);
      expect(response.headers['cache-control']).toBe('no-store');
    });

    it('issues a cookie that works', async () => {
      const response = await demoLogin(SAME_ORIGIN, '203.0.113.51');
      const token = sessionTokenFrom(response);

      const profile = await me(`${SESSION_COOKIE}=${token}`);

      expect(profile.statusCode).toBe(200);
      expect(profile.json()).toMatchObject({ user: { isDemo: true } });
    });

    it('never puts the session token in the response body', async () => {
      const response = await demoLogin(SAME_ORIGIN, '203.0.113.52');
      const token = sessionTokenFrom(response) ?? 'missing';

      expect(response.body).not.toContain(token);
    });

    it('reuses one demo user across logins but gives each login its own session', async () => {
      const first = await demoLogin(SAME_ORIGIN, '203.0.113.53');
      const second = await demoLogin(SAME_ORIGIN, '203.0.113.54');

      expect(first.json<{ user: { id: string } }>().user.id).toBe(
        second.json<{ user: { id: string } }>().user.id,
      );
      expect(sessionTokenFrom(first)).not.toBe(sessionTokenFrom(second));
      expect(await count('select count(*)::int as n from users where is_demo')).toBe(1);
      expect(await count("select count(*)::int as n from identities where provider = 'demo'")).toBe(
        1,
      );
    });

    it('creates exactly one demo user when many visitors arrive together on a fresh database', async () => {
      const fresh = await createTestApp();
      try {
        const responses = await Promise.all(
          Array.from({ length: 12 }, (_, index) =>
            fresh.app.inject({
              method: 'POST',
              url: '/api/auth/demo',
              headers: SAME_ORIGIN,
              remoteAddress: `198.51.100.${index + 1}`,
            }),
          ),
        );

        expect(responses.every((response) => response.statusCode === 200)).toBe(true);
        const users = await fresh.db.query('select 1 from users where is_demo');
        const identities = await fresh.db.query("select 1 from identities where provider = 'demo'");
        expect([users.rowCount, identities.rowCount]).toEqual([1, 1]);
      } finally {
        await fresh.close();
      }
    });

    it("replaces the browser's previous session when signing in again", async () => {
      const first = await demoLogin(SAME_ORIGIN, '203.0.113.60');
      const oldCookie = `${SESSION_COOKIE}=${sessionTokenFrom(first)}`;

      const second = await t.app.inject({
        method: 'POST',
        url: '/api/auth/demo',
        headers: { ...SAME_ORIGIN, cookie: oldCookie },
        remoteAddress: '203.0.113.60',
      });

      expect(second.statusCode).toBe(200);
      expect((await me(oldCookie)).statusCode).toBe(401);
      expect((await me(`${SESSION_COOKIE}=${sessionTokenFrom(second)}`)).statusCode).toBe(200);
    });

    describe('rate limiting', () => {
      const ip = '203.0.113.99';

      it(`allows ${DEMO_LOGIN_RULE.limit} sign-ins per hour per address, then answers 429 with Retry-After and no cookie`, async () => {
        for (let attempt = 0; attempt < DEMO_LOGIN_RULE.limit; attempt += 1) {
          expect((await demoLogin(SAME_ORIGIN, ip)).statusCode).toBe(200);
        }

        const blocked = await demoLogin(SAME_ORIGIN, ip);

        expect(blocked.statusCode).toBe(429);
        expect(blocked.json()).toMatchObject({ error: 'rate_limited' });
        expect(Number(blocked.headers['retry-after'])).toBeGreaterThanOrEqual(1);
        expect(Number(blocked.headers['retry-after'])).toBeLessThanOrEqual(3600);
        expect(sessionTokenFrom(blocked)).toBeNull();
      });

      it('does not block a different address', async () => {
        expect((await demoLogin(SAME_ORIGIN, '203.0.113.100')).statusCode).toBe(200);
      });

      it('lets the address back in when the next hour starts', async () => {
        t.clock.advance(HOUR);

        expect((await demoLogin(SAME_ORIGIN, ip)).statusCode).toBe(200);
      });
    });

    describe('request guards', () => {
      it('refuses a cross-site request and creates no session', async () => {
        const before = await count('select count(*)::int as n from sessions');

        const response = await demoLogin({ 'sec-fetch-site': 'cross-site' }, '203.0.113.70');

        expect(response.statusCode).toBe(403);
        expect(response.json()).toMatchObject({ error: 'cross_site_request' });
        expect(sessionTokenFrom(response)).toBeNull();
        expect(await count('select count(*)::int as n from sessions')).toBe(before);
      });

      it('refuses a mismatched Origin when the browser sends no Sec-Fetch-Site', async () => {
        const response = await demoLogin(
          { origin: 'https://evil.example', host: 'app.example.com' },
          '203.0.113.71',
        );

        expect(response.statusCode).toBe(403);
      });

      it('refuses a form-encoded body', async () => {
        const response = await t.app.inject({
          method: 'POST',
          url: '/api/auth/demo',
          headers: { ...SAME_ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
          payload: 'a=1',
          remoteAddress: '203.0.113.72',
        });

        expect(response.statusCode).toBe(415);
      });
    });
  });

  describe('POST /api/auth/logout', () => {
    it('ends the session, clears the cookie, and answers 204', async () => {
      const { cookie } = await t.login();

      const response = await t.app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: { ...SAME_ORIGIN, cookie },
      });

      expect(response.statusCode).toBe(204);
      expect(response.body).toBe('');
      expect(setCookies(response)[0]).toContain('Max-Age=0');
      expect((await me(cookie)).statusCode).toBe(401);
    });

    it("leaves the same user's other sessions alone", async () => {
      const { user, cookie } = await t.login();
      const other = await demoLogin(SAME_ORIGIN, '203.0.113.80');
      const otherCookie = `${SESSION_COOKIE}=${sessionTokenFrom(other)}`;

      await t.app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: { ...SAME_ORIGIN, cookie },
      });

      expect((await me(otherCookie)).statusCode).toBe(200);
      expect(user.id).toBeTruthy();
    });

    it.each([
      ['no cookie', undefined],
      ['an unknown token', `${SESSION_COOKIE}=${'z'.repeat(43)}`],
      ['a malformed cookie', `${SESSION_COOKIE}=not-a-token`],
    ])('is idempotent with %s', async (_label, cookie) => {
      const response = await t.app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: { ...SAME_ORIGIN, ...(cookie ? { cookie } : {}) },
      });

      expect(response.statusCode).toBe(204);
      expect(setCookies(response)[0]).toContain('Max-Age=0');
    });

    it('cannot be triggered cross-site, so a stranger cannot sign someone out', async () => {
      const { cookie } = await t.login();

      const response = await t.app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: { 'sec-fetch-site': 'cross-site', cookie },
      });

      expect(response.statusCode).toBe(403);
      expect((await me(cookie)).statusCode).toBe(200);
    });
  });

  describe('how the session cookie is judged (via GET /api/me)', () => {
    it('answers 401 with a fixed body when there is no cookie', async () => {
      const response = await me();

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: 'unauthenticated', message: 'Sign in to continue' });
      expect(setCookies(response)).toEqual([]);
    });

    it.each([
      ['an unknown token', `${SESSION_COOKIE}=${'q'.repeat(43)}`],
      ['a malformed token', `${SESSION_COOKIE}=nope`],
      ['an empty value', `${SESSION_COOKIE}=`],
    ])('answers 401 for %s and tells the browser to drop the cookie', async (_label, cookie) => {
      const response = await me(cookie);

      expect(response.statusCode).toBe(401);
      expect(setCookies(response)[0]).toContain('Max-Age=0');
    });

    it('rejects a cookie sent twice (cookie tossing), even if one copy is valid', async () => {
      const { cookie } = await t.login();

      const response = await me(`${cookie}; ${SESSION_COOKIE}=${'x'.repeat(43)}`);

      expect(response.statusCode).toBe(401);
    });

    it('ignores a similarly named cookie', async () => {
      const { token } = await t.login();

      expect((await me(`session=${token}`)).statusCode).toBe(401);
      expect((await me(`Host-session=${token}`)).statusCode).toBe(401);
    });

    it('answers 401 once the session has expired, and clears the cookie', async () => {
      const { cookie } = await t.login();
      t.clock.advance(SESSION_TTL_MS + 1);

      const response = await me(cookie);

      expect(response.statusCode).toBe(401);
      expect(setCookies(response)[0]).toContain('Max-Age=0');
      t.clock.advance(-(SESSION_TTL_MS + 1));
    });

    it('does not touch the cookie while the session is fresh, and refreshes it after an hour of use', async () => {
      const { token, cookie } = await t.login();

      const fresh = await me(cookie);
      t.clock.advance(SESSION_RENEW_AFTER_MS + 1000);
      const stale = await me(cookie);

      expect(fresh.statusCode).toBe(200);
      expect(setCookies(fresh)).toEqual([]);
      expect(stale.statusCode).toBe(200);
      const refreshed = setCookies(stale)[0] ?? '';
      expect(refreshed).toContain(`${SESSION_COOKIE}=${token}`);
      expect(refreshed).toContain(`Max-Age=${SESSION_TTL_MS / 1000}`);
    });
  });

  describe('GET /api/me', () => {
    it('returns exactly the public user fields and nothing about the session', async () => {
      const { user, cookie } = await t.login({ name: 'Pat Lee', timeZone: 'America/New_York' });

      const response = await me(cookie);

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        user: {
          id: user.id,
          email: user.email,
          name: 'Pat Lee',
          pictureUrl: null,
          timeZone: 'America/New_York',
          isDemo: false,
        },
      });
      expect(response.body).not.toMatch(/token|hash|session/i);
    });

    it('is never cached', async () => {
      const { cookie } = await t.login();

      expect((await me(cookie)).headers['cache-control']).toBe('no-store');
    });

    it('answers HEAD like GET: 401 without a session, 200 with one', async () => {
      const { cookie } = await t.login();

      expect((await t.app.inject({ method: 'HEAD', url: '/api/me' })).statusCode).toBe(401);
      expect(
        (await t.app.inject({ method: 'HEAD', url: '/api/me', headers: { cookie } })).statusCode,
      ).toBe(200);
    });
  });

  describe('PATCH /api/me', () => {
    const patch = (
      cookie: string | undefined,
      payload: unknown,
      headers: Record<string, string> = SAME_ORIGIN,
    ) =>
      t.app.inject({
        method: 'PATCH',
        url: '/api/me',
        headers: { ...headers, ...(cookie ? { cookie } : {}) },
        payload: payload as object,
      });

    it('changes the time zone and persists it', async () => {
      const { cookie } = await t.login();

      const response = await patch(cookie, { timeZone: 'Asia/Kolkata' });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ user: { timeZone: 'Asia/Kolkata' } });
      expect((await me(cookie)).json()).toMatchObject({ user: { timeZone: 'Asia/Kolkata' } });
    });

    it("never changes another user's settings", async () => {
      const mine = await t.login({ timeZone: 'UTC' });
      const theirs = await t.login({ timeZone: 'Europe/London' });

      await patch(mine.cookie, { timeZone: 'Pacific/Auckland' });

      expect((await me(theirs.cookie)).json()).toMatchObject({
        user: { timeZone: 'Europe/London' },
      });
    });

    it.each([
      ['an offset', { timeZone: '+05:00' }, 'timeZone'],
      ['an unknown zone', { timeZone: 'Mars/Olympus' }, 'timeZone'],
      ['a missing zone', {}, 'timeZone'],
      ['a null zone', { timeZone: null }, 'timeZone'],
      ['an unexpected key', { timeZone: 'UTC', isDemo: true }, ''],
      ['a server-owned key', { email: 'x@y.z' }, ''],
    ])('answers 400 with the problems for %s', async (_label, payload, path) => {
      const { cookie } = await t.login({ timeZone: 'UTC' });

      const response = await patch(cookie, payload);

      expect(response.statusCode).toBe(400);
      const body = response.json<{ error: string; issues: { path: string; message: string }[] }>();
      expect(body.error).toBe('validation_error');
      expect(body.issues.length).toBeGreaterThan(0);
      expect(body.issues.some((issue) => issue.path === path)).toBe(true);
      expect((await me(cookie)).json()).toMatchObject({ user: { timeZone: 'UTC' } });
    });

    it('answers 400, not 500, for malformed JSON', async () => {
      const { cookie } = await t.login();

      const response = await t.app.inject({
        method: 'PATCH',
        url: '/api/me',
        headers: { ...SAME_ORIGIN, cookie, 'content-type': 'application/json' },
        payload: '{"timeZone":',
      });

      expect(response.statusCode).toBe(400);
    });

    it('checks the session before the body: bad input from a stranger is still a 401', async () => {
      expect((await patch(undefined, { timeZone: 'nonsense' })).statusCode).toBe(401);
    });

    it('refuses text/plain (what a cross-site form can send) and cross-site requests', async () => {
      const { cookie } = await t.login({ timeZone: 'UTC' });

      const plain = await t.app.inject({
        method: 'PATCH',
        url: '/api/me',
        headers: { ...SAME_ORIGIN, cookie, 'content-type': 'text/plain' },
        payload: '{"timeZone":"Asia/Kolkata"}',
      });
      const crossSite = await patch(
        cookie,
        { timeZone: 'Asia/Kolkata' },
        { 'sec-fetch-site': 'cross-site' },
      );

      expect(plain.statusCode).toBe(415);
      expect(crossSite.statusCode).toBe(403);
      expect((await me(cookie)).json()).toMatchObject({ user: { timeZone: 'UTC' } });
    });
  });
});
