import { DataExportSchema } from '@jat/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, SAME_ORIGIN, setCookies, type TestApp } from '../test/app';
import { TEST_DATABASE_URL } from '../test/testDb';
import { ACCOUNT_DELETION_CONFIRMATION } from './me';

describe.skipIf(!TEST_DATABASE_URL)('account export and deletion (real app, real database)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.close();
  });

  const createFor = (cookie: string, company: string) =>
    t.app.inject({
      method: 'POST',
      url: '/api/applications',
      headers: { ...SAME_ORIGIN, cookie },
      payload: { company, role: 'SDET', status: 'Applied' },
    });
  const exportFor = (cookie: string) =>
    t.app.inject({ method: 'GET', url: '/api/me/export', headers: { cookie } });
  const deleteAccount = (cookie: string, payload: object) =>
    t.app.inject({
      method: 'DELETE',
      url: '/api/me',
      headers: { ...SAME_ORIGIN, cookie },
      payload,
    });

  describe('GET /api/me/export', () => {
    it("downloads everything the app holds about the user, and nobody else's data", async () => {
      const me = await t.login({ timeZone: 'America/New_York' });
      const other = await t.login();
      await createFor(me.cookie, 'Mine One');
      t.clock.advance(1000);
      await createFor(me.cookie, 'Mine Two');
      t.clock.advance(-1000);
      await createFor(other.cookie, 'Theirs');

      const response = await exportFor(me.cookie);

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-disposition']).toBe(
        'attachment; filename="job-applications-2026-11-05.json"',
      );
      const parsed = DataExportSchema.safeParse(response.json());
      expect(parsed.success).toBe(true);
      if (!parsed.success) return;
      expect(parsed.data.user.id).toBe(me.user.id);
      expect(parsed.data.applications.map((application) => application.company)).toEqual([
        'Mine One',
        'Mine Two',
      ]);
      expect(
        parsed.data.applications.every((application) => application.history.length === 1),
      ).toBe(true);
      expect(response.body).not.toContain('Theirs');
    });

    it('works with no applications', async () => {
      const { cookie } = await t.login();

      expect(DataExportSchema.parse((await exportFor(cookie)).json()).applications).toEqual([]);
    });

    it('is not available to the shared demo account', async () => {
      const { cookie } = await t.login({ isDemo: true });

      const response = await exportFor(cookie);

      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: 'demo_restricted' });
    });
  });

  describe('DELETE /api/me', () => {
    it('deletes the account and everything in it, signs out, and leaves other accounts alone', async () => {
      const doomed = await t.login();
      const bystander = await t.login();
      await createFor(doomed.cookie, 'Doomed Co');
      await createFor(bystander.cookie, 'Safe Co');

      const response = await deleteAccount(doomed.cookie, {
        confirm: ACCOUNT_DELETION_CONFIRMATION,
      });

      expect(response.statusCode).toBe(204);
      expect(setCookies(response)[0]).toContain('Max-Age=0');
      const left = await t.db.query<{ users: number; applications: number; sessions: number }>(
        `select (select count(*)::int from users where id = $1) as users,
                (select count(*)::int from applications where user_id = $1) as applications,
                (select count(*)::int from sessions where user_id = $1) as sessions`,
        [doomed.user.id],
      );
      expect(left.rows[0]).toEqual({ users: 0, applications: 0, sessions: 0 });
      expect(
        (await t.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: doomed.cookie } }))
          .statusCode,
      ).toBe(401);
      expect(
        DataExportSchema.parse((await exportFor(bystander.cookie)).json()).applications,
      ).toHaveLength(1);
    });

    it.each([
      ['no confirmation', {}],
      ['a wrong confirmation', { confirm: 'yes' }],
      ['a confirmation of the wrong type', { confirm: true }],
      ['extra keys', { confirm: ACCOUNT_DELETION_CONFIRMATION, userId: 'someone-else' }],
    ])('refuses %s with 400 and deletes nothing', async (_label, payload) => {
      const { user, cookie } = await t.login();

      const response = await deleteAccount(cookie, payload);

      expect(response.statusCode).toBe(400);
      expect((await t.db.query('select 1 from users where id = $1', [user.id])).rowCount).toBe(1);
    });

    it('cannot delete the shared demo account', async () => {
      const { user, cookie } = await t.login({ isDemo: true });

      const response = await deleteAccount(cookie, { confirm: ACCOUNT_DELETION_CONFIRMATION });

      expect(response.statusCode).toBe(403);
      expect((await t.db.query('select 1 from users where id = $1', [user.id])).rowCount).toBe(1);
    });

    it('cannot be triggered cross-site', async () => {
      const { user, cookie } = await t.login();

      const response = await t.app.inject({
        method: 'DELETE',
        url: '/api/me',
        headers: { 'sec-fetch-site': 'cross-site', cookie },
        payload: { confirm: ACCOUNT_DELETION_CONFIRMATION },
      });

      expect(response.statusCode).toBe(403);
      expect((await t.db.query('select 1 from users where id = $1', [user.id])).rowCount).toBe(1);
    });
  });
});
