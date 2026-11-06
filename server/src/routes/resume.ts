import {
  matchPosting,
  RESUME_LIMITS,
  ResumeMatchSchema,
  RESUME_MEDIA_TYPES,
  ResumeAnalysisListSchema,
  ResumeAnalysisSchema,
  ResumeEnvelopeSchema,
  ResumeSchema,
  ResumeUploadSchema,
} from '@jat/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { consumeRateLimit, rateLimitKey, type RateLimitRule } from '../auth/rateLimit';
import type { Clock } from '../clock';
import type { Db } from '../db/types';
import { ApiError, parseInput } from '../http/errors';
import type { PageFetcher } from '../postings/fetchPage';
import { PreviewError, type PreviewFailure } from '../postings/preview';
import { readPostingText } from '../postings/text';
import { getApplication } from '../repo/applications';
import { PREVIEW_RULE } from './postings';
import {
  deleteAnalysis,
  deleteResume,
  findRecentAnalysis,
  getAnalysis,
  getResume,
  getResumeFile,
  getResumeText,
  listAnalyses,
  saveAnalysis,
  saveResume,
} from '../repo/resumes';
import { AnalyzerUnavailableError, type ResumeAnalyzer } from '../resume/analyze';
import {
  extractResume,
  pastedResume,
  ResumeFileError,
  type ExtractedResume,
  type ResumeFileFailure,
} from '../resume/extract';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Each analysis is a paid model call, and signup is open: a cap per user and one for everyone. */
export const ANALYSIS_RULE: RateLimitRule = { name: 'resume-analysis', limit: 5, windowMs: DAY_MS };
export const ANALYSIS_GLOBAL_RULE: RateLimitRule = {
  name: 'resume-analysis-all',
  limit: 200,
  windowMs: DAY_MS,
};
export const UPLOAD_RULE: RateLimitRule = {
  name: 'resume-upload',
  limit: 20,
  windowMs: 60 * 60 * 1000,
};

/** The same resume text within this long gets the saved answer instead of a new call. */
export const REUSE_WINDOW_MS = DAY_MS;

/** A 2 MB file is about 2.8 MB as base64; the JSON around it is small. */
export const UPLOAD_BODY_LIMIT = 3 * 1024 * 1024;

const FILE_STATUS: Record<ResumeFileFailure, number> = {
  too_large: 413,
  unsupported_type: 415,
  unreadable: 422,
  too_many_pages: 422,
  no_text: 422,
};
const FILE_MESSAGES: Record<ResumeFileFailure, string> = {
  too_large: 'The file is over 2 MB. Save a smaller copy and try again.',
  unsupported_type: 'Upload a PDF or a Word (.docx) file, or paste the text.',
  unreadable: "This file couldn't be read. Save it again as PDF or .docx and try again.",
  too_many_pages: 'That file has more than 10 pages, which is more than a resume.',
  no_text:
    'No text was found. If this is a scanned image, export the resume from Word or Google Docs instead, or paste the text.',
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IdParams = z.object({ id: z.string() });

export interface ResumeRouteDeps {
  db: Db | undefined;
  clock: Clock;
  /** Null when there is no Anthropic key: uploads still work, analysis says it is off. */
  analyzer: ResumeAnalyzer | null;
  /** Reads job postings for "Check my resume" (the guarded fetcher). */
  fetchPage: PageFetcher;
}

const POSTING_MESSAGES: Record<PreviewFailure, string> = {
  unsupported_site:
    "This site needs a sign-in to show its postings, so it can't be read here. Use the company's own job page link.",
  unreadable: "The job link couldn't be read. Check it, or try again later.",
  no_posting_data: 'No job description was found at the job link.',
};

const notFound = () => new ApiError(404, 'not_found', 'Analysis not found');
const applicationNotFound = () => new ApiError(404, 'not_found', 'Application not found');
const demoRefused = () =>
  new ApiError(403, 'demo_restricted', 'The shared demo account cannot upload a resume');

export function registerResumeRoutes(app: FastifyInstance, deps: ResumeRouteDeps): void {
  const requireDb = (): Db => {
    if (!deps.db) throw new ApiError(503, 'unavailable', 'The service is not available');
    return deps.db;
  };
  const userOf = (request: FastifyRequest) => {
    const user = request.auth?.user;
    if (!user) throw new ApiError(401, 'unauthenticated', 'Sign in to continue');
    return user;
  };
  const idOf = (request: FastifyRequest): string => {
    const id = (request.params as { id?: string }).id;
    if (!id || !UUID.test(id)) throw notFound();
    return id.toLowerCase();
  };
  const spend = async (
    db: Db,
    rule: RateLimitRule,
    subject: string,
    reply: FastifyReply,
    message: string,
  ) => {
    const result = await consumeRateLimit(
      db,
      rateLimitKey(rule.name, subject),
      rule,
      deps.clock.now(),
    );
    if (!result.allowed) {
      void reply.header('retry-after', String(result.retryAfterSeconds));
      throw new ApiError(429, 'rate_limited', message);
    }
  };

  app.get(
    '/api/resume',
    {
      config: {
        auth: 'user',
        contract: {
          summary: 'The current resume (without its contents), and whether analysis is on',
          responses: { 200: ResumeEnvelopeSchema },
        },
      },
    },
    async (request) => {
      const user = userOf(request);
      return {
        resume: await getResume(requireDb(), user.id),
        analysisAvailable: deps.analyzer !== null,
      };
    },
  );

  app.put(
    '/api/resume',
    {
      // Only this route takes a file, so only it gets the larger body limit.
      bodyLimit: UPLOAD_BODY_LIMIT,
      config: {
        auth: 'user',
        contract: {
          summary: 'Upload or replace the resume: a PDF or DOCX as base64, or pasted text',
          errors: {
            403: 'Not available to the demo account',
            413: 'The file is over 2 MB',
            415: 'Not a PDF or DOCX file',
            422: 'The file has no readable text, or too many pages',
            429: 'Too many uploads',
          },
          body: ResumeUploadSchema,
          responses: { 200: ResumeSchema },
        },
      },
    },
    async (request, reply) => {
      const db = requireDb();
      const user = userOf(request);
      if (user.isDemo) throw demoRefused();
      const upload = parseInput(ResumeUploadSchema, request.body);
      await spend(db, UPLOAD_RULE, user.id, reply, 'Too many uploads. Try again later.');

      const file = upload.kind === 'file' ? Buffer.from(upload.dataBase64, 'base64') : null;
      let extracted: ExtractedResume;
      try {
        extracted =
          upload.kind === 'file' && file
            ? await extractResume(new Uint8Array(file))
            : pastedResume(upload.kind === 'text' ? upload.text : '');
      } catch (error) {
        if (!(error instanceof ResumeFileError)) throw error;
        // Only the outcome is logged, never the file or its text.
        request.log.info({ outcome: error.code }, 'resume upload');
        throw new ApiError(FILE_STATUS[error.code], error.code, FILE_MESSAGES[error.code]);
      }
      request.log.info(
        { outcome: 'ok', mediaType: extracted.mediaType, characters: extracted.text.length },
        'resume upload',
      );
      return saveResume(
        db,
        user.id,
        {
          fileName: upload.kind === 'file' ? upload.fileName : null,
          mediaType: extracted.mediaType,
          file,
          text: extracted.text,
          textSha256: extracted.textSha256,
        },
        deps.clock.now(),
      );
    },
  );

  app.delete(
    '/api/resume',
    {
      config: {
        auth: 'user',
        contract: {
          summary: 'Delete the stored resume (analyses are kept)',
          responses: { 204: null },
        },
      },
    },
    async (request, reply) => {
      const user = userOf(request);
      await deleteResume(requireDb(), user.id);
      return reply.code(204).send();
    },
  );

  app.get(
    '/api/resume/file',
    {
      config: {
        auth: 'user',
        contract: {
          summary: 'Download the stored resume file',
          errors: { 404: 'No resume file (none uploaded, or the text was pasted)' },
          responses: {
            200: { file: RESUME_MEDIA_TYPES.filter((type) => type !== 'text/plain') },
          },
        },
      },
    },
    async (request, reply) => {
      const user = userOf(request);
      const stored = await getResumeFile(requireDb(), user.id);
      if (!stored) throw new ApiError(404, 'not_found', 'No resume file');
      // Only plain characters in the header; the full name goes in the RFC 5987 form.
      const plain = stored.fileName.replace(/[^\w. -]/g, '_');
      return reply
        .header('content-type', stored.mediaType)
        .header(
          'content-disposition',
          `attachment; filename="${plain}"; filename*=UTF-8''${encodeURIComponent(stored.fileName)}`,
        )
        .send(stored.file);
    },
  );

  app.post(
    '/api/resume/analyses',
    {
      config: {
        auth: 'user',
        contract: {
          summary: 'Analyse the current resume: the 20 best-fit titles and their ATS keywords',
          errors: {
            403: 'Not available to the demo account',
            404: 'Analysis is not configured on this server',
            409: 'No resume uploaded yet',
            429: 'The daily analysis limit is reached',
            502: 'The analysis failed; nothing was saved',
            503: 'The Anthropic key was rejected',
          },
          responses: {
            200: ResumeAnalysisSchema.describe('The same resume was analysed in the last day'),
            201: ResumeAnalysisSchema,
          },
        },
      },
    },
    async (request, reply) => {
      const db = requireDb();
      const user = userOf(request);
      if (user.isDemo) throw demoRefused();
      // Not configured on this server (no Anthropic key): like Gmail import, the feature is absent.
      if (!deps.analyzer)
        throw new ApiError(404, 'not_available', 'Resume analysis is not available on this server');
      const resume = await getResumeText(db, user.id);
      if (!resume) throw new ApiError(409, 'no_resume', 'Upload a resume first');

      const now = deps.clock.now();
      const recent = await findRecentAnalysis(
        db,
        user.id,
        resume.textSha256,
        new Date(now.getTime() - REUSE_WINDOW_MS),
      );
      if (recent) return reply.code(200).send(recent);

      await spend(db, ANALYSIS_RULE, user.id, reply, 'You can analyse 5 resumes a day.');
      await spend(
        db,
        ANALYSIS_GLOBAL_RULE,
        'all',
        reply,
        'Resume analysis is busy today. Try again tomorrow.',
      );

      const started = Date.now();
      let outcome;
      try {
        outcome = await deps.analyzer.analyze(resume.text);
      } catch (error) {
        if (error instanceof AnalyzerUnavailableError) {
          request.log.error({ outcome: 'unavailable' }, 'resume analysis');
          throw new ApiError(503, 'unavailable', 'Resume analysis is not available right now');
        }
        throw error;
      }
      const ms = Date.now() - started;
      if (outcome.kind === 'failed') {
        request.log.warn({ outcome: 'failed', reason: outcome.reason, ms }, 'resume analysis');
        throw new ApiError(
          502,
          'analysis_failed',
          'The analysis did not finish. Nothing was saved; try again.',
        );
      }
      request.log.info(
        { outcome: 'ok', model: outcome.model, titles: outcome.result.titles.length, ms },
        'resume analysis',
      );
      const saved = await saveAnalysis(
        db,
        user.id,
        {
          fileName: resume.fileName,
          textSha256: resume.textSha256,
          result: outcome.result,
          model: outcome.model,
        },
        deps.clock.now(),
      );
      void reply.code(201).header('location', `/api/resume/analyses/${saved.id}`);
      return saved;
    },
  );

  app.get(
    '/api/resume/analyses',
    {
      config: {
        auth: 'user',
        contract: {
          summary: `The saved analyses, newest first (at most ${String(RESUME_LIMITS.analysesKept)})`,
          responses: { 200: ResumeAnalysisListSchema },
        },
      },
    },
    async (request) => {
      const user = userOf(request);
      return { items: await listAnalyses(requireDb(), user.id) };
    },
  );

  app.get(
    '/api/resume/analyses/:id',
    {
      config: {
        auth: 'user',
        contract: {
          summary: 'One saved analysis',
          params: IdParams,
          errors: { 404: 'No such analysis' },
          responses: { 200: ResumeAnalysisSchema },
        },
      },
    },
    async (request) => {
      const user = userOf(request);
      const analysis = await getAnalysis(requireDb(), user.id, idOf(request));
      if (!analysis) throw notFound();
      return analysis;
    },
  );

  app.delete(
    '/api/resume/analyses/:id',
    {
      config: {
        auth: 'user',
        contract: {
          summary: 'Delete a saved analysis',
          params: IdParams,
          errors: { 404: 'No such analysis' },
          responses: { 204: null },
        },
      },
    },
    async (request, reply) => {
      const user = userOf(request);
      if (!(await deleteAnalysis(requireDb(), user.id, idOf(request)))) throw notFound();
      return reply.code(204).send();
    },
  );

  app.post(
    '/api/applications/:id/resume-match',
    {
      config: {
        auth: 'user',
        contract: {
          summary: "Check the resume against the application's job posting (stores nothing)",
          errors: {
            403: 'Not available to the demo account',
            404: 'No such application (or not yours), or analysis is not configured',
            409: 'No resume uploaded yet',
            422: 'The application has no job link, or the posting could not be read',
            429: 'The daily analysis limit or the link-reading limit is reached',
            502: 'The posting could not be analysed',
            503: 'The Anthropic key was rejected',
          },
          params: IdParams,
          responses: { 200: ResumeMatchSchema },
        },
      },
    },
    async (request, reply) => {
      const db = requireDb();
      const user = userOf(request);
      const id = (request.params as { id?: string }).id;
      if (!id || !UUID.test(id)) throw applicationNotFound();
      const found = await getApplication(db, user.id, id.toLowerCase());
      if (!found) throw applicationNotFound();
      if (user.isDemo) throw demoRefused();
      if (!deps.analyzer)
        throw new ApiError(404, 'not_available', 'Resume analysis is not available on this server');
      const jobLink = found.record.jobLink;
      if (!jobLink)
        throw new ApiError(
          422,
          'no_job_link',
          'Add the job posting link to this application first',
        );
      const resume = await getResumeText(db, user.id);
      if (!resume) throw new ApiError(409, 'no_resume', 'Upload a resume first');

      await spend(db, PREVIEW_RULE, user.id, reply, 'Too many links read. Try again later.');
      let postingText: string;
      const host = new URL(jobLink).hostname;
      try {
        postingText = await readPostingText(jobLink, deps.fetchPage);
      } catch (error) {
        if (!(error instanceof PreviewError)) throw error;
        request.log.info({ host, outcome: error.code }, 'resume match');
        throw new ApiError(422, error.code, POSTING_MESSAGES[error.code]);
      }

      await spend(db, ANALYSIS_RULE, user.id, reply, 'You can run 5 resume checks a day.');
      await spend(
        db,
        ANALYSIS_GLOBAL_RULE,
        'all',
        reply,
        'Resume analysis is busy today. Try again tomorrow.',
      );
      let outcome;
      try {
        outcome = await deps.analyzer.postingKeywords(postingText);
      } catch (error) {
        if (error instanceof AnalyzerUnavailableError)
          throw new ApiError(503, 'unavailable', 'Resume analysis is not available right now');
        throw error;
      }
      const match = outcome.kind === 'keywords' ? matchPosting(outcome.answer, resume.text) : null;
      if (outcome.kind !== 'keywords' || !match) {
        request.log.warn(
          { host, outcome: 'failed', reason: outcome.kind === 'failed' ? outcome.reason : 'few' },
          'resume match',
        );
        throw new ApiError(
          502,
          'analysis_failed',
          "The posting's keywords could not be read. Try again later.",
        );
      }
      request.log.info({ host, outcome: 'ok', keywords: match.keywords.length }, 'resume match');
      return { jobLink, model: outcome.model, ...match };
    },
  );
}
