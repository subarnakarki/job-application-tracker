import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, SAME_ORIGIN, type TestApp } from '../test/app';
import { TEST_DATABASE_URL } from '../test/testDb';
import { DEMO_PREVIEW_RULE } from './postings';

const POSTING = 'https://careers.example.com/jobs/7';

describe.skipIf(!TEST_DATABASE_URL)('POST /api/postings/preview (real app, stub internet)', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp({
      fetchPage: (url) =>
        url === POSTING
          ? Promise.resolve({
              url,
              contentType: 'text/html',
              text: `<script type="application/ld+json">${JSON.stringify({
                '@type': 'JobPosting',
                title: 'SDET',
                hiringOrganization: { name: 'Initech' },
              })}</script>`,
            })
          : Promise.reject(new Error('unexpected fetch')),
    });
  });
  afterAll(() => t.close());

  const preview = (cookie: string, url: string) =>
    t.app.inject({
      method: 'POST',
      url: '/api/postings/preview',
      headers: { cookie, ...SAME_ORIGIN, 'content-type': 'application/json' },
      payload: JSON.stringify({ url }),
    });

  it('returns the details and stores nothing', async () => {
    const { cookie } = await t.login();
    const response = await preview(cookie, POSTING);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      jobLink: POSTING,
      company: 'Initech',
      role: 'SDET',
      salaryMin: null,
      salaryMax: null,
      salaryCurrency: null,
    });
    const listed = await t.app.inject({
      method: 'GET',
      url: '/api/applications',
      headers: { cookie },
    });
    expect(listed.json()).toMatchObject({ total: 0 });
  });

  it('explains sign-in sites, and rejects links that are not http(s)', async () => {
    const { cookie } = await t.login();
    const linkedin = await preview(cookie, 'https://www.linkedin.com/jobs/view/1');
    expect(linkedin.statusCode).toBe(422);
    expect(linkedin.json()).toMatchObject({ error: 'unsupported_site' });
    const script = await preview(cookie, 'javascript:alert(1)');
    expect(script.statusCode).toBe(400);
  });

  it('limits how many links one user can have read', async () => {
    const { cookie } = await t.login({ isDemo: true });
    for (let index = 0; index < DEMO_PREVIEW_RULE.limit; index++) {
      expect((await preview(cookie, POSTING)).statusCode).toBe(200);
    }
    const over = await preview(cookie, POSTING);
    expect(over.statusCode).toBe(429);
    expect(over.headers['retry-after']).toBeDefined();
  });
});
