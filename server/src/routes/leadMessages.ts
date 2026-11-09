import {
  characterCount,
  clipToLength,
  LEAD_MESSAGE_LIMITS,
  LeadMessageDraftSchema,
  LeadMessageRequestSchema,
  LeadMessageSentSchema,
  LeadNoteSchema,
  localDateIn,
  sentMessageNote,
  type LeadMessageAnswer,
} from '@jat/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { consumeRateLimit, rateLimitKey, type RateLimitRule } from '../auth/rateLimit';
import type { Clock } from '../clock';
import type { Db } from '../db/types';
import { ApiError, parseInput } from '../http/errors';
import { jobSearchAccess, type JobSearchAccessDeps } from '../jobsearch/access';
import type { LeadMessageModelRequest } from '../jobsearch/claude';
import { getApplication } from '../repo/applications';
import { getLead, recordLeadMessage } from '../repo/leads';
import { getResumeText } from '../repo/resumes';
import { AnalyzerUnavailableError } from '../resume/analyze';

const DAY_MS = 24 * 60 * 60 * 1000;

/** LinkedIn message drafts: one small model call each. */
export const LEAD_MESSAGE_RULE: RateLimitRule = {
  name: 'lead-message',
  limit: 30,
  windowMs: DAY_MS,
};

/** The notes about a lead the draft sees: the newest few, each cut short. */
const NOTES_FOR_DRAFT = 5;
const NOTE_CHARS_FOR_DRAFT = 1000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IdParams = z.object({ id: z.string() });

const applicationNotFound = () => new ApiError(404, 'not_found', 'Application not found');
const leadNotFound = () => new ApiError(404, 'not_found', 'Lead not found');

export interface LeadMessageRouteDeps extends JobSearchAccessDeps {
  clock: Clock;
}

/** Whether a draft is within LinkedIn's limits; if not, what was too long. */
function tooLong(answer: LeadMessageAnswer): string | null {
  const problems: string[] = [];
  const note = characterCount(answer.connectionNote.trim());
  const message = characterCount(answer.message.trim());
  if (note > LEAD_MESSAGE_LIMITS.connectionNote)
    problems.push(
      `the connection note was ${String(note)} characters (at most ${String(LEAD_MESSAGE_LIMITS.connectionNote)})`,
    );
  if (message > LEAD_MESSAGE_LIMITS.message)
    problems.push(
      `the message was ${String(message)} characters (at most ${String(LEAD_MESSAGE_LIMITS.message)})`,
    );
  return problems.length ? problems.join('; ') : null;
}

export function registerLeadMessageRoutes(app: FastifyInstance, deps: LeadMessageRouteDeps): void {
  const { memberOf } = jobSearchAccess(deps);
  const requireDb = (): Db => {
    if (!deps.db) throw new ApiError(503, 'unavailable', 'The service is not available');
    return deps.db;
  };
  const applicationIdOf = (request: FastifyRequest) => {
    const id = (request.params as { id?: string }).id;
    if (!id || !UUID.test(id)) throw applicationNotFound();
    return id.toLowerCase();
  };
  const spend = async (db: Db, subject: string, reply: FastifyReply) => {
    const result = await consumeRateLimit(
      db,
      rateLimitKey(LEAD_MESSAGE_RULE.name, subject),
      LEAD_MESSAGE_RULE,
      deps.clock.now(),
    );
    if (!result.allowed) {
      void reply.header('retry-after', String(result.retryAfterSeconds));
      throw new ApiError(429, 'rate_limited', 'You can draft 30 messages a day.');
    }
  };

  app.post(
    '/api/applications/:id/lead-message',
    {
      config: {
        auth: 'user',
        contract: {
          summary: 'Draft a LinkedIn connection note and message to a lead (stores nothing)',
          errors: {
            404: 'No such application or lead (or not yours), or not available',
            409: 'No resume uploaded yet',
            429: 'The daily limit is reached',
            502: 'The draft did not finish',
            503: 'The Anthropic key was rejected',
          },
          params: IdParams,
          body: LeadMessageRequestSchema,
          responses: { 200: LeadMessageDraftSchema },
        },
      },
    },
    async (request, reply) => {
      const db = requireDb();
      const { user, claude } = await memberOf(request);
      const input = parseInput(LeadMessageRequestSchema, request.body);
      const application = await getApplication(db, user.id, applicationIdOf(request));
      if (!application) throw applicationNotFound();
      const lead = await getLead(db, user.id, input.leadId);
      if (!lead) throw leadNotFound();
      const resume = await getResumeText(db, user.id);
      if (!resume) throw new ApiError(409, 'no_resume', 'Upload a resume first');
      await spend(db, user.id, reply);

      const { record } = application;
      const ask: LeadMessageModelRequest = {
        resumeText: resume.text,
        company: record.company,
        role: record.role,
        status: record.status,
        kind: input.kind,
        postingText: '',
        lead: { name: lead.name, company: lead.company },
        notes: lead.notes.slice(0, NOTES_FOR_DRAFT).map((note) => ({
          heldOn: note.heldOn,
          body: clipToLength(note.body, NOTE_CHARS_FOR_DRAFT),
        })),
        steer: input.steer,
      };
      let answer: LeadMessageAnswer | null;
      try {
        answer = await claude.leadMessage(ask);
        // Too long: asked once more, then cut at a sentence by code.
        const problem = answer ? tooLong(answer) : null;
        if (problem) answer = (await claude.leadMessage({ ...ask, tooLong: problem })) ?? answer;
      } catch (error) {
        if (error instanceof AnalyzerUnavailableError)
          throw new ApiError(503, 'unavailable', 'Drafting is not available right now');
        throw error;
      }
      if (!answer)
        throw new ApiError(502, 'draft_failed', 'The message did not finish. Try again.');
      return {
        leadId: lead.id,
        kind: input.kind,
        connectionNote: clipToLength(answer.connectionNote, LEAD_MESSAGE_LIMITS.connectionNote),
        message: clipToLength(answer.message, LEAD_MESSAGE_LIMITS.message),
      };
    },
  );

  app.post(
    '/api/applications/:id/lead-message/sent',
    {
      config: {
        auth: 'user',
        contract: {
          summary: 'Log a LinkedIn message as sent: a note on the lead, linked to the application',
          errors: {
            404: 'No such application or lead (or not yours), or not available',
            409: 'The lead has too many notes',
          },
          params: IdParams,
          body: LeadMessageSentSchema,
          responses: { 200: LeadNoteSchema },
        },
      },
    },
    async (request) => {
      const db = requireDb();
      const { user } = await memberOf(request);
      const input = parseInput(LeadMessageSentSchema, request.body);
      const applicationId = applicationIdOf(request);
      const application = await getApplication(db, user.id, applicationId);
      if (!application) throw applicationNotFound();
      const now = deps.clock.now();
      const result = await recordLeadMessage(
        db,
        user.id,
        applicationId,
        input.leadId,
        {
          heldOn: localDateIn(now, user.timeZone),
          body: sentMessageNote(application.record.company, application.record.role, input.text),
        },
        now,
      );
      if (result.kind === 'not_found') throw leadNotFound();
      if (result.kind === 'limit_reached')
        throw new ApiError(409, 'limit_reached', 'This lead has the most notes allowed');
      return result.value;
    },
  );
}
