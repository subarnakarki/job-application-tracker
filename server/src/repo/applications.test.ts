import { ApplicationInputSchema, LIMITS, type ApplicationInput } from '@jat/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../db/migrate';
import { insertUser } from '../test/factories';
import { createTestDb, TEST_DATABASE_URL, type TestDb } from '../test/testDb';
import {
  createApplication,
  deleteApplication,
  deleteUser,
  getApplication,
  listAllWithHistory,
  updateApplication,
  type ApplicationWithHistory,
  type Owner,
} from './applications';

const T0 = new Date('2026-11-05T15:00:00Z');
const T1 = new Date('2026-11-06T09:00:00Z');
const input = (overrides: Partial<ApplicationInput> = {}): ApplicationInput =>
  ApplicationInputSchema.parse({ company: 'Acme', role: 'SDET', ...overrides });

describe.skipIf(!TEST_DATABASE_URL)('applications repository (real Postgres)', () => {
  let testDb: TestDb;
  const db = () => testDb.db;

  beforeAll(async () => {
    testDb = await createTestDb();
    await runMigrations(testDb.url, { schema: testDb.schema });
  });
  afterAll(async () => {
    await testDb.drop();
  });

  async function newOwner(overrides: { isDemo?: boolean; timeZone?: string } = {}): Promise<Owner> {
    const user = await insertUser(db(), overrides);
    return {
      userId: user.id,
      isDemo: overrides.isDemo ?? false,
      timeZone: overrides.timeZone ?? 'UTC',
    };
  }

  async function create(
    owner: Owner,
    overrides: Partial<ApplicationInput> = {},
    now = T0,
  ): Promise<ApplicationWithHistory> {
    const result = await createApplication(db(), owner, input(overrides), now);
    if (result.kind !== 'created') throw new Error(`expected created, got ${result.kind}`);
    return result.value;
  }

  describe('createApplication', () => {
    it('stores the input, stamps the three timestamps with "now", starts at version 1 and writes null -> status', async () => {
      const owner = await newOwner();

      const { record, history } = await create(owner, { status: 'Saved', notes: 'hello' });

      expect(record).toMatchObject({
        company: 'Acme',
        role: 'SDET',
        status: 'Saved',
        notes: 'hello',
        version: 1,
      });
      expect(
        [record.createdAt, record.updatedAt, record.lastActivityAt].map((date) =>
          date.toISOString(),
        ),
      ).toEqual([T0.toISOString(), T0.toISOString(), T0.toISOString()]);
      expect(
        history.map(({ fromStatus, toStatus, actor }) => ({ fromStatus, toStatus, actor })),
      ).toEqual([{ fromStatus: null, toStatus: 'Saved', actor: 'user' }]);
      expect(history[0]?.occurredAt.toISOString()).toBe(T0.toISOString());
    });

    it("fills dateApplied with today in the owner's zone when created as Applied or later", async () => {
      const utc = await newOwner({ timeZone: 'UTC' });
      const newYork = await newOwner({ timeZone: 'America/New_York' });
      const lateEvening = new Date('2026-11-06T02:00:00Z'); // still the 5th in New York

      expect((await create(utc, { status: 'Applied' }, lateEvening)).record.dateApplied).toBe(
        '2026-11-06',
      );
      expect((await create(newYork, { status: 'Applied' }, lateEvening)).record.dateApplied).toBe(
        '2026-11-05',
      );
      expect((await create(utc, { status: 'Interviewing' })).record.dateApplied).toBe('2026-11-05');
    });

    it('leaves dateApplied empty for Saved and Withdrawn, and never overwrites a given date', async () => {
      const owner = await newOwner();

      expect((await create(owner, { status: 'Saved' })).record.dateApplied).toBeNull();
      expect((await create(owner, { status: 'Withdrawn' })).record.dateApplied).toBeNull();
      expect(
        (await create(owner, { status: 'Applied', dateApplied: '2026-10-01' })).record.dateApplied,
      ).toBe('2026-10-01');
    });

    it('refuses the next application once the quota is reached, and writes nothing', async () => {
      const owner = await newOwner({ isDemo: true });
      await db().query(
        `insert into applications (user_id, company, role)
         select $1, 'Filler ' || n, 'Role' from generate_series(1, $2) as n`,
        [owner.userId, LIMITS.applicationsPerDemoUser],
      );

      const result = await createApplication(db(), owner, input(), T0);

      expect(result).toEqual({ kind: 'limit_reached', limit: LIMITS.applicationsPerDemoUser });
      const count = await db().query<{ n: number }>(
        'select count(*)::int as n from applications where user_id = $1',
        [owner.userId],
      );
      expect(count.rows[0]?.n).toBe(LIMITS.applicationsPerDemoUser);
    });

    it('uses the larger quota for a normal user', async () => {
      const owner = await newOwner();
      await db().query(
        `insert into applications (user_id, company, role)
         select $1, 'Filler ' || n, 'Role' from generate_series(1, $2) as n`,
        [owner.userId, LIMITS.applicationsPerDemoUser],
      );

      expect((await createApplication(db(), owner, input(), T0)).kind).toBe('created');
    });

    it('cannot be raced past the quota by simultaneous requests', async () => {
      const owner = await newOwner({ isDemo: true });
      const already = LIMITS.applicationsPerDemoUser - 5;
      await db().query(
        `insert into applications (user_id, company, role)
         select $1, 'Filler ' || n, 'Role' from generate_series(1, $2) as n`,
        [owner.userId, already],
      );

      const results = await Promise.all(
        Array.from({ length: 20 }, () => createApplication(db(), owner, input(), T0)),
      );

      expect(results.filter((result) => result.kind === 'created')).toHaveLength(5);
      const count = await db().query<{ n: number }>(
        'select count(*)::int as n from applications where user_id = $1',
        [owner.userId],
      );
      expect(count.rows[0]?.n).toBe(LIMITS.applicationsPerDemoUser);
    });

    it("does not count another user's applications against the quota", async () => {
      const busy = await newOwner({ isDemo: true });
      const fresh = await newOwner({ isDemo: true });
      await db().query(
        `insert into applications (user_id, company, role)
         select $1, 'Filler ' || n, 'Role' from generate_series(1, $2) as n`,
        [busy.userId, LIMITS.applicationsPerDemoUser],
      );

      expect((await createApplication(db(), fresh, input(), T0)).kind).toBe('created');
    });
  });

  describe('getApplication', () => {
    it('returns the application with its history in order', async () => {
      const owner = await newOwner();
      const { record } = await create(owner, { status: 'Saved' });
      await updateApplication(db(), owner, record.id, 1, { status: 'Applied' }, T1);

      const found = await getApplication(db(), owner.userId, record.id);

      expect(found?.history.map((entry) => `${entry.fromStatus}->${entry.toStatus}`)).toEqual([
        'null->Saved',
        'Saved->Applied',
      ]);
    });

    it("returns null for another user's application, exactly as for a missing one", async () => {
      const owner = await newOwner();
      const stranger = await newOwner();
      const { record } = await create(owner);

      expect(await getApplication(db(), stranger.userId, record.id)).toBeNull();
      expect(
        await getApplication(db(), owner.userId, '00000000-0000-4000-8000-000000000000'),
      ).toBeNull();
    });
  });

  describe('updateApplication', () => {
    it('applies a real edit: bumps the version, the audit time and the follow-up clock', async () => {
      const owner = await newOwner();
      const { record } = await create(owner);

      const result = await updateApplication(
        db(),
        owner,
        record.id,
        1,
        { notes: 'Called the recruiter' },
        T1,
      );

      expect(result.kind).toBe('updated');
      if (result.kind !== 'updated') return;
      expect(result.value.record).toMatchObject({ notes: 'Called the recruiter', version: 2 });
      expect(result.value.record.updatedAt.toISOString()).toBe(T1.toISOString());
      expect(result.value.record.lastActivityAt.toISOString()).toBe(T1.toISOString());
      expect(result.value.record.createdAt.toISOString()).toBe(T0.toISOString());
    });

    it('treats a save that changes nothing as a no-op: same version, follow-up clock untouched, no history', async () => {
      const owner = await newOwner();
      const { record } = await create(owner, { status: 'Applied', notes: 'n' });

      const result = await updateApplication(
        db(),
        owner,
        record.id,
        1,
        { status: 'Applied', notes: 'n', company: 'Acme' },
        T1,
      );

      expect(result.kind).toBe('unchanged');
      const stored = await getApplication(db(), owner.userId, record.id);
      expect(stored?.record.version).toBe(1);
      expect(stored?.record.lastActivityAt.toISOString()).toBe(T0.toISOString());
      expect(stored?.history).toHaveLength(1);
    });

    it('writes one history row for a status change and none for other edits', async () => {
      const owner = await newOwner();
      const { record } = await create(owner, { status: 'Applied' });

      await updateApplication(db(), owner, record.id, 1, { status: 'Screening' }, T1);
      await updateApplication(db(), owner, record.id, 2, { contact: 'Pat' }, T1);
      await updateApplication(db(), owner, record.id, 3, { status: 'Rejected' }, T1);
      await updateApplication(db(), owner, record.id, 4, { status: 'Interviewing' }, T1); // reopened

      const stored = await getApplication(db(), owner.userId, record.id);
      expect(stored?.history.map((entry) => `${entry.fromStatus}->${entry.toStatus}`)).toEqual([
        'null->Applied',
        'Applied->Screening',
        'Screening->Rejected',
        'Rejected->Interviewing',
      ]);
    });

    it('fills dateApplied on the first move to Applied, and a cleared date stays cleared', async () => {
      const owner = await newOwner({ timeZone: 'Asia/Kolkata' });
      const { record } = await create(owner, { status: 'Saved' });

      const applied = await updateApplication(db(), owner, record.id, 1, { status: 'Applied' }, T1);
      const cleared = await updateApplication(db(), owner, record.id, 2, { dateApplied: null }, T1);
      const moved = await updateApplication(
        db(),
        owner,
        record.id,
        3,
        { status: 'Interviewing' },
        T1,
      );

      expect(applied.kind === 'updated' && applied.value.record.dateApplied).toBe('2026-11-06');
      expect(cleared.kind === 'updated' && cleared.value.record.dateApplied).toBeNull();
      expect(moved.kind === 'updated' && moved.value.record.dateApplied).toBeNull();
    });

    it('clears a field with null and leaves absent fields alone', async () => {
      const owner = await newOwner();
      const { record } = await create(owner, { contact: 'Pat', nextStep: 'Call' });

      const result = await updateApplication(db(), owner, record.id, 1, { contact: null }, T1);

      expect(result.kind === 'updated' && result.value.record).toMatchObject({
        contact: null,
        nextStep: 'Call',
      });
    });

    it('checks salary rules against the stored values merged with the patch', async () => {
      const owner = await newOwner();
      const noCurrency = await create(owner);
      const withRange = await create(owner, {
        salaryMin: 100,
        salaryMax: 200,
        salaryCurrency: 'USD',
      });

      const missingCurrency = await updateApplication(
        db(),
        owner,
        noCurrency.record.id,
        1,
        { salaryMin: 90000 },
        T1,
      );
      const belowMinimum = await updateApplication(
        db(),
        owner,
        withRange.record.id,
        1,
        { salaryMax: 50 },
        T1,
      );
      const fine = await updateApplication(
        db(),
        owner,
        withRange.record.id,
        1,
        { salaryMax: 300 },
        T1,
      );

      expect(missingCurrency).toMatchObject({
        kind: 'invalid',
        issues: [{ path: 'salaryCurrency' }],
      });
      expect(belowMinimum).toMatchObject({ kind: 'invalid', issues: [{ path: 'salaryMax' }] });
      expect(fine.kind).toBe('updated');
      expect((await getApplication(db(), owner.userId, noCurrency.record.id))?.record.version).toBe(
        1,
      );
    });

    it('refuses a stale version and reports the current one, changing nothing', async () => {
      const owner = await newOwner();
      const { record } = await create(owner);
      await updateApplication(db(), owner, record.id, 1, { notes: 'first' }, T1);

      const stale = await updateApplication(db(), owner, record.id, 1, { notes: 'second' }, T1);

      expect(stale).toEqual({ kind: 'version_conflict', currentVersion: 2 });
      expect((await getApplication(db(), owner.userId, record.id))?.record.notes).toBe('first');
    });

    it('lets exactly one of two simultaneous edits of the same version win', async () => {
      const owner = await newOwner();
      const { record } = await create(owner);

      const results = await Promise.all([
        updateApplication(db(), owner, record.id, 1, { notes: 'tab A' }, T1),
        updateApplication(db(), owner, record.id, 1, { notes: 'tab B' }, T1),
      ]);

      expect(results.map((result) => result.kind).sort()).toEqual(['updated', 'version_conflict']);
      const stored = await getApplication(db(), owner.userId, record.id);
      expect(stored?.record.version).toBe(2);
    });

    it("cannot touch another user's application", async () => {
      const owner = await newOwner();
      const stranger = await newOwner();
      const { record } = await create(owner, { notes: 'mine' });

      const result = await updateApplication(db(), stranger, record.id, 1, { notes: 'hacked' }, T1);

      expect(result).toEqual({ kind: 'not_found' });
      expect((await getApplication(db(), owner.userId, record.id))?.record.notes).toBe('mine');
    });
  });

  describe('deleting', () => {
    it("deletes one's own application with its history, and not someone else's", async () => {
      const owner = await newOwner();
      const stranger = await newOwner();
      const { record } = await create(owner);

      expect(await deleteApplication(db(), stranger.userId, record.id)).toBe(false);
      expect(await getApplication(db(), owner.userId, record.id)).not.toBeNull();
      expect(await deleteApplication(db(), owner.userId, record.id)).toBe(true);
      expect(await deleteApplication(db(), owner.userId, record.id)).toBe(false);
      const history = await db().query('select 1 from status_history where application_id = $1', [
        record.id,
      ]);
      expect(history.rowCount).toBe(0);
    });

    it('deletes a whole account and everything in it, leaving others intact', async () => {
      const doomed = await newOwner();
      const bystander = await newOwner();
      await create(doomed);
      await create(doomed);
      const kept = await create(bystander);

      expect(await deleteUser(db(), doomed.userId)).toBe(true);

      expect(await listAllWithHistory(db(), doomed.userId)).toEqual([]);
      expect(await getApplication(db(), bystander.userId, kept.record.id)).not.toBeNull();
    });
  });

  describe('listAllWithHistory (export)', () => {
    it("returns every application of one user with its history, oldest first, and nobody else's", async () => {
      const owner = await newOwner();
      const stranger = await newOwner();
      const first = await create(owner, { company: 'First' }, T0);
      await create(owner, { company: 'Second' }, T1);
      await create(stranger, { company: 'Theirs' });
      await updateApplication(db(), owner, first.record.id, 1, { status: 'Applied' }, T1);

      const all = await listAllWithHistory(db(), owner.userId);

      expect(all.map((entry) => entry.record.company)).toEqual(['First', 'Second']);
      expect(all[0]?.history).toHaveLength(2);
      expect(all[1]?.history).toHaveLength(1);
    });
  });
});
