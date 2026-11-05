import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildApp } from './app';
import { createDb } from './db/connection';

/**
 * Vercel function entry. Bundled by esbuild into build/handler.mjs (see
 * `build:api`) and re-exported by the committed api/index.ts stub, so Node never
 * resolves TypeScript or extensionless imports at runtime. Built once per
 * function instance (module scope), so the pool survives warm invocations.
 */
const databaseUrl = process.env['DATABASE_URL'];
const db = databaseUrl
  ? createDb(databaseUrl, { max: Number(process.env['DB_POOL_MAX'] ?? 2) })
  : undefined;

const app = buildApp({ db, logger: { level: process.env['LOG_LEVEL'] ?? 'info' } });

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await app.ready();
  app.server.emit('request', req, res);
}
