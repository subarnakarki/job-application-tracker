import Fastify, { type FastifyInstance } from 'fastify';

/**
 * Builds the Fastify app without listening, so tests (and later the Vercel
 * entrypoint) can use it directly. Dependencies such as the database and the
 * clock are injected from Phase 2 onwards.
 */
export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: false });

  // Deliberately does not touch the database, so uptime checks never wake it.
  app.get('/api/health', () => ({ status: 'ok' }));

  return app;
}
