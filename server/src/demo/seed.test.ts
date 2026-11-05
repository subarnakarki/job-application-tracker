import { LIMITS, SOURCES } from '@jat/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findOrCreateDemoUser } from '../auth/users';
import { runMigrations } from '../db/migrate';
import { listApplications } from '../repo/applications';
import { statsBySource } from '../repo/stats';
import { T0 } from '../test/app';
import { insertUser } from '../test/factories';
import { createTestDb, TEST_DATABASE_URL, type TestDb } from '../test/testDb';
import { DEMO_SAMPLES, seedDemoData } from './seed';

describe.skipIf(!TEST_DATABASE_URL)('demo seed (real Postgres)', () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await createTestDb();
    await runMigrations(testDb.url, { schema: testDb.schema });
  });
  afterAll(async () => {
    await testDb.drop();
  });

  const demoOwner = async () => {
    const demo = await findOrCreateDemoUser(testDb.db);
    return { userId: demo.id, isDemo: true, timeZone: 'UTC' };
  };

  it('replaces the demo data with a full, current-looking pipeline, as often as it runs', async () => {
    const owner = await demoOwner();
    await seedDemoData(testDb.db, owner.userId, T0);
    await seedDemoData(testDb.db, owner.userId, T0);

    const list = await listApplications(testDb.db, owner, { sort: 'updated_desc' }, T0);
    const statuses = new Set(list.map((app) => app.status));
    const stats = await statsBySource(testDb.db, owner);

    expect(list).toHaveLength(DEMO_SAMPLES.length);
    expect(DEMO_SAMPLES.length).toBeLessThanOrEqual(LIMITS.applicationsPerDemoUser);
    expect(statuses.size).toBe(7); // every stage has something in it
    expect(stats.sources.every((row) => row.total > 0)).toBe(true);
    expect(SOURCES.length).toBe(stats.sources.length);
  });

  it('flags the quiet ones for follow-up, and keeps next steps in the future', async () => {
    const owner = await demoOwner();
    await seedDemoData(testDb.db, owner.userId, T0);

    const followUps = await listApplications(
      testDb.db,
      owner,
      { sort: 'updated_desc', followUp: true },
      T0,
    );
    const list = await listApplications(testDb.db, owner, { sort: 'updated_desc' }, T0);

    expect(followUps.map((app) => app.company).sort()).toEqual([
      'Kestrel Mobility',
      'Silverleaf Insurance',
    ]);
    for (const app of list) {
      if (app.nextStepDate) expect(app.nextStepDate > '2026-11-05').toBe(true);
    }
  });

  it('refuses any user but the demo, and leaves other users alone', async () => {
    const owner = await demoOwner();
    const someone = await insertUser(testDb.db);
    await testDb.db.query(
      "insert into applications (user_id, company, role) values ($1, 'Mine', 'SDET')",
      [someone.id],
    );

    await expect(seedDemoData(testDb.db, someone.id, T0)).rejects.toThrow(/not the demo/);
    await seedDemoData(testDb.db, owner.userId, T0);
    const theirs = await testDb.db.query('select company from applications where user_id = $1', [
      someone.id,
    ]);

    expect(theirs.rows).toEqual([{ company: 'Mine' }]);
  });
});
