import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth/cookies';
import { createSession } from '../auth/sessions';
import type { Clock } from '../clock';
import { runMigrations } from '../db/migrate';
import type { Db } from '../db/types';
import { insertUser, type UserFixture } from './factories';
import { createTestDb, type TestDb } from './testDb';

export const T0 = new Date('2026-11-05T12:00:00Z');

/** A clock the test moves by hand. */
export interface MutableClock extends Clock {
  set(instant: Date): void;
  advance(ms: number): void;
}

export function mutableClock(start: Date = T0): MutableClock {
  let current = start.getTime();
  return {
    now: () => new Date(current),
    set: (instant) => {
      current = instant.getTime();
    },
    advance: (ms) => {
      current += ms;
    },
  };
}

export interface TestApp {
  app: FastifyInstance;
  db: Db;
  clock: MutableClock;
  testDb: TestDb;
  /** A signed-in user: a real session row and the Cookie header that carries it. */
  login(
    overrides?: Parameters<typeof insertUser>[1],
  ): Promise<{ user: UserFixture; token: string; cookie: string }>;
  close(): Promise<void>;
}

/** The real app on a fresh, fully migrated schema. */
export async function createTestApp(
  options: { env?: Record<string, string | undefined> } = {},
): Promise<TestApp> {
  const testDb = await createTestDb();
  await runMigrations(testDb.url, { schema: testDb.schema });
  const clock = mutableClock();
  const app = buildApp({ db: testDb.db, clock, env: options.env ?? {} });
  await app.ready();

  return {
    app,
    db: testDb.db,
    clock,
    testDb,
    async login(overrides) {
      const user = await insertUser(testDb.db, overrides);
      const { token } = await createSession(testDb.db, user.id, clock.now());
      return { user, token, cookie: `${SESSION_COOKIE}=${token}` };
    },
    async close() {
      await app.close();
      await testDb.drop();
    },
  };
}

/** Headers a same-origin browser fetch carries. */
export const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin' } as const;

/** Every Set-Cookie header on a response, as an array (Fastify gives a string for one). */
export function setCookies(response: LightMyRequestResponse): string[] {
  const value = response.headers['set-cookie'];
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/** The token value from a response's session Set-Cookie, or null. */
export function sessionTokenFrom(response: LightMyRequestResponse): string | null {
  const header = setCookies(response).find((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`));
  const value = header?.split(';')[0]?.slice(SESSION_COOKIE.length + 1);
  return value ? value : null;
}
