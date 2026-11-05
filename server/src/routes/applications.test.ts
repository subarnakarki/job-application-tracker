import { ApplicationDetailSchema, LIMITS, type ApplicationDetail } from '@jat/shared';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, SAME_ORIGIN, T0, type TestApp } from '../test/app';
import { TEST_DATABASE_URL } from '../test/testDb';
import { DEMO_WRITE_RULE, parseIfMatch } from './applications';

const DAY = 24 * 60 * 60 * 1000;
const MISSING_ID = '00000000-0000-4000-8000-000000000000';

/** Every successful response is checked against the strict shared contract. */
function detail(response: LightMyRequestResponse): ApplicationDetail {
  const parsed = ApplicationDetailSchema.safeParse(response.json());
  if (!parsed.success)
    throw new Error(`Response broke the contract: ${parsed.error.message}\n${response.body}`);
  return parsed.data;
}

describe('parseIfMatch', () => {
  it.each([
    [undefined, null],
    ['"1"', 1],
    ['"42"', 42],
    [' "7" ', 7],
    [['"3"'], 3],
    ['1', 'invalid'],
    ['"0"', 'invalid'],
    ['"-1"', 'invalid'],
    ['"01"', 'invalid'],
    ['W/"1"', 'invalid'],
    ['*', 'invalid'],
    ['"1", "2"', 'invalid'],
    ['"abc"', 'invalid'],
    ['"9999999999"', 'invalid'],
  ])('%j -> %j', (header, expected) => {
    expect(parseIfMatch(header)).toBe(expected);
  });
});

describe.skipIf(!TEST_DATABASE_URL)('applications API (real app, real database)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.close();
  });

  const send = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    cookie: string,
    options: { payload?: object; headers?: Record<string, string> } = {},
  ) =>
    t.app.inject({
      method,
      url,
      headers: { ...SAME_ORIGIN, cookie, ...options.headers },
      ...(options.payload !== undefined ? { payload: options.payload } : {}),
    });

  const create = (cookie: string, payload: object = { company: 'Acme', role: 'SDET' }) =>
    send('POST', '/api/applications', cookie, { payload });
  const read = (cookie: string, id: string) => send('GET', `/api/applications/${id}`, cookie);
  const patch = (cookie: string, id: string, version: number | string | null, payload: object) =>
    send('PATCH', `/api/applications/${id}`, cookie, {
      payload,
      headers:
        version === null
          ? {}
          : { 'if-match': typeof version === 'number' ? `"${version}"` : version },
    });
  const remove = (cookie: string, id: string) => send('DELETE', `/api/applications/${id}`, cookie);

  describe('POST /api/applications', () => {
    it('creates an application: 201, Location, ETag, the full detail with its first history entry', async () => {
      const { cookie } = await t.login();

      const response = await create(cookie, {
        company: 'Acme',
        role: 'SDET',
        status: 'Applied',
        source: 'Referral',
      });

      expect(response.statusCode).toBe(201);
      const body = detail(response);
      expect(response.headers['location']).toBe(`/api/applications/${body.id}`);
      expect(response.headers['etag']).toBe('"1"');
      expect(body).toMatchObject({
        company: 'Acme',
        role: 'SDET',
        status: 'Applied',
        source: 'Referral',
        dateApplied: '2026-11-05',
        version: 1,
        needsFollowUp: false,
        isClosed: false,
        createdAt: T0.toISOString(),
      });
      expect(body.history).toMatchObject([
        { fromStatus: null, toStatus: 'Applied', actor: 'user' },
      ]);
    });

    it('fills the defaults for a minimal application', async () => {
      const { cookie } = await t.login();

      const body = detail(await create(cookie));

      expect(body).toMatchObject({
        status: 'Saved',
        source: 'Other',
        notes: '',
        dateApplied: null,
        jobLink: null,
      });
    });

    it.each([
      ['no company', { role: 'SDET' }, 'company'],
      ['a blank role', { company: 'Acme', role: '  ' }, 'role'],
      [
        'a javascript: link',
        { company: 'Acme', role: 'SDET', jobLink: 'javascript:alert(1)' },
        'jobLink',
      ],
      [
        'a salary without a currency',
        { company: 'Acme', role: 'SDET', salaryMin: 1 },
        'salaryCurrency',
      ],
      [
        'an impossible date',
        { company: 'Acme', role: 'SDET', nextStepDate: '2026-02-30' },
        'nextStepDate',
      ],
      ['an attempt to set the owner', { company: 'Acme', role: 'SDET', userId: MISSING_ID }, ''],
      ['an attempt to set the version', { company: 'Acme', role: 'SDET', version: 9 }, ''],
    ])(
      'rejects %s with 400 naming the field, and creates nothing',
      async (_label, payload, path) => {
        const { user, cookie } = await t.login();

        const response = await create(cookie, payload);

        expect(response.statusCode).toBe(400);
        const body = response.json<{ error: string; issues: { path: string }[] }>();
        expect(body.error).toBe('validation_error');
        expect(body.issues.map((issue) => issue.path)).toContain(path);
        const count = await t.db.query('select 1 from applications where user_id = $1', [user.id]);
        expect(count.rowCount).toBe(0);
      },
    );

    it('answers 409 once the quota is reached', async () => {
      const { user, cookie } = await t.login({ isDemo: true });
      await t.db.query(
        `insert into applications (user_id, company, role)
         select $1, 'Filler ' || n, 'Role' from generate_series(1, $2) as n`,
        [user.id, LIMITS.applicationsPerDemoUser],
      );

      const response = await create(cookie);

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: 'limit_reached' });
    });
  });

  describe('GET /api/applications/:id', () => {
    it('returns the detail with an ETag of the current version', async () => {
      const { cookie } = await t.login();
      const created = detail(await create(cookie));

      const response = await read(cookie, created.id);

      expect(response.statusCode).toBe(200);
      expect(response.headers['etag']).toBe('"1"');
      expect(detail(response)).toEqual(created);
    });

    it('accepts the id in upper case', async () => {
      const { cookie } = await t.login();
      const created = detail(await create(cookie));

      expect((await read(cookie, created.id.toUpperCase())).statusCode).toBe(200);
    });
  });

  describe('PATCH /api/applications/:id', () => {
    it('applies an edit with the current version: 200, the new ETag, the follow-up clock reset', async () => {
      const { cookie } = await t.login();
      const created = detail(await create(cookie));
      t.clock.advance(DAY);

      const response = await patch(cookie, created.id, 1, { notes: 'Phone screen booked' });

      expect(response.statusCode).toBe(200);
      expect(response.headers['etag']).toBe('"2"');
      const body = detail(response);
      expect(body).toMatchObject({ notes: 'Phone screen booked', version: 2 });
      expect(body.lastActivityAt).toBe(new Date(T0.getTime() + DAY).toISOString());
      t.clock.advance(-DAY);
    });

    it('treats an identical save as a no-op: 200, the same ETag, nothing touched', async () => {
      const { cookie } = await t.login();
      const created = detail(await create(cookie, { company: 'Acme', role: 'SDET', notes: 'n' }));
      t.clock.advance(DAY);

      const response = await patch(cookie, created.id, 1, { company: 'Acme', notes: 'n' });

      expect(response.statusCode).toBe(200);
      expect(response.headers['etag']).toBe('"1"');
      expect(detail(response)).toEqual(created);
      t.clock.advance(-DAY);
    });

    it('records each status change in the history, in order', async () => {
      const { cookie } = await t.login();
      const created = detail(await create(cookie));

      await patch(cookie, created.id, 1, { status: 'Applied' });
      await patch(cookie, created.id, 2, { status: 'Interviewing' });
      const final = detail(await patch(cookie, created.id, 3, { status: 'Offer' }));

      expect(final.history.map((entry) => `${entry.fromStatus}->${entry.toStatus}`)).toEqual([
        'null->Saved',
        'Saved->Applied',
        'Applied->Interviewing',
        'Interviewing->Offer',
      ]);
      expect(final.dateApplied).toBe('2026-11-05');
    });

    it('answers 428 without If-Match, and 400 for a malformed one, changing nothing', async () => {
      const { cookie } = await t.login();
      const created = detail(await create(cookie));

      const missing = await patch(cookie, created.id, null, { notes: 'x' });
      const malformed = await patch(cookie, created.id, '1', { notes: 'x' });

      expect(missing.statusCode).toBe(428);
      expect(missing.json()).toMatchObject({ error: 'precondition_required' });
      expect(malformed.statusCode).toBe(400);
      expect(malformed.json()).toMatchObject({ error: 'invalid_if_match' });
      expect(detail(await read(cookie, created.id)).version).toBe(1);
    });

    it('answers 412 with the current ETag when someone else saved first, and keeps their change', async () => {
      const { cookie } = await t.login();
      const created = detail(await create(cookie));
      await patch(cookie, created.id, 1, { notes: 'saved in the other tab' });

      const stale = await patch(cookie, created.id, 1, { notes: 'saved here' });

      expect(stale.statusCode).toBe(412);
      expect(stale.json()).toMatchObject({ error: 'version_conflict' });
      expect(stale.headers['etag']).toBe('"2"');
      expect(detail(await read(cookie, created.id)).notes).toBe('saved in the other tab');
    });

    it('checks salary rules against the stored values', async () => {
      const { cookie } = await t.login();
      const created = detail(
        await create(cookie, {
          company: 'Acme',
          role: 'SDET',
          salaryMin: 100,
          salaryCurrency: 'USD',
        }),
      );

      const below = await patch(cookie, created.id, 1, { salaryMax: 50 });
      const fine = await patch(cookie, created.id, 1, { salaryMax: 150 });

      expect(below.statusCode).toBe(400);
      expect(
        below.json<{ issues: { path: string }[] }>().issues.map((issue) => issue.path),
      ).toEqual(['salaryMax']);
      expect(fine.statusCode).toBe(200);
    });

    it.each([
      ['an unknown status', { status: 'Hired' }],
      ['clearing the company', { company: null }],
      ['an unknown key', { userId: MISSING_ID }],
    ])('rejects %s with 400', async (_label, payload) => {
      const { cookie } = await t.login();
      const created = detail(await create(cookie));

      expect((await patch(cookie, created.id, 1, payload)).statusCode).toBe(400);
    });
  });

  describe('DELETE /api/applications/:id', () => {
    it('deletes with 204, after which the application is gone', async () => {
      const { cookie } = await t.login();
      const created = detail(await create(cookie));

      const response = await remove(cookie, created.id);

      expect(response.statusCode).toBe(204);
      expect((await read(cookie, created.id)).statusCode).toBe(404);
      expect((await remove(cookie, created.id)).statusCode).toBe(404);
    });
  });

  describe('isolation: another user gets the same 404 as for an id that does not exist', () => {
    it.each([
      ['GET', 'read'],
      ['PATCH', 'edit'],
      ['DELETE', 'delete'],
    ] as const)('%s (%s)', async (method, action) => {
      const owner = await t.login();
      const stranger = await t.login();
      const created = detail(
        await create(owner.cookie, { company: 'Private Co', role: 'SDET', notes: 'secret notes' }),
      );
      const attempt = (id: string) =>
        method === 'GET'
          ? read(stranger.cookie, id)
          : method === 'PATCH'
            ? patch(stranger.cookie, id, 1, { notes: 'hacked' })
            : remove(stranger.cookie, id);

      const foreign = await attempt(created.id);
      const missing = await attempt(MISSING_ID);
      const garbage = await attempt('not-a-uuid');

      for (const response of [foreign, missing, garbage]) {
        expect(response.statusCode, `a stranger trying to ${action}`).toBe(404);
        expect(response.json()).toEqual({ error: 'not_found', message: 'Application not found' });
        expect(response.headers['etag']).toBeUndefined();
      }
      expect(foreign.body).not.toContain('Private Co');
      expect(detail(await read(owner.cookie, created.id))).toEqual(created);
    });
  });

  describe('needs follow-up, computed end to end', () => {
    it('turns on after 7 quiet days, goes off with a real edit, and a no-op save does not reset it', async () => {
      const { cookie } = await t.login();
      const created = detail(
        await create(cookie, { company: 'Acme', role: 'SDET', status: 'Applied' }),
      );
      t.clock.advance(7 * DAY);
      try {
        const stale = detail(await read(cookie, created.id));
        const noOp = detail(await patch(cookie, created.id, 1, { status: 'Applied' }));
        const edited = detail(
          await patch(cookie, created.id, 1, { notes: 'Followed up by email' }),
        );

        expect(stale.needsFollowUp).toBe(true);
        expect(noOp.needsFollowUp).toBe(true);
        expect(edited.needsFollowUp).toBe(false);
      } finally {
        t.clock.advance(-7 * DAY);
      }
    });

    it('is off while a next step is booked for today or later', async () => {
      const { cookie } = await t.login();
      const created = detail(
        await create(cookie, {
          company: 'Acme',
          role: 'SDET',
          status: 'Interviewing',
          nextStepDate: '2026-11-12',
        }),
      );
      t.clock.advance(7 * DAY);
      try {
        expect(detail(await read(cookie, created.id)).needsFollowUp).toBe(false);
      } finally {
        t.clock.advance(-7 * DAY);
      }
    });

    it("uses the owner's time zone: calendar days are counted where the user lives", async () => {
      // Created at 12:00 UTC on 5 Nov: that is the 5th in Honolulu (UTC-10) but already the 6th in
      // Auckland (UTC+13). So Honolulu reaches its 7th calendar day first (12 Nov 00:00 local =
      // 6 days 22 h later), an hour before Auckland does (13 Nov 00:00 local = 6 days 23 h later).
      const auckland = await t.login({ timeZone: 'Pacific/Auckland' });
      const honolulu = await t.login({ timeZone: 'Pacific/Honolulu' });
      const forAuckland = detail(
        await create(auckland.cookie, { company: 'A', role: 'R', status: 'Applied' }),
      );
      const forHonolulu = detail(
        await create(honolulu.cookie, { company: 'H', role: 'R', status: 'Applied' }),
      );
      const between = 6 * DAY + 22.5 * 60 * 60 * 1000;
      t.clock.advance(between);
      try {
        expect(detail(await read(honolulu.cookie, forHonolulu.id)).needsFollowUp).toBe(true);
        expect(detail(await read(auckland.cookie, forAuckland.id)).needsFollowUp).toBe(false);
        t.clock.advance(60 * 60 * 1000);
        expect(detail(await read(auckland.cookie, forAuckland.id)).needsFollowUp).toBe(true);
      } finally {
        t.clock.advance(-(between + 60 * 60 * 1000));
      }
    });
  });

  describe('write rate limit', () => {
    it(`gives the demo account ${DEMO_WRITE_RULE.limit} changes an hour, then 429 with Retry-After`, async () => {
      const { cookie } = await t.login({ isDemo: true });
      const created = detail(await create(cookie));

      for (let attempt = 1; attempt < DEMO_WRITE_RULE.limit; attempt += 1) {
        expect((await patch(cookie, created.id, 1, { company: 'Acme' })).statusCode).toBe(200);
      }
      const blocked = await patch(cookie, created.id, 1, { company: 'Acme' });

      expect(blocked.statusCode).toBe(429);
      expect(blocked.json()).toMatchObject({ error: 'rate_limited' });
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
      expect((await read(cookie, created.id)).statusCode).toBe(200); // reads are not limited
    });
  });
});
