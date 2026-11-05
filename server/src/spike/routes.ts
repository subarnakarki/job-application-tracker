import { APP_NAME } from '@jat/shared';
import type { FastifyInstance } from 'fastify';

/**
 * THROWAWAY (Phase 0.5 deploy spike). Deleted once the spike has proven the
 * platform assumptions. Nothing here is production code.
 */

export interface SpikeDeps {
  /** One plain query through the pooled connection. */
  queryNow(): Promise<{ now: string; serverVersion: string }>;
  /** BEGIN / INSERT / COUNT / COMMIT on a single client (proves pooler transaction mode). */
  recordPing(): Promise<number>;
}

export const SPIKE_COOKIE = '__Host-spike';

export function registerSpikeRoutes(
  app: FastifyInstance,
  deps: SpikeDeps | null,
  env: Record<string, string | undefined>,
): void {
  // Per function instance: true for the first request after a cold start.
  let coldStart = true;

  app.get('/api/spike/info', () => ({
    app: APP_NAME,
    vercelRegion: env['VERCEL_REGION'] ?? null,
    vercelEnv: env['VERCEL_ENV'] ?? null,
    nodeVersion: process.version,
    hasDatabaseUrl: deps !== null,
  }));

  app.get('/api/spike/db', async (_request, reply) => {
    if (!deps) {
      return reply.code(503).send({ error: 'DATABASE_URL is not configured' });
    }
    const wasCold = coldStart;
    coldStart = false;
    const started = performance.now();
    const row = await deps.queryNow();
    return { ...row, coldStart: wasCold, queryMs: Math.round(performance.now() - started) };
  });

  app.post('/api/spike/db/ping', async (_request, reply) => {
    if (!deps) {
      return reply.code(503).send({ error: 'DATABASE_URL is not configured' });
    }
    const started = performance.now();
    const total = await deps.recordPing();
    return { total, transactionMs: Math.round(performance.now() - started) };
  });

  app.get('/api/spike/cookie/set', (_request, reply) => {
    // __Host- prefix requires: Secure, Path=/, and no Domain attribute.
    void reply.header(
      'Set-Cookie',
      `${SPIKE_COOKIE}=1; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600`,
    );
    return { set: true };
  });

  app.get('/api/spike/cookie/read', (request) => {
    const header = request.headers.cookie ?? '';
    const present = header.split(';').some((part) => part.trim() === `${SPIKE_COOKIE}=1`);
    return { present };
  });
}
