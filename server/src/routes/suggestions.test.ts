import { ApplicationDetailSchema, type ApplicationDetail } from '@jat/shared';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { saveSuggestion, type SuggestionInput } from '../repo/postingSuggestions';
import { createTestApp, SAME_ORIGIN, type TestApp } from '../test/app';
import { TEST_DATABASE_URL } from '../test/testDb';

const MISSING_ID = '00000000-0000-4000-8000-000000000000';

function detail(response: LightMyRequestResponse): ApplicationDetail {
  const parsed = ApplicationDetailSchema.safeParse(response.json());
  if (!parsed.success)
    throw new Error(`Response broke the contract: ${parsed.error.message}\n${response.body}`);
  return parsed.data;
}

const FOUND: SuggestionInput = {
  source: 'greenhouse',
  jobLink: 'https://job-boards.greenhouse.io/acme/jobs/42',
  role: 'Senior SDET',
  salaryMin: 150000,
  salaryMax: 180000,
  salaryCurrency: 'USD',
  location: 'Boston, MA',
  workMode: 'Hybrid',
  postedOn: '2026-10-01',
};

describe.skipIf(!TEST_DATABASE_URL)('posting suggestions API (real app, real database)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.close();
  });

  const send = (
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    cookie: string,
    headers: Record<string, string> = {},
  ) =>
    t.app.inject({
      method,
      url,
      headers: { ...SAME_ORIGIN, cookie, ...headers },
      ...(method === 'POST' ? { payload: {} } : {}),
    });

  /** An application with a suggestion, as an import would leave it. */
  async function withSuggestion(cookie: string, userId: string, extra: object = {}) {
    const created = await t.app.inject({
      method: 'POST',
      url: '/api/applications',
      headers: { ...SAME_ORIGIN, cookie },
      payload: { company: 'Acme', role: 'Role not stated', ...extra },
    });
    const application = detail(created);
    await saveSuggestion(t.db, userId, application.id, FOUND, t.clock.now());
    return application;
  }

  const apply = (cookie: string, id: string, version: number | null) =>
    send(
      'POST',
      `/api/applications/${id}/suggestion/apply`,
      cookie,
      version === null ? {} : { 'if-match': `"${version}"` },
    );

  it('shows the suggestion on the application', async () => {
    const { cookie, user } = await t.login();
    const application = await withSuggestion(cookie, user.id);

    const read = detail(await send('GET', `/api/applications/${application.id}`, cookie));
    expect(read.postingSuggestion).toMatchObject({ source: 'greenhouse', role: 'Senior SDET' });
  });

  it('applies it into the empty fields only, then it is gone', async () => {
    const { cookie, user } = await t.login();
    const application = await withSuggestion(cookie, user.id, { location: 'Remote (US)' });

    const response = await apply(cookie, application.id, application.version);
    expect(response.statusCode).toBe(200);
    expect(detail(response)).toMatchObject({
      role: 'Senior SDET', // the "Role not stated" placeholder counts as empty
      jobLink: FOUND.jobLink,
      salaryMin: 150000,
      salaryMax: 180000,
      salaryCurrency: 'USD',
      location: 'Remote (US)', // typed by the user: kept
      workMode: 'Hybrid',
      postedOn: '2026-10-01',
      postingSuggestion: null,
      version: application.version + 1,
    });
    expect((await apply(cookie, application.id, application.version + 1)).statusCode).toBe(404);
  });

  it('needs If-Match, and refuses a stale version without changing anything', async () => {
    const { cookie, user } = await t.login();
    const application = await withSuggestion(cookie, user.id);

    expect((await apply(cookie, application.id, null)).statusCode).toBe(428);
    const stale = await apply(cookie, application.id, application.version + 5);
    expect(stale.statusCode).toBe(412);
    expect(stale.headers.etag).toBe(`"${application.version}"`);
    const read = detail(await send('GET', `/api/applications/${application.id}`, cookie));
    expect(read).toMatchObject({
      role: 'Role not stated',
      postingSuggestion: { role: 'Senior SDET' },
    });
  });

  it('dismisses it, leaving the application as it was', async () => {
    const { cookie, user } = await t.login();
    const application = await withSuggestion(cookie, user.id);

    expect(
      (await send('DELETE', `/api/applications/${application.id}/suggestion`, cookie)).statusCode,
    ).toBe(204);
    const read = detail(await send('GET', `/api/applications/${application.id}`, cookie));
    expect(read).toMatchObject({
      role: 'Role not stated',
      postingSuggestion: null,
      version: application.version,
    });
    expect(
      (await send('DELETE', `/api/applications/${application.id}/suggestion`, cookie)).statusCode,
    ).toBe(404);
  });

  describe('isolation: another user gets the same 404 as for an id that does not exist', () => {
    it('cannot see, apply or dismiss someone else’s suggestion', async () => {
      const owner = await t.login();
      const application = await withSuggestion(owner.cookie, owner.user.id);
      const other = await t.login();

      for (const id of [application.id, MISSING_ID]) {
        expect((await apply(other.cookie, id, 1)).statusCode).toBe(404);
        expect(
          (await send('DELETE', `/api/applications/${id}/suggestion`, other.cookie)).statusCode,
        ).toBe(404);
      }
      // And nothing changed for the owner.
      const read = detail(await send('GET', `/api/applications/${application.id}`, owner.cookie));
      expect(read.postingSuggestion).not.toBeNull();
      // Nor can a suggestion be saved onto someone else's application.
      expect(
        await saveSuggestion(t.db, other.user.id, application.id, FOUND, t.clock.now()),
      ).toBeNull();
    });
  });
});
