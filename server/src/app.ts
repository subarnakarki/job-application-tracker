import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify';
import type { Db } from './db/types';

export interface AppDeps {
  /** Absent in tests that never touch the database. */
  db?: Db;
  logger?: FastifyServerOptions['logger'];
}

/**
 * Builds the Fastify app without listening, so tests (and the Vercel entry)
 * can use it directly. Everything the app depends on is injected.
 */
export function buildApp(deps: AppDeps = {}): FastifyInstance {
  const app = Fastify({ logger: deps.logger ?? false });

  // Never leak internals: a 5xx returns a fixed body (details go to the log),
  // while deliberate 4xx errors keep their message.
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const statusCode = typeof error.statusCode === 'number' ? error.statusCode : 500;
    if (statusCode >= 500) {
      request.log.error(error);
      return reply.code(500).send({ error: 'internal_error' });
    }
    return reply.code(statusCode).send({ error: error.code, message: error.message });
  });

  // Never touches the database, so an uptime check cannot wake it or be slowed by it.
  app.get('/api/health', () => ({ status: 'ok' }));

  // Readiness: proves the app can reach the database. For deploy smoke tests, not uptime pings.
  app.get('/api/health/db', async (request, reply) => {
    if (!deps.db) return reply.code(503).send({ status: 'unavailable' });
    try {
      await deps.db.query('select 1');
      return { status: 'ok' };
    } catch (error) {
      request.log.error(error);
      return reply.code(503).send({ status: 'unavailable' });
    }
  });

  return app;
}
