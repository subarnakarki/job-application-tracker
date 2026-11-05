import { SOURCES, STATUSES, summarizeBySource, type Status, type StatsSubject } from '@jat/shared';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../db/migrate';
import { insertUser } from '../test/factories';
import { createTestDb, TEST_DATABASE_URL, type TestDb } from '../test/testDb';
import { statsBySource } from './stats';

/** A status path with no repeated neighbours (history never records a same-status move). */
function path(statuses: Status[]): Status[] {
  return statuses.filter((status, index) => index === 0 || status !== statuses[index - 1]);
}

describe.skipIf(!TEST_DATABASE_URL)('stats: SQL and TypeScript agree (real Postgres)', () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await createTestDb();
    await runMigrations(testDb.url, { schema: testDb.schema });
  });
  afterAll(async () => {
    await testDb.drop();
  });

  async function insertApplications(userId: string, subjects: StatsSubject[]): Promise<void> {
    for (const subject of subjects) {
      const current = subject.statuses.at(-1) ?? 'Saved';
      const inserted = await testDb.db.query<{ id: string }>(
        `insert into applications (user_id, company, role, status, source)
         values ($1, 'Acme', 'Engineer', $2, $3) returning id`,
        [userId, current, subject.source],
      );
      const id = inserted.rows[0]?.id;
      let from: Status | null = null;
      for (const to of subject.statuses) {
        await testDb.db.query(
          `insert into status_history (application_id, from_status, to_status) values ($1, $2, $3)`,
          [id, from, to],
        );
        from = to;
      }
    }
  }

  it('matches summarizeBySource on random histories', async () => {
    const subject = fc.record({
      source: fc.constantFrom(...SOURCES),
      statuses: fc
        .array(fc.constantFrom(...STATUSES), { minLength: 1, maxLength: 5 })
        .map((list) => path(list)),
    });
    await fc.assert(
      fc.asyncProperty(fc.array(subject, { maxLength: 12 }), async (subjects) => {
        const user = await insertUser(testDb.db);
        await insertApplications(user.id, subjects);

        expect(await statsBySource(testDb.db, { userId: user.id })).toEqual(
          summarizeBySource(subjects),
        );
      }),
      { numRuns: 40 },
    );
  });

  it("counts only the owner's applications", async () => {
    const owner = await insertUser(testDb.db);
    const other = await insertUser(testDb.db);
    await insertApplications(owner.id, [{ source: 'Referral', statuses: ['Applied'] }]);
    await insertApplications(other.id, [{ source: 'Referral', statuses: ['Applied', 'Offer'] }]);

    const stats = await statsBySource(testDb.db, { userId: owner.id });

    expect(stats.totals).toMatchObject({ total: 1, applied: 1, offers: 0 });
  });
});
