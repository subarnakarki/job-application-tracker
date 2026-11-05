import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from './migrate';

// Needs a real Postgres (docker compose locally; a service container from Phase 2 in CI).
const url = process.env['TEST_DATABASE_URL'];

describe.skipIf(!url)('migration runner (real Postgres)', () => {
  const pool = new pg.Pool({ connectionString: url, max: 1 });

  beforeEach(async () => {
    await pool.query('drop table if exists spike_ping, schema_migrations, spike_probe');
  });
  afterAll(async () => {
    await pool.end();
  });

  async function dirWith(files: Record<string, string>): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'migrations-'));
    for (const [name, sql] of Object.entries(files)) await writeFile(path.join(dir, name), sql);
    return dir;
  }

  it('applies the real migrations once and is a no-op the second time', async () => {
    const first = await runMigrations(url ?? '');
    const second = await runMigrations(url ?? '');

    expect(first).toEqual(['001_spike_ping.sql']);
    expect(second).toEqual([]);
    const table = await pool.query("select to_regclass('spike_ping')::text as t");
    expect(table.rows[0]).toEqual({ t: 'spike_ping' });
  });

  it('rolls back a failing migration and leaves it unrecorded', async () => {
    const dir = await dirWith({
      '001_ok.sql': 'create table spike_probe (id int);',
      '002_bad.sql': 'create table spike_probe (id int); select 1/0;',
    });

    await expect(runMigrations(url ?? '', dir)).rejects.toThrow('002_bad.sql');

    const recorded = await pool.query<{ name: string }>('select name from schema_migrations');
    expect(recorded.rows.map((row) => row.name)).toEqual(['001_ok.sql']);
  });

  it('serialises concurrent runs so each migration is applied exactly once', async () => {
    const dir = await dirWith({ '001_t.sql': 'create table spike_probe (id int);' });

    const results = await Promise.all([
      runMigrations(url ?? '', dir),
      runMigrations(url ?? '', dir),
      runMigrations(url ?? '', dir),
    ]);

    expect(results.flat()).toEqual(['001_t.sql']);
  });
});
