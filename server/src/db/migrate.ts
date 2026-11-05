import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';
import { resolveConnection } from './connection';

/**
 * Applies numbered `.sql` files from `migrations/` in order. Meant to run from
 * CI against the DIRECT (unpooled) connection string, never from the app.
 *
 * Rules the runner enforces:
 * - Files are named `0001_short_name.sql`; anything else ending in .sql is an error (typos fail loudly).
 * - Each file runs in its own transaction and is recorded with a SHA-256 checksum.
 * - An applied file that is later edited fails the run: change the schema with a NEW migration.
 * - A file whose first line is `-- migrate:no-transaction` runs outside a transaction and must hold a single
 *   statement (for `CREATE INDEX CONCURRENTLY` and similar). Keep it idempotent (`if not exists`).
 * - `lock_timeout` and `statement_timeout` bound every migration, so a blocked DDL fails instead of queueing
 *   behind (and then blocking) live traffic.
 * - An advisory lock serialises concurrent deploys.
 */

const NAME_PATTERN = /^(\d{4})_[a-z0-9_]+\.sql$/;
const NO_TRANSACTION_MARKER = '-- migrate:no-transaction';
const LOCK_WAIT_MS = 60_000;

export const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

export interface MigrateOptions {
  dir?: string;
  /** Run inside this schema (tests). Omitted: the connection's default `search_path`. */
  schema?: string;
  lockTimeoutMs?: number;
  statementTimeoutMs?: number;
  log?: (message: string) => void;
}

export interface MigrateResult {
  /** Files applied by this run, in order. */
  applied: string[];
  /** Recorded as applied but no longer on disk (renamed or deleted). Reported, not fatal. */
  unknown: string[];
}

interface MigrationFile {
  name: string;
  sql: string;
  checksum: string;
  transactional: boolean;
}

async function loadMigrations(dir: string): Promise<MigrationFile[]> {
  const entries = (await readdir(dir)).filter((name) => name.endsWith('.sql')).sort();
  const seenNumbers = new Map<string, string>();
  const files: MigrationFile[] = [];

  for (const name of entries) {
    const match = NAME_PATTERN.exec(name);
    if (!match) {
      throw new Error(`Migration file name must look like 0001_short_name.sql: ${name}`);
    }
    const number = match[1] ?? '';
    const clash = seenNumbers.get(number);
    if (clash) throw new Error(`Two migrations share number ${number}: ${clash} and ${name}`);
    seenNumbers.set(number, name);

    const sql = await readFile(path.join(dir, name), 'utf8');
    const firstLine = sql.split('\n').find((line) => line.trim() !== '') ?? '';
    const transactional = firstLine.trim() !== NO_TRANSACTION_MARKER;
    if (!transactional) assertSingleStatement(name, sql);
    files.push({
      name,
      sql,
      transactional,
      checksum: createHash('sha256').update(sql).digest('hex'),
    });
  }
  return files;
}

/**
 * Counts statements, ignoring `--` comments and the contents of single-quoted
 * strings, so a trailing comment or a ';' inside a string is not a second
 * statement. Dollar-quoted bodies are not understood and would be over-counted,
 * which fails safe (the file is rejected, never wrongly accepted).
 */
export function countStatements(sql: string): number {
  let inString = false;
  let hasContent = false;
  let count = 0;
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql.charAt(index);
    if (inString) {
      if (character === "'") {
        if (sql.charAt(index + 1) === "'")
          index += 1; // escaped quote
        else inString = false;
      }
      continue;
    }
    if (character === "'") {
      inString = true;
      hasContent = true;
    } else if (character === '-' && sql.charAt(index + 1) === '-') {
      while (index < sql.length && sql.charAt(index) !== '\n') index += 1;
    } else if (character === ';') {
      if (hasContent) count += 1;
      hasContent = false;
    } else if (character.trim() !== '') {
      hasContent = true;
    }
  }
  return hasContent ? count + 1 : count;
}

/** No-transaction files run as one query, so they may not contain several statements. */
function assertSingleStatement(name: string, sql: string): void {
  if (countStatements(sql) > 1) {
    throw new Error(`${name}: a no-transaction migration must contain a single statement`);
  }
}

function assertSchemaName(schema: string): void {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error('Invalid schema name');
}

export async function runMigrations(
  connectionString: string,
  options: MigrateOptions = {},
): Promise<MigrateResult> {
  const dir = options.dir ?? MIGRATIONS_DIR;
  const lockTimeoutMs = options.lockTimeoutMs ?? 5_000;
  const statementTimeoutMs = options.statementTimeoutMs ?? 120_000;
  const log = options.log ?? (() => undefined);
  if (options.schema !== undefined) assertSchemaName(options.schema);

  const files = await loadMigrations(dir);
  const resolved = resolveConnection(connectionString);
  const client = new pg.Client({
    connectionString: resolved.connectionString,
    ssl: resolved.ssl,
    connectionTimeoutMillis: 15_000,
  });
  await client.connect();

  const lockName = `jat_migrations:${options.schema ?? 'default'}`;
  let locked = false;
  const applied: string[] = [];
  let unknown: string[] = [];
  try {
    if (options.schema !== undefined) {
      await client.query(`create schema if not exists ${options.schema}`);
      await client.query(`set search_path to ${options.schema}`);
    }

    // Wait (bounded) for any concurrent run, then bound every migration statement.
    await client.query(`set lock_timeout = ${LOCK_WAIT_MS}`);
    await client.query('select pg_advisory_lock(hashtext($1))', [lockName]);
    locked = true;
    await client.query(`set lock_timeout = ${lockTimeoutMs}`);
    await client.query(`set statement_timeout = ${statementTimeoutMs}`);

    await client.query(
      `create table if not exists schema_migrations (
         name text primary key,
         applied_at timestamptz not null default now()
       )`,
    );
    // Tables created by the earlier spike runner had no checksum column.
    await client.query('alter table schema_migrations add column if not exists checksum text');

    const recorded = await client.query<{ name: string; checksum: string | null }>(
      'select name, checksum from schema_migrations',
    );
    const recordedByName = new Map(recorded.rows.map((row) => [row.name, row.checksum]));
    const onDisk = new Set(files.map((file) => file.name));
    unknown = recorded.rows
      .map((row) => row.name)
      .filter((name) => !onDisk.has(name))
      .sort();
    for (const name of unknown) log(`warning: applied migration ${name} is no longer on disk`);

    for (const file of files) {
      const storedChecksum = recordedByName.get(file.name);
      if (recordedByName.has(file.name)) {
        if (storedChecksum !== null && storedChecksum !== file.checksum) {
          throw new Error(
            `Migration ${file.name} was modified after it was applied. Add a new migration instead.`,
          );
        }
        continue;
      }

      try {
        if (file.transactional) {
          await client.query('begin');
          await client.query(file.sql);
          await client.query('insert into schema_migrations (name, checksum) values ($1, $2)', [
            file.name,
            file.checksum,
          ]);
          await client.query('commit');
        } else {
          await client.query(file.sql);
          await client.query('insert into schema_migrations (name, checksum) values ($1, $2)', [
            file.name,
            file.checksum,
          ]);
        }
      } catch (error) {
        await client.query('rollback').catch(() => undefined);
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`Migration ${file.name} failed: ${reason}`, { cause: error });
      }
      applied.push(file.name);
      log(`applied ${file.name}`);
    }
  } finally {
    if (locked) {
      await client
        .query('select pg_advisory_unlock(hashtext($1))', [lockName])
        .catch(() => undefined);
    }
    await client.end();
  }
  return { applied, unknown };
}

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL_DIRECT'];
  if (!url) throw new Error('DATABASE_URL_DIRECT is not set');
  const result = await runMigrations(url, { log: (message) => console.log(message) });
  console.log(result.applied.length ? `Applied: ${result.applied.join(', ')}` : 'Nothing to apply');
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
