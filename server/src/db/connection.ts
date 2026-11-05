import pg from 'pg';
import type { Db, Queryable, QueryResult } from './types';

export interface ResolvedConnection {
  /** The connection string without `sslmode`, which is expressed in `ssl` instead. */
  connectionString: string;
  ssl: false | { rejectUnauthorized: boolean };
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const VERIFYING_MODES = new Set(['require', 'verify-ca', 'verify-full']);

/**
 * Decides TLS explicitly instead of leaving it to `pg`, whose handling of
 * `sslmode=require` is changing (today an alias for verify-full, later libpq
 * semantics). Remote hosts always get verified TLS; local hosts get none unless
 * a verifying mode is requested; `disable` and `no-verify` are honoured.
 */
export function resolveConnection(connectionString: string): ResolvedConnection {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error('Database URL must be a postgres:// URL');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error('Database URL must be a postgres:// URL');
  }

  const mode = url.searchParams.get('sslmode');
  url.searchParams.delete('sslmode');
  const isLocal = LOCAL_HOSTS.has(url.hostname);

  let ssl: ResolvedConnection['ssl'];
  if (mode === null || mode === 'prefer' || mode === 'allow') {
    ssl = isLocal ? false : { rejectUnauthorized: true };
  } else if (mode === 'disable') {
    ssl = false;
  } else if (mode === 'no-verify') {
    ssl = { rejectUnauthorized: false };
  } else if (VERIFYING_MODES.has(mode)) {
    ssl = { rejectUnauthorized: true };
  } else {
    throw new Error(`Unsupported sslmode: ${mode}`);
  }

  return { connectionString: url.toString(), ssl };
}

/**
 * Parser overrides. `date` columns stay plain `YYYY-MM-DD` strings: the default
 * parser builds a JS Date in the server's local zone, which shifts the day.
 */
const DATE_OID = 1082;
const types = {
  getTypeParser(oid: number, format?: 'text' | 'binary') {
    if (oid === DATE_OID) return (value: string) => value;
    return pg.types.getTypeParser(oid, format ?? 'text') as (value: string) => unknown;
  },
};

export interface CreateDbOptions {
  /** Connections per process. Keep small on serverless (each instance has its own pool). */
  max?: number;
  /** Pin the Postgres `search_path`. Direct connections only (a pooler rejects startup options). Used by tests. */
  searchPath?: string;
}

class PgDb implements Db {
  constructor(private readonly pool: pg.Pool) {}

  async query<Row extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResult<Row>> {
    const result = await this.pool.query<Row>(text, [...params]);
    return { rows: result.rows, rowCount: result.rowCount ?? 0 };
  }

  async transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    const tx: Queryable = {
      async query<Row extends pg.QueryResultRow = pg.QueryResultRow>(
        text: string,
        params: readonly unknown[] = [],
      ): Promise<QueryResult<Row>> {
        const result = await client.query<Row>(text, [...params]);
        return { rows: result.rows, rowCount: result.rowCount ?? 0 };
      },
    };
    try {
      await client.query('begin');
      const value = await work(tx);
      await client.query('commit');
      return value;
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async end(): Promise<void> {
    await this.pool.end();
  }
}

export function createDb(connectionString: string, options: CreateDbOptions = {}): Db {
  const resolved = resolveConnection(connectionString);
  if (options.searchPath !== undefined && !/^[a-z_][a-z0-9_]*$/.test(options.searchPath)) {
    throw new Error('Invalid search_path');
  }
  const pool = new pg.Pool({
    connectionString: resolved.connectionString,
    ssl: resolved.ssl,
    max: options.max ?? 3,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 15_000,
    types,
    ...(options.searchPath !== undefined
      ? { options: `-c search_path=${options.searchPath}` }
      : {}),
  });
  // An idle client erroring (e.g. the server restarted) must not crash the process.
  pool.on('error', () => undefined);
  return new PgDb(pool);
}
