import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth/cookies';
import type { GoogleProvider } from '../auth/google';
import { FetchError, type PageFetcher } from '../postings/fetchPage';
import type { EmailClassifier } from '../import/classify';
import type { ResumeAnalyzer } from '../resume/analyze';
import type { GmailClient } from '../import/gmail';
import type { GmailAuthorizer } from '../import/gmailAuth';
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
export interface TestAppOptions {
  env?: Record<string, string | undefined>;
  /** Posting fetcher; the default fails like an unreachable site, so no test touches the network. */
  fetchPage?: PageFetcher;
  /** Google sign-in stub (defaults to none: Google not configured). */
  google?: GoogleProvider | null;
  /** Gmail import stubs (default: not configured). */
  gmailAuthorizer?: GmailAuthorizer | null;
  gmail?: GmailClient;
  classifier?: EmailClassifier | null;
  /** Resume analyzer stub (default: not configured). */
  resumeAnalyzer?: ResumeAnalyzer | null;
  /** Add extra routes (a probe) before the app starts. */
  configure?: (app: FastifyInstance) => void;
}

export async function createTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const testDb = await createTestDb();
  await runMigrations(testDb.url, { schema: testDb.schema });
  const clock = mutableClock();
  // Every API test is also a contract test: each response is checked against its route's declaration.
  const app = buildApp({
    db: testDb.db,
    clock,
    env: options.env ?? {},
    google: options.google ?? null,
    fetchPage:
      options.fetchPage ??
      (() => Promise.reject(new FetchError('network', 'tests never reach the network'))),
    gmailAuthorizer: options.gmailAuthorizer ?? null,
    ...(options.gmail ? { gmail: options.gmail } : {}),
    classifier: options.classifier ?? null,
    resumeAnalyzer: options.resumeAnalyzer ?? null,
    validateResponses: true,
  });
  options.configure?.(app);
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
