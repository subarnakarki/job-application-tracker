import {
  LeadDetailSchema,
  LeadInputSchema,
  LeadListSchema,
  LeadNoteInputSchema,
  LeadNotePatchSchema,
  LeadNoteSchema,
  LeadPatchSchema,
  localDateIn,
  noteDateProblem,
} from '@jat/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { consumeRateLimit, rateLimitKey } from '../auth/rateLimit';
import type { Clock } from '../clock';
import type { Db } from '../db/types';
import { ApiError, parseInput } from '../http/errors';
import {
  addLeadNote,
  createLead,
  deleteLead,
  deleteLeadNote,
  getLead,
  listLeads,
  updateLead,
  updateLeadNote,
} from '../repo/leads';
import { DEMO_WRITE_RULE, WRITE_RULE } from './applications';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Path parameters as received: any string (a non-uuid simply answers 404). */
const LeadParams = z.object({ id: z.string() });
const NoteParams = z.object({ id: z.string(), noteId: z.string() });
const ListQuery = z.strictObject({ q: z.string().max(200).optional() });

export interface LeadRouteDeps {
  db: Db | undefined;
  /** The app clock, for rate limits. Dates in the user's zone use request.clock. */
  clock: Clock;
}

const leadNotFound = () => new ApiError(404, 'not_found', 'Lead not found');
const noteNotFound = () => new ApiError(404, 'not_found', 'Note not found');

export function registerLeadRoutes(app: FastifyInstance, deps: LeadRouteDeps): void {
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
  const leadIdOf = (request: FastifyRequest) =>
    uuidParam((request.params as { id?: string }).id, leadNotFound);
  const noteIdsOf = (request: FastifyRequest) => ({
    leadId: leadIdOf(request),
    noteId: uuidParam((request.params as { noteId?: string }).noteId, noteNotFound),
  });

  const spendWrite = async (
    db: Db,
    user: { id: string; isDemo: boolean },
    reply: FastifyReply,
  ): Promise<void> => {
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

  /** A note is never dated after the user's own today. */
  const checkNoteDay = (request: FastifyRequest, heldOn: string | undefined, timeZone: string) => {
    if (heldOn === undefined) return;
    const problem = noteDateProblem(heldOn, localDateIn(request.clock.now(), timeZone));
    if (problem)
      throw new ApiError(400, 'validation_error', 'The request is invalid', [
        { path: 'heldOn', message: problem },
      ]);
  };

  app.get(
    '/api/leads',
    {
      config: {
        auth: 'user',
        contract: {
          summary: 'Every networking lead, by name (optionally searched)',
          query: ListQuery,
          responses: { 200: LeadListSchema },
        },
      },
    },
    async (request) => {
      const db = requireDb();
      const user = userOf(request);
      const { q } = parseInput(ListQuery, { ...(request.query as object) });
      const items = await listLeads(db, user.id, q);
      return { items, total: items.length };
    },
  );

  app.post(
    '/api/leads',
    {
      config: {
        auth: 'user',
        contract: {
          summary: 'Add a networking lead',
          errors: { 409: 'The lead quota is reached', 429: 'Too many changes' },
          body: LeadInputSchema,
          responses: { 201: LeadDetailSchema },
        },
      },
    },
    async (request, reply) => {
      const db = requireDb();
      const user = userOf(request);
      const input = parseInput(LeadInputSchema, request.body);
      await spendWrite(db, user, reply);
      const result = await createLead(
        db,
        { userId: user.id, isDemo: user.isDemo },
        input,
        request.clock.now(),
      );
      if (result.kind === 'limit_reached')
        throw new ApiError(409, 'limit_reached', `You can keep up to ${result.limit} leads`);
      void reply.code(201).header('location', `/api/leads/${result.value.id}`);
      return result.value;
    },
  );

  app.get(
    '/api/leads/:id',
    {
      config: {
        auth: 'user',
        contract: {
          summary: 'One lead with its notes and linked applications',
          errors: { 404: 'No such lead (or not yours)' },
          params: LeadParams,
          responses: { 200: LeadDetailSchema },
        },
      },
    },
    async (request) => {
      const db = requireDb();
      const user = userOf(request);
      const lead = await getLead(db, user.id, leadIdOf(request));
      if (!lead) throw leadNotFound();
      return lead;
    },
  );

  app.patch(
    '/api/leads/:id',
    {
      config: {
        auth: 'user',
        contract: {
          summary: 'Edit a lead',
          errors: { 404: 'No such lead (or not yours)', 429: 'Too many changes' },
          params: LeadParams,
          body: LeadPatchSchema,
          responses: { 200: LeadDetailSchema },
        },
      },
    },
    async (request, reply) => {
      const db = requireDb();
      const user = userOf(request);
      const id = leadIdOf(request);
      const patch = parseInput(LeadPatchSchema, request.body);
      await spendWrite(db, user, reply);
      const lead = await updateLead(db, user.id, id, patch, request.clock.now());
      if (!lead) throw leadNotFound();
      return lead;
    },
  );

  app.delete(
    '/api/leads/:id',
    {
      config: {
        auth: 'user',
        contract: {
          summary: 'Delete a lead and its notes (its applications stay, unlinked)',
          errors: { 404: 'No such lead (or not yours)', 429: 'Too many changes' },
          params: LeadParams,
          responses: { 204: null },
        },
      },
    },
    async (request, reply) => {
      const db = requireDb();
      const user = userOf(request);
      const id = leadIdOf(request);
      await spendWrite(db, user, reply);
      if (!(await deleteLead(db, user.id, id))) throw leadNotFound();
      return reply.code(204).send();
    },
  );

  app.post(
    '/api/leads/:id/notes',
    {
      config: {
        auth: 'user',
        contract: {
          summary: 'Add a note to a lead',
          errors: {
            404: 'No such lead (or not yours)',
            409: 'The note quota for this lead is reached',
            429: 'Too many changes',
          },
          params: LeadParams,
          body: LeadNoteInputSchema,
          responses: { 201: LeadNoteSchema },
        },
      },
    },
    async (request, reply) => {
      const db = requireDb();
      const user = userOf(request);
      const leadId = leadIdOf(request);
      const input = parseInput(LeadNoteInputSchema, request.body);
      checkNoteDay(request, input.heldOn, user.timeZone);
      await spendWrite(db, user, reply);
      const result = await addLeadNote(db, user.id, leadId, input, request.clock.now());
      if (result.kind === 'not_found') throw leadNotFound();
      if (result.kind === 'limit_reached')
        throw new ApiError(409, 'limit_reached', `A lead can keep up to ${result.limit} notes`);
      return reply.code(201).send(result.value);
    },
  );

  app.patch(
    '/api/leads/:id/notes/:noteId',
    {
      config: {
        auth: 'user',
        contract: {
          summary: 'Edit a note',
          errors: { 404: 'No such note (or not yours)', 429: 'Too many changes' },
          params: NoteParams,
          body: LeadNotePatchSchema,
          responses: { 200: LeadNoteSchema },
        },
      },
    },
    async (request, reply) => {
      const db = requireDb();
      const user = userOf(request);
      const { leadId, noteId } = noteIdsOf(request);
      const patch = parseInput(LeadNotePatchSchema, request.body);
      checkNoteDay(request, patch.heldOn, user.timeZone);
      await spendWrite(db, user, reply);
      const note = await updateLeadNote(db, user.id, leadId, noteId, patch, request.clock.now());
      if (!note) throw noteNotFound();
      return note;
    },
  );

  app.delete(
    '/api/leads/:id/notes/:noteId',
    {
      config: {
        auth: 'user',
        contract: {
          summary: 'Delete a note',
          errors: { 404: 'No such note (or not yours)', 429: 'Too many changes' },
          params: NoteParams,
          responses: { 204: null },
        },
      },
    },
    async (request, reply) => {
      const db = requireDb();
      const user = userOf(request);
      const { leadId, noteId } = noteIdsOf(request);
      await spendWrite(db, user, reply);
      if (!(await deleteLeadNote(db, user.id, leadId, noteId))) throw noteNotFound();
      return reply.code(204).send();
    },
  );
}
