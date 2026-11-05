import pg from 'pg';
import type { SpikeDeps } from './routes';

/**
 * THROWAWAY (Phase 0.5). Small pool per function instance; the pooled Neon URL
 * (PgBouncer, transaction mode) sits in front of Postgres.
 */
export function createSpikeDeps(connectionString: string): SpikeDeps {
  const pool = new pg.Pool({
    connectionString,
    max: 2,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 15_000,
  });

  return {
    async queryNow() {
      const result = await pool.query<{ now: string; server_version: string }>(
        `select now()::text as now, current_setting('server_version') as server_version`,
      );
      const row = result.rows[0];
      if (!row) throw new Error('No row returned');
      return { now: row.now, serverVersion: row.server_version };
    },

    async recordPing() {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query('insert into spike_ping default values');
        const result = await client.query<{ total: string }>(
          'select count(*)::text as total from spike_ping',
        );
        await client.query('commit');
        return Number(result.rows[0]?.total ?? 0);
      } catch (error) {
        await client.query('rollback').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
