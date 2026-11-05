import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';

/**
 * THROWAWAY seed of the Phase 2 migration runner. Applies numbered .sql files
 * in order, each in its own transaction, tracked in schema_migrations. An
 * advisory lock stops two concurrent deploys from racing. Meant to run from CI
 * against the DIRECT (unpooled) connection string, never from the app.
 */

const LOCK_KEY = 727_274;
const defaultDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

export async function runMigrations(
  connectionString: string,
  dir: string = defaultDir,
): Promise<string[]> {
  const files = (await readdir(dir)).filter((name) => name.endsWith('.sql')).sort();
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 15_000 });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query('select pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(
      `create table if not exists schema_migrations (
         name text primary key,
         applied_at timestamptz not null default now()
       )`,
    );
    const done = await client.query<{ name: string }>('select name from schema_migrations');
    const doneNames = new Set(done.rows.map((row) => row.name));

    for (const file of files) {
      if (doneNames.has(file)) continue;
      const sql = await readFile(path.join(dir, file), 'utf8');
      try {
        await client.query('begin');
        await client.query(sql);
        await client.query('insert into schema_migrations (name) values ($1)', [file]);
        await client.query('commit');
      } catch (error) {
        await client.query('rollback').catch(() => undefined);
        throw new Error(`Migration ${file} failed`, { cause: error });
      }
      applied.push(file);
    }
  } finally {
    await client.query('select pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    await client.end();
  }
  return applied;
}

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL_DIRECT'];
  if (!url) throw new Error('DATABASE_URL_DIRECT is not set');
  const applied = await runMigrations(url);
  console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Nothing to apply');
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
