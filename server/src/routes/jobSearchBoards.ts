import {
  boardRefOf,
  WatchBoardSchema,
  WatchedBoardListSchema,
  WatchedBoardSchema,
  type WatchedBoard,
} from '@jat/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { consumeRateLimit, rateLimitKey, type RateLimitRule } from '../auth/rateLimit';
import type { Clock } from '../clock';
import type { Db } from '../db/types';
import { ApiError, parseInput } from '../http/errors';
import { jobSearchAccess, type JobSearchAccessDeps } from '../jobsearch/access';
import { companyFromSlug } from '../jobsearch/readJob';
import { readWorkdayBoard, workdayBoardOf } from '../jobsearch/workday';
import { BOARD_SOURCES, BOARDS, type BoardSource } from '../postings/boards';
import type { PageFetcher } from '../postings/fetchPage';
import {
  countWatchedBoards,
  unwatchBoard,
  watchBoard,
  watchedBoards,
  type WatchedBoardRow,
} from '../repo/jobSearch';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IdParams = z.object({ id: z.string() });
const DAY_MS = 24 * 60 * 60 * 1000;

/** Companies added by hand: each add reads the board once. */
export const WATCH_RULE: RateLimitRule = { name: 'job-search-watch', limit: 40, windowMs: DAY_MS };
/** Boards one user may watch: the hourly sweep reads them all. */
export const MAX_WATCHED_BOARDS = 500;

const boardNotFound = () => new ApiError(404, 'not_found', 'Company not found');
const isListable = (source: string): source is BoardSource =>
  (BOARD_SOURCES as readonly string[]).includes(source);

const present = (row: WatchedBoardRow): WatchedBoard => ({
  id: row.id,
  source: row.source,
  board: row.board,
  // A Workday board is "tenant.wd5/site": the tenant is the company.
  company: companyFromSlug(
    row.source === 'workday' ? (row.board.split('.')[0] ?? row.board) : row.board,
  ),
  addedBy: row.addedBy,
  lastSweptAt: row.lastSweptAt?.toISOString() ?? null,
  lastError: row.lastError,
});

export interface JobSearchBoardRouteDeps extends JobSearchAccessDeps {
  clock: Clock;
  /** Reads a board's list (the guarded fetcher). */
  fetchBoard: PageFetcher;
}

/**
 * The companies whose boards the hourly sweep reads (Phase 22c): those the searches found, and
 * those the owner adds by pasting a link. Owner-only, like the job search.
 */
export function registerJobSearchBoardRoutes(
  app: FastifyInstance,
  deps: JobSearchBoardRouteDeps,
): void {
  const { memberOf } = jobSearchAccess(deps);
  const requireDb = (): Db => {
    if (!deps.db) throw new ApiError(503, 'unavailable', 'The service is not available');
    return deps.db;
  };
  const idOf = (request: FastifyRequest) => {
    const id = (request.params as { id?: string }).id;
    if (!id || !UUID.test(id)) throw boardNotFound();
    return id.toLowerCase();
  };

  app.get(
    '/api/job-search/boards',
    {
      config: {
        auth: 'user',
        contract: {
          summary:
            'The companies whose boards are read every hour, the ones read longest ago first',
          errors: { 404: 'Not available to this account' },
          responses: { 200: WatchedBoardListSchema },
        },
      },
    },
    async (request) => {
      const db = requireDb();
      const { user } = await memberOf(request);
      const rows = await watchedBoards(db, user.id, MAX_WATCHED_BOARDS, [
        ...BOARD_SOURCES,
        'workday',
      ]);
      return { items: rows.map(present), total: await countWatchedBoards(db, user.id) };
    },
  );

  app.post(
    '/api/job-search/boards',
    {
      config: {
        auth: 'user',
        contract: {
          summary:
            "Watch a company: a link to its careers board or to any of its jobs; the board's list is read once to check it",
          errors: {
            404: 'Not available to this account',
            409: 'Too many companies watched',
            422: 'Not a board that can be read, or it could not be read',
            429: 'Too many companies added today',
          },
          body: WatchBoardSchema,
          responses: { 201: WatchedBoardSchema },
        },
      },
    },
    async (request, reply) => {
      const db = requireDb();
      const { user } = await memberOf(request);
      const { link } = parseInput(WatchBoardSchema, request.body);
      // A Workday site is named by its host and site (one company may run several).
      const workday = workdayBoardOf(link);
      const ref = workday ? { source: 'workday' as const, board: workday } : boardRefOf(link);
      if (!ref || !(isListable(ref.source) || workday))
        throw new ApiError(
          422,
          'unsupported_board',
          'Paste a link to a Greenhouse, Lever, Ashby or Workday careers board, or to one of the company’s jobs',
        );
      const spent = await consumeRateLimit(
        db,
        rateLimitKey(WATCH_RULE.name, user.id),
        WATCH_RULE,
        deps.clock.now(),
      );
      if (!spent.allowed) {
        void reply.header('retry-after', String(spent.retryAfterSeconds));
        throw new ApiError(
          429,
          'rate_limited',
          'That limit is reached for today. Try again tomorrow.',
        );
      }
      if ((await countWatchedBoards(db, user.id)) >= MAX_WATCHED_BOARDS)
        throw new ApiError(409, 'too_many_boards', 'Remove a company before adding another');
      // Read once: a mistyped company would otherwise fail silently every hour.
      try {
        if (workday) {
          await readWorkdayBoard(
            workday,
            { wanted: [], skipped: [], timeframeDays: 1, now: deps.clock.now() },
            deps.fetchBoard,
          );
        } else if (isListable(ref.source)) {
          const spec = BOARDS[ref.source];
          const url = spec.listUrl(ref.board);
          if (!url) throw new Error('no list');
          spec.parseList((await deps.fetchBoard(url)).text, ref.board);
        }
      } catch {
        throw new ApiError(
          422,
          'board_unreadable',
          'That company’s board could not be read. Check the link.',
        );
      }
      const row = await watchBoard(db, user.id, ref, 'user', deps.clock.now());
      if (!row) throw boardNotFound();
      void reply.code(201);
      return present(row);
    },
  );

  app.delete(
    '/api/job-search/boards/:id',
    {
      config: {
        auth: 'user',
        contract: {
          summary: 'Stop watching a company (jobs already found stay)',
          params: IdParams,
          errors: { 404: 'No such company (or not yours), or not available' },
          responses: { 204: null },
        },
      },
    },
    async (request, reply) => {
      const db = requireDb();
      const { user } = await memberOf(request);
      if (!(await unwatchBoard(db, user.id, idOf(request)))) throw boardNotFound();
      return reply.code(204).send();
    },
  );
}
