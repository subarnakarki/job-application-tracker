import type { FastifyInstance, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Clock } from '../clock';
import { serializeSessionCookie } from '../auth/cookies';
import { GoogleSignInError, pkceChallenge, randomToken, type GoogleProvider } from '../auth/google';
import {
  readOAuthCookie,
  safeNextPath,
  serializeClearedOAuthCookie,
  serializeOAuthCookie,
} from '../auth/oauthState';
import { consumeRateLimit, rateLimitKey, type RateLimitRule } from '../auth/rateLimit';
import { createSession, deleteSession } from '../auth/sessions';
import { findOrCreateGoogleUser } from '../auth/users';
import type { Db } from '../db/types';
import { clientIp } from '../http/clientIp';

export const GOOGLE_CALLBACK_PATH = '/api/auth/google/callback';
export const GOOGLE_LOGIN_RULE: RateLimitRule = {
  name: 'google-login',
  limit: 60,
  windowMs: 60 * 60 * 1000,
};

const StartQuery = z.object({ next: z.string().max(2000).optional() });
const CallbackQuery = z.object({
  code: z.string().max(4000).optional(),
  state: z.string().max(200).optional(),
  error: z.string().max(200).optional(),
});

export interface GoogleRouteDeps {
  db: Db | undefined;
  clock: Clock;
  env: Record<string, string | undefined>;
  google: GoogleProvider | null;
}

/** The public origin the browser used. On Vercel the platform sets the forwarded headers. */
export function origin(request: FastifyRequest, env: Record<string, string | undefined>): string {
  const configured = env['PUBLIC_ORIGIN'];
  if (configured) return configured.replace(/\/$/, '');
  const header = (name: string) => {
    const value = request.headers[name];
    return Array.isArray(value) ? value[0] : value;
  };
  if (env['VERCEL'] === '1') {
    return `${header('x-forwarded-proto') ?? 'https'}://${header('x-forwarded-host') ?? header('host')}`;
  }
  return `http://${header('host') ?? 'localhost'}`;
}

export function sameToken(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function registerGoogleRoutes(app: FastifyInstance, deps: GoogleRouteDeps): void {
  const failTo = (reason: string) => `/login?error=${reason}`;

  // Starts the sign-in: remembers state, PKCE verifier and nonce in a cookie, then sends the
  // browser to Google.
  app.get(
    '/api/auth/google/start',
    {
      config: {
        auth: 'public',
        contract: {
          summary: 'Start Google sign-in (redirects to Google)',
          query: StartQuery,
          responses: { 302: null },
        },
      },
    },
    async (request, reply) => {
      const query = StartQuery.safeParse(request.query);
      const next = safeNextPath(query.success ? query.data.next : undefined);
      if (!deps.google || !deps.db) return reply.redirect(failTo('google_unavailable'), 302);

      const state = { state: randomToken(), verifier: randomToken(), nonce: randomToken(), next };
      const url = deps.google.authorizationUrl({
        state: state.state,
        nonce: state.nonce,
        codeChallenge: pkceChallenge(state.verifier),
        redirectUri: `${origin(request, deps.env)}${GOOGLE_CALLBACK_PATH}`,
      });
      void reply.header('set-cookie', serializeOAuthCookie(state));
      return reply.redirect(url, 302);
    },
  );

  // Google sends the browser back here. Every failure ends on the sign-in page with a reason
  // code; the details go to the log only.
  app.get(
    GOOGLE_CALLBACK_PATH,
    {
      config: {
        auth: 'public',
        contract: {
          summary: 'Finish Google sign-in (redirects into the app)',
          query: CallbackQuery,
          responses: { 302: null },
        },
      },
    },
    async (request, reply) => {
      const pending = readOAuthCookie(request.headers.cookie);
      void reply.header('set-cookie', serializeClearedOAuthCookie());
      const query = CallbackQuery.safeParse(request.query);
      const params = query.success ? query.data : {};

      if (params.error) return reply.redirect(failTo('google_cancelled'), 302);
      if (!deps.google || !deps.db) return reply.redirect(failTo('google_unavailable'), 302);
      if (!pending || !params.code || !params.state || !sameToken(params.state, pending.state)) {
        request.log.warn('Google callback without a matching sign-in in this browser');
        return reply.redirect(failTo('google_expired'), 302);
      }

      const db = deps.db;
      const now = deps.clock.now();
      const ip = clientIp({
        headers: request.headers,
        remoteAddress: request.socket.remoteAddress,
        env: deps.env,
      });
      const limit = await consumeRateLimit(
        db,
        rateLimitKey(GOOGLE_LOGIN_RULE.name, ip),
        GOOGLE_LOGIN_RULE,
        now,
      );
      if (!limit.allowed) return reply.redirect(failTo('rate_limited'), 302);

      let profile;
      try {
        profile = await deps.google.exchangeCode({
          code: params.code,
          codeVerifier: pending.verifier,
          redirectUri: `${origin(request, deps.env)}${GOOGLE_CALLBACK_PATH}`,
          nonce: pending.nonce,
        });
      } catch (error) {
        if (!(error instanceof GoogleSignInError)) throw error;
        request.log.warn({ reason: error.message }, 'Google sign-in rejected');
        return reply.redirect(failTo('google_failed'), 302);
      }

      // Signing in replaces whatever session this browser already had (for example the demo).
      if (request.auth) await deleteSession(db, request.auth.token);
      const user = await findOrCreateGoogleUser(db, profile);
      const session = await createSession(db, user.id, now);
      void reply.header('set-cookie', [
        serializeClearedOAuthCookie(),
        serializeSessionCookie(
          session.token,
          Math.floor((session.expiresAt.getTime() - now.getTime()) / 1000),
        ),
      ]);
      return reply.redirect(safeNextPath(pending.next), 302);
    },
  );
}
