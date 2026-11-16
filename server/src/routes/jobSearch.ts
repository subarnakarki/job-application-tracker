import { createHash, timingSafeEqual } from 'node:crypto';
import {
  ApplicationInputSchema,
  acceptTailoring,
  ApplyQueueSchema,
  BlockHitSchema,
  byFit,
  DraftEditSchema,
  isRunDue,
  jobRefOf,
  JobHitSchema,
  JobSearchProfileSchema,
  JobSearchRunDetailSchema,
  JobSearchRunListSchema,
  JobSearchSetupSchema,
  QueueCheckResultSchema,
  SaveTailoredResumeSchema,
  localDateIn,
  olderMatchKind,
  refillDraft,
  SOURCE_LABELS,
  type DraftAnswer,
  type JobHit,
  type JobSearchProfile,
} from '@jat/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  consumeRateLimit,
  deleteExpiredRateLimits,
  rateLimitKey,
  type RateLimitRule,
} from '../auth/rateLimit';
import { deleteExpiredSessions } from '../auth/sessions';
import type { Clock } from '../clock';
import type { Db } from '../db/types';
import { ApiError, parseInput } from '../http/errors';
import { JOB_SEARCH_MODEL, type JobSearchClaude } from '../jobsearch/claude';
import { readJob } from '../jobsearch/readJob';
import { checkOpenJobs, MANUAL_CHECK_AGE_MS, SCHEDULED_CHECK_AGE_MS } from '../jobsearch/check';
import { allowedUserIds, jobSearchAccess, NO_CLAUDE } from '../jobsearch/access';
import { draftHit, draftPending, runJobSearch, sweepNewJobs } from '../jobsearch/run';
import type { PageFetcher } from '../postings/fetchPage';
import { createApplication, getApplication, updateApplication } from '../repo/applications';
import {
  checkSummary,
  getHit,
  getProfile,
  getRun,
  scheduledRunState,
  listAgeSkipped,
  linkHitApplication,
  listDraftedWaiting,
  listOpenHits,
  listRunHits,
  listRuns,
  saveDraft,
  saveProfile,
  saveTailoring,
  setHitState,
} from '../repo/jobSearch';
import { ClaudeLimitError, type ClaudeLimitKind } from '../anthropic/limits';
import { copyQueueLetter } from '../repo/coverLetters';
import { getResume, getResumeText } from '../repo/resumes';
import { getTailoring, saveSuggestions, saveVersion, versionEdits } from '../repo/tailorings';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Runs by hand, on top of the schedule. Each costs about $0.50 to $1.50 in model use. */
export const MANUAL_RUN_RULE: RateLimitRule = {
  name: 'job-search-run',
  limit: 10,
  windowMs: DAY_MS,
};
/** Every run of every user: a ceiling on web search and drafting spend. */
export const ALL_RUNS_RULE: RateLimitRule = { name: 'job-search-all', limit: 50, windowMs: DAY_MS };
/** Single drafts (re-draft, move to queue). */
export const DRAFT_RULE: RateLimitRule = { name: 'job-search-draft', limit: 30, windowMs: DAY_MS };
/** "Tailor my resume": one model call each, about $0.10 to $0.20. */
export const TAILOR_RULE: RateLimitRule = {
  name: 'job-search-tailor',
  limit: 10,
  windowMs: DAY_MS,
};
/** "Check they're still open" by hand: each reads up to 60 boards. */
export const CHECK_RULE: RateLimitRule = { name: 'job-search-check', limit: 6, windowMs: DAY_MS };
/** A check by hand answers within the request: well under the function limit. */
export const CHECK_BUDGET_MS = 50_000;

/** Stop starting new work this long after a request began (the function limit is 300 s). */
export const RUN_BUDGET_MS = 240_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IdParams = z.object({ id: z.string() });
const CronResultSchema = z.strictObject({
  started: z.number().int().min(0),
  drafted: z.number().int().min(0),
  /** New jobs the hourly board sweep saved. */
  found: z.number().int().min(0),
  /** Users whose turn ended in an error (logged); the others still ran. */
  failed: z.number().int().min(0),
});

export interface JobSearchRouteDeps {
  db: Db | undefined;
  clock: Clock;
  env: Record<string, string | undefined>;
  /** Null without an Anthropic key: the feature is off. */
  claude: JobSearchClaude | null;
  fetchPage: PageFetcher;
  fetchBoard: PageFetcher;
  /**
   * Test routes on (never in production): synthetic test users may use the job search, and
   * without an Anthropic key a stand-in that finds nothing is used, so e2e tests can drive the
   * pages with runs seeded through /api/test/job-search.
   */
  openToTestUsers?: boolean;
}

/** Constant-time comparison of the cron secret, by hash so the lengths always match. */
export function secretMatches(given: string | undefined, expected: string | undefined): boolean {
  if (!given || !expected || expected.length < 32) return false;
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(given), digest(expected));
}

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
  const { claudeFor, memberOf } = jobSearchAccess(deps);
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
      const available = (await claudeFor(user)) !== null;
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
          summary:
            'Save the confirmed setup (the first save ends the first-run setup); waiting jobs take any answers it now covers',
          errors: { 404: 'Not available to this account' },
          body: JobSearchProfileSchema,
          responses: { 200: JobSearchSetupSchema },
        },
      },
    },
    async (request) => {
      const db = requireDb();
      const { user } = await memberOf(request);
      const profile = parseInput(JobSearchProfileSchema, request.body);
      const confirmedAt = await saveProfile(db, user.id, profile, deps.clock.now());
      // Jobs already waiting take the new answers now: by code, no model call. A job with no
      // required question left moves to Ready; answers the user typed are never touched.
      for (const hit of await listDraftedWaiting(db, user.id)) {
        if (!hit.draft || !hit.questions) continue;
        const { filled, ...outcome } = refillDraft(hit.draft, hit.questions, profile);
        if (filled > 0) await saveDraft(db, user.id, hit.id, outcome, deps.clock.now());
      }
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
      const { user, claude } = await memberOf(request);
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
      const { user } = await memberOf(request);
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
      const { user } = await memberOf(request);
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
      const db = requireDb();
      const { user } = await memberOf(request);
      const open = await listOpenHits(db, user.id);
      const profile = (await getProfile(db, user.id))?.profile;
      const now = deps.clock.now();
      const olderMatches = profile
        ? (await listAgeSkipped(db, user.id, 200))
            .filter((hit) => olderMatchKind(hit, profile, now) !== null)
            .slice(0, 50)
        : [];
      return {
        olderMatches,
        ready: open.filter((hit) => hit.kind === 'target' && hit.state === 'ready').sort(byFit),
        needsYou: open
          .filter((hit) => hit.kind === 'target' && hit.state === 'needs_you')
          .sort(byFit),
        finishYourself: open.filter((hit) => hit.kind === 'finish_yourself'),
        keywordOnly: open.filter((hit) => hit.kind === 'keyword_only'),
        notDrafted: open.filter((hit) => hit.kind === 'target' && hit.state === 'new').length,
        checks: await checkSummary(db, user.id, now),
      };
    },
  );

  app.post(
    '/api/job-search/queue/check',
    {
      config: {
        auth: 'user',
        contract: {
          summary: "Check they're still open: read each waiting job again and close the gone ones",
          errors: { 404: 'Not available to this account', 429: 'Too many checks today' },
          responses: { 200: QueueCheckResultSchema },
        },
      },
    },
    async (request, reply) => {
      const db = requireDb();
      const { user } = await memberOf(request);
      await spend(db, CHECK_RULE, user.id, reply);
      const saved = await getProfile(db, user.id);
      return checkOpenJobs(searchDeps(db, NO_CLAUDE), user.id, {
        maxAgeMs: MANUAL_CHECK_AGE_MS,
        deadline: Date.now() + CHECK_BUDGET_MS,
        salaryFloor: saved?.profile.salaryFloor ?? null,
      });
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
        const { user, claude } = await memberOf(request);
        const hit = await hitOf(db, user.id, request);
        await handle({ db, user, claude, hit, request, reply });
        const updated = await getHit(db, user.id, hit.id);
        if (!updated) throw hitNotFound();
        return updated;
      },
    });

  /** A queue job's application in the tracker: from the job itself, or a tracker match. */
  const createFromHit = async (
    db: Db,
    user: { id: string; isDemo: boolean; timeZone: string },
    hit: JobHit,
    status: 'Saved' | 'Applied',
    now: Date,
  ): Promise<string> => {
    const created = await createApplication(
      db,
      { userId: user.id, isDemo: user.isDemo, timeZone: user.timeZone },
      ApplicationInputSchema.parse({
        company: hit.company,
        role: hit.role,
        status,
        dateApplied: status === 'Applied' ? localDateIn(now, user.timeZone) : null,
        source: 'Company site',
        jobLink: hit.jobLink,
        location: hit.location,
        workMode: hit.workMode,
        postedOn: hit.postedAt?.slice(0, 10) ?? null,
        notes:
          status === 'Applied'
            ? `Applied through the job search (${SOURCE_LABELS[hit.source]}).`
            : `Saved from the job search (${SOURCE_LABELS[hit.source]}).`,
      }),
      now,
    );
    if (created.kind !== 'created')
      throw new ApiError(409, 'limit_reached', 'The application limit is reached');
    return created.value.record.id;
  };

  /** The queue's drafted letter goes with the job, unless its application has a letter already. */
  const copyLetter = async (
    db: Db,
    userId: string,
    hit: JobHit,
    applicationId: string,
    now: Date,
  ): Promise<void> => {
    if (hit.draft?.coverLetter)
      await copyQueueLetter(db, userId, applicationId, hit.draft.coverLetter, now);
  };

  /** The queue job's application: the tracked one, else a new Saved one (linked either way). */
  const trackHit = async (
    db: Db,
    user: { id: string; isDemo: boolean; timeZone: string },
    hit: JobHit,
    now: Date,
  ): Promise<string> => {
    if (!['new', 'ready', 'needs_you'].includes(hit.state))
      throw new ApiError(409, 'not_in_queue', 'This job is no longer in the queue');
    // `tracked` is the job's own application while it exists, else the tracker's match.
    const applicationId =
      hit.tracked?.applicationId ?? (await createFromHit(db, user, hit, 'Saved', now));
    if (applicationId !== hit.applicationId)
      await linkHitApplication(db, user.id, hit.id, applicationId, now);
    await copyLetter(db, user.id, hit, applicationId, now);
    return applicationId;
  };

  hitRoute(
    'track',
    'Track a queue job in the tracker as Saved (or link the application already there)',
    undefined,
    { 409: 'The job is no longer in the queue, or the application limit is reached' },
    async ({ db, user, hit }) => {
      await trackHit(db, user, hit, deps.clock.now());
    },
  );

  hitRoute(
    'tailored-resume',
    "Save this job's resume from the queue: tracks the job (Saved) if needed, keeps the version",
    SaveTailoredResumeSchema,
    { 409: 'No resume, the job is no longer in the queue, or the application limit is reached' },
    async ({ db, user, hit, request }) => {
      const { text } = parseInput(SaveTailoredResumeSchema, request.body);
      const resume = await getResumeText(db, user.id);
      if (!resume) throw new ApiError(409, 'no_resume', 'Upload your resume first');
      const now = deps.clock.now();
      const applicationId = await trackHit(db, user, hit, now);
      // The queue's suggestions and keywords go with it, unless the application has its own.
      const stored = await getTailoring(db, user.id, applicationId);
      if (!stored?.tailoring && hit.tailoring)
        await saveSuggestions(
          db,
          user.id,
          applicationId,
          { tailoring: hit.tailoring, keywords: hit.draft?.keywords ?? [], postingText: null },
          now,
        );
      await saveVersion(
        db,
        user.id,
        applicationId,
        { text, edits: versionEdits(resume.text, text), resumeSha256: resume.textSha256 },
        now,
      );
    },
  );

  hitRoute(
    'applied',
    'Mark a job applied: moves its Saved application to Applied, or creates one (once)',
    undefined,
    { 409: 'The application limit is reached' },
    async ({ db, user, hit }) => {
      if (hit.state === 'applied') return;
      const now = deps.clock.now();
      const owner = { userId: user.id, isDemo: user.isDemo, timeZone: user.timeZone };
      let applicationId = hit.tracked?.applicationId ?? null;
      const existing = applicationId ? await getApplication(db, user.id, applicationId) : null;
      if (existing?.record.status === 'Saved') {
        // Saved to Applied through the normal update: today's date and a history row. A
        // concurrent edit (version conflict) leaves it to the user rather than overwriting.
        await updateApplication(
          db,
          owner,
          existing.record.id,
          existing.record.version,
          { status: 'Applied' },
          now,
        );
      }
      // Already Applied or further along: left as it is, never moved back.
      if (!existing) applicationId = await createFromHit(db, user, hit, 'Applied', now);
      if (applicationId) await copyLetter(db, user.id, hit, applicationId, now);
      await setHitState(
        db,
        user.id,
        hit.id,
        { state: 'applied', applicationId: applicationId ?? undefined },
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

  hitRoute(
    'closed',
    'Mark a job closed (its page says it no longer takes applications)',
    undefined,
    {},
    async ({ db, user, hit }) => {
      if (!['new', 'ready', 'needs_you'].includes(hit.state)) return;
      await setHitState(db, user.id, hit.id, { state: 'closed' }, deps.clock.now());
    },
  );

  hitRoute(
    'tailor',
    'Tailor my resume: suggested edits of existing resume lines that add the missing keywords',
    undefined,
    {
      409: 'Not drafted with keywords yet, no resume, or the job is done',
      429: 'Too many tailorings today',
      502: 'The suggestions did not finish',
    },
    async ({ db, user, claude, hit, reply }) => {
      if (!['new', 'ready', 'needs_you'].includes(hit.state))
        throw new ApiError(409, 'hit_closed', 'This job is already done');
      const keywords = hit.draft?.keywords;
      if (!keywords || !hit.fit)
        throw new ApiError(409, 'no_keywords', 'Redraft this job first to get its keywords');
      const resume = await getResumeText(db, user.id);
      if (!resume) throw new ApiError(409, 'no_resume', 'Upload your resume first');
      await spend(db, TAILOR_RULE, user.id, reply);
      let postingText = '';
      const ref = jobRefOf(hit.jobLink);
      try {
        if (ref) postingText = (await readJob(ref, deps.fetchPage, deps.fetchBoard)).text;
      } catch {
        // The keywords and the title are enough to tailor from.
      }
      const answer = await claude.tailor({
        resumeText: resume.text,
        company: hit.company,
        role: hit.role,
        postingText,
        missing: hit.fit.missing,
      });
      if (!answer)
        throw new ApiError(502, 'tailor_failed', 'The suggestions did not finish. Try again.');
      const now = deps.clock.now();
      await saveTailoring(
        db,
        user.id,
        hit.id,
        {
          ...acceptTailoring(answer, resume.text, keywords),
          model: JOB_SEARCH_MODEL,
          createdAt: now.toISOString(),
        },
        now,
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
    'Move a keyword-only job, or an older match, into the queue and draft it',
    undefined,
    { 409: 'Not set up, or no resume', 429: 'Too many drafts today' },
    async ({ db, user, claude, hit, reply }) => {
      let kind: 'target' | 'finish_yourself' | null = null;
      if (hit.kind === 'keyword_only' && hit.state === 'new') kind = 'target';
      else if (hit.state === 'skipped') {
        const profile = await requireProfile(db, user.id);
        kind = olderMatchKind(hit, profile, deps.clock.now());
      }
      if (!kind) return;
      await setHitState(db, user.id, hit.id, { state: 'new', kind }, deps.clock.now());
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
      // Housekeeping, once per knock: expired sessions and rate-limit windows. Never fatal.
      try {
        const now = deps.clock.now();
        const sessions = await deleteExpiredSessions(db, now);
        const rateLimits = await deleteExpiredRateLimits(db, now);
        request.log.info({ sessions, rateLimits }, 'job search schedule: housekeeping');
      } catch (error) {
        request.log.error({ err: error }, 'job search schedule: housekeeping failed');
      }
      let runs = 0;
      let drafted = 0;
      let failed = 0;
      let found = 0;
      let limited: ClaudeLimitKind | null = null;
      /** One user's turn: the still-open check, then a due run or drafting. */
      const forUser = async (userId: string): Promise<'stop' | undefined> => {
        const owner = await db.query<{ time_zone: string; is_demo: boolean }>(
          'select time_zone, is_demo from users where id = $1',
          [userId],
        );
        const row = owner.rows[0];
        const saved = row && !row.is_demo ? await getProfile(db, userId) : null;
        if (!row || !saved || !(await getResumeText(db, userId))) return undefined;
        const { profile } = saved;
        // About once a day per job, before anything is drafted: closed jobs leave the queue.
        await checkOpenJobs(searchDeps(db, claude), userId, {
          maxAgeMs: SCHEDULED_CHECK_AGE_MS,
          deadline: Math.min(deadline, Date.now() + CHECK_BUDGET_MS),
          salaryFloor: profile.salaryFloor,
        });
        const now = deps.clock.now();
        const past = await scheduledRunState(db, userId, localDateIn(now, row.time_zone));
        const due =
          profile.scheduleOn &&
          isRunDue(profile, row.time_zone, now, past.lastDoneDay, past.triesToday);
        if (!due) {
          // Every hour: the watched boards' own lists, for jobs posted since the last look (free:
          // no model call), then drafting, which covers what the sweep just found.
          found += await sweepNewJobs(
            searchDeps(db, claude),
            { userId, timeZone: row.time_zone },
            profile,
            deadline,
          );
          drafted += await draftPending(searchDeps(db, claude), userId, profile, deadline);
          return undefined;
        }
        const allowedToday = await consumeRateLimit(
          db,
          rateLimitKey(ALL_RUNS_RULE.name, 'all'),
          ALL_RUNS_RULE,
          deps.clock.now(),
        );
        if (!allowedToday.allowed) return undefined;
        const result = await runJobSearch(
          searchDeps(db, claude),
          { userId, timeZone: row.time_zone },
          profile,
          'schedule',
          deadline,
        );
        if (result.kind === 'done') runs += 1;
        // A rejected key fails every user alike: stop here.
        return result.kind === 'unavailable' ? 'stop' : undefined;
      };
      for (const userId of allowedUserIds(deps.env)) {
        if (Date.now() >= deadline) break;
        try {
          if ((await forUser(userId)) === 'stop') break;
        } catch (error) {
          failed += 1;
          // A Claude limit is the whole organization's: every later user would hit it too.
          if (error instanceof ClaudeLimitError) {
            limited = error.kind;
            request.log.warn({ limit: error.kind, userId }, 'job search schedule: claude limit');
            break;
          }
          // One user's failure (its run is already marked failed) never stops the others.
          request.log.error({ err: error, userId }, 'job search schedule: a user failed');
        }
      }
      request.log.info({ runs, drafted, failed, found, limited }, 'job search schedule');
      return { started: runs, drafted, failed, found };
    },
  );
}
