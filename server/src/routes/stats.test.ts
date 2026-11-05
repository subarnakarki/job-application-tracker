import { ApplicationDetailSchema, StatsSchema } from '@jat/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, SAME_ORIGIN, type TestApp } from '../test/app';
import { TEST_DATABASE_URL } from '../test/testDb';

describe.skipIf(!TEST_DATABASE_URL)('GET /api/stats (real app, real database)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.close();
  });

  const create = async (cookie: string, payload: Record<string, unknown>): Promise<string> => {
    const response = await t.app.inject({
      method: 'POST',
      url: '/api/applications',
      headers: { ...SAME_ORIGIN, cookie },
      payload: { role: 'SDET', ...payload },
    });
    return ApplicationDetailSchema.parse(response.json()).id;
  };

  it('answers 401 without a session', async () => {
    const response = await t.app.inject({ method: 'GET', url: '/api/stats' });

    expect(response.statusCode).toBe(401);
  });

  it('counts history, not just the current status, per source, for this user only', async () => {
    const me = await t.login();
    const other = await t.login();
    await create(me.cookie, { company: 'A', status: 'Applied', source: 'LinkedIn' });
    const rejected = await create(me.cookie, {
      company: 'B',
      status: 'Applied',
      source: 'LinkedIn',
    });
    await t.app.inject({
      method: 'PATCH',
      url: `/api/applications/${rejected}`,
      headers: { ...SAME_ORIGIN, cookie: me.cookie, 'if-match': '"1"' },
      payload: { status: 'Rejected' },
    });
    await create(me.cookie, { company: 'C', status: 'Interviewing', source: 'Referral' });
    await create(other.cookie, { company: 'X', status: 'Offer', source: 'Referral' });

    const response = await t.app.inject({
      method: 'GET',
      url: '/api/stats',
      headers: { cookie: me.cookie },
    });
    const body = StatsSchema.parse(response.json());

    expect(body.sources.find((row) => row.source === 'LinkedIn')).toMatchObject({
      total: 2,
      applied: 2,
      responded: 1, // Applied -> Rejected counts as a response
      responseRate: 0.5,
    });
    expect(body.sources.find((row) => row.source === 'Referral')).toMatchObject({
      total: 1,
      interviewing: 1,
      offers: 0,
    });
    expect(body.totals.total).toBe(3);
  });
});
