import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../db/migrate';
import type { Queryable } from '../db/types';
import { insertUser } from '../test/factories';
import { createTestDb, TEST_DATABASE_URL, type TestDb } from '../test/testDb';
import {
  createSession,
  deleteExpiredSessions,
  deleteSession,
  deleteSessionsForUser,
  resolveSession,
  SESSION_RENEW_AFTER_MS,
  SESSION_TTL_MS,
} from './sessions';
import { generateSessionToken, hashSessionToken } from './tokens';

const T0 = new Date('2026-11-05T12:00:00Z');
const at = (ms: number) => new Date(T0.getTime() + ms);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe('resolveSession input handling (no database needed)', () => {
  it.each(['', 'short', `${'a'.repeat(42)}=`, "' or 1=1 --", 'a'.repeat(500)])(
    'does not even query the database for the malformed token %j',
    async (token) => {
      const query = vi.fn();
      const db: Queryable = { query };

      expect(await resolveSession(db, token, T0)).toBeNull();
      expect(await deleteSession(db, token)).toBe(false);
      expect(query).not.toHaveBeenCalled();
    },
  );
});

describe.skipIf(!TEST_DATABASE_URL)('sessions (real Postgres)', () => {
  let testDb: TestDb;
  const db = () => testDb.db;

  beforeAll(async () => {
    testDb = await createTestDb();
    await runMigrations(testDb.url, { schema: testDb.schema });
  });
  afterAll(async () => {
    await testDb.drop();
  });

  describe('createSession', () => {
    it('stores only the hash of the token, never the token', async () => {
      const user = await insertUser(db());

      const { token } = await createSession(db(), user.id, T0);

      const rows = await db().query<{ token_hash: Buffer }>(
        'select token_hash from sessions where user_id = $1',
        [user.id],
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]?.token_hash.equals(hashSessionToken(token))).toBe(true);
      const dump = await db().query<{ found: boolean }>(
        "select exists (select 1 from sessions where encode(token_hash, 'escape') like $1) as found",
        [`%${token}%`],
      );
      expect(dump.rows[0]?.found).toBe(false);
    });

    it('expires after the lifetime, counted from the supplied clock', async () => {
      const user = await insertUser(db());

      const { expiresAt } = await createSession(db(), user.id, T0);

      expect(expiresAt.getTime()).toBe(T0.getTime() + SESSION_TTL_MS);
    });

    it('gives each session a distinct token, even for the same user', async () => {
      const user = await insertUser(db());

      const first = await createSession(db(), user.id, T0);
      const second = await createSession(db(), user.id, T0);

      expect(first.token).not.toBe(second.token);
    });

    it('refuses a session for a user that does not exist', async () => {
      await expect(
        createSession(db(), '00000000-0000-4000-8000-000000000000', T0),
      ).rejects.toMatchObject({ code: '23503' });
    });
  });

  describe('resolveSession', () => {
    it("returns the session's user", async () => {
      const user = await insertUser(db(), { name: 'Pat Lee', timeZone: 'America/New_York' });
      const { token } = await createSession(db(), user.id, T0);

      const resolved = await resolveSession(db(), token, at(5 * 60 * 1000));

      expect(resolved).toMatchObject({
        renewed: false,
        user: {
          id: user.id,
          email: user.email,
          name: 'Pat Lee',
          pictureUrl: null,
          timeZone: 'America/New_York',
          isDemo: false,
        },
      });
    });

    it('reports a demo user as demo', async () => {
      const user = await insertUser(db(), { isDemo: true });
      const { token } = await createSession(db(), user.id, T0);

      expect((await resolveSession(db(), token, T0))?.user.isDemo).toBe(true);
    });

    it('returns null for a well-formed token that was never issued', async () => {
      expect(await resolveSession(db(), generateSessionToken(), T0)).toBeNull();
    });

    it('does not mix up two users', async () => {
      const first = await insertUser(db());
      const second = await insertUser(db());
      const a = await createSession(db(), first.id, T0);
      const b = await createSession(db(), second.id, T0);

      expect((await resolveSession(db(), a.token, T0))?.user.id).toBe(first.id);
      expect((await resolveSession(db(), b.token, T0))?.user.id).toBe(second.id);
    });

    it('stops working at the exact instant it expires', async () => {
      // One session per probe: resolving a session near its end legitimately renews it
      // (see "sliding renewal"), which would change the answer for the next probe.
      const user = await insertUser(db());
      const probe = async (offsetFromExpiryMs: number) => {
        const { token, expiresAt } = await createSession(db(), user.id, T0);
        return resolveSession(db(), token, new Date(expiresAt.getTime() + offsetFromExpiryMs));
      };

      expect(await probe(-1)).not.toBeNull(); // one millisecond before: still valid
      expect(await probe(0)).toBeNull(); // the instant it expires: gone
      expect(await probe(DAY)).toBeNull();
    });

    it('renews a session used at the last moment, so an active user is not cut off', async () => {
      const user = await insertUser(db());
      const { token, expiresAt } = await createSession(db(), user.id, T0);
      const lastMoment = new Date(expiresAt.getTime() - 1);

      const resolved = await resolveSession(db(), token, lastMoment);

      expect(resolved?.renewed).toBe(true);
      expect(resolved?.expiresAt.getTime()).toBe(lastMoment.getTime() + SESSION_TTL_MS);
      expect(await resolveSession(db(), token, expiresAt)).not.toBeNull();
    });

    it('stops working once deleted', async () => {
      const user = await insertUser(db());
      const { token } = await createSession(db(), user.id, T0);

      expect(await deleteSession(db(), token)).toBe(true);

      expect(await resolveSession(db(), token, T0)).toBeNull();
    });
  });

  describe('sliding renewal', () => {
    it('does not write on reads within the hour', async () => {
      const user = await insertUser(db());
      const { token } = await createSession(db(), user.id, T0);

      const resolved = await resolveSession(db(), token, at(SESSION_RENEW_AFTER_MS - 1));

      expect(resolved?.renewed).toBe(false);
      const row = await db().query<{ last_seen_at: Date }>(
        'select last_seen_at from sessions where user_id = $1',
        [user.id],
      );
      expect(row.rows[0]?.last_seen_at.toISOString()).toBe(T0.toISOString());
    });

    it('extends the session once an hour has passed, and reports it so the cookie can be refreshed', async () => {
      const user = await insertUser(db());
      const { token } = await createSession(db(), user.id, T0);
      const later = at(SESSION_RENEW_AFTER_MS);

      const resolved = await resolveSession(db(), token, later);

      expect(resolved?.renewed).toBe(true);
      expect(resolved?.expiresAt.getTime()).toBe(later.getTime() + SESSION_TTL_MS);
      const row = await db().query<{ last_seen_at: Date; expires_at: Date }>(
        'select last_seen_at, expires_at from sessions where user_id = $1',
        [user.id],
      );
      expect(row.rows[0]?.last_seen_at.toISOString()).toBe(later.toISOString());
      expect(row.rows[0]?.expires_at.getTime()).toBe(later.getTime() + SESSION_TTL_MS);
    });

    it('then leaves it alone for another hour', async () => {
      const user = await insertUser(db());
      const { token } = await createSession(db(), user.id, T0);
      await resolveSession(db(), token, at(HOUR));

      const again = await resolveSession(db(), token, at(HOUR + 30 * 60 * 1000));
      const afterAnother = await resolveSession(db(), token, at(2 * HOUR));

      expect(again?.renewed).toBe(false);
      expect(afterAnother?.renewed).toBe(true);
    });

    it('keeps an active user signed in far beyond one lifetime', async () => {
      const user = await insertUser(db());
      const { token } = await createSession(db(), user.id, T0);

      for (let day = 1; day <= 90; day += 10) {
        expect(await resolveSession(db(), token, at(day * DAY))).not.toBeNull();
      }
    });

    it('signs out someone who stays away for the whole lifetime', async () => {
      const user = await insertUser(db());
      const { token } = await createSession(db(), user.id, T0);

      expect(await resolveSession(db(), token, at(SESSION_TTL_MS + 1))).toBeNull();
    });

    it('renews exactly once when many requests arrive together', async () => {
      const user = await insertUser(db());
      const { token } = await createSession(db(), user.id, T0);
      const later = at(3 * HOUR);

      const results = await Promise.all(
        Array.from({ length: 12 }, () => resolveSession(db(), token, later)),
      );

      expect(results.every((result) => result !== null)).toBe(true);
      expect(results.filter((result) => result?.renewed).length).toBe(1);
    });
  });

  describe('deleting sessions', () => {
    it("logs out one session without touching the same user's others", async () => {
      const user = await insertUser(db());
      const first = await createSession(db(), user.id, T0);
      const second = await createSession(db(), user.id, T0);

      expect(await deleteSession(db(), first.token)).toBe(true);
      expect(await deleteSession(db(), first.token)).toBe(false);

      expect(await resolveSession(db(), second.token, T0)).not.toBeNull();
    });

    it('signs a user out everywhere without affecting anyone else', async () => {
      const user = await insertUser(db());
      const bystander = await insertUser(db());
      await createSession(db(), user.id, T0);
      await createSession(db(), user.id, T0);
      const kept = await createSession(db(), bystander.id, T0);

      expect(await deleteSessionsForUser(db(), user.id)).toBe(2);

      expect(await resolveSession(db(), kept.token, T0)).not.toBeNull();
    });

    it('cleans up only the expired sessions', async () => {
      const user = await insertUser(db());
      const expired = await createSession(db(), user.id, T0, DAY);
      const live = await createSession(db(), user.id, T0, 10 * DAY);
      const now = at(2 * DAY);

      const removed = await deleteExpiredSessions(db(), now);

      expect(removed).toBeGreaterThanOrEqual(1);
      expect(await resolveSession(db(), expired.token, at(DAY - 1))).toBeNull();
      expect(await resolveSession(db(), live.token, now)).not.toBeNull();
    });

    it('removes sessions when their user is deleted', async () => {
      const user = await insertUser(db());
      const { token } = await createSession(db(), user.id, T0);

      await db().query('delete from users where id = $1', [user.id]);

      expect(await resolveSession(db(), token, T0)).toBeNull();
    });
  });
});
