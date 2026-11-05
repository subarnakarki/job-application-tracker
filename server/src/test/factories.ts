import type { Queryable } from '../db/types';

export interface UserFixture {
  id: string;
  email: string;
}

let counter = 0;

/** Inserts a user directly (tests that need a row without going through an API). */
export async function insertUser(
  db: Queryable,
  overrides: { email?: string; name?: string | null; timeZone?: string; isDemo?: boolean } = {},
): Promise<UserFixture> {
  counter += 1;
  const email = overrides.email ?? `user${counter}-${Date.now()}@example.com`;
  const result = await db.query<{ id: string }>(
    `insert into users (email, name, time_zone, is_demo) values ($1, $2, $3, $4) returning id`,
    [email, overrides.name ?? null, overrides.timeZone ?? 'UTC', overrides.isDemo ?? false],
  );
  return { id: result.rows[0]?.id ?? '', email };
}
