import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, TEST_DATABASE_URL, type TestDb } from '../test/testDb';
import { resolveConnection } from './connection';

describe('resolveConnection (TLS decision)', () => {
  const NEON =
    'postgresql://user:pw@ep-cool-123-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require';

  it('verifies TLS for a remote host and strips sslmode from the string', () => {
    const resolved = resolveConnection(NEON);

    expect(resolved.ssl).toEqual({ rejectUnauthorized: true });
    expect(resolved.connectionString).not.toContain('sslmode');
    expect(resolved.connectionString).toContain('channel_binding=require');
    expect(resolved.connectionString).toContain('ep-cool-123-pooler');
  });

  it.each([
    ['no sslmode, remote', 'postgres://u:p@db.example.com/app', { rejectUnauthorized: true }],
    [
      'prefer, remote',
      'postgres://u:p@db.example.com/app?sslmode=prefer',
      { rejectUnauthorized: true },
    ],
    [
      'verify-full, remote',
      'postgres://u:p@db.example.com/app?sslmode=verify-full',
      { rejectUnauthorized: true },
    ],
    [
      'verify-ca, remote',
      'postgres://u:p@db.example.com/app?sslmode=verify-ca',
      { rejectUnauthorized: true },
    ],
    [
      'no-verify, remote',
      'postgres://u:p@db.example.com/app?sslmode=no-verify',
      { rejectUnauthorized: false },
    ],
    ['disable, remote', 'postgres://u:p@db.example.com/app?sslmode=disable', false],
    ['no sslmode, localhost', 'postgres://u:p@localhost:5432/app', false],
    ['no sslmode, 127.0.0.1', 'postgres://u:p@127.0.0.1:5432/app', false],
    ['no sslmode, ::1', 'postgres://u:p@[::1]:5432/app', false],
    ['prefer, localhost', 'postgres://u:p@localhost/app?sslmode=prefer', false],
    [
      'require, localhost',
      'postgres://u:p@localhost/app?sslmode=require',
      { rejectUnauthorized: true },
    ],
  ])('%s', (_label, url, ssl) => {
    expect(resolveConnection(url).ssl).toEqual(ssl);
  });

  it('keeps the credentials and database name intact', () => {
    const resolved = resolveConnection(
      'postgres://me:s3cret@db.example.com:6543/jobs?sslmode=require',
    );
    const url = new URL(resolved.connectionString);
    expect([url.username, url.password, url.hostname, url.port, url.pathname]).toEqual([
      'me',
      's3cret',
      'db.example.com',
      '6543',
      '/jobs',
    ]);
  });

  it('rejects an unsupported sslmode and a non-postgres URL', () => {
    expect(() => resolveConnection('postgres://u:p@h/db?sslmode=banana')).toThrow(
      'Unsupported sslmode',
    );
    expect(() => resolveConnection('mysql://u:p@h/db')).toThrow('postgres://');
    expect(() => resolveConnection('host=localhost dbname=app')).toThrow('postgres://');
    expect(() => resolveConnection('')).toThrow('postgres://');
  });
});

describe('test database availability', () => {
  it.runIf(process.env['CI'])(
    'is always provided in CI, so database tests can never be silently skipped',
    () => {
      expect(TEST_DATABASE_URL).toBeTruthy();
    },
  );
});

describe.skipIf(!TEST_DATABASE_URL)('Db (real Postgres)', () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await createTestDb();
    await testDb.db.query(
      'create table item (id int primary key, day date, at timestamptz, big bigint)',
    );
  });
  afterAll(async () => {
    await testDb.drop();
  });

  it('is pinned to its own schema', async () => {
    const result = await testDb.db.query<{ schema: string }>('select current_schema() as schema');
    expect(result.rows[0]?.schema).toBe(testDb.schema);
  });

  it('returns date columns as plain YYYY-MM-DD strings, whatever the process time zone', async () => {
    await testDb.db.query("insert into item (id, day) values (1, '2026-11-05'), (2, '2026-03-08')");
    const result = await testDb.db.query<{ id: number; day: string }>(
      'select id, day from item order by id',
    );

    expect(result.rows.map((row) => row.day)).toEqual(['2026-11-05', '2026-03-08']);
    expect(typeof result.rows[0]?.day).toBe('string');
  });

  it('returns timestamptz as Date objects at the right instant', async () => {
    await testDb.db.query("insert into item (id, at) values (3, '2026-11-05T15:00:00Z')");
    const result = await testDb.db.query<{ at: Date }>('select at from item where id = 3');

    expect(result.rows[0]?.at).toBeInstanceOf(Date);
    expect(result.rows[0]?.at.toISOString()).toBe('2026-11-05T15:00:00.000Z');
  });

  it('reports rowCount for writes', async () => {
    const result = await testDb.db.query('update item set big = 1 where id in (1, 2)');
    expect(result.rowCount).toBe(2);
  });

  it('passes parameters safely (no string interpolation)', async () => {
    const hostile = "x'; drop table item; --";
    await testDb.db.query('insert into item (id, big) values ($1, $2)', [10, 5]);
    const result = await testDb.db.query(
      'select id from item where id = $1 and $2::text <> id::text',
      [10, hostile],
    );

    expect(result.rowCount).toBe(1);
    const stillThere = await testDb.db.query("select to_regclass('item')::text as t");
    expect(stillThere.rows[0]).toEqual({ t: 'item' });
  });

  describe('transaction', () => {
    it('commits everything on success and returns the work result', async () => {
      const value = await testDb.db.transaction(async (tx) => {
        await tx.query('insert into item (id) values (20)');
        await tx.query('insert into item (id) values (21)');
        return 'done';
      });

      expect(value).toBe('done');
      const count = await testDb.db.query('select 1 from item where id in (20, 21)');
      expect(count.rowCount).toBe(2);
    });

    it('rolls everything back when the work throws, and rethrows the same error', async () => {
      const failure = new Error('boom');

      await expect(
        testDb.db.transaction(async (tx) => {
          await tx.query('insert into item (id) values (30)');
          throw failure;
        }),
      ).rejects.toBe(failure);

      const rows = await testDb.db.query('select 1 from item where id = 30');
      expect(rows.rowCount).toBe(0);
    });

    it('rolls back when a statement fails inside the transaction', async () => {
      await expect(
        testDb.db.transaction(async (tx) => {
          await tx.query('insert into item (id) values (40)');
          await tx.query('insert into item (id) values (40)'); // duplicate key
        }),
      ).rejects.toMatchObject({ code: '23505' });

      expect((await testDb.db.query('select 1 from item where id = 40')).rowCount).toBe(0);
    });

    it('does not leak connections: many failed transactions still leave the pool usable', async () => {
      for (let attempt = 0; attempt < 12; attempt += 1) {
        await expect(
          testDb.db.transaction(() => Promise.reject(new Error('fail'))),
        ).rejects.toThrow('fail');
      }
      expect((await testDb.db.query('select 1 as ok')).rows[0]).toEqual({ ok: 1 });
    });

    it('isolates concurrent transactions until they commit', async () => {
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });

      const writer = testDb.db.transaction(async (tx) => {
        await tx.query('insert into item (id) values (50)');
        await gate;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      const before = await testDb.db.query('select 1 from item where id = 50');
      release();
      await writer;
      const after = await testDb.db.query('select 1 from item where id = 50');

      expect([before.rowCount, after.rowCount]).toEqual([0, 1]);
    });
  });
});
