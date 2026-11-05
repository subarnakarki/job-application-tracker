import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createDb } from '../db/connection';
import type { Db } from '../db/types';

/** Set by CI and by anyone running Postgres locally (see docker-compose.yml). */
export const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];

export interface TestDb {
  db: Db;
  /** Unique schema this test owns. Parallel test files never see each other's tables. */
  schema: string;
  url: string;
  /** Drops the schema and closes the connections. */
  drop(): Promise<void>;
}

/**
 * A fresh, isolated schema on the test database. Migrations run into it
 * (`runMigrations(url, { schema })`) and the returned `db` is pinned to it.
 */
export async function createTestDb(): Promise<TestDb> {
  if (!TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is not set');
  const url = TEST_DATABASE_URL;
  const schema = `t_${randomBytes(6).toString('hex')}`;

  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  try {
    await admin.query(`create schema ${schema}`);
  } finally {
    await admin.end();
  }

  const db = createDb(url, { max: 4, searchPath: schema });
  return {
    db,
    schema,
    url,
    async drop() {
      await db.end();
      const cleaner = new pg.Client({ connectionString: url });
      await cleaner.connect();
      try {
        await cleaner.query(`drop schema if exists ${schema} cascade`);
      } finally {
        await cleaner.end();
      }
    },
  };
}
