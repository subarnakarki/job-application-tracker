import { ClaudeLimitError } from '../anthropic/limits';
import { ImportItemSchema, ImportRunDetailSchema, ImportRunListSchema } from '@jat/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Classification, EmailClassifier } from '../import/classify';
import type { GmailClient, GmailMessage } from '../import/gmail';
import { GmailAuthError, type GmailAuthorizer } from '../import/gmailAuth';
import { finishRun, startRun } from '../repo/imports';
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
        postingUrl: null,
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

    it('lists only your own imports, newest first, with counts per outcome', async () => {
      const me = await importer();
      const other = await importer();
      await runImport(me.cookie, me.user.id);

      const mine = ImportRunListSchema.parse((await get('/api/import/runs', me.cookie)).json());
      const theirs = ImportRunListSchema.parse(
        (await get('/api/import/runs', other.cookie)).json(),
      );

      expect(mine.items).toMatchObject([
        { status: 'finished', emailsScanned: 1, changed: 1, needsReview: 0, skipped: 0 },
      ]);
      expect(theirs.items).toEqual([]);
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

    it('stops at a Claude limit: back to the Account page, run failed, emails kept for next time', async () => {
      const { cookie, user } = await importer();
      const classify = inbox.classify.bind(inbox);
      inbox.classify = () => Promise.reject(new ClaudeLimitError('spend_limit', null));
      let stopped;
      try {
        stopped = await runImport(cookie, user.id);
      } finally {
        inbox.classify = classify;
      }

      expect(stopped.statusCode).toBe(302);
      expect(stopped.headers.location).toBe('/account?import=claude_limit_reached');
      const runs = (await get('/api/import/runs', cookie)).json<{ items: { status: string }[] }>()
        .items;
      expect(runs.map((run) => run.status)).toEqual(['failed']);

      // With Claude back, the next import reads the same email and handles it.
      const done = await runImport(cookie, user.id);
      expect(done.headers.location).toMatch(/^\/import\//);
      const detail = ImportRunDetailSchema.parse(
        (
          await get(
            `/api/${String(done.headers.location).slice(1).replace('import/', 'import/runs/')}`,
            cookie,
          )
        ).json(),
      );
      expect(detail.items).toMatchObject([{ outcome: 'created', company: 'Acme' }]);
    });

    it('does not start a second import while one is running', async () => {
      const { cookie, user } = await importer();
      inbox.owner = user.id;
      // The user is already on their way to Google (say, a second tab) when another import starts.
      const start = await get('/api/import/gmail/start', cookie);
      const state = new URL(String(start.headers.location)).searchParams.get('state') ?? '';
      const importCookie = (setCookies(start)[0] ?? '').split(';')[0] ?? '';
      const running = (await startRun(t.db, user.id, t.clock.now())) ?? '';

      // A new start is not sent to Google again...
      const second = await get('/api/import/gmail/start', cookie);
      expect(second.statusCode).toBe(302);
      expect(second.headers.location).toBe('/account?import=import_running');
      // ...and the callback of the earlier trip is refused too, with nothing imported.
      const callback = await get(
        `/api/import/gmail/callback?code=abc&state=${state}`,
        `${cookie}; ${importCookie}`,
      );
      expect(callback.headers.location).toBe('/account?import=import_running');
      const runs = await get('/api/import/runs', cookie);
      expect(runs.json<{ items: unknown[] }>().items).toHaveLength(1);

      // Once the running one is done, a new import works again.
      await finishRun(t.db, user.id, running, {
        status: 'finished',
        emailsScanned: 0,
        now: t.clock.now(),
      });
      expect((await runImport(cookie, user.id)).headers.location).toMatch(/^\/import\//);
    });

    it('has no daily limit for an allowed user (each email is still handled once)', async () => {
      const { cookie } = await importer();
      for (let i = 0; i < 5; i += 1) {
        expect((await get('/api/import/gmail/start', cookie)).headers.location).toMatch(/^https:/);
      }
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
