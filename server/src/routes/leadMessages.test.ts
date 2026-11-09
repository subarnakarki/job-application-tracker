import {
  ApplicationDetailSchema,
  LeadDetailSchema,
  LeadMessageDraftSchema,
  type LeadMessageAnswer,
} from '@jat/shared';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { JobSearchClaude, LeadMessageModelRequest } from '../jobsearch/claude';
import { createTestApp, SAME_ORIGIN, T0, type TestApp } from '../test/app';
import { TEST_DATABASE_URL } from '../test/testDb';
import { LEAD_MESSAGE_RULE } from './leadMessages';

/** The model, stubbed: answers in order (the last one repeats), and what it was asked. */
const model = {
  answers: [] as (LeadMessageAnswer | null)[],
  requests: [] as LeadMessageModelRequest[],
};
const claude: JobSearchClaude = {
  search: () => Promise.resolve({ links: [], searches: 0 }),
  draft: () => Promise.resolve(null),
  tailor: () => Promise.resolve(null),
  leadMessage: (request) => {
    model.requests.push(request);
    const answer = model.answers[model.requests.length - 1] ?? model.answers.at(-1) ?? null;
    return Promise.resolve(answer);
  },
};
const SHORT: LeadMessageAnswer = {
  connectionNote: "Hi Sam, I'm applying for the SDET role at Acme and would value connecting.",
  message: "Hi Sam,\n\nI'm applying for the SDET role at Acme. Would you be open to a short chat?",
};

function parsed<T>(schema: { parse(value: unknown): T }) {
  return (response: LightMyRequestResponse): T => {
    expect(response.statusCode, response.body).toBe(200);
    return schema.parse(response.json());
  };
}

describe.skipIf(!TEST_DATABASE_URL)('LinkedIn messages to a lead (real app, real database)', () => {
  let t: TestApp;
  const env: Record<string, string> = { JOB_SEARCH_USER_IDS: '' };

  beforeAll(async () => {
    t = await createTestApp({ env, jobSearchClaude: claude });
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    model.answers = [SHORT];
    model.requests = [];
    t.clock.set(T0);
    await t.db.query("delete from rate_limits where key like 'lead-message%'");
  });

  const send = (method: 'GET' | 'POST' | 'PUT', url: string, cookie: string, payload?: object) =>
    t.app.inject({
      method,
      url,
      headers: { ...SAME_ORIGIN, cookie },
      ...(payload ? { payload } : method === 'GET' ? {} : { payload: {} }),
    });

  /** An allowed user with a resume, an application, and a lead with two notes. */
  async function owner(options: { allowed?: boolean; resume?: boolean } = {}) {
    const login = await t.login({ timeZone: 'America/New_York' });
    if (options.allowed !== false)
      env['JOB_SEARCH_USER_IDS'] = [env['JOB_SEARCH_USER_IDS'], login.user.id]
        .filter(Boolean)
        .join(',');
    const { cookie } = login;
    if (options.resume !== false)
      await send('PUT', '/api/resume', cookie, {
        kind: 'text',
        text: 'Pat Example. SDET, Playwright suites across 12 teams. '.repeat(5),
      });
    const application = (
      await send('POST', '/api/applications', cookie, {
        company: 'Acme',
        role: 'SDET',
        status: 'Applied',
      })
    ).json<{ id: string }>();
    const lead = (
      await send('POST', '/api/leads', cookie, {
        name: 'Sam Lee',
        company: 'Acme',
        profileLink: 'https://www.linkedin.com/in/samlee',
      })
    ).json<{ id: string }>();
    await send('POST', `/api/leads/${lead.id}/notes`, cookie, {
      heldOn: '2026-10-01',
      body: 'Met at the testing meetup.',
    });
    await send('POST', `/api/leads/${lead.id}/notes`, cookie, {
      heldOn: '2026-10-20',
      body: 'Said their team is hiring.',
    });
    return { ...login, applicationId: application.id, leadId: lead.id };
  }
  const draft = (cookie: string, applicationId: string, body: object) =>
    send('POST', `/api/applications/${applicationId}/lead-message`, cookie, body);
  const sent = (cookie: string, applicationId: string, body: object) =>
    send('POST', `/api/applications/${applicationId}/lead-message/sent`, cookie, body);
  const leadOf = async (cookie: string, id: string) =>
    parsed(LeadDetailSchema)(await send('GET', `/api/leads/${id}`, cookie));
  const applicationOf = async (cookie: string, id: string) =>
    parsed(ApplicationDetailSchema)(await send('GET', `/api/applications/${id}`, cookie));

  it('drafts both versions from the job, the lead, their notes and the resume, storing nothing', async () => {
    const me = await owner();
    const before = await applicationOf(me.cookie, me.applicationId);

    const result = parsed(LeadMessageDraftSchema)(
      await draft(me.cookie, me.applicationId, {
        leadId: me.leadId,
        kind: 'follow_up',
        steer: 'Mention the Playwright work.',
      }),
    );

    expect(result).toEqual({ leadId: me.leadId, kind: 'follow_up', ...SHORT });
    expect(model.requests).toHaveLength(1);
    expect(model.requests[0]).toMatchObject({
      company: 'Acme',
      role: 'SDET',
      status: 'Applied',
      kind: 'follow_up',
      lead: { name: 'Sam Lee', company: 'Acme' },
      steer: 'Mention the Playwright work.',
      notes: [
        { heldOn: '2026-10-20', body: 'Said their team is hiring.' },
        { heldOn: '2026-10-01', body: 'Met at the testing meetup.' },
      ],
    });
    expect(model.requests[0]?.resumeText).toContain('Playwright');
    // Nothing stored: the lead has its two notes, the application is unchanged.
    expect((await leadOf(me.cookie, me.leadId)).notes).toHaveLength(2);
    expect((await applicationOf(me.cookie, me.applicationId)).version).toBe(before.version);
  });

  it('asks once more when a draft is too long, then cuts it to the limits', async () => {
    const me = await owner();
    const long = {
      connectionNote: 'A sentence that runs on. '.repeat(20),
      message: 'Another long sentence here. '.repeat(60),
    };
    model.answers = [long, long];

    const result = parsed(LeadMessageDraftSchema)(
      await draft(me.cookie, me.applicationId, { leadId: me.leadId, kind: 'referral' }),
    );

    expect(model.requests).toHaveLength(2);
    expect(model.requests[1]?.tooLong).toMatch(/connection note was \d+ characters/);
    expect([...result.connectionNote].length).toBeLessThanOrEqual(200);
    expect([...result.message].length).toBeLessThanOrEqual(1000);
    expect(result.connectionNote).toMatch(/on\.$/);
  });

  it('answers 502 when the draft does not finish, and 409 without a resume', async () => {
    const me = await owner();
    model.answers = [null];
    const failed = await draft(me.cookie, me.applicationId, { leadId: me.leadId, kind: 'thanks' });
    expect(failed.statusCode).toBe(502);
    expect(failed.json()).toMatchObject({ error: 'draft_failed' });

    const noResume = await owner({ resume: false });
    const response = await draft(noResume.cookie, noResume.applicationId, {
      leadId: noResume.leadId,
      kind: 'thanks',
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'no_resume' });
  });

  it('allows 30 drafts a day', async () => {
    const me = await owner();
    const body = { leadId: me.leadId, kind: 'follow_up' };
    for (let index = 0; index < LEAD_MESSAGE_RULE.limit; index += 1)
      expect((await draft(me.cookie, me.applicationId, body)).statusCode).toBe(200);
    expect((await draft(me.cookie, me.applicationId, body)).statusCode).toBe(429);
  });

  it('is not available (404) to a user who is not on the list', async () => {
    const stranger = await owner({ allowed: false });
    const response = await draft(stranger.cookie, stranger.applicationId, {
      leadId: stranger.leadId,
      kind: 'follow_up',
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: 'not_available' });
    expect(model.requests).toHaveLength(0);
  });

  it('marks it sent: one dated note on the lead, the lead linked, activity on the application', async () => {
    const me = await owner();
    const before = await applicationOf(me.cookie, me.applicationId);
    t.clock.set(new Date(T0.getTime() + 60 * 60 * 1000));
    const text = 'Hi Sam,\n\nI applied for the SDET role at Acme. Thank you!';

    const first = await sent(me.cookie, me.applicationId, { leadId: me.leadId, text });
    // A double click: the same message again the same day.
    const second = await sent(me.cookie, me.applicationId, { leadId: me.leadId, text });

    expect(first.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    const lead = await leadOf(me.cookie, me.leadId);
    expect(lead.notes).toHaveLength(3);
    expect(lead.notes[0]?.body).toBe(`LinkedIn message about SDET at Acme:\n\n${text}`);
    const after = await applicationOf(me.cookie, me.applicationId);
    expect(after.leadId).toBe(me.leadId);
    expect(after.version).toBe(before.version + 1);
    const activity = await t.db.query<{ last_activity_at: Date }>(
      'select last_activity_at from applications where id = $1',
      [me.applicationId],
    );
    expect(activity.rows[0]?.last_activity_at.getTime()).toBe(t.clock.now().getTime());
  });

  it("gives another user 404 for someone else's application or lead, and changes nothing", async () => {
    const me = await owner();
    const other = await owner();
    const message = { text: 'Hello there.' };
    for (const [applicationId, leadId] of [
      [me.applicationId, other.leadId], // my application, their lead
      [other.applicationId, me.leadId], // their application, my lead (from the body)
    ] as const) {
      const drafted = await draft(other.cookie, applicationId, { leadId, kind: 'thanks' });
      const logged = await sent(other.cookie, applicationId, { leadId, ...message });
      expect(drafted.statusCode).toBe(404);
      expect(logged.statusCode).toBe(404);
    }
    for (const id of ['00000000-0000-4000-8000-000000000000', 'not-a-uuid']) {
      expect(
        (await draft(other.cookie, id, { leadId: other.leadId, kind: 'thanks' })).statusCode,
      ).toBe(404);
      expect((await sent(other.cookie, id, { leadId: other.leadId, ...message })).statusCode).toBe(
        404,
      );
    }
    expect((await leadOf(me.cookie, me.leadId)).notes).toHaveLength(2);
    expect((await applicationOf(me.cookie, me.applicationId)).leadId).toBeNull();
    expect(model.requests).toHaveLength(0);
  });
});
