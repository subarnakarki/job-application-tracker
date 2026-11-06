import { readFileSync } from 'node:fs';
import { ApplicationDetailSchema, type ApplicationDetail } from '@jat/shared';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FetchError, type PageFetcher } from '../postings/fetchPage';
import { createTestApp, SAME_ORIGIN, type TestApp } from '../test/app';
import { TEST_DATABASE_URL } from '../test/testDb';

const MISSING_ID = '00000000-0000-4000-8000-000000000000';

const STRIPE_BOARD = 'https://boards-api.greenhouse.io/v1/boards/stripe/jobs';
const board = readFileSync(
  new URL('../postings/fixtures/greenhouse-board.json', import.meta.url),
  'utf8',
);

/** Stripe's Greenhouse board; every other board answers 404, as a missing board does. */
const asked: string[] = [];
const fetchPage: PageFetcher = (url) => {
  asked.push(url);
  return url === STRIPE_BOARD
    ? Promise.resolve({ url, contentType: 'application/json', text: board })
    : Promise.reject(new FetchError('http_status', '404'));
};

function detail(response: LightMyRequestResponse): ApplicationDetail {
  const parsed = ApplicationDetailSchema.safeParse(response.json());
  if (!parsed.success)
    throw new Error(`Response broke the contract: ${parsed.error.message}\n${response.body}`);
  return parsed.data;
}

describe.skipIf(!TEST_DATABASE_URL)('find posting API (real app, real database)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({ fetchPage });
  });
  afterAll(async () => {
    await t.close();
  });

  async function create(cookie: string, input: object) {
    return detail(
      await t.app.inject({
        method: 'POST',
        url: '/api/applications',
        headers: { ...SAME_ORIGIN, cookie },
        payload: input,
      }),
    );
  }

  const find = (cookie: string, id: string) =>
    t.app.inject({
      method: 'POST',
      url: `/api/applications/${id}/suggestion/find`,
      headers: { ...SAME_ORIGIN, cookie },
      payload: {},
    });

  it('saves a match as the suggestion, and changes nothing else', async () => {
    const { cookie } = await t.login();
    const application = await create(cookie, { company: 'Stripe', role: 'abuse investigator' });

    const response = await find(cookie, application.id);
    expect(response.statusCode).toBe(200);
    expect(detail(response)).toMatchObject({
      role: 'abuse investigator',
      jobLink: null,
      version: application.version,
      postingSuggestion: {
        source: 'greenhouse',
        role: 'Abuse Investigator',
        jobLink: 'https://stripe.com/jobs/search?gh_jid=8172487',
      },
    });
  });

  it('uses the domain of an email address in the contact field', async () => {
    const { cookie } = await t.login();
    const application = await create(cookie, {
      company: 'Stripe Payments', // board names "stripepayments" and "stripe-payments" do not exist
      role: 'Abuse Investigator',
      contact: 'Jane Doe <jane@stripe.com>',
    });
    asked.length = 0;
    const found = detail(await find(cookie, application.id));
    expect(found.postingSuggestion).toMatchObject({ source: 'greenhouse' });
    expect(asked).toContain(STRIPE_BOARD);
  });

  it('answers with the application as it was when nothing matches', async () => {
    const { cookie } = await t.login();
    const application = await create(cookie, { company: 'Stripe', role: 'Chief Llama Officer' });
    const response = await find(cookie, application.id);
    expect(response.statusCode).toBe(200);
    expect(detail(response)).toMatchObject({
      postingSuggestion: null,
      version: application.version,
    });
  });

  it('needs a role to look for', async () => {
    const { cookie } = await t.login();
    asked.length = 0;
    const application = await create(cookie, { company: 'Stripe', role: 'Role not stated' });
    const response = await find(cookie, application.id);
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: 'no_role' });
    expect(asked).toEqual([]);
  });

  it('limits lookups to 30 an hour per user', async () => {
    const { cookie } = await t.login();
    const application = await create(cookie, { company: 'Stripe', role: 'Chief Llama Officer' });
    for (let i = 0; i < 30; i++) expect((await find(cookie, application.id)).statusCode).toBe(200);
    const limited = await find(cookie, application.id);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
  });

  describe('isolation: another user gets the same 404 as for an id that does not exist', () => {
    it('cannot look up postings for someone else’s application', async () => {
      const owner = await t.login();
      const application = await create(owner.cookie, {
        company: 'Stripe',
        role: 'Abuse Investigator',
      });
      const other = await t.login();
      asked.length = 0;
      for (const id of [application.id, MISSING_ID]) {
        expect((await find(other.cookie, id)).statusCode).toBe(404);
      }
      expect(asked).toEqual([]);
      const read = await t.app.inject({
        method: 'GET',
        url: `/api/applications/${application.id}`,
        headers: { ...SAME_ORIGIN, cookie: owner.cookie },
      });
      expect(detail(read).postingSuggestion).toBeNull();
    });
  });
});
