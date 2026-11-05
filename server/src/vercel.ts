import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildApp } from './app';
import { createSpikeDeps } from './spike/db';
import { registerSpikeRoutes } from './spike/routes';

/**
 * THROWAWAY (Phase 0.5): Vercel function entry. Bundled by esbuild into
 * api/index.js (see `build:api`), so Node never has to resolve TypeScript or
 * extensionless imports at runtime. Built once per function instance (module
 * scope), so the pg pool survives across warm invocations.
 */
const databaseUrl = process.env['DATABASE_URL'];
const app = buildApp();
registerSpikeRoutes(app, databaseUrl ? createSpikeDeps(databaseUrl) : null, process.env);

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await app.ready();
  app.server.emit('request', req, res);
}
