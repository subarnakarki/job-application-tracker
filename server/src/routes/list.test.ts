import { ApplicationListSchema, type ApplicationList } from '@jat/shared';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, SAME_ORIGIN, type TestApp } from '../test/app';
import { TEST_DATABASE_URL } from '../test/testDb';

const DAY = 24 * 60 * 60 * 1000;

function list(response: LightMyRequestResponse): ApplicationList {
  expect(response.statusCode, response.body).toBe(200);
  return ApplicationListSchema.parse(response.json());
}

describe.skipIf(!TEST_DATABASE_URL)('GET /api/applications (real app, real database)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.close();
  });

  const create = async (cookie: string, payload: Record<string, unknown>) => {
    const response = await t.app.inject({
      method: 'POST',
      url: '/api/applications',
      headers: { ...SAME_ORIGIN, cookie },
      payload: { role: 'SDET', ...payload },
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json<{ id: string }>().id;
  };
  const get = (cookie: string, query = '') =>
    t.app.inject({ method: 'GET', url: `/api/applications${query}`, headers: { cookie } });
  const companies = (result: ApplicationList) => result.items.map((item) => item.company);

  it('returns an empty list for a new user', async () => {
    const { cookie } = await t.login();

    expect(list(await get(cookie))).toEqual({ items: [], total: 0 });
  });

  it("returns only the caller's applications, never anyone else's", async () => {
    const me = await t.login();
    const other = await t.login();
    await create(me.cookie, { company: 'Mine' });
    await create(other.cookie, { company: 'Theirs', notes: 'Mine' });

    const result = list(await get(me.cookie));

    expect(companies(result)).toEqual(['Mine']);
    expect(list(await get(me.cookie, '?q=theirs')).total).toBe(0);
  });

  describe('status filter', () => {
    it('returns only that stage', async () => {
      const { cookie } = await t.login();
      await create(cookie, { company: 'A', status: 'Applied' });
      await create(cookie, { company: 'B', status: 'Interviewing' });
      await create(cookie, { company: 'C', status: 'Applied' });

      expect(companies(list(await get(cookie, '?status=Applied&sort=company_asc')))).toEqual([
        'A',
        'C',
      ]);
      expect(list(await get(cookie, '?status=Offer')).total).toBe(0);
    });

    it.each([
      ['an unknown status', '?status=Hired'],
      ['a lower-case status', '?status=applied'],
      ['the status twice', '?status=Applied&status=Offer'],
      ['an unknown parameter', '?page=2'],
      ['an unknown sort', '?sort=random'],
      ['a non-boolean follow-up flag', '?followUp=yes'],
    ])('rejects %s with 400', async (_label, query) => {
      const { cookie } = await t.login();

      const response = await get(cookie, query);

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: 'validation_error' });
    });
  });

  describe('follow-up filter', () => {
    it('returns exactly the applications whose computed flag is on, and the rest for false', async () => {
      const { cookie } = await t.login({ timeZone: 'America/Los_Angeles' });
      await create(cookie, { company: 'Stale applied', status: 'Applied' });
      await create(cookie, { company: 'Stale screening', status: 'Screening' });
      await create(cookie, {
        company: 'Stale but booked',
        status: 'Interviewing',
        nextStepDate: '2026-11-20',
      });
      await create(cookie, { company: 'Stale offer', status: 'Offer' });
      await create(cookie, { company: 'Saved', status: 'Saved' });
      t.clock.advance(8 * DAY);
      try {
        await create(cookie, { company: 'Fresh applied', status: 'Applied' });

        const everything = list(await get(cookie, '?sort=company_asc'));
        const flagged = list(await get(cookie, '?followUp=true&sort=company_asc'));
        const unflagged = list(await get(cookie, '?followUp=false&sort=company_asc'));

        // The SQL filter and the TypeScript flag on each item must agree, item for item.
        expect(companies(flagged)).toEqual(
          companies(everything).filter((_, index) => everything.items[index]?.needsFollowUp),
        );
        expect(companies(unflagged)).toEqual(
          companies(everything).filter((_, index) => !everything.items[index]?.needsFollowUp),
        );
        expect(companies(flagged)).toEqual(['Stale applied', 'Stale screening']);
        expect(flagged.total + unflagged.total).toBe(everything.total);
      } finally {
        t.clock.advance(-8 * DAY);
      }
    });

    it('combines with the status filter', async () => {
      const { cookie } = await t.login();
      await create(cookie, { company: 'Applied', status: 'Applied' });
      await create(cookie, { company: 'Screening', status: 'Screening' });
      t.clock.advance(8 * DAY);
      try {
        expect(companies(list(await get(cookie, '?followUp=true&status=Screening')))).toEqual([
          'Screening',
        ]);
      } finally {
        t.clock.advance(-8 * DAY);
      }
    });
  });

  describe('search', () => {
    let cookie: string;

    beforeAll(async () => {
      ({ cookie } = await t.login());
      await create(cookie, {
        company: 'Acme Robotics',
        role: 'Senior SDET',
        contact: 'Pat Lee',
        notes: 'Met at the meetup',
      });
      await create(cookie, {
        company: 'Globex',
        role: 'QA Lead',
        contact: null,
        notes: 'Salary 500k?',
      });
      await create(cookie, {
        company: 'Initech',
        role: 'SDET',
        contact: 'Sam',
        notes: 'Discount: 50% off',
      });
      await create(cookie, { company: 'Umbrella', role: 'a_b tester', notes: 'path C:\\jobs' });
      await create(cookie, { company: 'Zürich Café', role: 'Engineer', notes: '' });
    });

    const search = async (q: string) =>
      companies(list(await get(cookie, `?sort=company_asc&q=${encodeURIComponent(q)}`)));

    it.each([
      ['the company', 'globex', ['Globex']],
      ['the role', 'lead', ['Globex']],
      ['the contact', 'lee', ['Acme Robotics']],
      ['the notes', 'meetup', ['Acme Robotics']],
      ['any case', 'ACME', ['Acme Robotics']],
      ['part of a word', 'robo', ['Acme Robotics']],
      ['every word, across fields', 'sdet pat', ['Acme Robotics']],
      ['several matches', 'sdet', ['Acme Robotics', 'Initech']],
      ['non-ASCII text', 'zürich café', ['Zürich Café']],
      ['nothing', 'nonexistent', []],
    ])('matches %s', async (_label, q, expected) => {
      expect(await search(q)).toEqual(expected);
    });

    it('needs every word to match: one word that matches nothing empties the result', async () => {
      expect(await search('sdet nonexistent')).toEqual([]);
    });

    it.each([
      ['a percent sign', '50%', ['Initech']],
      ['an underscore', 'a_b', ['Umbrella']],
      ['a backslash', 'c:\\jobs', ['Umbrella']],
    ])('takes %s literally, not as a wildcard', async (_label, q, expected) => {
      expect(await search(q)).toEqual(expected);
    });

    it('does not let % or _ match anything (they are not wildcards)', async () => {
      expect(await search('%')).toEqual(['Initech']);
      expect(await search('_')).toEqual(['Umbrella']);
      expect(await search('5_0')).toEqual([]);
    });

    it('treats a blank search as no search', async () => {
      expect((await search('   ')).length).toBe(5);
    });

    it('combines with the status filter', async () => {
      await create(cookie, { company: 'Acme Two', role: 'SDET', status: 'Offer' });

      expect(companies(list(await get(cookie, '?q=acme&status=Offer')))).toEqual(['Acme Two']);
    });
  });

  describe('sort', () => {
    it('defaults to most recently updated first', async () => {
      const { cookie } = await t.login();
      const first = await create(cookie, { company: 'First' });
      t.clock.advance(1000);
      await create(cookie, { company: 'Second' });
      t.clock.advance(1000);
      await t.app.inject({
        method: 'PATCH',
        url: `/api/applications/${first}`,
        headers: { ...SAME_ORIGIN, cookie, 'if-match': '"1"' },
        payload: { notes: 'touched' },
      });
      t.clock.advance(-2000);

      expect(companies(list(await get(cookie)))).toEqual(['First', 'Second']);
    });

    it('sorts by date applied, newest first, with undated ones last', async () => {
      const { cookie } = await t.login();
      await create(cookie, { company: 'Undated' });
      await create(cookie, { company: 'October', dateApplied: '2026-10-01' });
      await create(cookie, { company: 'November', dateApplied: '2026-11-01' });

      expect(companies(list(await get(cookie, '?sort=applied_desc')))).toEqual([
        'November',
        'October',
        'Undated',
      ]);
    });

    it('sorts by company, ignoring case', async () => {
      const { cookie } = await t.login();
      for (const company of ['beta', 'Alpha', 'gamma', 'Delta']) await create(cookie, { company });

      expect(companies(list(await get(cookie, '?sort=company_asc')))).toEqual([
        'Alpha',
        'beta',
        'Delta',
        'gamma',
      ]);
    });

    it('returns ties in the same order every time (the clock is frozen, so all timestamps are equal)', async () => {
      const { cookie } = await t.login();
      for (let index = 0; index < 6; index += 1) await create(cookie, { company: 'Same' });

      const first = list(await get(cookie)).items.map((item) => item.id);
      const second = list(await get(cookie)).items.map((item) => item.id);

      expect(second).toEqual(first);
      expect([...first].sort()).toEqual(first); // ties are broken by id
    });
  });

  it('reports total as the number of items', async () => {
    const { cookie } = await t.login();
    for (let index = 0; index < 3; index += 1) await create(cookie, { company: `C${index}` });

    const result = list(await get(cookie));

    expect(result.total).toBe(result.items.length);
    expect(result.total).toBe(3);
  });
});
