import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixedClock } from '../clock';
import { runMigrations } from '../db/migrate';
import { insertUser } from '../test/factories';
import { createTestDb, TEST_DATABASE_URL, type TestDb } from '../test/testDb';
import { userClock } from './userClock';

const BASE = fixedClock('2026-11-05T12:00:00Z');

describe.skipIf(!TEST_DATABASE_URL)('userClock (real Postgres)', () => {
  let testDb: TestDb;
  const db = () => testDb.db;

  beforeAll(async () => {
    testDb = await createTestDb();
    await runMigrations(testDb.url, { schema: testDb.schema });
  });
  afterAll(async () => {
    await testDb.drop();
  });

  it('is the shared clock for a user with no test clock', async () => {
    const user = await insertUser(db());

    const clock = await userClock(db(), user.id, BASE);

    expect(clock.now().toISOString()).toBe('2026-11-05T12:00:00.000Z');
  });

  it('freezes time at the stored instant', async () => {
    const user = await insertUser(db());
    await db().query('insert into test_clocks (user_id, frozen_at) values ($1, $2)', [
      user.id,
      '2030-01-02T03:04:05Z',
    ]);

    const clock = await userClock(db(), user.id, BASE);

    expect(clock.now().toISOString()).toBe('2030-01-02T03:04:05.000Z');
    expect(clock.now().toISOString()).toBe('2030-01-02T03:04:05.000Z');
  });

  it('shifts the shared clock by the stored offset, forwards or backwards', async () => {
    const ahead = await insertUser(db());
    const behind = await insertUser(db());
    const day = 24 * 60 * 60 * 1000;
    await db().query('insert into test_clocks (user_id, offset_ms) values ($1, $2), ($3, $4)', [
      ahead.id,
      10 * day,
      behind.id,
      -3 * day,
    ]);

    expect((await userClock(db(), ahead.id, BASE)).now().toISOString()).toBe(
      '2026-11-15T12:00:00.000Z',
    );
    expect((await userClock(db(), behind.id, BASE)).now().toISOString()).toBe(
      '2026-11-02T12:00:00.000Z',
    );
  });

  it('keeps moving with the shared clock when only an offset is set', async () => {
    const user = await insertUser(db());
    await db().query('insert into test_clocks (user_id, offset_ms) values ($1, 1000)', [user.id]);
    let now = new Date('2026-01-01T00:00:00Z').getTime();
    const moving = { now: () => new Date(now) };

    const clock = await userClock(db(), user.id, moving);
    const first = clock.now().getTime();
    now += 5000;

    expect(clock.now().getTime() - first).toBe(5000);
  });

  it('prefers the frozen instant over an offset, and never leaks to another user', async () => {
    const frozen = await insertUser(db());
    const other = await insertUser(db());
    await db().query(
      "insert into test_clocks (user_id, frozen_at, offset_ms) values ($1, '2020-01-01T00:00:00Z', 99999)",
      [frozen.id],
    );

    expect((await userClock(db(), frozen.id, BASE)).now().toISOString()).toBe(
      '2020-01-01T00:00:00.000Z',
    );
    expect((await userClock(db(), other.id, BASE)).now().toISOString()).toBe(
      '2026-11-05T12:00:00.000Z',
    );
  });
});
