import {
  acceptTailoring,
  APPLICATION_TAILOR_LIMITS,
  ApplicationTailoringSchema,
  lineEdits,
  LineEditSchema,
  matchPosting,
  POSTING_KEYWORDS_MAX,
  SaveTailoredResumeSchema,
  TailorApplicationSchema,
} from '@jat/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { consumeRateLimit, rateLimitKey, type RateLimitRule } from '../auth/rateLimit';
import type { Clock } from '../clock';
import type { Db } from '../db/types';
import { ApiError, parseInput } from '../http/errors';
import { jobSearchAccess, type JobSearchAccessDeps } from '../jobsearch/access';
import { JOB_SEARCH_MODEL } from '../jobsearch/claude';
import type { PageFetcher } from '../postings/fetchPage';
import { PreviewError, type PreviewFailure } from '../postings/preview';
import { readPostingText } from '../postings/text';
import { getApplication } from '../repo/applications';
import { getResumeText } from '../repo/resumes';
import {
  getTailoring,
  presentTailoring,
  removeVersion,
  saveSuggestions,
  saveVersion,
} from '../repo/tailorings';
import { AnalyzerUnavailableError } from '../resume/analyze';
import { TAILOR_RULE } from './jobSearch';
import { PREVIEW_RULE } from './postings';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IdParams = z.object({ id: z.string() });
const MAX_EDIT = LineEditSchema.shape.original.maxLength ?? 2400;

const POSTING_MESSAGES: Record<PreviewFailure, string> = {
  unsupported_site:
    "This site needs a sign-in, so the posting can't be read here. Paste it instead.",
  unreadable: "The job link couldn't be read. Paste the posting instead.",
  no_posting_data: 'No job description was found at the job link. Paste the posting instead.',
};

const applicationNotFound = () => new ApiError(404, 'not_found', 'Application not found');

export interface TailoringRouteDeps extends JobSearchAccessDeps {
  clock: Clock;
  /** Reads the job link (the guarded fetcher). */
  fetchPage: PageFetcher;
}

/**
 * "Tailor my resume" on any application (Phase 18c): suggestions from the posting (read from the
 * job link, or pasted), the posting's keywords for the fit, and the version the owner saves for
 * this job. Owner-only, like the job search.
 */
export function registerTailoringRoutes(app: FastifyInstance, deps: TailoringRouteDeps): void {
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
  const contract = (summary: string, errors: Record<number, string>, body?: z.ZodType) => ({
    auth: 'user' as const,
    contract: {
      summary,
      params: IdParams,
      ...(body ? { body } : {}),
      errors: { 404: 'No such application (or not yours), or not available', ...errors },
      responses: { 200: ApplicationTailoringSchema },
    },
  });

  app.get(
    '/api/applications/:id/tailoring',
    {
      config: contract(
        "The application's tailoring: the last suggestions and the saved version",
        {},
      ),
    },
    async (request) => {
      const { db, user, applicationId } = await context(request);
      const resume = await getResumeText(db, user.id);
      return presentTailoring(
        await getTailoring(db, user.id, applicationId),
        resume?.textSha256 ?? null,
      );
    },
  );

  app.post(
    '/api/applications/:id/tailor',
    {
      config: contract(
        'Tailor my resume for this application: suggested edits and the posting keywords',
        {
          409: 'No resume uploaded yet',
          422: 'No job link, or the posting could not be read: paste it',
          429: 'Too many tailorings today, or too many links read',
          502: 'The suggestions did not finish',
          503: 'The Anthropic key was rejected',
        },
        TailorApplicationSchema,
      ),
    },
    async (request, reply) => {
      const { db, user, claude, applicationId, application } = await context(request);
      const input = parseInput(TailorApplicationSchema, request.body ?? {});
      const resume = await getResumeText(db, user.id);
      if (!resume) throw new ApiError(409, 'no_resume', 'Upload your resume first');
      const stored = await getTailoring(db, user.id, applicationId);

      // A pasted posting, else the one already read for this job, else the job link.
      let postingText = input.postingText ?? stored?.postingText ?? null;
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
          request.log.info({ host: new URL(jobLink).hostname, outcome: error.code }, 'tailor');
          throw new ApiError(422, 'posting_unreadable', POSTING_MESSAGES[error.code]);
        }
      }
      postingText = [...postingText].slice(0, APPLICATION_TAILOR_LIMITS.postingText).join('');

      await spend(db, TAILOR_RULE, user.id, reply, 'You can tailor 10 times a day.');
      let answer;
      try {
        answer = await claude.tailorPosting({
          resumeText: resume.text,
          company: application.record.company,
          role: application.record.role,
          postingText,
        });
      } catch (error) {
        if (error instanceof AnalyzerUnavailableError)
          throw new ApiError(503, 'unavailable', 'Tailoring is not available right now');
        throw error;
      }
      if (!answer)
        throw new ApiError(502, 'tailor_failed', 'The suggestions did not finish. Try again.');

      // The keywords as the fit score reads them: deduplicated and clipped, by code.
      const keywords = (
        matchPosting({ keywords: answer.keywords }, resume.text)?.keywords ??
        answer.keywords.map((keyword) => ({ ...keyword, term: keyword.term.trim().slice(0, 100) }))
      )
        .filter((keyword) => keyword.term)
        .slice(0, POSTING_KEYWORDS_MAX)
        .map((keyword) => ({ term: keyword.term, group: keyword.group }));
      const now = deps.clock.now();
      await saveSuggestions(
        db,
        user.id,
        applicationId,
        {
          tailoring: {
            ...acceptTailoring(answer, resume.text, keywords),
            model: JOB_SEARCH_MODEL,
            createdAt: now.toISOString(),
          },
          keywords,
          postingText,
        },
        now,
      );
      return presentTailoring(await getTailoring(db, user.id, applicationId), resume.textSha256);
    },
  );

  app.put(
    '/api/applications/:id/tailored-resume',
    {
      config: contract(
        "Save this job's resume: the edited text, with its changes from the resume",
        { 409: 'No resume uploaded yet' },
        SaveTailoredResumeSchema,
      ),
    },
    async (request) => {
      const { db, user, applicationId } = await context(request);
      const { text } = parseInput(SaveTailoredResumeSchema, request.body);
      const resume = await getResumeText(db, user.id);
      if (!resume) throw new ApiError(409, 'no_resume', 'Upload your resume first');
      const edits = lineEdits(resume.text, text)
        .slice(0, APPLICATION_TAILOR_LIMITS.savedEdits)
        .map((edit) => ({
          original: edit.original.slice(0, MAX_EDIT),
          replacement: edit.replacement.slice(0, MAX_EDIT),
        }));
      await saveVersion(
        db,
        user.id,
        applicationId,
        { text, edits, resumeSha256: resume.textSha256 },
        deps.clock.now(),
      );
      return presentTailoring(await getTailoring(db, user.id, applicationId), resume.textSha256);
    },
  );

  app.delete(
    '/api/applications/:id/tailored-resume',
    { config: contract("Remove this job's saved resume (the suggestions stay)", {}) },
    async (request) => {
      const { db, user, applicationId } = await context(request);
      await removeVersion(db, user.id, applicationId, deps.clock.now());
      const resume = await getResumeText(db, user.id);
      return presentTailoring(
        await getTailoring(db, user.id, applicationId),
        resume?.textSha256 ?? null,
      );
    },
  );
}
