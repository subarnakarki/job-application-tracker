import type { Queryable } from '../db/types';
import { generateSessionToken, hashSessionToken, isPlausibleToken } from './tokens';

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** A session is renewed (and its expiry pushed out) at most this often, so reads rarely write. */
export const SESSION_RENEW_AFTER_MS = 60 * 60 * 1000;

export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
  pictureUrl: string | null;
  timeZone: string;
  isDemo: boolean;
}

export interface CreatedSession {
  /** The raw token: shown once, to set the cookie. Only its hash is stored. */
  token: string;
  expiresAt: Date;
}

export interface ResolvedSession {
  sessionId: string;
  user: SessionUser;
  expiresAt: Date;
  /** True when this request extended the session, so the cookie should be refreshed. */
  renewed: boolean;
}

export async function createSession(
  db: Queryable,
  userId: string,
  now: Date,
  ttlMs: number = SESSION_TTL_MS,
): Promise<CreatedSession> {
  const token = generateSessionToken();
  const expiresAt = new Date(now.getTime() + ttlMs);
  await db.query(
    `insert into sessions (token_hash, user_id, created_at, last_seen_at, expires_at)
     values ($1, $2, $3, $3, $4)`,
    [hashSessionToken(token), userId, now, expiresAt],
  );
  return { token, expiresAt };
}

interface SessionRow {
  id: string;
  expires_at: Date;
  last_seen_at: Date;
  user_id: string;
  email: string;
  name: string | null;
  picture_url: string | null;
  time_zone: string;
  is_demo: boolean;
}

/**
 * Looks a token up and returns who it belongs to, or null if it is malformed,
 * unknown, deleted or expired. An expired session stops working at the exact
 * instant it expires. A valid session older than an hour since its last renewal
 * is extended; the update is conditional, so concurrent requests renew it once.
 */
export async function resolveSession(
  db: Queryable,
  token: string,
  now: Date,
): Promise<ResolvedSession | null> {
  if (!isPlausibleToken(token)) return null; // never send attacker-shaped input to the database

  const found = await db.query<SessionRow>(
    `select s.id, s.expires_at, s.last_seen_at,
            u.id as user_id, u.email, u.name, u.picture_url, u.time_zone, u.is_demo
       from sessions s
       join users u on u.id = s.user_id
      where s.token_hash = $1 and s.expires_at > $2`,
    [hashSessionToken(token), now],
  );
  const row = found.rows[0];
  if (!row) return null;

  let expiresAt = row.expires_at;
  let renewed = false;
  if (now.getTime() - row.last_seen_at.getTime() >= SESSION_RENEW_AFTER_MS) {
    const renewedExpiry = new Date(now.getTime() + SESSION_TTL_MS);
    const update = await db.query(
      `update sessions set last_seen_at = $2, expires_at = $3
        where id = $1 and last_seen_at <= $4`,
      [row.id, now, renewedExpiry, new Date(now.getTime() - SESSION_RENEW_AFTER_MS)],
    );
    if (update.rowCount > 0) {
      expiresAt = renewedExpiry;
      renewed = true;
    }
  }

  return {
    sessionId: row.id,
    expiresAt,
    renewed,
    user: {
      id: row.user_id,
      email: row.email,
      name: row.name,
      pictureUrl: row.picture_url,
      timeZone: row.time_zone,
      isDemo: row.is_demo,
    },
  };
}

/** Logout. True if a session was removed. */
export async function deleteSession(db: Queryable, token: string): Promise<boolean> {
  if (!isPlausibleToken(token)) return false;
  const result = await db.query('delete from sessions where token_hash = $1', [
    hashSessionToken(token),
  ]);
  return result.rowCount > 0;
}

/** "Sign out everywhere". Returns how many sessions were removed. */
export async function deleteSessionsForUser(db: Queryable, userId: string): Promise<number> {
  const result = await db.query('delete from sessions where user_id = $1', [userId]);
  return result.rowCount;
}

/** Housekeeping for the scheduled cleanup. */
export async function deleteExpiredSessions(db: Queryable, now: Date): Promise<number> {
  const result = await db.query('delete from sessions where expires_at <= $1', [now]);
  return result.rowCount;
}
