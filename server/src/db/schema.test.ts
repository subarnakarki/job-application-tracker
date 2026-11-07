import { SOURCES, STATUSES } from '@jat/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, TEST_DATABASE_URL, type TestDb } from '../test/testDb';
import { runMigrations } from './migrate';

interface PgError {
  code?: string;
  constraint?: string;
}

describe.skipIf(!TEST_DATABASE_URL)('schema (real Postgres, real migrations)', () => {
  let testDb: TestDb;
  const sql = (text: string, params: unknown[] = []) => testDb.db.query(text, params);

  beforeAll(async () => {
    testDb = await createTestDb();
    await runMigrations(testDb.url, { schema: testDb.schema });
  });
  afterAll(async () => {
    await testDb.drop();
  });

  async function insertUser(overrides: Record<string, unknown> = {}): Promise<string> {
    const values = { email: 'pat@example.com', ...overrides };
    const columns = Object.keys(values);
    const result = await sql(
      `insert into users (${columns.join(', ')}) values (${columns.map((_, index) => `$${index + 1}`).join(', ')}) returning id`,
      Object.values(values),
    );
    return (result.rows[0] as { id: string }).id;
  }

  async function insertApplication(
    userId: string,
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const values = { user_id: userId, company: 'Acme', role: 'SDET', ...overrides };
    const columns = Object.keys(values);
    const result = await sql(
      `insert into applications (${columns.join(', ')}) values (${columns.map((_, index) => `$${index + 1}`).join(', ')}) returning id`,
      Object.values(values),
    );
    return (result.rows[0] as { id: string }).id;
  }

  async function violation(promise: Promise<unknown>): Promise<PgError> {
    try {
      await promise;
    } catch (error) {
      return error as PgError;
    }
    throw new Error('Expected the database to reject this, but it was accepted');
  }

  describe('applications: defaults', () => {
    it('needs only a user, company and role, and fills the rest', async () => {
      const userId = await insertUser();
      const id = await insertApplication(userId);

      const { rows } = await sql('select * from applications where id = $1', [id]);
      const row = rows[0] as Record<string, unknown>;

      expect(row).toMatchObject({
        status: 'Saved',
        source: 'Other',
        notes: '',
        version: 1,
        date_applied: null,
        next_step_date: null,
        salary_min: null,
        job_link: null,
      });
      expect(row['created_at']).toBeInstanceOf(Date);
      expect(row['updated_at']).toBeInstanceOf(Date);
      expect(row['last_activity_at']).toBeInstanceOf(Date);
    });

    it('returns date columns as YYYY-MM-DD strings', async () => {
      const userId = await insertUser();
      const id = await insertApplication(userId, {
        date_applied: '2026-11-05',
        next_step_date: '2026-03-08',
      });

      const { rows } = await sql(
        'select date_applied, next_step_date from applications where id = $1',
        [id],
      );

      expect(rows[0]).toEqual({ date_applied: '2026-11-05', next_step_date: '2026-03-08' });
    });

    it('generates distinct ids', async () => {
      const userId = await insertUser();
      const ids = await Promise.all([
        insertApplication(userId),
        insertApplication(userId),
        insertApplication(userId),
      ]);

      expect(new Set(ids).size).toBe(3);
    });
  });

  describe('applications: constraints reject what zod would (last line of defence)', () => {
    it.each([
      ['blank company', { company: '   ' }, 'applications_company_check'],
      ['company over 200', { company: 'a'.repeat(201) }, 'applications_company_check'],
      ['blank role', { role: '' }, 'applications_role_check'],
      ['unknown status', { status: 'Hired' }, 'applications_status_check'],
      ['lower-case status', { status: 'applied' }, 'applications_status_check'],
      ['unknown source', { source: 'Glassdoor' }, 'applications_source_check'],
      [
        'negative minimum',
        { salary_min: -1, salary_currency: 'USD' },
        'applications_salary_min_check',
      ],
      [
        'negative maximum',
        { salary_max: -5, salary_currency: 'USD' },
        'applications_salary_max_check',
      ],
      [
        'maximum below minimum',
        { salary_min: 200, salary_max: 100, salary_currency: 'USD' },
        'applications_salary_order',
      ],
      ['amount without currency', { salary_min: 100 }, 'applications_salary_currency_required'],
      [
        'lower-case currency',
        { salary_min: 1, salary_currency: 'usd' },
        'applications_salary_currency_check',
      ],
      ['javascript: link', { job_link: 'javascript:alert(1)' }, 'applications_job_link_check'],
      ['ftp link', { job_link: 'ftp://files.example/x' }, 'applications_job_link_check'],
      ['link without a scheme', { job_link: 'example.com/job' }, 'applications_job_link_check'],
      [
        'link over 2000',
        { job_link: `https://a.example/${'x'.repeat(2000)}` },
        'applications_job_link_check',
      ],
      ['contact over 200', { contact: 'a'.repeat(201) }, 'applications_contact_check'],
      ['next step over 500', { next_step: 'a'.repeat(501) }, 'applications_next_step_check'],
      ['notes over 10000', { notes: 'a'.repeat(10_001) }, 'applications_notes_check'],
      ['version 0', { version: 0 }, 'applications_version_check'],
    ])('rejects %s', async (_label, overrides, constraint) => {
      const userId = await insertUser();

      const error = await violation(insertApplication(userId, overrides));

      expect(error).toMatchObject({ code: '23514', constraint });
    });

    it('accepts every real status and source, and the boundary values', async () => {
      const userId = await insertUser();
      for (const status of STATUSES) await insertApplication(userId, { status });
      for (const source of SOURCES) await insertApplication(userId, { source });
      await insertApplication(userId, { company: 'a'.repeat(200), notes: 'a'.repeat(10_000) });
      await insertApplication(userId, { salary_min: 5, salary_max: 5, salary_currency: 'EUR' });
      await insertApplication(userId, { salary_min: 90_000, salary_currency: 'USD' });
      await insertApplication(userId, { job_link: 'HTTPS://ACME.EXAMPLE/jobs?id=1#top' });
      await insertApplication(userId, { job_link: 'http://acme.example' });

      const count = await sql('select count(*)::int as n from applications where user_id = $1', [
        userId,
      ]);
      expect(count.rows[0]).toEqual({ n: STATUSES.length + SOURCES.length + 5 });
    });

    it('rejects an application for a user that does not exist', async () => {
      const error = await violation(insertApplication('00000000-0000-4000-8000-000000000000'));

      expect(error.code).toBe('23503');
    });
  });

  describe('the SQL lists cannot drift from the shared constants', () => {
    async function listedValues(constraint: string): Promise<string[]> {
      const { rows } = await sql(
        `select pg_get_constraintdef(c.oid) as definition
           from pg_constraint c
           join pg_namespace n on n.oid = c.connamespace
          where c.conname = $1 and n.nspname = current_schema()`,
        [constraint],
      );
      const definition = (rows[0] as { definition: string }).definition;
      return [...definition.matchAll(/'([^']+)'::text/g)].map((match) => match[1] ?? '').sort();
    }

    it.each([
      ['applications_status_check', STATUSES],
      ['status_history_from_check', STATUSES],
      ['status_history_to_check', STATUSES],
      ['applications_source_check', SOURCES],
    ])('%s lists exactly the shared values', async (constraint, expected) => {
      expect(await listedValues(constraint)).toEqual([...expected].sort());
    });
  });

  describe('status history', () => {
    async function applicationWithHistory() {
      const userId = await insertUser();
      const applicationId = await insertApplication(userId);
      return { userId, applicationId };
    }
    const insertHistory = (
      applicationId: string,
      from: string | null,
      to: string,
      actor = 'user',
    ) =>
      sql(
        'insert into status_history (application_id, from_status, to_status, actor) values ($1, $2, $3, $4)',
        [applicationId, from, to, actor],
      );

    it('records creation as null -> status and later moves', async () => {
      const { applicationId } = await applicationWithHistory();

      await insertHistory(applicationId, null, 'Saved');
      await insertHistory(applicationId, 'Saved', 'Applied');

      const { rows } = await sql(
        'select from_status, to_status, actor from status_history where application_id = $1 order by occurred_at, id',
        [applicationId],
      );
      expect(rows).toEqual([
        { from_status: null, to_status: 'Saved', actor: 'user' },
        { from_status: 'Saved', to_status: 'Applied', actor: 'user' },
      ]);
    });

    it('stores when it happened separately from when it was recorded', async () => {
      const { applicationId } = await applicationWithHistory();
      await sql(
        "insert into status_history (application_id, from_status, to_status, occurred_at, actor) values ($1, 'Saved', 'Applied', '2026-01-02T03:04:05Z', 'gmail')",
        [applicationId],
      );

      const { rows } = await sql(
        'select occurred_at, recorded_at from status_history where application_id = $1',
        [applicationId],
      );
      const row = rows[0] as { occurred_at: Date; recorded_at: Date };
      expect(row.occurred_at.toISOString()).toBe('2026-01-02T03:04:05.000Z');
      expect(row.recorded_at.getTime()).toBeGreaterThan(row.occurred_at.getTime());
    });

    it('refuses a row that keeps the same status', async () => {
      const { applicationId } = await applicationWithHistory();

      expect(await violation(insertHistory(applicationId, 'Applied', 'Applied'))).toMatchObject({
        code: '23514',
        constraint: 'status_history_changed',
      });
    });

    it.each([
      ['unknown to_status', null, 'Hired', 'user'],
      ['unknown from_status', 'Hired', 'Applied', 'user'],
      ['unknown actor', 'Saved', 'Applied', 'robot'],
    ])('refuses %s', async (_label, from, to, actor) => {
      const { applicationId } = await applicationWithHistory();

      expect((await violation(insertHistory(applicationId, from, to, actor))).code).toBe('23514');
    });

    it('refuses history for an application that does not exist', async () => {
      expect(
        (await violation(insertHistory('00000000-0000-4000-8000-000000000000', null, 'Saved')))
          .code,
      ).toBe('23503');
    });
  });

  describe('identities', () => {
    it('is unique per provider and subject, but the same subject may exist under another provider', async () => {
      const first = await insertUser();
      const second = await insertUser({ email: 'sam@example.com' });
      await sql(
        "insert into identities (user_id, provider, subject) values ($1, 'google', 'sub-1')",
        [first],
      );

      expect(
        (
          await violation(
            sql(
              "insert into identities (user_id, provider, subject) values ($1, 'google', 'sub-1')",
              [second],
            ),
          )
        ).code,
      ).toBe('23505');
      await sql(
        "insert into identities (user_id, provider, subject) values ($1, 'demo', 'sub-1')",
        [second],
      );
    });

    it('only allows synthetic test users to use the test provider with a test: subject', async () => {
      const userId = await insertUser();

      await sql(
        "insert into identities (user_id, provider, subject) values ($1, 'test', 'test:abc')",
        [userId],
      );
      expect(
        (
          await violation(
            sql(
              "insert into identities (user_id, provider, subject) values ($1, 'test', 'real-person')",
              [userId],
            ),
          )
        ).code,
      ).toBe('23514');
    });

    it('rejects an unknown provider', async () => {
      const userId = await insertUser();

      expect(
        (
          await violation(
            sql(
              "insert into identities (user_id, provider, subject) values ($1, 'facebook', 'x')",
              [userId],
            ),
          )
        ).code,
      ).toBe('23514');
    });
  });

  describe('users', () => {
    it('defaults to UTC, not demo', async () => {
      const id = await insertUser();

      const { rows } = await sql('select time_zone, is_demo from users where id = $1', [id]);
      expect(rows[0]).toEqual({ time_zone: 'UTC', is_demo: false });
    });

    it('accepts IANA names and rejects offsets and junk', async () => {
      await insertUser({ time_zone: 'America/New_York' });
      await insertUser({ time_zone: 'Etc/GMT+5' });
      for (const bad of ['+05:00', '-08:00', 'GMT+5', '', 'UTC; drop table users']) {
        expect((await violation(insertUser({ time_zone: bad }))).code, bad).toBe('23514');
      }
    });

    it('rejects an implausible email and a non-http picture url', async () => {
      expect((await violation(insertUser({ email: 'a' }))).code).toBe('23514');
      expect((await violation(insertUser({ picture_url: 'javascript:alert(1)' }))).code).toBe(
        '23514',
      );
    });
  });

  describe('sessions', () => {
    const insertSession = (userId: string, tokenHash: Buffer, expiresInDays = 7) =>
      sql(
        "insert into sessions (token_hash, user_id, expires_at) values ($1, $2, now() + ($3 || ' days')::interval)",
        [tokenHash, userId, String(expiresInDays)],
      );

    it('stores a 32-byte token hash, unique across sessions', async () => {
      const userId = await insertUser();
      const hash = Buffer.alloc(32, 7);

      await insertSession(userId, hash);

      expect((await violation(insertSession(userId, hash))).code).toBe('23505');
      expect((await violation(insertSession(userId, Buffer.alloc(31, 1)))).code).toBe('23514');
    });

    it('refuses a session that is already expired when created', async () => {
      const userId = await insertUser();

      expect((await violation(insertSession(userId, Buffer.alloc(32, 9), -1))).code).toBe('23514');
    });
  });

  describe('deleting data cascades, and only as far as it should', () => {
    it('deleting an application removes its history but not its owner or siblings', async () => {
      const userId = await insertUser();
      const doomed = await insertApplication(userId);
      const sibling = await insertApplication(userId);
      for (const id of [doomed, sibling]) {
        await sql(
          "insert into status_history (application_id, from_status, to_status) values ($1, null, 'Saved')",
          [id],
        );
      }

      await sql('delete from applications where id = $1', [doomed]);

      const history = await sql(
        'select application_id from status_history where application_id in ($1, $2)',
        [doomed, sibling],
      );
      expect(history.rows).toEqual([{ application_id: sibling }]);
      expect((await sql('select 1 from users where id = $1', [userId])).rowCount).toBe(1);
    });

    it('deleting a user removes identities, sessions, applications and history, and nobody else', async () => {
      const doomed = await insertUser({ email: 'doomed@example.com' });
      const bystander = await insertUser({ email: 'bystander@example.com' });
      const keep: string[] = [];
      for (const [owner, subject] of [
        [doomed, 'doomed-sub'],
        [bystander, 'bystander-sub'],
      ] as const) {
        const applicationId = await insertApplication(owner);
        if (owner === bystander) keep.push(applicationId);
        await sql(
          "insert into status_history (application_id, from_status, to_status) values ($1, null, 'Saved')",
          [applicationId],
        );
        await sql("insert into identities (user_id, provider, subject) values ($1, 'google', $2)", [
          owner,
          subject,
        ]);
        await sql(
          "insert into sessions (token_hash, user_id, expires_at) values ($1, $2, now() + interval '1 day')",
          [Buffer.alloc(32, owner === doomed ? 1 : 2), owner],
        );
      }

      await sql('delete from users where id = $1', [doomed]);

      const counts = await sql(
        `select (select count(*)::int from applications where user_id = $1) as doomed_apps,
                (select count(*)::int from identities where user_id = $1) as doomed_identities,
                (select count(*)::int from sessions where user_id = $1) as doomed_sessions,
                (select count(*)::int from applications where user_id = $2) as bystander_apps,
                (select count(*)::int from status_history where application_id = any($3::uuid[])) as bystander_history`,
        [doomed, bystander, keep],
      );
      expect(counts.rows[0]).toEqual({
        doomed_apps: 0,
        doomed_identities: 0,
        doomed_sessions: 0,
        bystander_apps: 1,
        bystander_history: 1,
      });
    });
  });

  describe('rate_limits (0002)', () => {
    const consume = (key: string, windowStart: string) =>
      sql(
        `insert into rate_limits (key, window_start, count) values ($1, $2, 1)
         on conflict (key, window_start) do update set count = rate_limits.count + 1
         returning count`,
        [key, windowStart],
      );

    it('counts hits per key and window with one atomic upsert', async () => {
      const first = await consume('demo:1.2.3.4', '2026-11-05T15:00:00Z');
      const second = await consume('demo:1.2.3.4', '2026-11-05T15:00:00Z');
      const nextWindow = await consume('demo:1.2.3.4', '2026-11-05T16:00:00Z');
      const otherKey = await consume('demo:5.6.7.8', '2026-11-05T15:00:00Z');

      expect(
        [first, second, nextWindow, otherKey].map(
          (result) => (result.rows[0] as { count: number }).count,
        ),
      ).toEqual([1, 2, 1, 1]);
    });

    it('refuses a zero count and an empty or oversized key', async () => {
      expect(
        (
          await violation(
            sql("insert into rate_limits (key, window_start, count) values ('k', now(), 0)"),
          )
        ).code,
      ).toBe('23514');
      expect(
        (
          await violation(
            sql("insert into rate_limits (key, window_start, count) values ('', now(), 1)"),
          )
        ).code,
      ).toBe('23514');
      expect(
        (
          await violation(
            sql('insert into rate_limits (key, window_start, count) values ($1, now(), 1)', [
              'k'.repeat(201),
            ]),
          )
        ).code,
      ).toBe('23514');
    });
  });

  describe('test_clocks (0002)', () => {
    it('holds one clock per user, defaults to no offset, and disappears with the user', async () => {
      const userId = await insertUser({ email: 'clock@example.com' });
      await sql('insert into test_clocks (user_id) values ($1)', [userId]);

      const { rows } = await sql(
        'select frozen_at, offset_ms::int as offset_ms from test_clocks where user_id = $1',
        [userId],
      );
      expect(rows[0]).toEqual({ frozen_at: null, offset_ms: 0 });
      expect(
        (await violation(sql('insert into test_clocks (user_id) values ($1)', [userId]))).code,
      ).toBe('23505');

      await sql('delete from users where id = $1', [userId]);
      expect((await sql('select 1 from test_clocks where user_id = $1', [userId])).rowCount).toBe(
        0,
      );
    });

    it('rejects a clock for a user that does not exist', async () => {
      expect(
        (
          await violation(
            sql('insert into test_clocks (user_id) values ($1)', [
              '00000000-0000-4000-8000-000000000000',
            ]),
          )
        ).code,
      ).toBe('23503');
    });
  });

  describe('status_history order (0003)', () => {
    it('keeps insertion order for rows written at the same instant', async () => {
      const userId = await insertUser({ email: 'order@example.com' });
      const applicationId = await insertApplication(userId);
      const moves: [string | null, string][] = [
        [null, 'Saved'],
        ['Saved', 'Applied'],
        ['Applied', 'Screening'],
        ['Screening', 'Rejected'],
        ['Rejected', 'Interviewing'],
      ];
      for (const [from, to] of moves) {
        await sql(
          "insert into status_history (application_id, from_status, to_status, occurred_at, recorded_at) values ($1, $2, $3, '2026-11-05T12:00:00Z', '2026-11-05T12:00:00Z')",
          [applicationId, from, to],
        );
      }

      const { rows } = await sql(
        'select to_status from status_history where application_id = $1 order by occurred_at, seq',
        [applicationId],
      );

      expect(rows.map((row) => (row as { to_status: string }).to_status)).toEqual(
        moves.map(([, to]) => to),
      );
    });

    it('does not let a client choose the sequence', async () => {
      const userId = await insertUser({ email: 'seq@example.com' });
      const applicationId = await insertApplication(userId);

      expect(
        (
          await violation(
            sql(
              "insert into status_history (application_id, to_status, seq) values ($1, 'Saved', 1)",
              [applicationId],
            ),
          )
        ).code,
      ).toBe('428C9');
    });
  });

  it('has the indexes the queries will rely on', async () => {
    const { rows } = await sql(
      'select indexname from pg_indexes where schemaname = current_schema() order by indexname',
    );
    const names = rows.map((row) => (row as { indexname: string }).indexname);

    expect(names).toEqual(
      expect.arrayContaining([
        'applications_user_activity_idx',
        'applications_user_status_idx',
        'applications_user_updated_idx',
        'status_history_application_idx',
        'sessions_user_idx',
        'sessions_expires_idx',
        'identities_user_idx',
        'rate_limits_window_idx',
        'status_history_application_order_idx',
      ]),
    );
  });

  it('is applied once and a second run changes nothing', async () => {
    const second = await runMigrations(testDb.url, { schema: testDb.schema });

    expect(second).toEqual({ applied: [], unknown: [] });
  });

  describe('leads, lead notes and interviews: data never crosses between users', () => {
    async function insertLead(userId: string, name = 'Sam Recruiter'): Promise<string> {
      const result = await sql('insert into leads (user_id, name) values ($1, $2) returning id', [
        userId,
        name,
      ]);
      return (result.rows[0] as { id: string }).id;
    }

    it('links an application only to a lead of the same user', async () => {
      const owner = await insertUser({ email: 'lead-owner@example.com' });
      const other = await insertUser({ email: 'lead-other@example.com' });
      const theirLead = await insertLead(other);

      const error = await violation(insertApplication(owner, { lead_id: theirLead }));
      expect(error.constraint).toBe('applications_lead_fk');
      await insertApplication(owner, { lead_id: await insertLead(owner) });
    });

    it('deleting a lead unlinks its applications (keeping them and their owner) and deletes its notes', async () => {
      const owner = await insertUser({ email: 'unlink@example.com' });
      const lead = await insertLead(owner);
      const application = await insertApplication(owner, { lead_id: lead });
      await sql(
        "insert into lead_notes (lead_id, user_id, held_on, body) values ($1, $2, '2026-11-01', 'Coffee chat')",
        [lead, owner],
      );

      await sql('delete from leads where id = $1', [lead]);

      const { rows } = await sql('select user_id, lead_id from applications where id = $1', [
        application,
      ]);
      expect(rows).toEqual([{ user_id: owner, lead_id: null }]);
      expect((await sql('select 1 from lead_notes where lead_id = $1', [lead])).rowCount).toBe(0);
    });

    it("refuses a note on another user's lead, and an interview on another user's application", async () => {
      const owner = await insertUser({ email: 'cross-owner@example.com' });
      const other = await insertUser({ email: 'cross-other@example.com' });
      const theirLead = await insertLead(other);
      const theirApplication = await insertApplication(other);

      const note = await violation(
        sql(
          "insert into lead_notes (lead_id, user_id, held_on, body) values ($1, $2, '2026-11-01', 'x')",
          [theirLead, owner],
        ),
      );
      expect(note.constraint).toBe('lead_notes_lead_fk');
      const interview = await violation(
        sql(
          "insert into interviews (application_id, user_id, held_on) values ($1, $2, '2026-11-01')",
          [theirApplication, owner],
        ),
      );
      expect(interview.constraint).toBe('interviews_application_fk');
    });

    it('deleting an application deletes its interviews', async () => {
      const owner = await insertUser({ email: 'interviews@example.com' });
      const application = await insertApplication(owner);
      await sql(
        "insert into interviews (application_id, user_id, held_on) values ($1, $2, '2026-11-01')",
        [application, owner],
      );
      await sql('delete from applications where id = $1', [application]);
      expect(
        (await sql('select 1 from interviews where application_id = $1', [application])).rowCount,
      ).toBe(0);
    });

    it('rejects blank names and notes, and links that are not http(s)', async () => {
      const owner = await insertUser({ email: 'checks@example.com' });
      expect((await violation(insertLead(owner, '   '))).constraint).toBe('leads_name_check');
      expect(
        (
          await violation(
            sql(
              "insert into leads (user_id, name, profile_link) values ($1, 'A', 'javascript:alert(1)')",
              [owner],
            ),
          )
        ).constraint,
      ).toBe('leads_profile_link_check');
      const lead = await insertLead(owner);
      expect(
        (
          await violation(
            sql(
              "insert into lead_notes (lead_id, user_id, held_on, body) values ($1, $2, '2026-11-01', '  ')",
              [lead, owner],
            ),
          )
        ).constraint,
      ).toBe('lead_notes_body_check');
    });
  });

  describe('job search (0009)', () => {
    const startRun = (userId: string) =>
      sql(
        "insert into job_search_runs (user_id, trigger, local_day) values ($1, 'manual', '2026-11-06') returning id",
        [userId],
      ).then((result) => (result.rows[0] as { id: string }).id);
    const insertHit = (userId: string, runId: string, overrides: Record<string, unknown> = {}) => {
      const values = {
        user_id: userId,
        run_id: runId,
        source: 'greenhouse',
        board: 'acme',
        job_id: '42',
        job_link: 'https://job-boards.greenhouse.io/acme/jobs/42',
        apply_link: 'https://job-boards.greenhouse.io/acme/jobs/42',
        company: 'Acme',
        role: 'SDET',
        kind: 'target',
        reason: 'Matches your titles',
        ...overrides,
      };
      const columns = Object.keys(values);
      return sql(
        `insert into job_search_hits (${columns.join(', ')}) values (${columns.map((_, index) => `$${index + 1}`).join(', ')}) returning id`,
        Object.values(values),
      );
    };

    it('allows one running run per user at a time', async () => {
      const owner = await insertUser({ email: 'search-running@example.com' });
      const first = await startRun(owner);
      expect((await violation(startRun(owner))).constraint).toBe('job_search_runs_one_running');
      await sql("update job_search_runs set status = 'done' where id = $1", [first]);
      await startRun(owner);
    });

    it('keeps each job once per user, but another user may have the same job', async () => {
      const owner = await insertUser({ email: 'search-once@example.com' });
      const run = await startRun(owner);
      await insertHit(owner, run);
      expect((await violation(insertHit(owner, run))).constraint).toBe('job_search_hits_job_key');

      const other = await insertUser({ email: 'search-other@example.com' });
      await insertHit(other, await startRun(other));
    });

    it.each([
      [
        'a board name that is not a plain name',
        { source: 'Indeed!' },
        'job_search_hits_source_check',
      ],
      ['an unknown kind', { kind: 'maybe' }, 'job_search_hits_kind_check'],
      ['an unknown state', { state: 'sent' }, 'job_search_hits_state_check'],
    ])('rejects %s', async (_label, overrides, constraint) => {
      const owner = await insertUser({ email: `search-${constraint}@example.com` });
      expect((await violation(insertHit(owner, await startRun(owner), overrides))).constraint).toBe(
        constraint,
      );
    });

    it("never links a hit to someone else's application, and keeps it when the application goes", async () => {
      const owner = await insertUser({ email: 'search-link@example.com' });
      const other = await insertUser({ email: 'search-link-other@example.com' });
      const theirs = await insertApplication(other);
      const run = await startRun(owner);
      expect((await violation(insertHit(owner, run, { application_id: theirs }))).constraint).toBe(
        'job_search_hits_application_fk',
      );

      const mine = await insertApplication(owner);
      const { rows } = await insertHit(owner, run, { application_id: mine, state: 'applied' });
      const hitId = (rows[0] as { id: string }).id;
      await sql('delete from applications where id = $1', [mine]);
      expect(
        (await sql('select state, application_id from job_search_hits where id = $1', [hitId]))
          .rows[0],
      ).toEqual({ state: 'applied', application_id: null });
    });

    it('goes when the user is deleted', async () => {
      const owner = await insertUser({ email: 'search-cascade@example.com' });
      await sql("insert into job_search_profiles (user_id, profile) values ($1, '{}')", [owner]);
      await insertHit(owner, await startRun(owner));
      await sql('delete from users where id = $1', [owner]);
      for (const table of ['job_search_profiles', 'job_search_runs', 'job_search_hits'])
        expect(
          (await sql(`select count(*)::int as n from ${table} where user_id = $1`, [owner]))
            .rows[0],
        ).toEqual({ n: 0 });
    });
  });

  describe('resumes and resume analyses (0008)', () => {
    const SHA = 'a'.repeat(64);
    const insertResume = (userId: string, overrides: Record<string, unknown> = {}) => {
      const values = {
        user_id: userId,
        file_name: 'cv.pdf',
        media_type: 'application/pdf',
        file: Buffer.from('%PDF-1.7'),
        text: 'Pat Doe, SDET',
        text_sha256: SHA,
        ...overrides,
      };
      const columns = Object.keys(values);
      return sql(
        `insert into resumes (${columns.join(', ')}) values (${columns.map((_, index) => `$${index + 1}`).join(', ')})`,
        Object.values(values),
      );
    };

    it('keeps one resume per user, with its file, and pasted text with none', async () => {
      const owner = await insertUser({ email: 'resume-one@example.com' });
      await insertResume(owner);
      expect((await violation(insertResume(owner))).constraint).toBe('resumes_pkey');

      const paster = await insertUser({ email: 'resume-paste@example.com' });
      await insertResume(paster, { file: null, file_name: null, media_type: 'text/plain' });
    });

    it.each([
      ['a file over 2 MB', { file: Buffer.alloc(2097153) }, 'resumes_file_check'],
      ['empty text', { text: '' }, 'resumes_text_check'],
      ['an unknown type', { media_type: 'image/png' }, 'resumes_media_type_check'],
      ['a file without a name', { file_name: null }, 'resumes_file_pair_check'],
      ['pasted text with a file', { media_type: 'text/plain' }, 'resumes_text_only_check'],
      ['a bad hash', { text_sha256: 'nope' }, 'resumes_text_sha256_check'],
    ])('rejects %s', async (_label, overrides, constraint) => {
      const owner = await insertUser({ email: `resume-${constraint}@example.com` });
      expect((await violation(insertResume(owner, overrides))).constraint).toBe(constraint);
    });

    it('goes when the user is deleted, analyses included', async () => {
      const owner = await insertUser({ email: 'resume-cascade@example.com' });
      await insertResume(owner);
      await sql(
        "insert into resume_analyses (user_id, text_sha256, result, model) values ($1, $2, '{}', 'm')",
        [owner, SHA],
      );
      await sql('delete from users where id = $1', [owner]);

      for (const table of ['resumes', 'resume_analyses'])
        expect(
          (await sql(`select count(*)::int as n from ${table} where user_id = $1`, [owner]))
            .rows[0],
        ).toEqual({ n: 0 });
    });
  });
});
