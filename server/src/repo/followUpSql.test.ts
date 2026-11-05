import {
  needsFollowUp,
  STATUSES,
  type FollowUpContext,
  type FollowUpSubject,
  type Status,
} from '@jat/shared';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../db/migrate';
import { createTestDb, TEST_DATABASE_URL, type TestDb } from '../test/testDb';
import { followUpPredicate } from './followUpSql';

describe('followUpPredicate (parameter numbering)', () => {
  it('numbers its four parameters from the requested start', () => {
    const fragment = followUpPredicate(
      { now: '2026-11-05T15:00:00Z', timeZone: 'America/New_York' },
      3,
    );

    expect(fragment.params).toHaveLength(4);
    expect(fragment.params).toEqual([
      ['Applied', 'Screening', 'Interviewing'],
      'America/New_York',
      '2026-10-29',
      '2026-11-05',
    ]);
    expect(fragment.sql).toContain('$3::text[]');
    expect(fragment.sql).toContain('$6::date');
    expect(fragment.sql).not.toContain('$1');
  });

  it('never interpolates user data into the SQL text', () => {
    const fragment = followUpPredicate({ now: '2026-11-05T15:00:00Z', timeZone: 'UTC' });

    expect(fragment.sql).not.toMatch(/UTC|2026|Applied/);
  });
});

describe.skipIf(!TEST_DATABASE_URL)('follow-up: SQL and TypeScript agree (real Postgres)', () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await createTestDb();
    await runMigrations(testDb.url, { schema: testDb.schema });
  });
  afterAll(async () => {
    await testDb.drop();
  });

  /** Evaluates the SQL predicate on one synthetic row. */
  async function sqlSays(subject: FollowUpSubject, context: FollowUpContext): Promise<boolean> {
    const predicate = followUpPredicate(context, 1);
    const result = await testDb.db.query<{ flagged: boolean }>(
      `select ${predicate.sql} as flagged
         from (select $5::text as status, $6::timestamptz as last_activity_at, $7::date as next_step_date) a`,
      [
        ...predicate.params,
        subject.status,
        new Date(subject.lastActivityAt).toISOString(),
        subject.nextStepDate,
      ],
    );
    return result.rows[0]?.flagged ?? false;
  }

  const NOW = '2026-11-05T15:00:00Z';
  const UTC: FollowUpContext = { now: NOW, timeZone: 'UTC' };
  const applied = (overrides: Partial<FollowUpSubject> = {}): FollowUpSubject => ({
    status: 'Applied',
    lastActivityAt: '2026-10-01T10:00:00Z',
    nextStepDate: null,
    ...overrides,
  });

  describe('the documented truth table', () => {
    it.each(STATUSES.map((status) => [status] as const))('status %s', async (status) => {
      const subject = applied({ status });

      expect(await sqlSays(subject, UTC)).toBe(needsFollowUp(subject, UTC));
    });

    it.each([
      ['2026-10-30T00:00:00Z', false], // 6 days
      ['2026-10-30T23:59:59Z', false],
      ['2026-10-29T23:59:59Z', true], // 7 days
      ['2026-10-29T00:00:00Z', true],
      ['2026-10-28T12:00:00Z', true],
      ['2026-11-05T14:00:00Z', false],
      ['2026-11-06T09:00:00Z', false], // clock skew
    ])('last activity %s -> %s', async (lastActivityAt, expected) => {
      const subject = applied({ lastActivityAt });

      expect(await sqlSays(subject, UTC)).toBe(expected);
      expect(needsFollowUp(subject, UTC)).toBe(expected);
    });

    it.each([
      [null, true],
      ['2026-11-04', true],
      ['2026-11-05', false],
      ['2026-11-06', false],
    ])('next step %s -> %s', async (nextStepDate, expected) => {
      const subject = applied({ nextStepDate });

      expect(await sqlSays(subject, UTC)).toBe(expected);
      expect(needsFollowUp(subject, UTC)).toBe(expected);
    });
  });

  describe('time zones and daylight saving', () => {
    const zones = [
      'UTC',
      'America/New_York',
      'America/Los_Angeles',
      'America/Sao_Paulo',
      'Europe/London',
      'Europe/Berlin',
      'Asia/Kolkata',
      'Asia/Kathmandu', // +05:45
      'Australia/Lord_Howe', // +10:30 with a 30-minute DST shift
      'Pacific/Chatham', // +12:45
      'Pacific/Auckland',
      'Pacific/Kiritimati', // +14
      'Pacific/Pago_Pago', // -11
    ];

    it('agrees at the exact seconds around DST transitions', async () => {
      const instants = [
        '2026-03-08T06:59:59Z',
        '2026-03-08T07:00:00Z', // New York spring forward
        '2026-11-01T05:59:59Z',
        '2026-11-01T06:00:00Z', // New York fall back
        '2026-03-29T00:59:59Z',
        '2026-03-29T01:00:00Z', // London spring forward
        '2026-10-25T00:59:59Z',
        '2026-10-25T01:00:00Z', // London fall back
        '2026-04-04T14:59:59Z',
        '2026-04-04T15:30:00Z', // Lord Howe fall back (half hour)
        '2026-10-03T15:29:59Z',
        '2026-10-03T15:30:00Z', // Lord Howe spring forward
        '2026-09-26T13:44:59Z',
        '2026-09-26T13:45:00Z', // Chatham
      ];
      for (const zone of zones) {
        for (const lastActivityAt of instants) {
          for (const now of [
            '2026-03-15T12:00:00Z',
            '2026-11-08T12:00:00Z',
            '2026-04-11T12:00:00Z',
            '2026-10-10T12:00:00Z',
          ]) {
            const context = { now, timeZone: zone };
            const subject = applied({ lastActivityAt });

            expect(await sqlSays(subject, context), `${zone} ${lastActivityAt} -> ${now}`).toBe(
              needsFollowUp(subject, context),
            );
          }
        }
      }
    });

    it('agrees on random inputs (property, 600 runs)', async () => {
      const instant = fc.date({
        min: new Date('2023-06-01T00:00:00Z'),
        max: new Date('2030-06-01T00:00:00Z'),
        noInvalidDate: true,
      });
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom<Status>(...STATUSES),
          instant,
          instant,
          fc.constantFrom(...zones),
          fc.option(fc.integer({ min: -40, max: 40 }), { nil: null }),
          async (status, lastActivityAt, now, timeZone, nextStepOffset) => {
            const context = { now, timeZone };
            const nextStepDate =
              nextStepOffset === null
                ? null
                : new Date(now.getTime() + nextStepOffset * 86_400_000).toISOString().slice(0, 10);
            const subject: FollowUpSubject = { status, lastActivityAt, nextStepDate };

            expect(await sqlSays(subject, context)).toBe(needsFollowUp(subject, context));
          },
        ),
        { numRuns: 600 },
      );
    }, 60_000);
  });

  describe('against real table rows', () => {
    it('selects exactly the applications the TypeScript rule flags, for the right user only', async () => {
      const insertUser = async (email: string) =>
        (
          await testDb.db.query<{ id: string }>(
            'insert into users (email) values ($1) returning id',
            [email],
          )
        ).rows[0]?.id as string;
      const owner = await insertUser('owner@example.com');
      const other = await insertUser('other@example.com');
      const context: FollowUpContext = { now: NOW, timeZone: 'America/Los_Angeles' };

      const rows: { userId: string; subject: FollowUpSubject }[] = [];
      for (const userId of [owner, other]) {
        for (const status of STATUSES) {
          for (const lastActivityAt of [
            '2026-10-29T03:00:00Z',
            '2026-10-30T03:00:00Z',
            '2026-11-04T10:00:00Z',
          ]) {
            for (const nextStepDate of [null, '2026-11-04', '2026-11-05']) {
              rows.push({ userId, subject: { status, lastActivityAt, nextStepDate } });
            }
          }
        }
      }
      const ids = new Map<string, FollowUpSubject>();
      for (const { userId, subject } of rows) {
        const result = await testDb.db.query<{ id: string }>(
          `insert into applications (user_id, company, role, status, last_activity_at, next_step_date)
           values ($1, 'Acme', 'SDET', $2, $3, $4) returning id`,
          [userId, subject.status, subject.lastActivityAt, subject.nextStepDate],
        );
        ids.set(result.rows[0]?.id as string, subject);
      }

      const predicate = followUpPredicate(context, 2);
      const found = await testDb.db.query<{ id: string }>(
        `select a.id from applications a where a.user_id = $1 and ${predicate.sql}`,
        [owner, ...predicate.params],
      );

      const expected = rows.filter(
        ({ userId, subject }) => userId === owner && needsFollowUp(subject, context),
      ).length;
      expect(expected).toBeGreaterThan(0);
      expect(found.rowCount).toBe(expected);
      for (const row of found.rows) {
        const subject = ids.get(row.id) as FollowUpSubject;
        expect(needsFollowUp(subject, context)).toBe(true);
      }
      // Nothing belonging to the other user leaks into the result.
      const leaked = await testDb.db.query(
        `select 1 from applications a where a.user_id = $1 and a.id = any($2::uuid[])`,
        [other, found.rows.map((row) => row.id)],
      );
      expect(leaked.rowCount).toBe(0);
    });
  });
});
