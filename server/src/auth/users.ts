import type { Db, Queryable } from '../db/types';
import type { SessionUser } from './sessions';

export const DEMO_PROVIDER = 'demo';
export const DEMO_SUBJECT = 'shared-demo';
export const DEMO_EMAIL = 'demo@jobtracker.invalid';

interface UserRow {
  id: string;
  email: string;
  name: string | null;
  picture_url: string | null;
  time_zone: string;
  is_demo: boolean;
}

const USER_COLUMNS = 'u.id, u.email, u.name, u.picture_url, u.time_zone, u.is_demo';

export function toSessionUser(row: UserRow): SessionUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    pictureUrl: row.picture_url,
    timeZone: row.time_zone,
    isDemo: row.is_demo,
  };
}

/**
 * The one shared demo account, created on first use. Two visitors arriving at
 * the same moment on a fresh database must not create two: an advisory lock
 * serialises the find-or-create.
 */
export async function findOrCreateDemoUser(db: Db): Promise<SessionUser> {
  return db.transaction(async (tx) => {
    await tx.query("select pg_advisory_xact_lock(hashtext('jat:demo-user'))");
    const existing = await tx.query<UserRow>(
      `select ${USER_COLUMNS}
         from identities i join users u on u.id = i.user_id
        where i.provider = $1 and i.subject = $2`,
      [DEMO_PROVIDER, DEMO_SUBJECT],
    );
    const found = existing.rows[0];
    if (found) return toSessionUser(found);

    const created = await tx.query<UserRow>(
      `insert into users (email, name, is_demo) values ($1, 'Demo', true)
       returning id, email, name, picture_url, time_zone, is_demo`,
      [DEMO_EMAIL],
    );
    const row = created.rows[0];
    if (!row) throw new Error('Demo user was not created');
    await tx.query('insert into identities (user_id, provider, subject) values ($1, $2, $3)', [
      row.id,
      DEMO_PROVIDER,
      DEMO_SUBJECT,
    ]);
    return toSessionUser(row);
  });
}

export async function updateTimeZone(
  db: Queryable,
  userId: string,
  timeZone: string,
): Promise<SessionUser | null> {
  const result = await db.query<UserRow>(
    `update users u set time_zone = $2 where u.id = $1
     returning ${USER_COLUMNS}`,
    [userId, timeZone],
  );
  const row = result.rows[0];
  return row ? toSessionUser(row) : null;
}
