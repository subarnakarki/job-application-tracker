import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify';
import { systemClock, type Clock } from './clock';
import type { Db } from './db/types';
import { ApiError } from './http/errors';
import { enforceRoutePolicy } from './http/policy';
import { registerRequestPipeline } from './http/pipeline';
import { registerApplicationRoutes } from './routes/applications';
import { registerHealthRoutes } from './routes/health';
import { registerMeRoutes } from './routes/me';
import { registerSessionRoutes } from './routes/session';
import { registerTestRoutes, registerTestSecretGuard } from './routes/testSupport';
import { resolveTestRoutes } from './test-support/config';

export interface AppDeps {
  /** Absent in tests that never touch the database. */
  db?: Db;
  logger?: FastifyServerOptions['logger'];
  /** "Now" for sessions, rate limits and (later) domain rules. Tests pass a controllable one. */
  clock?: Clock;
  env?: Record<string, string | undefined>;
}

/**
 * Builds the Fastify app without listening, so tests (and the Vercel entry)
 * can use it directly. Everything the app depends on is injected.
 */
export function buildApp(deps: AppDeps = {}): FastifyInstance {
  const app = Fastify({ logger: deps.logger ?? false });
  const clock = deps.clock ?? systemClock;
  const env = deps.env ?? process.env;

  // Must come first: it checks every route as it is registered.
  enforceRoutePolicy(app);

  // Never leak internals: a 5xx returns a fixed body (details go to the log),
  // while deliberate errors keep their message.
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof ApiError) {
      return reply.code(error.statusCode).send({
        error: error.code,
        message: error.message,
        ...(error.issues ? { issues: error.issues } : {}),
      });
    }
    const statusCode = typeof error.statusCode === 'number' ? error.statusCode : 500;
    if (statusCode >= 500) {
      request.log.error(error);
      return reply.code(500).send({ error: 'internal_error' });
    }
    return reply.code(statusCode).send({ error: error.code, message: error.message });
  });

  // Test-only routes exist only when the environment explicitly allows them (never in production).
  const testRoutes = resolveTestRoutes(env);
  // The secret guard goes first, so a caller without it sees a plain 404 for anything under /api/test/.
  if (testRoutes) registerTestSecretGuard(app, testRoutes.secret);

  registerRequestPipeline(app, { db: deps.db, clock, perUserClocks: testRoutes !== null });
  registerHealthRoutes(app, deps.db);
  registerSessionRoutes(app, { db: deps.db, clock, env });
  registerMeRoutes(app, deps.db);
  registerApplicationRoutes(app, { db: deps.db, clock });
  if (testRoutes) registerTestRoutes(app, { db: deps.db, clock });

  return app;
}
