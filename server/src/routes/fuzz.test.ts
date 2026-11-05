import { ApplicationInputSchema } from '@jat/shared';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import type { RegisteredRoute } from '../http/policy';
import { createApplication } from '../repo/applications';
import { createTestApp, SAME_ORIGIN, type TestApp } from '../test/app';
import { hostile, idValue, jsonSchemaOf, validish } from '../test/fuzz/arbitraries';
import { routeKey } from '../test/registry';
import { TEST_DATABASE_URL } from '../test/testDb';

/**
 * Property-based fuzzing of EVERY registered route, driven by its declared
 * contract (the JavaScript counterpart of Schemathesis). For each route,
 * fast-check generates requests mixing plausible-valid bodies, hostile bodies,
 * malformed JSON, junk ids, junk If-Match values, signed-in and anonymous
 * callers, normal and demo users. Each request must:
 *
 * 1. never produce a 5xx (contract violations are turned into 500s, so a
 *    response that breaks its declared schema fails here too);
 * 2. only use a status the route declares or that the pipeline implies;
 * and, across the whole run, a bystander user's data must not change.
 *
 * FUZZ_RUNS raises the number of requests per route (default 40).
 */

const SECRET = 'fuzz-test-secret-1234567890';
const ENV = { ENABLE_TEST_ROUTES: '1', NODE_ENV: 'test', TEST_ROUTES_SECRET: SECRET };
const RUNS = Number(process.env['FUZZ_RUNS'] ?? 40);

/** The route list, read without starting anything (routes register synchronously). */
const ROUTES = buildApp({ env: ENV }).registeredRoutes;

function allowedStatuses(route: RegisteredRoute): Set<number> {
  const allowed = new Set<number>([400]);
  for (const status of Object.keys(route.contract.responses)) allowed.add(Number(status));
  for (const status of Object.keys(route.contract.errors ?? {})) allowed.add(Number(status));
  if (route.auth === 'user') allowed.add(401);
  if (route.mutating) {
    allowed.add(403);
    allowed.add(415);
  }
  return allowed;
}

const MALFORMED_JSON = ['{', '{"company":', '[1,2', 'not json', '{"a":1}}', '\u0000'];
const printable = fc.stringMatching(/^[ -~]{0,24}$/);

interface Plan {
  signedIn: boolean;
  isDemo: boolean;
  idChoice: 'real' | 'other';
  otherId: string;
  ifMatch: string | undefined;
  body: { kind: 'json'; value: unknown } | { kind: 'raw'; text: string } | { kind: 'none' };
}

function planFor(route: RegisteredRoute): fc.Arbitrary<Plan> {
  const bodySchema = route.contract.body ? jsonSchemaOf(route.contract.body) : {};
  const body: fc.Arbitrary<Plan['body']> = route.mutating
    ? fc.oneof(
        {
          weight: 4,
          arbitrary: validish(bodySchema).map((value) => ({ kind: 'json' as const, value })),
        },
        {
          weight: 4,
          arbitrary: hostile(bodySchema).map((value) => ({ kind: 'json' as const, value })),
        },
        {
          weight: 1,
          arbitrary: fc
            .constantFrom(...MALFORMED_JSON)
            .map((text) => ({ kind: 'raw' as const, text })),
        },
        { weight: 1, arbitrary: fc.constant({ kind: 'none' as const }) },
      )
    : fc.constant({ kind: 'none' as const });
  return fc.record({
    signedIn: fc.oneof(
      { weight: 5, arbitrary: fc.constant(true) },
      { weight: 1, arbitrary: fc.constant(false) },
    ),
    isDemo: fc.boolean(),
    idChoice: fc.constantFrom('real' as const, 'other' as const),
    otherId: idValue('00000000-0000-4000-8000-000000000000'),
    ifMatch: fc.option(fc.oneof(fc.constantFrom('"1"', '"2"', '"999"'), printable), {
      nil: undefined,
    }),
    body,
  });
}

describe.skipIf(!TEST_DATABASE_URL)(
  'API fuzzing: every route, from its contract (real app)',
  () => {
    let t: TestApp;
    let bystander: { userId: string; cookie: string };
    let bystanderBefore: string;

    /** Everything about the bystander, as one comparable string. */
    const snapshotOf = async (userId: string) => {
      const result = await t.db.query(
        `select row_to_json(u)::text as user_row,
              (select json_agg(a order by a.id)::text from applications a where a.user_id = u.id) as applications,
              (select json_agg(h order by h.seq)::text from status_history h
                 join applications a on a.id = h.application_id where a.user_id = u.id) as history,
              (select count(*)::int from sessions s where s.user_id = u.id) as sessions
         from users u where u.id = $1`,
        [userId],
      );
      return JSON.stringify(result.rows[0] ?? null);
    };

    beforeAll(async () => {
      t = await createTestApp({ env: ENV });
      const login = await t.login({ name: 'Bystander' });
      bystander = { userId: login.user.id, cookie: login.cookie };
      await createApplication(
        t.db,
        { userId: login.user.id, isDemo: false, timeZone: 'UTC' },
        ApplicationInputSchema.parse({
          company: 'Bystander Co',
          role: 'SDET',
          status: 'Interviewing',
          notes: 'private',
        }),
        t.clock.now(),
      );
      bystanderBefore = await snapshotOf(bystander.userId);
    });
    afterAll(async () => {
      await t.close();
    });

    it('has routes to fuzz', () => {
      expect(ROUTES.length).toBeGreaterThan(10);
    });

    for (const route of ROUTES) {
      it(`${routeKey(route)}: never 5xx, never an undocumented status`, async () => {
        const allowed = allowedStatuses(route);

        await fc.assert(
          fc.asyncProperty(planFor(route), async (plan) => {
            const owner = await t.login({ isDemo: plan.isDemo });
            const owned = await createApplication(
              t.db,
              { userId: owner.user.id, isDemo: plan.isDemo, timeZone: 'UTC' },
              ApplicationInputSchema.parse({ company: 'Fuzz Co', role: 'SDET' }),
              t.clock.now(),
            );
            const realId =
              owned.kind === 'created'
                ? owned.value.record.id
                : '00000000-0000-4000-8000-000000000000';
            const id = plan.idChoice === 'real' ? realId : plan.otherId;
            const url = route.url.replace(/:[A-Za-z_]\w*/g, encodeURIComponent(id));

            const headers: Record<string, string> = { ...SAME_ORIGIN, 'x-test-secret': SECRET };
            if (plan.signedIn) headers['cookie'] = owner.cookie;
            if (plan.ifMatch !== undefined) headers['if-match'] = plan.ifMatch;
            let payload: string | undefined;
            if (plan.body.kind === 'json') {
              headers['content-type'] = 'application/json';
              payload = JSON.stringify(plan.body.value) ?? 'null';
            } else if (plan.body.kind === 'raw') {
              headers['content-type'] = 'application/json';
              payload = plan.body.text;
            }

            const response = await t.app.inject({
              method: route.method as 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT',
              url,
              headers,
              ...(payload !== undefined ? { payload } : {}),
            });

            const where = `${route.method} ${url} -> ${response.statusCode}: ${response.body.slice(0, 300)}`;
            expect(response.statusCode, where).toBeLessThan(500);
            expect(allowed.has(response.statusCode), `undocumented status. ${where}`).toBe(true);
          }),
          { numRuns: RUNS },
        );
      }, 120_000);
    }

    it("never changed the bystander's data, whatever was thrown at the API", async () => {
      expect(await snapshotOf(bystander.userId)).toBe(bystanderBefore);
      const stillSignedIn = await t.app.inject({
        method: 'GET',
        url: '/api/me',
        headers: { cookie: bystander.cookie },
      });
      expect(stillSignedIn.statusCode).toBe(200);
    });

    it('caused no contract violation anywhere', () => {
      expect(t.app.contractViolations).toEqual([]);
    });
  },
);
