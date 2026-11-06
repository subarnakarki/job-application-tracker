import { InterviewInputSchema, InterviewPatchSchema, InterviewSchema } from '@jat/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { consumeRateLimit, rateLimitKey } from '../auth/rateLimit';
import type { Clock } from '../clock';
import type { Db } from '../db/types';
import { ApiError, parseInput } from '../http/errors';
import { addInterview, deleteInterview, updateInterview } from '../repo/interviews';
import { presentInterview } from '../repo/present';
import { DEMO_WRITE_RULE, WRITE_RULE } from './applications';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Path parameters as received: any string (a non-uuid simply answers 404). */
const ApplicationParams = z.object({ id: z.string() });
const InterviewParams = z.object({ id: z.string(), interviewId: z.string() });

export interface InterviewRouteDeps {
  db: Db | undefined;
  /** The app clock, for rate limits. */
  clock: Clock;
}

const applicationNotFound = () => new ApiError(404, 'not_found', 'Application not found');
const interviewNotFound = () => new ApiError(404, 'not_found', 'Interview not found');

export function registerInterviewRoutes(app: FastifyInstance, deps: InterviewRouteDeps): void {
  const requireDb = (): Db => {
    if (!deps.db) throw new ApiError(503, 'unavailable', 'The service is not available');
    return deps.db;
  };
  const userOf = (request: FastifyRequest) => {
    const user = request.auth?.user;
    if (!user) throw new ApiError(401, 'unauthenticated', 'Sign in to continue');
    return user;
  };
  /** Same answer for "missing", "someone else's" and "not even an id", so ids cannot be probed. */
  const uuidParam = (value: string | undefined, notFound: () => ApiError): string => {
    if (!value || !UUID.test(value)) throw notFound();
    return value.toLowerCase();
  };
  const applicationIdOf = (request: FastifyRequest) =>
    uuidParam((request.params as { id?: string }).id, applicationNotFound);
  const interviewIdsOf = (request: FastifyRequest) => ({
    applicationId: applicationIdOf(request),
    interviewId: uuidParam(
      (request.params as { interviewId?: string }).interviewId,
      interviewNotFound,
    ),
  });
  const spendWrite = async (db: Db, user: { id: string; isDemo: boolean }, reply: FastifyReply) => {
    const rule = user.isDemo ? DEMO_WRITE_RULE : WRITE_RULE;
    const result = await consumeRateLimit(
      db,
      rateLimitKey(rule.name, user.id),
      rule,
      deps.clock.now(),
    );
    if (!result.allowed) {
      void reply.header('retry-after', String(result.retryAfterSeconds));
      throw new ApiError(429, 'rate_limited', 'Too many changes. Try again later.');
    }
  };

  app.post(
    '/api/applications/:id/interviews',
    {
      config: {
        auth: 'user',
        contract: {
          summary: 'Log an interview (past or scheduled) on an application',
          errors: {
            404: 'No such application (or not yours)',
            409: 'The interview quota for this application is reached',
            429: 'Too many changes',
          },
          params: ApplicationParams,
          body: InterviewInputSchema,
          responses: { 201: InterviewSchema },
        },
      },
    },
    async (request, reply) => {
      const db = requireDb();
      const user = userOf(request);
      const applicationId = applicationIdOf(request);
      const input = parseInput(InterviewInputSchema, request.body);
      await spendWrite(db, user, reply);
      const result = await addInterview(db, user.id, applicationId, input, request.clock.now());
      if (result.kind === 'not_found') throw applicationNotFound();
      if (result.kind === 'limit_reached')
        throw new ApiError(
          409,
          'limit_reached',
          `An application can keep up to ${result.limit} interviews`,
        );
      return reply.code(201).send(presentInterview(result.value));
    },
  );

  app.patch(
    '/api/applications/:id/interviews/:interviewId',
    {
      config: {
        auth: 'user',
        contract: {
          summary: 'Edit an interview',
          errors: { 404: 'No such interview (or not yours)', 429: 'Too many changes' },
          params: InterviewParams,
          body: InterviewPatchSchema,
          responses: { 200: InterviewSchema },
        },
      },
    },
    async (request, reply) => {
      const db = requireDb();
      const user = userOf(request);
      const { applicationId, interviewId } = interviewIdsOf(request);
      const patch = parseInput(InterviewPatchSchema, request.body);
      await spendWrite(db, user, reply);
      const updated = await updateInterview(
        db,
        user.id,
        applicationId,
        interviewId,
        patch,
        request.clock.now(),
      );
      if (!updated) throw interviewNotFound();
      return presentInterview(updated);
    },
  );

  app.delete(
    '/api/applications/:id/interviews/:interviewId',
    {
      config: {
        auth: 'user',
        contract: {
          summary: 'Remove an interview',
          errors: { 404: 'No such interview (or not yours)', 429: 'Too many changes' },
          params: InterviewParams,
          responses: { 204: null },
        },
      },
    },
    async (request, reply) => {
      const db = requireDb();
      const user = userOf(request);
      const { applicationId, interviewId } = interviewIdsOf(request);
      await spendWrite(db, user, reply);
      if (!(await deleteInterview(db, user.id, applicationId, interviewId, request.clock.now())))
        throw interviewNotFound();
      return reply.code(204).send();
    },
  );
}
