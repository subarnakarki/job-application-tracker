import { LIMITS, LeadDetailSchema, type LeadDetail } from '@jat/shared';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, SAME_ORIGIN, type TestApp } from '../test/app';
import { TEST_DATABASE_URL } from '../test/testDb';

const MISSING_ID = '00000000-0000-4000-8000-000000000000';

function detail(response: LightMyRequestResponse): LeadDetail {
  const parsed = LeadDetailSchema.safeParse(response.json());
  if (!parsed.success)
    throw new Error(`Response broke the contract: ${parsed.error.message}\n${response.body}`);
  return parsed.data;
}

describe.skipIf(!TEST_DATABASE_URL)('leads API (real app, real database)', () => {
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
  ) =>
    t.app.inject({
      method,
      url,
      headers: {
        cookie,
        ...SAME_ORIGIN,
        ...(payload ? { 'content-type': 'application/json' } : {}),
      },
      ...(payload ? { payload: JSON.stringify(payload) } : {}),
    });

  it('adds a lead, keeps dated notes newest first, edits and deletes them', async () => {
    const { cookie } = await t.login();
    const created = await call(cookie, 'POST', '/api/leads', {
      name: '  Sam Rivera ',
      company: 'Globex',
      email: 'sam@example.com',
      profileLink: 'https://www.linkedin.com/in/sam',
    });
    expect(created.statusCode).toBe(201);
    const lead = detail(created);
    expect(lead).toMatchObject({
      name: 'Sam Rivera',
      company: 'Globex',
      phone: null,
      noteCount: 0,
    });
    expect(created.headers['location']).toBe(`/api/leads/${lead.id}`);

    const first = await call(cookie, 'POST', `/api/leads/${lead.id}/notes`, {
      heldOn: '2026-11-01',
      body: 'Coffee chat: they are hiring SDETs in Q1',
    });
    const second = await call(cookie, 'POST', `/api/leads/${lead.id}/notes`, {
      heldOn: '2026-11-04',
      body: 'Sent my resume',
    });
    expect([first.statusCode, second.statusCode]).toEqual([201, 201]);

    const withNotes = detail(await call(cookie, 'GET', `/api/leads/${lead.id}`));
    expect(withNotes.notes.map((note) => note.body)).toEqual([
      'Sent my resume',
      'Coffee chat: they are hiring SDETs in Q1',
    ]);
    expect(withNotes.latestNote).toEqual({ heldOn: '2026-11-04', body: 'Sent my resume' });

    const noteId = first.json<{ id: string }>().id;
    const edited = await call(cookie, 'PATCH', `/api/leads/${lead.id}/notes/${noteId}`, {
      body: 'Coffee chat: hiring in January',
    });
    expect(edited.json()).toMatchObject({
      heldOn: '2026-11-01',
      body: 'Coffee chat: hiring in January',
    });
    expect((await call(cookie, 'DELETE', `/api/leads/${lead.id}/notes/${noteId}`)).statusCode).toBe(
      204,
    );

    const renamed = detail(
      await call(cookie, 'PATCH', `/api/leads/${lead.id}`, { phone: '555-0100', email: null }),
    );
    expect(renamed).toMatchObject({
      name: 'Sam Rivera',
      phone: '555-0100',
      email: null,
      noteCount: 1,
    });

    expect((await call(cookie, 'DELETE', `/api/leads/${lead.id}`)).statusCode).toBe(204);
    expect((await call(cookie, 'GET', `/api/leads/${lead.id}`)).statusCode).toBe(404);
  });

  it("refuses a note dated after the user's own today, in the user's time zone", async () => {
    // T0 is 2026-11-05T12:00Z, which is already 2026-11-06 in Auckland.
    const { cookie } = await t.login({ timeZone: 'Pacific/Auckland' });
    const lead = detail(await call(cookie, 'POST', '/api/leads', { name: 'Ari' }));

    const today = await call(cookie, 'POST', `/api/leads/${lead.id}/notes`, {
      heldOn: '2026-11-06',
      body: 'Call',
    });
    const tomorrow = await call(cookie, 'POST', `/api/leads/${lead.id}/notes`, {
      heldOn: '2026-11-07',
      body: 'Call',
    });

    expect(today.statusCode).toBe(201);
    expect(tomorrow.statusCode).toBe(400);
    expect(tomorrow.json()).toMatchObject({
      error: 'validation_error',
      issues: [{ path: 'heldOn', message: 'A note cannot be dated in the future' }],
    });
  });

  it('rejects bad input with field issues', async () => {
    const { cookie } = await t.login();
    const response = await call(cookie, 'POST', '/api/leads', {
      name: ' ',
      email: 'not-an-email',
      profileLink: 'javascript:alert(1)',
    });
    expect(response.statusCode).toBe(400);
    const paths = response.json<{ issues: { path: string }[] }>().issues.map((issue) => issue.path);
    expect(paths.sort()).toEqual(['email', 'name', 'profileLink']);
  });

  it('searches by name, company and note text, and lists by name', async () => {
    const { cookie } = await t.login();
    const zoe = detail(
      await call(cookie, 'POST', '/api/leads', { name: 'Zoe', company: 'Initech' }),
    );
    await call(cookie, 'POST', '/api/leads', { name: 'adam' });
    await call(cookie, 'POST', `/api/leads/${zoe.id}/notes`, {
      heldOn: '2026-11-01',
      body: 'Knows the QA director',
    });

    const all = (await call(cookie, 'GET', '/api/leads')).json<{ items: { name: string }[] }>();
    const byNote = (await call(cookie, 'GET', '/api/leads?q=director')).json<{ total: number }>();
    const byCompany = (await call(cookie, 'GET', '/api/leads?q=INITECH')).json<{
      total: number;
    }>();
    expect(all.items.map((lead) => lead.name)).toEqual(['adam', 'Zoe']);
    expect([byNote.total, byCompany.total]).toEqual([1, 1]);
  });

  it('stops at the demo quota', async () => {
    const { cookie } = await t.login({ isDemo: true });
    for (let index = 0; index < LIMITS.leadsPerDemoUser; index++) {
      expect((await call(cookie, 'POST', '/api/leads', { name: `Lead ${index}` })).statusCode).toBe(
        201,
      );
    }
    const over = await call(cookie, 'POST', '/api/leads', { name: 'One too many' });
    expect(over.statusCode).toBe(409);
    expect(over.json()).toMatchObject({ error: 'limit_reached' });
  });

  describe('isolation: another user gets the same 404 as for an id that does not exist', () => {
    it.each([
      ['GET', 'lead'],
      ['PATCH', 'lead'],
      ['DELETE', 'lead'],
      ['POST', 'notes'],
      ['PATCH', 'note'],
      ['DELETE', 'note'],
    ] as const)('%s %s', async (method, target) => {
      const owner = await t.login();
      const stranger = await t.login();
      const lead = detail(
        await call(owner.cookie, 'POST', '/api/leads', { name: 'Private Person' }),
      );
      const note = (
        await call(owner.cookie, 'POST', `/api/leads/${lead.id}/notes`, {
          heldOn: '2026-11-01',
          body: 'secret',
        })
      ).json<{ id: string }>();

      const url = (leadId: string, noteId: string) =>
        target === 'lead'
          ? `/api/leads/${leadId}`
          : target === 'notes'
            ? `/api/leads/${leadId}/notes`
            : `/api/leads/${leadId}/notes/${noteId}`;
      const payload =
        method === 'GET' || method === 'DELETE'
          ? undefined
          : target === 'lead'
            ? { name: 'hacked' }
            : { heldOn: '2026-11-01', body: 'hacked' };
      const attempts = [
        url(lead.id, note.id),
        url(MISSING_ID, MISSING_ID),
        url('not-a-uuid', 'not-a-uuid'),
      ];

      for (const attempt of attempts) {
        const response = await call(stranger.cookie, method, attempt, payload);
        expect(response.statusCode, attempt).toBe(404);
        expect(response.body).not.toContain('Private Person');
        expect(response.body).not.toContain('secret');
      }
      if (target === 'note') {
        const theirs = detail(
          await call(stranger.cookie, 'POST', '/api/leads', { name: 'Their own' }),
        );
        const crossed = await call(stranger.cookie, method, url(theirs.id, note.id), payload);
        expect(crossed.statusCode, "the owner's note under the stranger's lead").toBe(404);
      }
      const after = detail(await call(owner.cookie, 'GET', `/api/leads/${lead.id}`));
      expect(after).toMatchObject({ name: 'Private Person', noteCount: 1 });
      expect(after.notes[0]?.body).toBe('secret');
    });
  });
});
