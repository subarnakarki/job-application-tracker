import { ApplicationDetailSchema, LIMITS, type ApplicationDetail } from '@jat/shared';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, SAME_ORIGIN, T0, type TestApp } from '../test/app';
import { TEST_DATABASE_URL } from '../test/testDb';

const DAY = 24 * 60 * 60 * 1000;
const MISSING_ID = '00000000-0000-4000-8000-000000000000';

function detail(response: LightMyRequestResponse): ApplicationDetail {
  const parsed = ApplicationDetailSchema.safeParse(response.json());
  if (!parsed.success)
    throw new Error(`Response broke the contract: ${parsed.error.message}\n${response.body}`);
  return parsed.data;
}

describe.skipIf(!TEST_DATABASE_URL)('interviews API (real app, real database)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  const call = (
    cookie: string,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: object,
    headers: Record<string, string> = {},
  ) =>
    t.app.inject({
      method,
      url,
      headers: {
        cookie,
        ...SAME_ORIGIN,
        ...headers,
        ...(payload ? { 'content-type': 'application/json' } : {}),
      },
      ...(payload ? { payload: JSON.stringify(payload) } : {}),
    });

  const createApplication = async (cookie: string, status = 'Applied') =>
    detail(
      await call(cookie, 'POST', '/api/applications', { company: 'Acme', role: 'SDET', status }),
    );

  it('logs past and scheduled interviews, shows them oldest first, and edits and removes them', async () => {
    const { cookie } = await t.login();
    const application = await createApplication(cookie);

    const later = await call(cookie, 'POST', `/api/applications/${application.id}/interviews`, {
      heldOn: '2026-11-20',
      label: 'Onsite',
    });
    const earlier = await call(cookie, 'POST', `/api/applications/${application.id}/interviews`, {
      heldOn: '2026-11-02',
      label: 'Recruiter screen',
      notes: 'Asked about Playwright',
    });
    expect([later.statusCode, earlier.statusCode]).toEqual([201, 201]);

    const withInterviews = detail(await call(cookie, 'GET', `/api/applications/${application.id}`));
    expect(withInterviews.interviews.map((entry) => entry.label)).toEqual([
      'Recruiter screen',
      'Onsite',
    ]);
    expect(withInterviews).toMatchObject({ interviewCount: 2, nextInterviewOn: '2026-11-20' });
    const listed = (await call(cookie, 'GET', '/api/applications')).json<{
      items: { interviewCount: number; nextInterviewOn: string | null }[];
    }>();
    expect(listed.items[0]).toMatchObject({ interviewCount: 2, nextInterviewOn: '2026-11-20' });

    const onsiteId = later.json<{ id: string }>().id;
    const moved = await call(
      cookie,
      'PATCH',
      `/api/applications/${application.id}/interviews/${onsiteId}`,
      {
        heldOn: '2026-11-21',
        label: null,
      },
    );
    expect(moved.json()).toMatchObject({ heldOn: '2026-11-21', label: null, notes: '' });
    const removed = await call(
      cookie,
      'DELETE',
      `/api/applications/${application.id}/interviews/${onsiteId}`,
    );
    expect(removed.statusCode).toBe(204);
    const after = detail(await call(cookie, 'GET', `/api/applications/${application.id}`));
    expect(after).toMatchObject({ interviewCount: 1, nextInterviewOn: null });
  });

  it('counts as an edit: the version moves, so a stale edit form is refused', async () => {
    const { cookie } = await t.login();
    const application = await createApplication(cookie);
    await call(cookie, 'POST', `/api/applications/${application.id}/interviews`, {
      heldOn: '2026-11-03',
    });

    const stale = await call(
      cookie,
      'PATCH',
      `/api/applications/${application.id}`,
      { notes: 'edited in an old tab' },
      { 'if-match': `"${application.version}"` },
    );
    expect(stale.statusCode).toBe(412);
  });

  it('a scheduled interview holds off "needs follow-up" until its day has passed', async () => {
    const { cookie } = await t.login();
    const application = await createApplication(cookie);
    await call(cookie, 'POST', `/api/applications/${application.id}/interviews`, {
      heldOn: '2026-12-05',
    });
    const read = async () =>
      detail(await call(cookie, 'GET', `/api/applications/${application.id}`));
    try {
      t.clock.advance(10 * DAY); // quiet for 10 days, but the interview is still ahead
      expect((await read()).needsFollowUp).toBe(false);
      t.clock.advance(21 * DAY); // the interview is over and nothing happened since
      expect((await read()).needsFollowUp).toBe(true);
    } finally {
      t.clock.set(T0);
    }
  });

  it('stops at the per-application cap', async () => {
    const { cookie } = await t.login();
    const application = await createApplication(cookie);
    for (let index = 0; index < LIMITS.interviewsPerApplication; index++) {
      const added = await call(cookie, 'POST', `/api/applications/${application.id}/interviews`, {
        heldOn: '2026-11-01',
      });
      expect(added.statusCode).toBe(201);
    }
    const over = await call(cookie, 'POST', `/api/applications/${application.id}/interviews`, {
      heldOn: '2026-11-01',
    });
    expect(over.statusCode).toBe(409);
    const unchanged = detail(await call(cookie, 'GET', `/api/applications/${application.id}`));
    expect(unchanged.interviewCount).toBe(LIMITS.interviewsPerApplication);
  });

  describe('isolation: another user gets the same 404 as for an id that does not exist', () => {
    it.each([['POST'], ['PATCH'], ['DELETE']] as const)('%s', async (method) => {
      const owner = await t.login();
      const stranger = await t.login();
      const application = await createApplication(owner.cookie);
      const interview = (
        await call(owner.cookie, 'POST', `/api/applications/${application.id}/interviews`, {
          heldOn: '2026-11-04',
          label: 'Private round',
        })
      ).json<{ id: string }>();
      const url = (applicationId: string, interviewId: string) =>
        method === 'POST'
          ? `/api/applications/${applicationId}/interviews`
          : `/api/applications/${applicationId}/interviews/${interviewId}`;
      const payload = method === 'DELETE' ? undefined : { heldOn: '2026-11-04', label: 'hacked' };

      for (const target of [
        url(application.id, interview.id),
        url(MISSING_ID, MISSING_ID),
        url('not-a-uuid', 'not-a-uuid'),
      ]) {
        const response = await call(stranger.cookie, method, target, payload);
        expect(response.statusCode, target).toBe(404);
        expect(response.body).not.toContain('Private round');
      }
      if (method !== 'POST') {
        // The owner's interview addressed through the stranger's own application.
        const theirs = await createApplication(stranger.cookie);
        const crossed = await call(stranger.cookie, method, url(theirs.id, interview.id), payload);
        expect(crossed.statusCode).toBe(404);
      }
      const after = detail(await call(owner.cookie, 'GET', `/api/applications/${application.id}`));
      expect(after.interviews).toEqual([
        expect.objectContaining({ id: interview.id, label: 'Private round' }),
      ]);
    });
  });
});
