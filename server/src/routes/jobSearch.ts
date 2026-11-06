import { createHash, timingSafeEqual } from 'node:crypto';
import {
  ApplicationInputSchema,
  ApplyQueueSchema,
  BlockHitSchema,
  DraftEditSchema,
  isRunDue,
  JobHitSchema,
  JobSearchProfileSchema,
  JobSearchRunDetailSchema,
  JobSearchRunListSchema,
  JobSearchSetupSchema,
  localDateIn,
  SOURCE_LABELS,
  type DraftAnswer,
  type JobHit,
  type JobSearchProfile,
} from '@jat/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { consumeRateLimit, rateLimitKey, type RateLimitRule } from '../auth/rateLimit';
import type { Clock } from '../clock';
import type { Db } from '../db/types';
import { ApiError, parseInput } from '../http/errors';
import type { JobSearchClaude } from '../jobsearch/claude';
import { draftHit, draftPending, runJobSearch } from '../jobsearch/run';
import type { PageFetcher } from '../postings/fetchPage';
import { createApplication } from '../repo/applications';
import {
  getHit,
  getProfile,
  getRun,
  lastScheduledRunDay,
  listOpenHits,
  listRunHits,
  listRuns,
  saveDraft,
  saveProfile,
  setHitState,
} from '../repo/jobSearch';
import { getResume, getResumeText } from '../repo/resumes';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Runs by hand: the schedule is the normal way, so a few a day is plenty. */
export const MANUAL_RUN_RULE: RateLimitRule = {
  name: 'job-search-run',
  limit: 3,
  windowMs: DAY_MS,
};
/** Every run of every user: a ceiling on web search and drafting spend. */
export const ALL_RUNS_RULE: RateLimitRule = { name: 'job-search-all', limit: 50, windowMs: DAY_MS };
/** Single drafts (re-draft, move to queue). */
export const DRAFT_RULE: RateLimitRule = { name: 'job-search-draft', limit: 30, windowMs: DAY_MS };

/** Stop starting new work this long after a request began (the function limit is 300 s). */
export const RUN_BUDGET_MS = 240_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IdParams = z.object({ id: z.string() });
const CronResultSchema = z.strictObject({
  started: z.number().int().min(0),
  drafted: z.number().int().min(0),
});

export interface JobSearchRouteDeps {
  db: Db | undefined;
  clock: Clock;
  env: Record<string, string | undefined>;
  /** Null without an Anthropic key: the feature is off. */
  claude: JobSearchClaude | null;
  fetchPage: PageFetcher;
  fetchBoard: PageFetcher;
}

/** Owner-only at first: the users listed in JOB_SEARCH_USER_IDS (comma-separated ids). */
export function allowedUserIds(env: Record<string, string | undefined>): Set<string> {
  return new Set(
    (env['JOB_SEARCH_USER_IDS'] ?? '')
      .split(',')
      .map((id) => id.trim().toLowerCase())
      .filter((id) => UUID.test(id)),
  );
}

/** Constant-time comparison of the cron secret, by hash so the lengths always match. */
export function secretMatches(given: string | undefined, expected: string | undefined): boolean {
  if (!given || !expected || expected.length < 32) return false;
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(given), digest(expected));
}

const notAvailable = () =>
  new ApiError(404, 'not_available', 'The job search is not available for this account');
const runNotFound = () => new ApiError(404, 'not_found', 'Run not found');
const hitNotFound = () => new ApiError(404, 'not_found', 'Job not found');

export function registerJobSearchRoutes(app: FastifyInstance, deps: JobSearchRouteDeps): void {
  const requireDb = (): Db => {
    if (!deps.db) throw new ApiError(503, 'unavailable', 'The service is not available');
    return deps.db;
  };
  const userOf = (request: FastifyRequest) => {
    const user = request.auth?.user;
    if (!user) throw new ApiError(401, 'unauthenticated', 'Sign in to continue');
    return user;
  };
  const canUse = (user: { id: string; isDemo: boolean }) =>
    deps.claude !== null && !user.isDemo && allowedUserIds(deps.env).has(user.id.toLowerCase());
  /** The signed-in user, when the feature is open to them; 404 otherwise (it is not theirs). */
  const memberOf = (request: FastifyRequest) => {
    const user = userOf(request);
    if (!canUse(user) || !deps.claude) throw notAvailable();
    return { user, claude: deps.claude };
  };
  const spend = async (db: Db, rule: RateLimitRule, subject: string, reply: FastifyReply) => {
    const result = await consumeRateLimit(
      db,
      rateLimitKey(rule.name, subject),
      rule,
      deps.clock.now(),
    );
    if (!result.allowed) {
      void reply.header('retry-after', String(result.retryAfterSeconds));
      throw new ApiError(
        429,
        'rate_limited',
        'That limit is reached for today. Try again tomorrow.',
      );
    }
  };
  const idOf = (request: FastifyRequest, notFound: () => ApiError) => {
    const id = (request.params as { id?: string }).id;
    if (!id || !UUID.test(id)) throw notFound();
    return id.toLowerCase();
  };
  const requireProfile = async (db: Db, userId: string): Promise<JobSearchProfile> => {
    const saved = await getProfile(db, userId);
    if (!saved) throw new ApiError(409, 'not_set_up', 'Finish the job search setup first');
    return saved.profile;
  };
  const hitOf = async (db: Db, userId: string, request: FastifyRequest): Promise<JobHit> => {
    const hit = await getHit(db, userId, idOf(request, hitNotFound));
    if (!hit) throw hitNotFound();
    return hit;
  };
  const searchDeps = (db: Db, claude: JobSearchClaude) => ({
    db,
    clock: deps.clock,
    claude,
    fetchPage: deps.fetchPage,
    fetchBoard: deps.fetchBoard,
  });

  app.get(
    '/api/job-search/profile',
    {
      config: {
        auth: 'user',
        contract: {
          summary: 'The job search setup, and whether the job search is open to this account',
          responses: { 200: JobSearchSetupSchema },
        },
      },
    },
    async (request) => {
      const db = requireDb();
      const user = userOf(request);
      const available = canUse(user);
      const saved = available ? await getProfile(db, user.id) : null;
      return {
        available,
        profile: saved?.profile ?? null,
        confirmedAt: saved?.confirmedAt.toISOString() ?? null,
        hasResume: (await getResume(db, user.id)) !== null,
      };
    },
  );

  app.put(
    '/api/job-search/profile',
    {
      config: {
        auth: 'user',
        contract: {
          summary: 'Save the confirmed setup (the first save ends the first-run setup)',
          errors: { 404: 'Not available to this account' },
          body: JobSearchProfileSchema,
          responses: { 200: JobSearchSetupSchema },
        },
      },
    },
    async (request) => {
      const db = requireDb();
      const { user } = memberOf(request);
      const profile = parseInput(JobSearchProfileSchema, request.body);
      const confirmedAt = await saveProfile(db, user.id, profile, deps.clock.now());
      return {
        available: true,
        profile,
        confirmedAt: confirmedAt.toISOString(),
        hasResume: (await getResume(db, user.id)) !== null,
      };
    },
  );

  app.post(
    '/api/job-search/runs',
    {
      config: {
        auth: 'user',
        contract: {
          summary: 'Run the job search now: search, read, sort, then draft until the time is up',
          errors: {
            404: 'Not available to this account',
            409: 'Not set up, no resume, or a run is already going',
            429: 'Too many runs today',
            503: 'The Anthropic key was rejected',
          },
          responses: { 201: JobSearchRunDetailSchema },
        },
      },
    },
    async (request, reply) => {
      const started = Date.now();
      const db = requireDb();
      const { user, claude } = memberOf(request);
      const profile = await requireProfile(db, user.id);
      if (!(await getResumeText(db, user.id)))
        throw new ApiError(409, 'no_resume', 'Upload your resume first');
      await spend(db, MANUAL_RUN_RULE, user.id, reply);
      await spend(db, ALL_RUNS_RULE, 'all', reply);

      const result = await runJobSearch(
        searchDeps(db, claude),
        { userId: user.id, timeZone: user.timeZone },
        profile,
        'manual',
        started + RUN_BUDGET_MS,
      );
      if (result.kind === 'already_running')
        throw new ApiError(409, 'run_in_progress', 'A search is already running');
      if (result.kind === 'unavailable')
        throw new ApiError(503, 'unavailable', 'The job search is not available right now');
      const run = await getRun(db, user.id, result.runId);
      if (!run) throw runNotFound();
      void reply.code(201).header('location', `/api/job-search/runs/${run.id}`);
      return { run, hits: await listRunHits(db, user.id, run.id) };
    },
  );

  app.get(
    '/api/job-search/runs',
    {
      config: {
        auth: 'user',
        contract: {
          summary: 'The latest runs, newest first, with their counts',
          errors: { 404: 'Not available to this account' },
          responses: { 200: JobSearchRunListSchema },
        },
      },
    },
    async (request) => {
      const { user } = memberOf(request);
      return { items: await listRuns(requireDb(), user.id) };
    },
  );

  app.get(
    '/api/job-search/runs/:id',
    {
      config: {
        auth: 'user',
        contract: {
          summary: 'One run and every job it found',
          params: IdParams,
          errors: { 404: 'No such run (or not yours), or not available' },
          responses: { 200: JobSearchRunDetailSchema },
        },
      },
    },
    async (request) => {
      const db = requireDb();
      const { user } = memberOf(request);
      const run = await getRun(db, user.id, idOf(request, runNotFound));
      if (!run) throw runNotFound();
      return { run, hits: await listRunHits(db, user.id, run.id) };
    },
  );

  app.get(
    '/api/job-search/queue',
    {
      config: {
        auth: 'user',
        contract: {
          summary: 'The apply queue: ready, needs you, finish yourself and keyword-only jobs',
          errors: { 404: 'Not available to this account' },
          responses: { 200: ApplyQueueSchema },
        },
      },
    },
    async (request) => {
      const { user } = memberOf(request);
      const open = await listOpenHits(requireDb(), user.id);
      return {
        ready: open.filter((hit) => hit.kind === 'target' && hit.state === 'ready'),
        needsYou: open.filter((hit) => hit.kind === 'target' && hit.state === 'needs_you'),
        finishYourself: open.filter((hit) => hit.kind === 'finish_yourself'),
        keywordOnly: open.filter((hit) => hit.kind === 'keyword_only'),
        notDrafted: open.filter((hit) => hit.kind === 'target' && hit.state === 'new').length,
      };
    },
  );

  const hitRoute = (
    path: string,
    summary: string,
    body: z.ZodType | undefined,
    errors: Record<number, string>,
    handle: (context: {
      db: Db;
      user: { id: string; isDemo: boolean; timeZone: string };
      claude: JobSearchClaude;
      hit: JobHit;
      request: FastifyRequest;
      reply: FastifyReply;
    }) => Promise<void>,
    method: 'POST' | 'PUT' = 'POST',
  ) =>
    app.route({
      method,
      url: `/api/job-search/hits/:id/${path}`,
      config: {
        auth: 'user',
        contract: {
          summary,
          params: IdParams,
          ...(body ? { body } : {}),
          errors: { 404: 'No such job (or not yours), or not available', ...errors },
          responses: { 200: JobHitSchema },
        },
      },
      handler: async (request, reply) => {
        const db = requireDb();
        const { user, claude } = memberOf(request);
        const hit = await hitOf(db, user.id, request);
        await handle({ db, user, claude, hit, request, reply });
        const updated = await getHit(db, user.id, hit.id);
        if (!updated) throw hitNotFound();
        return updated;
      },
    });

  hitRoute(
    'applied',
    'Mark a job applied: creates the application in the tracker (once)',
    undefined,
    { 409: 'The application limit is reached' },
    async ({ db, user, hit }) => {
      if (hit.state === 'applied') return;
      const now = deps.clock.now();
      const created = await createApplication(
        db,
        { userId: user.id, isDemo: user.isDemo, timeZone: user.timeZone },
        ApplicationInputSchema.parse({
          company: hit.company,
          role: hit.role,
          status: 'Applied',
          dateApplied: localDateIn(now, user.timeZone),
          source: 'Company site',
          jobLink: hit.jobLink,
          location: hit.location,
          workMode: hit.workMode,
          postedOn: hit.postedAt?.slice(0, 10) ?? null,
          notes: `Applied through the job search (${SOURCE_LABELS[hit.source]}).`,
        }),
        now,
      );
      if (created.kind !== 'created')
        throw new ApiError(409, 'limit_reached', 'The application limit is reached');
      await setHitState(
        db,
        user.id,
        hit.id,
        { state: 'applied', applicationId: created.value.record.id },
        now,
      );
    },
  );

  hitRoute(
    'blocked',
    "Mark a job blocked (an account, a CAPTCHA, a question the queue doesn't cover)",
    BlockHitSchema,
    {},
    async ({ db, user, hit, request }) => {
      const { reason } = parseInput(BlockHitSchema, request.body);
      if (hit.state === 'applied') return;
      await setHitState(
        db,
        user.id,
        hit.id,
        { state: 'blocked', blockReason: reason },
        deps.clock.now(),
      );
    },
  );

  hitRoute('skip', 'Skip a job', undefined, {}, async ({ db, user, hit }) => {
    if (hit.state === 'applied') return;
    await setHitState(db, user.id, hit.id, { state: 'skipped' }, deps.clock.now());
  });

  const draftNow = async (
    db: Db,
    user: { id: string },
    claude: JobSearchClaude,
    hitId: string,
    reply: FastifyReply,
  ) => {
    const profile = await requireProfile(db, user.id);
    const resume = await getResumeText(db, user.id);
    if (!resume) throw new ApiError(409, 'no_resume', 'Upload your resume first');
    await spend(db, DRAFT_RULE, user.id, reply);
    await draftHit(searchDeps(db, claude), user.id, profile, hitId, resume.text);
  };

  hitRoute(
    'queue',
    'Move a keyword-only job into the queue and draft it',
    undefined,
    { 409: 'Not set up, or no resume', 429: 'Too many drafts today' },
    async ({ db, user, claude, hit, reply }) => {
      if (hit.kind !== 'keyword_only' || hit.state !== 'new') return;
      await setHitState(db, user.id, hit.id, { state: 'new', kind: 'target' }, deps.clock.now());
      await draftNow(db, user, claude, hit.id, reply);
    },
  );

  hitRoute(
    'redraft',
    'Draft a job again (or for the first time)',
    undefined,
    { 409: 'Not set up, no resume, or the job is done', 429: 'Too many drafts today' },
    async ({ db, user, claude, hit, reply }) => {
      if (!['new', 'ready', 'needs_you'].includes(hit.state))
        throw new ApiError(409, 'hit_closed', 'This job is already done');
      await draftNow(db, user, claude, hit.id, reply);
    },
  );

  hitRoute(
    'draft',
    'Save edited answers; the job is ready once every required question has an answer',
    DraftEditSchema,
    { 409: 'Not drafted yet, or the job is done' },
    async ({ db, user, hit, request }) => {
      const edit = parseInput(DraftEditSchema, request.body);
      if (!hit.draft || !['ready', 'needs_you'].includes(hit.state))
        throw new ApiError(409, 'not_editable', 'This job has no draft to edit');
      const edited = new Map(edit.answers.map((entry) => [entry.question, entry.answer.trim()]));
      const required = new Set(
        (hit.questions ?? []).filter((question) => question.required).map((q) => q.label),
      );
      let needsYou = false;
      const answers = hit.draft.answers.map((answer) => {
        // An answer the user sends back is theirs, changed or not: it no longer needs them.
        const sent = edited.get(answer.question);
        if (sent === undefined) {
          if (answer.source === 'needs_you' && required.has(answer.question)) needsYou = true;
          return answer;
        }
        const source: DraftAnswer['source'] = sent ? 'draft' : 'needs_you';
        if (source === 'needs_you' && required.has(answer.question)) needsYou = true;
        const option = sent === answer.answer ? answer.option : null;
        return { ...answer, answer: sent, source, option };
      });
      await saveDraft(
        db,
        user.id,
        hit.id,
        { draft: { ...hit.draft, answers, coverLetter: edit.coverLetter.trim() }, needsYou },
        deps.clock.now(),
      );
    },
    'PUT',
  );

  // Called every hour by the scheduled GitHub Actions workflow. Public (no session), but only with
  // the secret; without JOB_SEARCH_CRON_SECRET set, it does not exist.
  app.post(
    '/api/cron/job-search',
    {
      config: {
        auth: 'public',
        contract: {
          summary: 'Scheduled: start the runs that are due, then keep drafting (needs the secret)',
          errors: { 404: 'Unknown secret, or the schedule is not configured' },
          responses: { 200: CronResultSchema },
        },
      },
    },
    async (request) => {
      const started = Date.now();
      const secret = request.headers['x-cron-secret'];
      if (
        !secretMatches(
          typeof secret === 'string' ? secret : undefined,
          deps.env['JOB_SEARCH_CRON_SECRET'],
        ) ||
        !deps.claude ||
        !deps.db
      )
        throw new ApiError(404, 'not_found', 'Not found');
      const { db, claude } = deps;
      const deadline = started + RUN_BUDGET_MS;
      let runs = 0;
      let drafted = 0;
      for (const userId of allowedUserIds(deps.env)) {
        if (Date.now() >= deadline) break;
        const owner = await db.query<{ time_zone: string; is_demo: boolean }>(
          'select time_zone, is_demo from users where id = $1',
          [userId],
        );
        const row = owner.rows[0];
        const saved = row && !row.is_demo ? await getProfile(db, userId) : null;
        if (!row || !saved || !(await getResumeText(db, userId))) continue;
        const { profile } = saved;
        const due =
          profile.scheduleOn &&
          isRunDue(profile, row.time_zone, deps.clock.now(), await lastScheduledRunDay(db, userId));
        if (due) {
          const allowedToday = await consumeRateLimit(
            db,
            rateLimitKey(ALL_RUNS_RULE.name, 'all'),
            ALL_RUNS_RULE,
            deps.clock.now(),
          );
          if (allowedToday.allowed) {
            const result = await runJobSearch(
              searchDeps(db, claude),
              { userId, timeZone: row.time_zone },
              profile,
              'schedule',
              deadline,
            );
            if (result.kind === 'done') runs += 1;
            if (result.kind === 'unavailable') break;
          }
        } else {
          drafted += await draftPending(searchDeps(db, claude), userId, profile, deadline);
        }
      }
      request.log.info({ runs, drafted }, 'job search schedule');
      return { started: runs, drafted };
    },
  );
}
