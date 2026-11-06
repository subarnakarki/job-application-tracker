import {
  ApplicationDetailSchema,
  ApplicationInputSchema,
  ApplicationListSchema,
  ApplicationPatchSchema,
  ListQuerySchema,
  localDateIn,
  PipelineSchema,
  StatsSchema,
} from '@jat/shared';
import { z } from 'zod';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { consumeRateLimit, rateLimitKey, type RateLimitRule } from '../auth/rateLimit';
import type { Clock } from '../clock';
import type { Db } from '../db/types';
import { ApiError, parseInput } from '../http/errors';
import {
  createApplication,
  deleteApplication,
  getApplication,
  listApplications,
  pipelineCounts,
  updateApplication,
  type Owner,
} from '../repo/applications';
import { toCsv } from '../repo/csv';
import { presentApplication, presentDetail } from '../repo/present';
import { statsBySource } from '../repo/stats';

const PipelineQuery = z.strictObject({ q: ListQuerySchema.shape.q });

/** Path parameter as received: any string (a non-uuid simply answers 404). */
const IdParams = z.object({ id: z.string() });
const IfMatchHeaders = z.object({ 'if-match': z.string().optional() });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Per-user write budget: generous for real use, tighter for the shared demo account. */
export const WRITE_RULE: RateLimitRule = { name: 'writes', limit: 600, windowMs: 60 * 60 * 1000 };
export const DEMO_WRITE_RULE: RateLimitRule = {
  name: 'demo-writes',
  limit: 120,
  windowMs: 60 * 60 * 1000,
};

export interface ApplicationRouteDeps {
  db: Db | undefined;
  /** The app clock, for rate limits (infrastructure). Domain logic uses request.clock. */
  clock: Clock;
}

/** Same answer for "missing", "someone else's" and "not even an id", so ids cannot be probed. */
const notFound = () => new ApiError(404, 'not_found', 'Application not found');

export const etag = (version: number): string => `"${version}"`;

/** `If-Match: "3"` -> 3. Missing -> null. Anything else -> 'invalid'. */
export function parseIfMatch(header: string | string[] | undefined): number | null | 'invalid' {
  const value = Array.isArray(header) ? header[0] : header;
  if (value === undefined) return null;
  const match = /^"([1-9][0-9]{0,8})"$/.exec(value.trim());
  return match ? Number(match[1]) : 'invalid';
}

export function registerApplicationRoutes(app: FastifyInstance, deps: ApplicationRouteDeps): void {
  const requireDb = (): Db => {
    if (!deps.db) throw new ApiError(503, 'unavailable', 'The service is not available');
    return deps.db;
  };

  const ownerOf = (request: FastifyRequest): Owner => {
    const user = request.auth?.user;
    if (!user) throw new ApiError(401, 'unauthenticated', 'Sign in to continue');
    return { userId: user.id, isDemo: user.isDemo, timeZone: user.timeZone };
  };

  const idOf = (request: FastifyRequest): string => {
    const { id } = request.params as { id?: string };
    if (!id || !UUID.test(id)) throw notFound();
    return id.toLowerCase();
  };

  const spendWrite = async (db: Db, owner: Owner, reply: FastifyReply): Promise<void> => {
    const rule = owner.isDemo ? DEMO_WRITE_RULE : WRITE_RULE;
    const result = await consumeRateLimit(
      db,
      rateLimitKey(rule.name, owner.userId),
      rule,
      deps.clock.now(),
    );
    if (!result.allowed) {
      void reply.header('retry-after', String(result.retryAfterSeconds));
      throw new ApiError(429, 'rate_limited', 'Too many changes. Try again later.');
    }
  };

  const context = (request: FastifyRequest, owner: Owner) => ({
    now: request.clock.now(),
    timeZone: owner.timeZone,
  });

  app.get(
    '/api/applications',
    {
      config: {
        auth: 'user',
        contract: {
          summary: 'List applications (status and follow-up filters, search, sort)',
          query: ListQuerySchema,
          responses: { 200: ApplicationListSchema },
        },
      },
    },
    async (request) => {
      const db = requireDb();
      const owner = ownerOf(request);
      const query = parseInput(ListQuerySchema, { ...(request.query as object) });
      const records = await listApplications(db, owner, query, request.clock.now());
      const present = context(request, owner);
      return {
        items: records.map((record) => presentApplication(record, present)),
        total: records.length,
      };
    },
  );

  app.get(
    '/api/pipeline',
    {
      config: {
        auth: 'user',
        contract: {
          summary: 'Count per stage (respects the search, ignores any stage filter)',
          query: PipelineQuery,
          responses: { 200: PipelineSchema },
        },
      },
    },
    async (request) => {
      const db = requireDb();
      const owner = ownerOf(request);
      const { q } = parseInput(PipelineQuery, { ...(request.query as object) });
      return pipelineCounts(db, owner, q, request.clock.now());
    },
  );

  app.get(
    '/api/stats',
    {
      config: {
        auth: 'user',
        contract: {
          summary: 'How far applications from each source got (responses, interviews, offers)',
          responses: { 200: StatsSchema },
        },
      },
    },
    async (request) => statsBySource(requireDb(), ownerOf(request)),
  );

  app.get(
    '/api/applications/export.csv',
    {
      config: {
        auth: 'user',
        contract: {
          summary: 'Download the listed applications as CSV (same filters as the list)',
          query: ListQuerySchema,
          responses: { 200: { text: 'text/csv' } },
          errors: { 403: 'Not available to the demo account' },
        },
      },
    },
    async (request, reply) => {
      const db = requireDb();
      const owner = ownerOf(request);
      if (owner.isDemo)
        throw new ApiError(403, 'demo_restricted', 'The shared demo account cannot be exported');
      const query = parseInput(ListQuerySchema, { ...(request.query as object) });
      const now = request.clock.now();
      const records = await listApplications(db, owner, query, now);
      const present = context(request, owner);
      void reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header(
          'content-disposition',
          `attachment; filename="applications-${localDateIn(now, owner.timeZone)}.csv"`,
        );
      return toCsv(records.map((record) => presentApplication(record, present)));
    },
  );

  app.post(
    '/api/applications',
    {
      config: {
        auth: 'user',
        contract: {
          summary: 'Create an application',
          errors: { 409: 'The application quota is reached', 429: 'Too many changes' },
          body: ApplicationInputSchema,
          responses: { 201: ApplicationDetailSchema },
        },
      },
    },
    async (request, reply) => {
      const db = requireDb();
      const owner = ownerOf(request);
      const input = parseInput(ApplicationInputSchema, request.body);
      await spendWrite(db, owner, reply);

      const result = await createApplication(db, owner, input, request.clock.now());
      if (result.kind === 'limit_reached') {
        throw new ApiError(409, 'limit_reached', `You can keep up to ${result.limit} applications`);
      }
      if (result.kind === 'invalid')
        throw new ApiError(400, 'validation_error', 'The request is invalid', result.issues);
      void reply.code(201).header('location', `/api/applications/${result.value.record.id}`);
      void reply.header('etag', etag(result.value.record.version));
      return presentDetail(result.value, context(request, owner));
    },
  );

  app.get(
    '/api/applications/:id',
    {
      config: {
        auth: 'user',
        contract: {
          summary: 'One application with its history',
          errors: { 404: 'No such application (or not yours)' },
          params: IdParams,
          responses: { 200: ApplicationDetailSchema },
        },
      },
    },
    async (request, reply) => {
      const db = requireDb();
      const owner = ownerOf(request);
      const found = await getApplication(db, owner.userId, idOf(request));
      if (!found) throw notFound();
      void reply.header('etag', etag(found.record.version));
      return presentDetail(found, context(request, owner));
    },
  );

  app.patch(
    '/api/applications/:id',
    {
      config: {
        auth: 'user',
        contract: {
          summary: 'Edit an application (needs If-Match)',
          errors: {
            404: 'No such application (or not yours)',
            412: 'The version is stale; ETag holds the current one',
            428: 'If-Match is required',
            429: 'Too many changes',
          },
          params: IdParams,
          headers: IfMatchHeaders,
          body: ApplicationPatchSchema,
          responses: { 200: ApplicationDetailSchema },
        },
      },
    },
    async (request, reply) => {
      const db = requireDb();
      const owner = ownerOf(request);
      const id = idOf(request);
      const expected = parseIfMatch(request.headers['if-match']);
      if (expected === null) {
        throw new ApiError(
          428,
          'precondition_required',
          'Send If-Match with the version you are editing',
        );
      }
      if (expected === 'invalid')
        throw new ApiError(400, 'invalid_if_match', 'If-Match must look like "3"');
      const patch = parseInput(ApplicationPatchSchema, request.body);
      await spendWrite(db, owner, reply);

      const result = await updateApplication(db, owner, id, expected, patch, request.clock.now());
      switch (result.kind) {
        case 'not_found':
          throw notFound();
        case 'version_conflict':
          void reply.header('etag', etag(result.currentVersion));
          throw new ApiError(
            412,
            'version_conflict',
            'This application was changed elsewhere. Reload and try again.',
          );
        case 'invalid':
          throw new ApiError(400, 'validation_error', 'The request is invalid', result.issues);
        case 'unchanged':
        case 'updated':
          void reply.header('etag', etag(result.value.record.version));
          return presentDetail(result.value, context(request, owner));
      }
    },
  );

  app.delete(
    '/api/applications/:id',
    {
      config: {
        auth: 'user',
        contract: {
          summary: 'Delete an application',
          errors: { 404: 'No such application (or not yours)', 429: 'Too many changes' },
          params: IdParams,
          responses: { 204: null },
        },
      },
    },
    async (request, reply) => {
      const db = requireDb();
      const owner = ownerOf(request);
      const id = idOf(request);
      await spendWrite(db, owner, reply);
      if (!(await deleteApplication(db, owner.userId, id))) throw notFound();
      return reply.code(204).send();
    },
  );
}
