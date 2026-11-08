import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RegisteredRoute } from '../http/policy';
import { createTestApp, SAME_ORIGIN, setCookies, type TestApp } from '../test/app';
import { checkIsolationCoverage, fillUrl, hasPathParams, routeKey } from '../test/registry';
import { TEST_DATABASE_URL } from '../test/testDb';

/**
 * These tests walk EVERY route the app registers and assert security properties
 * mechanically, so a new endpoint is checked the moment it exists and cannot be
 * forgotten. Nothing here names a specific endpoint except the two allowlists.
 */

const SECRET = 'registry-test-secret-1234567890';
const ENV = { ENABLE_TEST_ROUTES: '1', NODE_ENV: 'test', TEST_ROUTES_SECRET: SECRET };
const WITH_SECRET = { ...SAME_ORIGIN, 'x-test-secret': SECRET };

/**
 * Routes that anyone may call without signing in. Adding to this list is a
 * deliberate decision: the test below fails on any public route not named here.
 */
const PUBLIC_ROUTES = [
  'GET /api/health',
  'GET /api/health/db',
  'GET /api/auth/google/start',
  'GET /api/auth/google/callback',
  'POST /api/auth/demo',
  'POST /api/auth/logout',
  // Scheduled job search: refused without the shared secret (see jobSearch.test.ts).
  'POST /api/cron/job-search',
].sort();
/** Public, but only registered when test routes are enabled, and always behind the secret. */
const PUBLIC_TEST_ROUTES = ['POST /api/test/login', 'POST /api/test/cleanup'].sort();

/**
 * Signed-in routes that address a record by id, mapped to the test file proving
 * another user gets 404. The check below fails for any id route not listed here.
 */
const ISOLATION_COVERAGE: Record<string, string> = {
  'GET /api/applications/:id': 'server/src/routes/applications.test.ts',
  'PATCH /api/applications/:id': 'server/src/routes/applications.test.ts',
  'DELETE /api/applications/:id': 'server/src/routes/applications.test.ts',
  'POST /api/applications/:id/suggestion/apply': 'server/src/routes/suggestions.test.ts',
  'DELETE /api/applications/:id/suggestion': 'server/src/routes/suggestions.test.ts',
  'POST /api/applications/:id/suggestion/find': 'server/src/routes/findPosting.test.ts',
  'POST /api/applications/:id/interviews': 'server/src/routes/interviews.test.ts',
  'PATCH /api/applications/:id/interviews/:interviewId': 'server/src/routes/interviews.test.ts',
  'DELETE /api/applications/:id/interviews/:interviewId': 'server/src/routes/interviews.test.ts',
  'GET /api/leads/:id': 'server/src/routes/leads.test.ts',
  'PATCH /api/leads/:id': 'server/src/routes/leads.test.ts',
  'DELETE /api/leads/:id': 'server/src/routes/leads.test.ts',
  'POST /api/leads/:id/notes': 'server/src/routes/leads.test.ts',
  'PATCH /api/leads/:id/notes/:noteId': 'server/src/routes/leads.test.ts',
  'DELETE /api/leads/:id/notes/:noteId': 'server/src/routes/leads.test.ts',
  'GET /api/import/runs/:id': 'server/src/routes/import.test.ts',
  'POST /api/import/items/:id/undo': 'server/src/routes/import.test.ts',
  'POST /api/import/items/:id/apply': 'server/src/routes/import.test.ts',
  'POST /api/import/items/:id/dismiss': 'server/src/routes/import.test.ts',
  'GET /api/resume/analyses/:id': 'server/src/routes/resume.test.ts',
  'POST /api/applications/:id/resume-match': 'server/src/routes/resume.test.ts',
  'GET /api/job-search/runs/:id': 'server/src/routes/jobSearch.test.ts',
  'POST /api/job-search/hits/:id/applied': 'server/src/routes/jobSearch.test.ts',
  'POST /api/job-search/hits/:id/blocked': 'server/src/routes/jobSearch.test.ts',
  'POST /api/job-search/hits/:id/skip': 'server/src/routes/jobSearch.test.ts',
  'POST /api/job-search/hits/:id/closed': 'server/src/routes/jobSearch.test.ts',
  'POST /api/job-search/hits/:id/tailor': 'server/src/routes/jobSearch.test.ts',
  'POST /api/job-search/hits/:id/queue': 'server/src/routes/jobSearch.test.ts',
  'POST /api/job-search/hits/:id/redraft': 'server/src/routes/jobSearch.test.ts',
  'PUT /api/job-search/hits/:id/draft': 'server/src/routes/jobSearch.test.ts',
  'DELETE /api/resume/analyses/:id': 'server/src/routes/resume.test.ts',
};

const callRoute = (
  t: TestApp,
  route: RegisteredRoute,
  headers: Record<string, string>,
  payload?: object | string,
) =>
  t.app.inject({
    method: route.method as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: fillUrl(route.url),
    headers,
    ...(payload !== undefined ? { payload } : route.mutating ? { payload: {} } : {}),
  });

describe('isolation coverage checker (the mechanism itself)', () => {
  const route = (
    method: string,
    url: string,
    auth: 'public' | 'user' = 'user',
  ): RegisteredRoute => ({
    method,
    url,
    auth,
    mutating: method !== 'GET',
    contract: { summary: 'fake', responses: { 200: null } },
  });

  it('flags a signed-in route with an id that no isolation test claims', () => {
    const routes = [
      route('GET', '/api/applications'),
      route('GET', '/api/applications/:id'),
      route('DELETE', '/api/applications/:id'),
    ];

    expect(
      checkIsolationCoverage(routes, { 'GET /api/applications/:id': 'applications.test.ts' }),
    ).toEqual({
      uncovered: ['DELETE /api/applications/:id'],
      stale: [],
    });
  });

  it('passes when every id route is claimed, and ignores routes without ids or without a session', () => {
    const routes = [
      route('GET', '/api/applications'),
      route('GET', '/api/applications/:id'),
      route('GET', '/api/public/:slug', 'public'),
    ];

    expect(checkIsolationCoverage(routes, { 'GET /api/applications/:id': 'x.test.ts' })).toEqual({
      uncovered: [],
      stale: [],
    });
  });

  it('flags a claim for a route that no longer exists', () => {
    expect(
      checkIsolationCoverage([route('GET', '/api/me')], { 'GET /api/gone/:id': 'x.test.ts' }),
    ).toEqual({
      uncovered: [],
      stale: ['GET /api/gone/:id'],
    });
  });

  it('treats several path parameters and nested ids as ids', () => {
    expect(hasPathParams({ url: '/api/applications/:id/history/:entryId' })).toBe(true);
    expect(hasPathParams({ url: '/api/applications' })).toBe(false);
    expect(fillUrl('/api/applications/:id/history/:entryId')).toBe(
      '/api/applications/00000000-0000-4000-8000-000000000000/history/00000000-0000-4000-8000-000000000000',
    );
  });
});

describe.skipIf(!TEST_DATABASE_URL)('route registry (every registered route, real app)', () => {
  let enabled: TestApp;
  let disabled: TestApp;

  beforeAll(async () => {
    enabled = await createTestApp({ env: ENV });
    disabled = await createTestApp({ env: {} });
  });
  afterAll(async () => {
    await enabled.close();
    await disabled.close();
  });

  const publicKeys = (t: TestApp) =>
    t.app.registeredRoutes
      .filter((route) => route.auth === 'public')
      .map(routeKey)
      .sort();

  describe('who may call without signing in', () => {
    it('is exactly the allowlist (a new public route must be added here on purpose)', () => {
      expect(publicKeys(disabled)).toEqual(PUBLIC_ROUTES);
      expect(publicKeys(enabled)).toEqual([...PUBLIC_ROUTES, ...PUBLIC_TEST_ROUTES].sort());
    });

    it('has no test route at all when test routes are disabled', () => {
      expect(
        disabled.app.registeredRoutes.filter((route) => route.url.startsWith('/api/test/')),
      ).toEqual([]);
    });

    it('puts every route under /api/', () => {
      for (const route of enabled.app.registeredRoutes)
        expect(route.url, routeKey(route)).toMatch(/^\/api\//);
    });
  });

  describe('every signed-in route refuses an anonymous caller', () => {
    it('answers 401 with a fixed body and sets no cookie, for each route and for HEAD', async () => {
      const routes = enabled.app.registeredRoutes.filter((route) => route.auth === 'user');
      expect(routes.length).toBeGreaterThan(0);

      for (const route of routes) {
        const response = await callRoute(enabled, route, WITH_SECRET);
        expect(response.statusCode, routeKey(route)).toBe(401);
        expect(response.json(), routeKey(route)).toEqual({
          error: 'unauthenticated',
          message: 'Sign in to continue',
        });
        expect(setCookies(response), routeKey(route)).toEqual([]);
      }
      for (const route of routes.filter((candidate) => candidate.method === 'GET')) {
        const head = await enabled.app.inject({
          method: 'HEAD',
          url: fillUrl(route.url),
          headers: WITH_SECRET,
        });
        expect(head.statusCode, `HEAD ${route.url}`).toBe(401);
      }
    });

    it.each([
      ['an unknown token', `__Host-session=${'k'.repeat(43)}`],
      ['a malformed token', '__Host-session=nope'],
      ['an empty token', '__Host-session='],
      ['the wrong cookie name', `session=${'k'.repeat(43)}`],
    ])('answers 401 with %s', async (_label, cookie) => {
      for (const route of enabled.app.registeredRoutes.filter(
        (candidate) => candidate.auth === 'user',
      )) {
        const response = await callRoute(enabled, route, { ...WITH_SECRET, cookie });
        expect(response.statusCode, routeKey(route)).toBe(401);
      }
    });

    it('answers 401 once the session has expired', async () => {
      const { cookie } = await enabled.login();
      enabled.clock.advance(31 * 24 * 60 * 60 * 1000);
      try {
        for (const route of enabled.app.registeredRoutes.filter(
          (candidate) => candidate.auth === 'user',
        )) {
          const response = await callRoute(enabled, route, { ...WITH_SECRET, cookie });
          expect(response.statusCode, routeKey(route)).toBe(401);
        }
      } finally {
        enabled.clock.advance(-31 * 24 * 60 * 60 * 1000);
      }
    });
  });

  describe('every state-changing route is protected from cross-site requests', () => {
    it('refuses a cross-site request with 403, even when the caller holds a valid session', async () => {
      const { cookie } = await enabled.login();
      const routes = enabled.app.registeredRoutes.filter((route) => route.mutating);
      expect(routes.length).toBeGreaterThan(0);

      for (const route of routes) {
        for (const site of ['cross-site', 'same-site', 'none']) {
          const response = await callRoute(enabled, route, {
            'sec-fetch-site': site,
            'x-test-secret': SECRET,
            cookie,
          });
          expect(response.statusCode, `${routeKey(route)} (${site})`).toBe(403);
          expect(response.json(), routeKey(route)).toMatchObject({ error: 'cross_site_request' });
        }
      }
    });

    it('refuses a mismatched Origin when the browser sends no Sec-Fetch-Site', async () => {
      const { cookie } = await enabled.login();
      for (const route of enabled.app.registeredRoutes.filter((candidate) => candidate.mutating)) {
        const response = await callRoute(enabled, route, {
          origin: 'https://evil.example',
          host: 'app.example.com',
          'x-test-secret': SECRET,
          cookie,
        });
        expect(response.statusCode, routeKey(route)).toBe(403);
      }
    });

    it('refuses a body that is not JSON with 415 (what a cross-site HTML form can send)', async () => {
      const { cookie } = await enabled.login();
      for (const route of enabled.app.registeredRoutes.filter((candidate) => candidate.mutating)) {
        for (const contentType of [
          'text/plain',
          'application/x-www-form-urlencoded',
          'multipart/form-data; boundary=x',
        ]) {
          const response = await callRoute(
            enabled,
            route,
            { ...WITH_SECRET, cookie, 'content-type': contentType },
            'a=1',
          );
          expect(response.statusCode, `${routeKey(route)} (${contentType})`).toBe(415);
        }
      }
    });

    it('never lets a write through without a same-origin signal when a browser header says otherwise', async () => {
      // A request that carries NO browser headers at all is a non-browser client (allowed by design);
      // the point here is that a sandboxed "null" origin, which browsers do send, is refused.
      for (const route of enabled.app.registeredRoutes.filter((candidate) => candidate.mutating)) {
        const response = await callRoute(enabled, route, {
          origin: 'null',
          host: 'app.example.com',
          'x-test-secret': SECRET,
        });
        expect(response.statusCode, routeKey(route)).toBe(403);
      }
    });
  });

  describe('every response is private', () => {
    it('is never cacheable, for any route, signed in or not, success or failure', async () => {
      for (const route of enabled.app.registeredRoutes) {
        // A fresh session per probe: some routes (sign-out) end the session they are called with.
        const anonymous = await callRoute(enabled, route, WITH_SECRET);
        const { cookie } = await enabled.login();
        const signedIn = await callRoute(enabled, route, { ...WITH_SECRET, cookie });

        for (const [who, response] of [
          ['anonymous', anonymous],
          ['signed in', signedIn],
        ] as const) {
          expect(
            response.headers['cache-control'],
            `${routeKey(route)} (${who}) -> ${response.statusCode}`,
          ).toBe('no-store');
        }
      }
    });

    it('actually reaches each signed-in route handler (the probe is not just collecting 401s)', async () => {
      const reached: string[] = [];
      for (const route of enabled.app.registeredRoutes.filter(
        (candidate) => candidate.auth === 'user',
      )) {
        const { cookie } = await enabled.login();
        const response = await callRoute(enabled, route, { ...WITH_SECRET, cookie });
        if (response.statusCode !== 401) reached.push(routeKey(route));
      }

      expect(reached.length).toBe(
        enabled.app.registeredRoutes.filter((route) => route.auth === 'user').length,
      );
    });
  });

  describe('every error body is safe', () => {
    it('never contains a stack trace, SQL, a file path or a connection detail', async () => {
      const pattern =
        /\bat \S+ \(|node_modules|\/home\/|select |insert |relation "|ECONN|password|postgres:\/\//i;
      for (const route of enabled.app.registeredRoutes) {
        for (const signedIn of [false, true]) {
          const { cookie } = await enabled.login();
          const headers = {
            ...WITH_SECRET,
            ...(signedIn ? { cookie } : {}),
            'content-type': 'application/json',
          };
          const response = await callRoute(
            enabled,
            route,
            headers,
            route.mutating ? '{"nonsense":' : undefined,
          );
          if (response.statusCode >= 400) {
            expect(
              response.body,
              `${routeKey(route)} (${signedIn ? 'signed in' : 'anonymous'}) -> ${response.statusCode}`,
            ).not.toMatch(pattern);
          }
        }
      }
    });
  });

  describe('isolation between users', () => {
    it('names a covering test for every signed-in route that addresses a record by id', () => {
      const problems = checkIsolationCoverage(enabled.app.registeredRoutes, ISOLATION_COVERAGE);

      expect(problems).toEqual({ uncovered: [], stale: [] });
    });
  });
});
