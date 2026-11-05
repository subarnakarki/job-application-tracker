import { UserEnvelopeSchema } from '@jat/shared';
import type { FastifyInstance } from 'fastify';
import type { Clock } from '../clock';
import {
  readSessionToken,
  serializeClearedSessionCookie,
  serializeSessionCookie,
} from '../auth/cookies';
import { consumeRateLimit, rateLimitKey, type RateLimitRule } from '../auth/rateLimit';
import { createSession, deleteSession } from '../auth/sessions';
import { findOrCreateDemoUser } from '../auth/users';
import type { Db } from '../db/types';
import { clientIp } from '../http/clientIp';
import { ApiError } from '../http/errors';

export const DEMO_LOGIN_RULE: RateLimitRule = {
  name: 'demo-login',
  limit: 30,
  windowMs: 60 * 60 * 1000,
};

export interface SessionRouteDeps {
  db: Db | undefined;
  clock: Clock;
  env: Record<string, string | undefined>;
}

export function registerSessionRoutes(app: FastifyInstance, deps: SessionRouteDeps): void {
  const requireDb = (): Db => {
    if (!deps.db) throw new ApiError(503, 'unavailable', 'The service is not available');
    return deps.db;
  };

  // Sign in as the shared demo user. Rate-limited per client address.
  app.post(
    '/api/auth/demo',
    {
      config: {
        auth: 'public',
        contract: {
          summary: 'Sign in as the shared demo account',
          errors: { 429: 'Too many sign-in attempts from this address' },
          responses: { 200: UserEnvelopeSchema },
        },
      },
    },
    async (request, reply) => {
      const db = requireDb();
      const now = deps.clock.now();
      const ip = clientIp({
        headers: request.headers,
        remoteAddress: request.socket.remoteAddress,
        env: deps.env,
      });

      const limit = await consumeRateLimit(
        db,
        rateLimitKey(DEMO_LOGIN_RULE.name, ip),
        DEMO_LOGIN_RULE,
        now,
      );
      if (!limit.allowed) {
        void reply.header('retry-after', String(limit.retryAfterSeconds));
        throw new ApiError(429, 'rate_limited', 'Too many sign-in attempts. Try again later.');
      }

      // Signing in replaces whatever session this browser already had.
      if (request.auth) await deleteSession(db, request.auth.token);

      const user = await findOrCreateDemoUser(db);
      const session = await createSession(db, user.id, now);
      void reply.header(
        'set-cookie',
        serializeSessionCookie(
          session.token,
          Math.floor((session.expiresAt.getTime() - now.getTime()) / 1000),
        ),
      );
      return { user };
    },
  );

  // Idempotent: signing out when already signed out is not an error.
  app.post(
    '/api/auth/logout',
    {
      config: {
        auth: 'public',
        contract: { summary: 'Sign out (idempotent)', responses: { 204: null } },
      },
    },
    async (request, reply) => {
      const token = readSessionToken(request.headers.cookie);
      if (token && deps.db) await deleteSession(deps.db, token);
      void reply.header('set-cookie', serializeClearedSessionCookie());
      return reply.code(204).send();
    },
  );
}
