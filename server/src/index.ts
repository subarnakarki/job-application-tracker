import { buildApp } from './app';
import { createDb } from './db/connection';

const port = Number(process.env['PORT'] ?? 3000);
const host = process.env['HOST'] ?? '127.0.0.1';
const databaseUrl = process.env['DATABASE_URL'];

const app = buildApp({
  db: databaseUrl ? createDb(databaseUrl) : undefined,
  logger: { level: process.env['LOG_LEVEL'] ?? 'info' },
});

app.listen({ port, host }).catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
