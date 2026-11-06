import { PostingPreviewRequestSchema, PostingPreviewSchema } from '@jat/shared';
import type { FastifyInstance } from 'fastify';
import { consumeRateLimit, rateLimitKey, type RateLimitRule } from '../auth/rateLimit';
import type { Clock } from '../clock';
import type { Db } from '../db/types';
import { ApiError, parseInput } from '../http/errors';
import type { PageFetcher } from '../postings/fetchPage';
import { previewPosting, PreviewError, type PreviewFailure } from '../postings/preview';

export const PREVIEW_RULE: RateLimitRule = {
  name: 'posting-preview',
  limit: 60,
  windowMs: 60 * 60 * 1000,
};
export const DEMO_PREVIEW_RULE: RateLimitRule = {
  name: 'demo-posting-preview',
  limit: 20,
  windowMs: 60 * 60 * 1000,
};

const MESSAGES: Record<PreviewFailure, string> = {
  unsupported_site:
    "This site needs a sign-in to show its postings, so it can't be read here. Fill in the details by hand.",
  unreadable: "This page couldn't be read. Check the link, or fill in the details by hand.",
  no_posting_data: 'No job details were found on this page. Fill them in by hand.',
};

export interface PostingRouteDeps {
  db: Db | undefined;
  clock: Clock;
  fetchPage: PageFetcher;
}

export function registerPostingRoutes(app: FastifyInstance, deps: PostingRouteDeps): void {
  app.post(
    '/api/postings/preview',
    {
      config: {
        auth: 'user',
        contract: {
          summary: 'Read a job posting link for "Fill from link" (stores nothing)',
          errors: {
            422: 'The page could not be read, or has no job details',
            429: 'Too many previews',
          },
          body: PostingPreviewRequestSchema,
          responses: { 200: PostingPreviewSchema },
        },
      },
    },
    async (request, reply) => {
      const user = request.auth?.user;
      if (!deps.db || !user) throw new ApiError(503, 'unavailable', 'The service is not available');
      const { url } = parseInput(PostingPreviewRequestSchema, request.body);
      const rule = user.isDemo ? DEMO_PREVIEW_RULE : PREVIEW_RULE;
      const limit = await consumeRateLimit(
        deps.db,
        rateLimitKey(rule.name, user.id),
        rule,
        deps.clock.now(),
      );
      if (!limit.allowed) {
        void reply.header('retry-after', String(limit.retryAfterSeconds));
        throw new ApiError(429, 'rate_limited', 'Too many links read. Try again later.');
      }

      // Only the host and the outcome are logged: never the full link or what the page said.
      const host = new URL(url).hostname;
      try {
        const preview = await previewPosting(url, deps.fetchPage);
        request.log.info({ host, outcome: 'ok' }, 'posting preview');
        return preview;
      } catch (error) {
        if (!(error instanceof PreviewError)) throw error;
        request.log.info({ host, outcome: error.code }, 'posting preview');
        throw new ApiError(422, error.code, MESSAGES[error.code]);
      }
    },
  );
}
