import {
  ApplicationCoverLetterSchema,
  clipToLength,
  COVER_LETTER_LIMITS,
  coverLetterTooLong,
  DraftCoverLetterSchema,
  greetingFor,
  pickPosting,
  SaveCoverLetterSchema,
  type CoverLetterAnswer,
} from '@jat/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { consumeRateLimit, rateLimitKey, type RateLimitRule } from '../auth/rateLimit';
import type { Clock } from '../clock';
import type { Db } from '../db/types';
import { ApiError, parseInput } from '../http/errors';
import { jobSearchAccess, type JobSearchAccessDeps } from '../jobsearch/access';
import type { CoverLetterModelRequest } from '../jobsearch/claude';
import type { PageFetcher } from '../postings/fetchPage';
import { PreviewError, type PreviewFailure } from '../postings/preview';
import { readPostingText } from '../postings/text';
import { getApplication } from '../repo/applications';
import {
  getCoverLetter,
  presentCoverLetter,
  removeCoverLetter,
  saveDraft,
  saveLetter,
} from '../repo/coverLetters';
import { getResumeText } from '../repo/resumes';
import { getTailoring } from '../repo/tailorings';
import { AnalyzerUnavailableError } from '../resume/analyze';
import { PREVIEW_RULE } from './postings';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Cover letter drafts: one model call each (two when the first runs long). */
export const COVER_LETTER_RULE: RateLimitRule = {
  name: 'cover-letter',
  limit: 20,
  windowMs: DAY_MS,
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IdParams = z.object({ id: z.string() });

const POSTING_MESSAGES: Record<PreviewFailure, string> = {
  unsupported_site:
    "This site needs a sign-in, so the posting can't be read here. Paste it instead.",
  unreadable: "The job link couldn't be read. Paste the posting instead.",
  no_posting_data: 'No job description was found at the job link. Paste the posting instead.',
};

const applicationNotFound = () => new ApiError(404, 'not_found', 'Application not found');

export interface CoverLetterRouteDeps extends JobSearchAccessDeps {
  clock: Clock;
  /** Reads the job link (the guarded fetcher). */
  fetchPage: PageFetcher;
}

/**
 * "Draft cover letter" on any application (Phase 23): a letter from the posting (pasted, stored,
 * or read from the job link) and the resume, in the length and tone chosen; saved as edited.
 * Owner-only, like the job search.
 */
export function registerCoverLetterRoutes(app: FastifyInstance, deps: CoverLetterRouteDeps): void {
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
  const spend = async (
    db: Db,
    rule: RateLimitRule,
    userId: string,
    reply: FastifyReply,
    message: string,
  ) => {
    const result = await consumeRateLimit(
      db,
      rateLimitKey(rule.name, userId),
      rule,
      deps.clock.now(),
    );
    if (!result.allowed) {
      void reply.header('retry-after', String(result.retryAfterSeconds));
      throw new ApiError(429, 'rate_limited', message);
    }
  };
  /** The user's application (404 otherwise), the user, and their Claude. */
  const context = async (request: FastifyRequest) => {
    const db = requireDb();
    const { user, claude } = await memberOf(request);
    const applicationId = applicationIdOf(request);
    const application = await getApplication(db, user.id, applicationId);
    if (!application) throw applicationNotFound();
    return { db, user, claude, applicationId, application };
  };
  /** The letter as the API shows it, with whether a posting is stored for drafting again. */
  const present = async (db: Db, userId: string, applicationId: string) => {
    const stored = await getCoverLetter(db, userId, applicationId);
    const hasPostingText =
      Boolean(stored?.postingText) ||
      Boolean((await getTailoring(db, userId, applicationId))?.postingText);
    const resume = await getResumeText(db, userId);
    return presentCoverLetter(stored, hasPostingText, resume?.textSha256 ?? null);
  };
  const contract = (summary: string, errors: Record<number, string>, body?: z.ZodType) => ({
    auth: 'user' as const,
    contract: {
      summary,
      params: IdParams,
      ...(body ? { body } : {}),
      errors: { 404: 'No such application (or not yours), or not available', ...errors },
      responses: { 200: ApplicationCoverLetterSchema },
    },
  });

  app.get(
    '/api/applications/:id/cover-letter',
    { config: contract("The application's cover letter, if any", {}) },
    async (request) => {
      const { db, user, applicationId } = await context(request);
      return present(db, user.id, applicationId);
    },
  );

  app.post(
    '/api/applications/:id/cover-letter/draft',
    {
      config: contract(
        'Draft a cover letter for this application, in the length and tone chosen',
        {
          409: 'No resume uploaded yet',
          422: 'No job link, or the posting could not be read: paste it',
          429: 'Too many drafts today, or too many links read',
          502: 'The draft did not finish',
          503: 'The Anthropic key was rejected',
        },
        DraftCoverLetterSchema,
      ),
    },
    async (request, reply) => {
      const { db, user, claude, applicationId, application } = await context(request);
      const input = parseInput(DraftCoverLetterSchema, request.body ?? {});
      const resume = await getResumeText(db, user.id);
      if (!resume) throw new ApiError(409, 'no_resume', 'Upload your resume first');

      const stored = await getCoverLetter(db, user.id, applicationId);
      const picked = pickPosting({
        pasted: input.postingText,
        stored: stored?.postingText,
        tailoring: (await getTailoring(db, user.id, applicationId))?.postingText,
      });
      let postingText = picked?.text ?? null;
      if (!postingText) {
        const jobLink = application.record.jobLink;
        if (!jobLink)
          throw new ApiError(
            422,
            'no_job_link',
            'This application has no job link. Paste the posting.',
          );
        await spend(db, PREVIEW_RULE, user.id, reply, 'Too many links read. Try again later.');
        try {
          postingText = await readPostingText(jobLink, deps.fetchPage);
        } catch (error) {
          if (!(error instanceof PreviewError)) throw error;
          request.log.info(
            { host: new URL(jobLink).hostname, outcome: error.code },
            'cover letter',
          );
          throw new ApiError(422, 'posting_unreadable', POSTING_MESSAGES[error.code]);
        }
      }
      postingText = [...postingText].slice(0, COVER_LETTER_LIMITS.postingText).join('');

      await spend(
        db,
        COVER_LETTER_RULE,
        user.id,
        reply,
        `You can draft ${String(COVER_LETTER_RULE.limit)} cover letters a day.`,
      );
      const { record } = application;
      const ask: CoverLetterModelRequest = {
        resumeText: resume.text,
        company: record.company,
        role: record.role,
        postingText,
        greeting: greetingFor(record.contact),
        length: input.length,
        tone: input.tone,
        steer: input.steer,
      };
      let answer: CoverLetterAnswer | null;
      try {
        answer = await claude.coverLetter(ask);
        // Too long: asked once more, then cut at a sentence by code if still over the limit.
        const problem = answer ? coverLetterTooLong(answer.letter, input.length) : null;
        if (problem) answer = (await claude.coverLetter({ ...ask, tooLong: problem })) ?? answer;
      } catch (error) {
        if (error instanceof AnalyzerUnavailableError)
          throw new ApiError(503, 'unavailable', 'Drafting is not available right now');
        throw error;
      }
      const text = answer ? clipToLength(answer.letter, COVER_LETTER_LIMITS.letter) : '';
      if (!text)
        throw new ApiError(502, 'draft_failed', 'The cover letter did not finish. Try again.');

      await saveDraft(
        db,
        user.id,
        applicationId,
        {
          text,
          // Kept only when it is new: pasted now or read from the link.
          postingText: picked?.source === 'stored' ? null : postingText,
          steer: input.steer,
          length: input.length,
          tone: input.tone,
          resumeSha256: resume.textSha256,
        },
        deps.clock.now(),
      );
      return present(db, user.id, applicationId);
    },
  );

  app.put(
    '/api/applications/:id/cover-letter',
    { config: contract('Save the cover letter as edited', {}, SaveCoverLetterSchema) },
    async (request) => {
      const { db, user, applicationId } = await context(request);
      const { text } = parseInput(SaveCoverLetterSchema, request.body);
      await saveLetter(db, user.id, applicationId, text, deps.clock.now());
      return present(db, user.id, applicationId);
    },
  );

  app.delete(
    '/api/applications/:id/cover-letter',
    { config: contract('Remove the cover letter (and the posting stored with it)', {}) },
    async (request) => {
      const { db, user, applicationId } = await context(request);
      await removeCoverLetter(db, user.id, applicationId);
      return present(db, user.id, applicationId);
    },
  );
}
