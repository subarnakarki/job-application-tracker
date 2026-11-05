import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, TEST_DATABASE_URL, type TestDb } from '../test/testDb';
import { countStatements, runMigrations } from './migrate';

describe.skipIf(!TEST_DATABASE_URL)('migration runner (real Postgres)', () => {
  let testDb: TestDb;
  const dirs: string[] = [];

  beforeAll(async () => {
    testDb = await createTestDb();
  });
  afterAll(async () => {
    await testDb.drop();
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });
  // Every test starts from an empty schema, so tests cannot depend on each other.
  beforeEach(async () => {
    await testDb.db.query('drop table if exists schema_migrations, t1, t2, t3, log cascade');
  });
  afterEach(() => undefined);

  async function dirWith(files: Record<string, string>): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'jat-migrations-'));
    dirs.push(dir);
    for (const [name, sql] of Object.entries(files)) await writeFile(path.join(dir, name), sql);
    return dir;
  }

  const migrate = (dir: string, extra: Parameters<typeof runMigrations>[1] = {}) =>
    runMigrations(testDb.url, { dir, schema: testDb.schema, ...extra });

  const recordedNames = async () =>
    (
      await testDb.db.query<{ name: string }>('select name from schema_migrations order by name')
    ).rows.map((row) => row.name);

  it('applies files in numeric order, records them, and does nothing the second time', async () => {
    const dir = await dirWith({
      '0010_c.sql': 'create table t3 (id int);',
      '0001_a.sql': 'create table t1 (id int);',
      '0002_b.sql': 'create table t2 (id int);',
    });
    const messages: string[] = [];

    const first = await migrate(dir, { log: (message) => messages.push(message) });
    const second = await migrate(dir);

    expect(first.applied).toEqual(['0001_a.sql', '0002_b.sql', '0010_c.sql']);
    expect(messages).toEqual(['applied 0001_a.sql', 'applied 0002_b.sql', 'applied 0010_c.sql']);
    expect(second).toEqual({ applied: [], unknown: [] });
    expect(await recordedNames()).toEqual(['0001_a.sql', '0002_b.sql', '0010_c.sql']);
  });

  it('is fine with an empty directory and ignores files that are not .sql', async () => {
    const dir = await dirWith({
      'README.md': '# notes',
      '0001_a.sql': 'create table t1 (id int);',
    });

    expect((await migrate(dir)).applied).toEqual(['0001_a.sql']);
    expect((await migrate(await dirWith({}))).applied).toEqual([]);
  });

  it.each([
    ['no number', 'add_users.sql'],
    ['short number', '1_add_users.sql'],
    ['upper case', '0001_Add_Users.sql'],
    ['spaces', '0001 add users.sql'],
    ['no name', '0001.sql'],
  ])('rejects a badly named file (%s) before touching the database', async (_label, name) => {
    const dir = await dirWith({ [name]: 'select 1;' });

    await expect(migrate(dir)).rejects.toThrow('0001_short_name.sql');
    expect(
      await testDb.db.query("select to_regclass('schema_migrations')::text as t"),
    ).toMatchObject({
      rows: [{ t: null }],
    });
  });

  it('rejects two files with the same number', async () => {
    const dir = await dirWith({ '0001_a.sql': 'select 1;', '0001_b.sql': 'select 1;' });

    await expect(migrate(dir)).rejects.toThrow('share number 0001');
  });

  it('rolls a failing file back completely, records nothing for it and stops there', async () => {
    const dir = await dirWith({
      '0001_ok.sql': 'create table t1 (id int);',
      '0002_bad.sql': 'create table t2 (id int); select 1/0;',
      '0003_never.sql': 'create table t3 (id int);',
    });

    await expect(migrate(dir)).rejects.toThrow(/0002_bad\.sql failed: .*division by zero/);

    expect(await recordedNames()).toEqual(['0001_ok.sql']);
    const tables = await testDb.db.query<{ name: string }>(
      "select table_name as name from information_schema.tables where table_schema = current_schema() and table_name in ('t1','t2','t3') order by 1",
    );
    expect(tables.rows.map((row) => row.name)).toEqual(['t1']);
  });

  it('serialises concurrent runs so every migration is applied exactly once', async () => {
    const dir = await dirWith({
      '0001_log.sql': 'create table log (n int);',
      '0002_row.sql': 'insert into log values (1);',
    });

    const results = await Promise.all([migrate(dir), migrate(dir), migrate(dir), migrate(dir)]);

    expect(results.flatMap((result) => result.applied).sort()).toEqual([
      '0001_log.sql',
      '0002_row.sql',
    ]);
    expect((await testDb.db.query('select * from log')).rowCount).toBe(1);
  });

  describe('checksums', () => {
    it('fails when an applied migration is edited, and names the file', async () => {
      const dir = await dirWith({ '0001_a.sql': 'create table t1 (id int);' });
      await migrate(dir);
      await writeFile(path.join(dir, '0001_a.sql'), 'create table t1 (id int, extra int);');

      await expect(migrate(dir)).rejects.toThrow('0001_a.sql was modified after it was applied');
    });

    it('accepts a row recorded without a checksum (tables created by the spike runner)', async () => {
      const dir = await dirWith({ '0001_a.sql': 'create table t1 (id int);' });
      await migrate(dir);
      await testDb.db.query('update schema_migrations set checksum = null');
      await writeFile(path.join(dir, '0001_a.sql'), 'create table t1 (id int); -- reworded');

      expect((await migrate(dir)).applied).toEqual([]);
    });

    it('does not mind a new migration being added after earlier ones were applied', async () => {
      const dir = await dirWith({ '0001_a.sql': 'create table t1 (id int);' });
      await migrate(dir);
      await writeFile(path.join(dir, '0002_b.sql'), 'create table t2 (id int);');

      expect((await migrate(dir)).applied).toEqual(['0002_b.sql']);
    });
  });

  it('reports applied migrations that are no longer on disk, without failing', async () => {
    const dir = await dirWith({ '0001_a.sql': 'create table t1 (id int);' });
    await migrate(dir);
    const messages: string[] = [];

    const result = await migrate(await dirWith({ '0002_b.sql': 'create table t2 (id int);' }), {
      log: (message) => messages.push(message),
    });

    expect(result).toEqual({ applied: ['0002_b.sql'], unknown: ['0001_a.sql'] });
    expect(messages[0]).toContain('0001_a.sql is no longer on disk');
  });

  describe('no-transaction migrations', () => {
    it('lets CREATE INDEX CONCURRENTLY run, which a normal migration cannot', async () => {
      const base = { '0001_t.sql': 'create table t1 (id int);' };
      const concurrently = 'create index concurrently if not exists t1_id on t1 (id);';

      const inTransaction = await dirWith({ ...base, '0002_idx.sql': concurrently });
      await expect(migrate(inTransaction)).rejects.toThrow(/transaction block/);
      expect(await recordedNames()).toEqual(['0001_t.sql']);

      const noTransaction = await dirWith({
        ...base,
        '0002_idx.sql': `-- migrate:no-transaction\n${concurrently}\n`,
      });
      expect((await migrate(noTransaction)).applied).toEqual(['0002_idx.sql']);
      const index = await testDb.db.query(
        "select 1 from pg_indexes where schemaname = current_schema() and indexname = 't1_id'",
      );
      expect(index.rowCount).toBe(1);
    });

    it('refuses a no-transaction file with more than one statement', async () => {
      const dir = await dirWith({
        '0001_x.sql':
          '-- migrate:no-transaction\ncreate table t1 (id int);\ncreate table t2 (id int);',
      });

      await expect(migrate(dir)).rejects.toThrow('must contain a single statement');
    });

    it('allows comments around the single statement and a trailing semicolon', async () => {
      const dir = await dirWith({
        '0001_x.sql':
          '\n-- migrate:no-transaction\n-- explains why\ncreate table t1 (id int); -- done\n',
      });

      // The trailing comment is fine; only a second statement is rejected.
      expect((await migrate(dir)).applied).toEqual(['0001_x.sql']);
    });
  });

  it('accepts a semicolon or a comment marker inside a string literal in a no-transaction file', async () => {
    const dir = await dirWith({
      '0001_a.sql': 'create table t1 (note text);',
      '0002_x.sql': "-- migrate:no-transaction\ninsert into t1 values ('a; b -- c');",
    });

    expect((await migrate(dir)).applied).toEqual(['0001_a.sql', '0002_x.sql']);
    expect((await testDb.db.query('select note from t1')).rows).toEqual([{ note: 'a; b -- c' }]);
  });

  describe('timeouts protect live traffic', () => {
    it('fails fast on a blocked lock instead of queueing behind it, and records nothing', async () => {
      await migrate(await dirWith({ '0001_a.sql': 'create table t1 (id int);' }));
      const holder = new pg.Client({ connectionString: testDb.url });
      await holder.connect();
      await holder.query(`set search_path to ${testDb.schema}`);
      await holder.query('begin');
      await holder.query('lock table t1 in access exclusive mode');
      try {
        const dir = await dirWith({
          '0001_a.sql': 'create table t1 (id int);',
          '0002_alter.sql': 'alter table t1 add column extra int;',
        });
        const started = Date.now();

        await expect(migrate(dir, { lockTimeoutMs: 300 })).rejects.toThrow(/lock timeout/i);

        expect(Date.now() - started).toBeLessThan(5_000);
        expect(await recordedNames()).toEqual(['0001_a.sql']);
      } finally {
        await holder.query('rollback');
        await holder.end();
      }
    });

    it('succeeds once the lock is released (the failed run left nothing behind)', async () => {
      const dir = await dirWith({
        '0001_a.sql': 'create table t1 (id int);',
        '0002_alter.sql': 'alter table t1 add column extra int;',
      });

      expect((await migrate(dir)).applied).toEqual(['0001_a.sql', '0002_alter.sql']);
    });

    it('cancels a statement that runs too long', async () => {
      const dir = await dirWith({ '0001_slow.sql': 'select pg_sleep(3);' });
      const started = Date.now();

      await expect(migrate(dir, { statementTimeoutMs: 200 })).rejects.toThrow(/statement timeout/i);

      expect(Date.now() - started).toBeLessThan(2_500);
      expect(await recordedNames()).toEqual([]);
    });
  });

  it('keeps separate schemas separate', async () => {
    const other = await createTestDb();
    try {
      const dir = await dirWith({ '0001_a.sql': 'create table t1 (id int);' });
      await migrate(dir);

      const result = await runMigrations(other.url, { dir, schema: other.schema });

      expect(result.applied).toEqual(['0001_a.sql']);
      const inOther = await other.db.query("select to_regclass('t1')::text as t");
      expect(inOther.rows[0]).toEqual({ t: 't1' });
    } finally {
      await other.drop();
    }
  });

  it('rejects an unsafe schema name', async () => {
    const dir = await dirWith({ '0001_a.sql': 'select 1;' });

    await expect(
      runMigrations(testDb.url, { dir, schema: 'x; drop schema public' }),
    ).rejects.toThrow('Invalid schema name');
  });
});

describe('countStatements', () => {
  it.each([
    ['', 0],
    ['-- only a comment', 0],
    ['select 1', 1],
    ['select 1;', 1],
    ['select 1; -- trailing', 1],
    ['-- lead\nselect 1;\n-- tail\n', 1],
    ["select 'a;b';", 1],
    ["select 'it''s; fine';", 1],
    ["select '-- not a comment';", 1],
    ['select 1; select 2', 2],
    ['select 1;\nselect 2;\n', 2],
    ['select 1;;', 1],
  ])('%j has %i statement(s)', (sql, expected) => {
    expect(countStatements(sql)).toBe(expected);
  });
});
