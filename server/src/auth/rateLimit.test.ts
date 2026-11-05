import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../db/migrate';
import { createTestDb, TEST_DATABASE_URL, type TestDb } from '../test/testDb';
import {
  consumeRateLimit,
  deleteExpiredRateLimits,
  rateLimitKey,
  type RateLimitRule,
} from './rateLimit';

const HOUR = 60 * 60 * 1000;
const RULE: RateLimitRule = { name: 'demo-login', limit: 3, windowMs: HOUR };
const T0 = new Date('2026-11-05T12:00:00Z'); // exactly on an hour boundary
const at = (ms: number) => new Date(T0.getTime() + ms);

describe('rateLimitKey', () => {
  it('joins name and subject', () => {
    expect(rateLimitKey('demo-login', '203.0.113.7')).toBe('demo-login:203.0.113.7');
  });

  it('keeps a long subject inside the column limit by hashing it, deterministically', () => {
    const long = 'x'.repeat(5000);

    const key = rateLimitKey('demo-login', long);

    expect(key.length).toBeLessThanOrEqual(200);
    expect(key).toBe(rateLimitKey('demo-login', long));
    expect(key).not.toContain('xxxxx');
  });

  it('gives different subjects different keys, even when they are long', () => {
    expect(rateLimitKey('a', 'y'.repeat(300))).not.toBe(rateLimitKey('a', `${'y'.repeat(299)}z`));
    expect(rateLimitKey('a', 'same')).not.toBe(rateLimitKey('b', 'same'));
  });

  it('always fits (property)', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 20 }), fc.string({ maxLength: 1000 }), (name, subject) => {
        expect(rateLimitKey(name, subject).length).toBeLessThanOrEqual(200 + name.length);
      }),
    );
  });
});

describe.skipIf(!TEST_DATABASE_URL)('consumeRateLimit (real Postgres)', () => {
  let testDb: TestDb;
  const db = () => testDb.db;
  let counter = 0;
  const freshKey = () => `test:${(counter += 1)}:${Math.random()}`;

  beforeAll(async () => {
    testDb = await createTestDb();
    await runMigrations(testDb.url, { schema: testDb.schema });
  });
  afterAll(async () => {
    await testDb.drop();
  });

  it('allows the limit and denies the next attempt, counting down', async () => {
    const key = freshKey();

    const results = [];
    for (let attempt = 0; attempt < 5; attempt += 1)
      results.push(await consumeRateLimit(db(), key, RULE, T0));

    expect(results.map((result) => result.allowed)).toEqual([true, true, true, false, false]);
    expect(results.map((result) => result.remaining)).toEqual([2, 1, 0, 0, 0]);
  });

  it('starts over in the next window', async () => {
    const key = freshKey();
    for (let attempt = 0; attempt < 4; attempt += 1) await consumeRateLimit(db(), key, RULE, T0);

    const sameWindow = await consumeRateLimit(db(), key, RULE, at(HOUR - 1));
    const nextWindow = await consumeRateLimit(db(), key, RULE, at(HOUR));

    expect(sameWindow.allowed).toBe(false);
    expect(nextWindow).toMatchObject({ allowed: true, remaining: 2 });
  });

  it('keeps keys and rule names independent', async () => {
    const first = freshKey();
    const second = freshKey();
    for (let attempt = 0; attempt < 4; attempt += 1) await consumeRateLimit(db(), first, RULE, T0);

    expect((await consumeRateLimit(db(), second, RULE, T0)).allowed).toBe(true);
    expect((await consumeRateLimit(db(), first, { ...RULE, name: 'other' }, T0)).allowed).toBe(
      false,
    ); // same key string
  });

  it('reports how long until the window ends', async () => {
    const key = freshKey();

    expect((await consumeRateLimit(db(), key, RULE, T0)).retryAfterSeconds).toBe(3600);
    expect((await consumeRateLimit(db(), key, RULE, at(30 * 60 * 1000))).retryAfterSeconds).toBe(
      1800,
    );
    expect((await consumeRateLimit(db(), key, RULE, at(HOUR - 1))).retryAfterSeconds).toBe(1);
    expect((await consumeRateLimit(db(), key, RULE, at(HOUR - 1500))).retryAfterSeconds).toBe(2);
  });

  it('lets exactly the limit through when many requests arrive at once', async () => {
    const key = freshKey();
    const rule = { ...RULE, limit: 10 };

    const results = await Promise.all(
      Array.from({ length: 40 }, () => consumeRateLimit(db(), key, rule, T0)),
    );

    expect(results.filter((result) => result.allowed)).toHaveLength(10);
    expect(results.filter((result) => !result.allowed)).toHaveLength(30);
  });

  it('uses the window containing "now" for any instant (property)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.date({
          min: new Date('2026-01-01T00:00:00Z'),
          max: new Date('2030-01-01T00:00:00Z'),
          noInvalidDate: true,
        }),
        fc.constantFrom(1000, 60_000, HOUR, 24 * HOUR),
        async (now, windowMs) => {
          const key = freshKey();
          const first = await consumeRateLimit(db(), key, { name: 'p', limit: 1, windowMs }, now);
          const second = await consumeRateLimit(db(), key, { name: 'p', limit: 1, windowMs }, now);

          expect(first.allowed).toBe(true);
          expect(second.allowed).toBe(false);
          expect(first.retryAfterSeconds).toBeGreaterThanOrEqual(1);
          expect(first.retryAfterSeconds).toBeLessThanOrEqual(windowMs / 1000);
        },
      ),
      { numRuns: 60 },
    );
  });

  it('rejects a nonsensical rule instead of silently allowing everything', async () => {
    const key = freshKey();

    await expect(consumeRateLimit(db(), key, { ...RULE, limit: 0 }, T0)).rejects.toThrow(
      RangeError,
    );
    await expect(consumeRateLimit(db(), key, { ...RULE, limit: 1.5 }, T0)).rejects.toThrow(
      RangeError,
    );
    await expect(consumeRateLimit(db(), key, { ...RULE, windowMs: 10 }, T0)).rejects.toThrow(
      RangeError,
    );
  });

  it('cleans up old windows and keeps recent ones', async () => {
    const oldKey = freshKey();
    const recentKey = freshKey();
    await consumeRateLimit(db(), oldKey, RULE, at(-3 * 24 * HOUR));
    await consumeRateLimit(db(), recentKey, RULE, at(-1 * HOUR));

    const removed = await deleteExpiredRateLimits(db(), T0);

    expect(removed).toBeGreaterThanOrEqual(1);
    const remaining = await db().query('select 1 from rate_limits where key = any($1::text[])', [
      [oldKey, recentKey],
    ]);
    expect(remaining.rowCount).toBe(1);
  });
});
