import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildApp } from '../server/src/app';
import { createSpikeDeps } from '../server/src/spike/db';
import { registerSpikeRoutes } from '../server/src/spike/routes';

/**
 * THROWAWAY (Phase 0.5): Vercel function entry. Built once per function
 * instance (module scope), so the pg pool and Fastify plugins survive across
 * warm invocations and only cold starts pay for registration.
 */
const databaseUrl = process.env['DATABASE_URL'];
const app = buildApp();
registerSpikeRoutes(app, databaseUrl ? createSpikeDeps(databaseUrl) : null, process.env);

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await app.ready();
  app.server.emit('request', req, res);
}
