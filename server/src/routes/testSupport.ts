import { randomUUID } from 'node:crypto';
import { TimeZoneSchema } from '@jat/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { serializeSessionCookie } from '../auth/cookies';
import { createSession, type SessionUser } from '../auth/sessions';
import { userClock } from '../auth/userClock';
import { toSessionUser } from '../auth/users';
import type { Clock } from '../clock';
import type { Db } from '../db/types';
import { ApiError, parseInput } from '../http/errors';
import { secretsMatch } from '../test-support/config';

/**
 * Test-only routes. They are registered only when `resolveTestRoutes` allows it
 * (see test-support/config.ts), and every request must carry the secret in
 * `x-test-secret`; without it the answer is a plain 404 so the routes do not
 * even reveal that they exist.
 */

const TEN_YEARS_MS = 10 * 365 * 24 * 60 * 60 * 1000;

const LoginBody = z.strictObject({ timeZone: TimeZoneSchema.optional() });

const ClockBody = z
  .strictObject({
    /** Freeze this user's time at an instant, or null to unfreeze. */
    frozenAt: z.union([z.iso.datetime({ offset: true }), z.null()]).optional(),
    /** Shift this user's time (ms) relative to the app clock. */
    offsetMs: z.number().int().min(-TEN_YEARS_MS).max(TEN_YEARS_MS).optional(),
  })
  .refine((body) => body.frozenAt !== undefined || body.offsetMs !== undefined, {
    message: 'Give frozenAt, offsetMs or both',
  });

const CleanupBody = z.strictObject({
  olderThanMinutes: z
    .number()
    .int()
    .min(0)
    .max(60 * 24 * 30),
});

/** Must be registered BEFORE the request pipeline so an unauthorised caller gets 404, not 401/403. */
export function registerTestSecretGuard(app: FastifyInstance, secret: string): void {
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/test/')) return;
    const provided = request.headers['x-test-secret'];
    if (!secretsMatch(secret, Array.isArray(provided) ? provided[0] : provided)) {
      return reply.code(404).send({ error: 'not_found' });
    }
  });
}

export interface TestRouteDeps {
  db: Db | undefined;
  clock: Clock;
}

export function registerTestRoutes(app: FastifyInstance, deps: TestRouteDeps): void {
  const requireDb = (): Db => {
    if (!deps.db) throw new ApiError(503, 'unavailable', 'The service is not available');
    return deps.db;
  };

  // Creates a brand-new synthetic user and signs them in. One per test: no shared state, no reset.
  app.post('/api/test/login', { config: { auth: 'public' } }, async (request, reply) => {
    const db = requireDb();
    const body = parseInput(LoginBody, request.body ?? {});
    const now = deps.clock.now();
    const id = randomUUID();

    const user = await db.transaction(async (tx) => {
      const created = await tx.query<{
        id: string;
        email: string;
        name: string | null;
        picture_url: string | null;
        time_zone: string;
        is_demo: boolean;
      }>(
        `insert into users (email, name, time_zone) values ($1, $2, $3)
         returning id, email, name, picture_url, time_zone, is_demo`,
        [`test-${id}@example.invalid`, 'Test User', body.timeZone ?? 'UTC'],
      );
      const row = created.rows[0];
      if (!row) throw new Error('Test user was not created');
      await tx.query(
        "insert into identities (user_id, provider, subject, created_at) values ($1, 'test', $2, $3)",
        [row.id, `test:${id}`, now],
      );
      return toSessionUser(row);
    });

    const session = await createSession(db, user.id, now);
    void reply.header(
      'set-cookie',
      serializeSessionCookie(
        session.token,
        Math.floor((session.expiresAt.getTime() - now.getTime()) / 1000),
      ),
    );
    // The token is returned too, so non-browser clients can send it as a Cookie header.
    return { user, token: session.token };
  });

  // Freezes or shifts the signed-in test user's own clock. Nobody else's time moves.
  app.post('/api/test/clock', { config: { auth: 'user' } }, async (request) => {
    const db = requireDb();
    const body = parseInput(ClockBody, request.body);
    const user = requireTestUser(request.auth?.user);
    await assertIsTestUser(db, user.id);

    await db.query(
      `insert into test_clocks (user_id, frozen_at, offset_ms) values ($1, $2, $3)
       on conflict (user_id) do update set
         frozen_at = case when $4 then excluded.frozen_at else test_clocks.frozen_at end,
         offset_ms = case when $5 then excluded.offset_ms else test_clocks.offset_ms end`,
      [
        user.id,
        body.frozenAt ? new Date(body.frozenAt) : null,
        body.offsetMs ?? 0,
        body.frozenAt !== undefined,
        body.offsetMs !== undefined,
      ],
    );
    return { now: (await userClock(db, user.id, deps.clock)).now().toISOString() };
  });

  // The time this user's domain logic sees. Lets tests prove clocks are isolated per user.
  app.get('/api/test/now', { config: { auth: 'user' } }, (request) => ({
    now: request.clock.now().toISOString(),
  }));

  // Housekeeping for long-lived preview databases: removes synthetic users (and, by cascade, all their data).
  app.post('/api/test/cleanup', { config: { auth: 'public' } }, async (request) => {
    const db = requireDb();
    const body = parseInput(CleanupBody, request.body);
    const cutoff = new Date(deps.clock.now().getTime() - body.olderThanMinutes * 60 * 1000);

    const result = await db.query(
      `delete from users u
        where exists (select 1 from identities i
                       where i.user_id = u.id and i.provider = 'test' and i.created_at < $1)`,
      [cutoff],
    );
    return { deleted: result.rowCount };
  });
}

function requireTestUser(user: SessionUser | undefined): SessionUser {
  if (!user) throw new ApiError(401, 'unauthenticated', 'Sign in to continue');
  return user;
}

/** The clock routes may only touch synthetic users, never a real or demo account. */
async function assertIsTestUser(db: Db, userId: string): Promise<void> {
  const result = await db.query(
    "select 1 from identities where user_id = $1 and provider = 'test'",
    [userId],
  );
  if (result.rowCount === 0)
    throw new ApiError(403, 'forbidden', 'Only test users may change their clock');
}
