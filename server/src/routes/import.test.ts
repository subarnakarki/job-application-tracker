import { ImportItemSchema, ImportRunDetailSchema } from '@jat/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Classification, EmailClassifier } from '../import/classify';
import type { GmailClient, GmailMessage } from '../import/gmail';
import { GmailAuthError, type GmailAuthorizer } from '../import/gmailAuth';
import { createTestApp, SAME_ORIGIN, setCookies, T0, type TestApp } from '../test/app';
import { TEST_DATABASE_URL } from '../test/testDb';

/** Google consent stub: echoes the state; `refuse` makes the next exchange fail. */
const authorizer = {
  refuse: null as GmailAuthError | null,
  authorizationUrl: ({ state }: { state: string }) => `https://google.test/consent?state=${state}`,
  exchangeCode() {
    const refusal = this.refuse;
    this.refuse = null;
    return refusal ? Promise.reject(refusal) : Promise.resolve('access-token');
  },
} satisfies GmailAuthorizer & { refuse: GmailAuthError | null };

/** One confirmation email per user; the message id carries the user so runs never collide. */
const inbox: GmailClient & EmailClassifier & { owner: string } = {
  owner: '',
  listMessageIds() {
    return Promise.resolve([`thanks-${this.owner}`]);
  },
  getMessage(_token, id): Promise<GmailMessage> {
    return Promise.resolve({
      id,
      from: 'jobs@acme.example',
      subject: 'Thanks',
      date: T0,
      body: '',
    });
  },
  classify(): Promise<Classification> {
    return Promise.resolve({
      kind: 'verdict',
      verdict: {
        kind: 'application_confirmation',
        company: 'Acme',
        role: 'SDET',
        confidence: 'high',
        summary: 'Acme received the application.',
      },
    });
  },
};

describe.skipIf(!TEST_DATABASE_URL)(
  'Gmail import routes (real app, stub Google and Claude)',
  () => {
    let t: TestApp;
    const env: Record<string, string | undefined> = {};

    beforeAll(async () => {
      t = await createTestApp({
        env,
        gmailAuthorizer: authorizer,
        gmail: inbox,
        classifier: inbox,
      });
    });
    afterAll(async () => {
      await t.close();
    });

    /** A signed-in user on the allowlist. */
    async function importer() {
      const session = await t.login();
      env['GMAIL_IMPORT_USER_IDS'] = [env['GMAIL_IMPORT_USER_IDS'], session.user.id]
        .filter(Boolean)
        .join(',');
      return session;
    }

    const get = (url: string, cookie: string) =>
      t.app.inject({ method: 'GET', url, headers: { cookie } });

    /** Start, then come back from Google: the full happy path, ending on the results page. */
    async function runImport(cookie: string, userId: string) {
      inbox.owner = userId;
      const start = await get('/api/import/gmail/start', cookie);
      expect(start.statusCode).toBe(302);
      const state = new URL(String(start.headers.location)).searchParams.get('state') ?? '';
      const importCookie = (setCookies(start)[0] ?? '').split(';')[0] ?? '';
      return get(
        `/api/import/gmail/callback?code=abc&state=${state}`,
        `${cookie}; ${importCookie}`,
      );
    }

    it('is invisible to users who are not on the allowlist, and to the demo account', async () => {
      const stranger = await t.login();
      const demo = await t.login({ isDemo: true });
      env['GMAIL_IMPORT_USER_IDS'] = `${demo.user.id}`;

      for (const { cookie } of [stranger, demo]) {
        expect((await get('/api/import/status', cookie)).json()).toEqual({ available: false });
        expect((await get('/api/import/gmail/start', cookie)).statusCode).toBe(404);
      }
    });

    it('asks Google for read-only Gmail access, then imports and lands on the results', async () => {
      const { cookie, user } = await importer();
      expect((await get('/api/import/status', cookie)).json()).toEqual({ available: true });

      const done = await runImport(cookie, user.id);

      expect(done.statusCode).toBe(302);
      const runPath = String(done.headers.location);
      expect(runPath).toMatch(/^\/import\/[0-9a-f-]{36}$/);
      const detail = ImportRunDetailSchema.parse(
        (await get(`/api/${runPath.slice(1).replace('import/', 'import/runs/')}`, cookie)).json(),
      );
      expect(detail.run.status).toBe('finished');
      expect(detail.items).toMatchObject([
        { outcome: 'created', company: 'Acme', toStatus: 'Applied' },
      ]);
    });

    it('refuses a callback without the state this user started', async () => {
      const { cookie, user } = await importer();
      const other = await importer();
      inbox.owner = user.id;
      const start = await get('/api/import/gmail/start', cookie);
      const importCookie = (setCookies(start)[0] ?? '').split(';')[0] ?? '';

      const forged = await get(
        '/api/import/gmail/callback?code=abc&state=wrong',
        `${cookie}; ${importCookie}`,
      );
      const state = new URL(String(start.headers.location)).searchParams.get('state') ?? '';
      const otherUser = await get(
        `/api/import/gmail/callback?code=abc&state=${state}`,
        `${other.cookie}; ${importCookie}`,
      );

      expect(forged.headers.location).toBe('/account?import=gmail_expired');
      expect(otherUser.headers.location).toBe('/account?import=gmail_expired');
    });

    it('goes back to the Account page when Gmail access is declined', async () => {
      const { cookie, user } = await importer();
      authorizer.refuse = new GmailAuthError('no scope', 'gmail_not_granted');

      const response = await runImport(cookie, user.id);

      expect(response.headers.location).toBe('/account?import=gmail_not_granted');
    });

    it('allows three imports a day', async () => {
      const { cookie } = await importer();
      for (let i = 0; i < 3; i += 1) {
        expect((await get('/api/import/gmail/start', cookie)).headers.location).toMatch(/^https:/);
      }

      expect((await get('/api/import/gmail/start', cookie)).headers.location).toBe(
        '/account?import=rate_limited',
      );
    });

    it("undoes an item once, and another user cannot see or touch this user's import", async () => {
      const me = await importer();
      const other = await importer();
      const runPath = String((await runImport(me.cookie, me.user.id)).headers.location);
      const runUrl = `/api/import/runs/${runPath.split('/').at(-1) ?? ''}`;
      const item = ImportRunDetailSchema.parse((await get(runUrl, me.cookie)).json()).items[0];
      const post = (action: string, cookie: string) =>
        t.app.inject({
          method: 'POST',
          url: `/api/import/items/${item?.id ?? ''}/${action}`,
          headers: { ...SAME_ORIGIN, cookie },
          payload: {},
        });

      expect((await get(runUrl, other.cookie)).statusCode).toBe(404);
      for (const action of ['undo', 'apply', 'dismiss']) {
        expect((await post(action, other.cookie)).statusCode).toBe(404);
      }

      const undone = await post('undo', me.cookie);
      expect(ImportItemSchema.parse(undone.json()).outcome).toBe('undone');
      const again = await post('undo', me.cookie);
      expect(again.statusCode).toBe(409);
      expect(again.json()).toMatchObject({ error: 'import_conflict' });
    });
  },
);
