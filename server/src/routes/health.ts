import { HealthSchema } from '@jat/shared';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/types';

export function registerHealthRoutes(app: FastifyInstance, db: Db | undefined): void {
  // Never touches the database, so an uptime check cannot wake it or be slowed by it.
  app.get(
    '/api/health',
    {
      config: {
        auth: 'public',
        contract: {
          summary: 'Liveness (never touches the database)',
          responses: { 200: HealthSchema },
        },
      },
    },
    () => ({ status: 'ok' }),
  );

  // Readiness: proves the app can reach the database. For deploy smoke tests, not uptime pings.
  app.get(
    '/api/health/db',
    {
      config: {
        auth: 'public',
        contract: {
          summary: 'Readiness: the database answers',
          responses: { 200: HealthSchema, 503: HealthSchema },
        },
      },
    },
    async (request, reply) => {
      if (!db) return reply.code(503).send({ status: 'unavailable' });
      try {
        await db.query('select 1');
        return { status: 'ok' };
      } catch (error) {
        request.log.error(error);
        return reply.code(503).send({ status: 'unavailable' });
      }
    },
  );
}
