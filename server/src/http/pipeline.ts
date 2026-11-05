import type { FastifyInstance } from 'fastify';
import type { Clock } from '../clock';
import {
  hasSessionCookie,
  readSessionToken,
  serializeClearedSessionCookie,
  serializeSessionCookie,
} from '../auth/cookies';
import { resolveSession, type SessionUser } from '../auth/sessions';
import type { Db } from '../db/types';
import { checkRequest } from './csrf';

export interface AuthContext {
  sessionId: string;
  token: string;
  user: SessionUser;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** The signed-in user, or null. Set for every route that exists. */
    auth: AuthContext | null;
  }
}

export interface PipelineDeps {
  db: Db | undefined;
  clock: Clock;
}

/**
 * The order matters and is fixed here:
 * 1. CSRF guard: cross-site and non-JSON writes are refused before anything else runs.
 * 2. Session: the cookie is resolved; routes marked `user` answer 401 without one.
 * 3. Responses under /api are never cached (they are per-user).
 */
export function registerRequestPipeline(app: FastifyInstance, deps: PipelineDeps): void {
  app.decorateRequest('auth', null);

  app.addHook('onRequest', async (request, reply) => {
    const verdict = checkRequest({ method: request.method, headers: request.headers });
    if (!verdict.ok) {
      return reply.code(verdict.statusCode).send({ error: verdict.code, message: verdict.message });
    }
  });

  app.addHook('onRequest', async (request, reply) => {
    const mode = request.routeOptions.config.auth;
    if (mode === undefined) return; // no such route: let Fastify answer 404

    const token = readSessionToken(request.headers.cookie);
    let auth: AuthContext | null = null;
    if (token && deps.db) {
      const now = deps.clock.now();
      const resolved = await resolveSession(deps.db, token, now);
      if (resolved) {
        auth = { sessionId: resolved.sessionId, token, user: resolved.user };
        if (resolved.renewed) {
          const seconds = Math.floor((resolved.expiresAt.getTime() - now.getTime()) / 1000);
          void reply.header('set-cookie', serializeSessionCookie(token, seconds));
        }
      }
    }
    // A cookie that does not resolve (expired, deleted, duplicated, malformed) is dropped,
    // so the browser stops sending it.
    if (!auth && hasSessionCookie(request.headers.cookie)) {
      void reply.header('set-cookie', serializeClearedSessionCookie());
    }

    request.auth = auth;
    if (mode === 'user' && !auth) {
      return reply.code(401).send({ error: 'unauthenticated', message: 'Sign in to continue' });
    }
  });

  app.addHook('onSend', async (request, reply, payload) => {
    if (request.url.startsWith('/api/') && !reply.hasHeader('cache-control')) {
      void reply.header('cache-control', 'no-store');
    }
    return payload;
  });
}
