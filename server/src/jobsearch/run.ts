import {
  assembleDraft,
  searchQueries,
  trackedMatcher,
  EMPTY_PROGRESS,
  type RunProgress,
  jobRefOf,
  localDateIn,
  parseQuery,
  questionsForModel,
  sortJob,
  uniqueJobRefs,
  workModeProblem,
  type JobRef,
  type JobSearchProfile,
  type SearchSource,
} from '@jat/shared';
import type { Clock } from '../clock';
import type { Db } from '../db/types';
import { BOARD_SOURCES } from '../postings/boards';
import type { PageFetcher } from '../postings/fetchPage';
import {
  finishRun,
  getHit,
  insertHit,
  listTrackedApplications,
  listUndrafted,
  markBoardsSwept,
  saveDraft,
  savePostingRead,
  seenJobKeys,
  setRunProgress,
  startRun,
  watchBoard,
  watchedBoards,
} from '../repo/jobSearch';
import { getResumeText } from '../repo/resumes';
import { ClaudeLimitError, type ClaudeLimitKind } from '../anthropic/limits';
import { AnalyzerUnavailableError } from '../resume/analyze';
import type { JobSearchClaude } from './claude';
import { companyFromSlug, JobReadError, readJob, type JobDetails } from './readJob';
import { MAX_BOARDS_PER_SWEEP, sweepBoards, type WatchedBoard } from './sweep';
import { readWorkdayBoard, workdayAddresses, workdayBoardOf } from './workday';

export interface JobSearchDeps {
  db: Db;
  clock: Clock;
  claude: JobSearchClaude;
  fetchPage: PageFetcher;
  /** For boards whose one-job read is the whole board (Ashby). */
  fetchBoard: PageFetcher;
}

/**
 * Boards whose job pages often cannot be read even while the job is open: Workable limits how
 * often its list is read; the account-only sites draw their pages by script. Only these may keep a
 * job from its search result. Every other board has a public API that answers for an open job.
 */
export const SEARCH_RESULT_SOURCES: readonly SearchSource[] = [
  'workable',
  'workday',
  'icims',
  'taleo',
  'successfactors',
];

/** New jobs read per run: a day's postings for a few titles, without running for ever. */
export const MAX_NEW_JOBS_PER_RUN = 60;
/** Drafts per call: each is a model call of several seconds. */
export const MAX_DRAFTS_PER_RUN = 25;
const READ_CONCURRENCY = 4;
const DRAFT_CONCURRENCY = 3;

/** Runs `work` over `items`, `limit` at a time, until the items or the time run out. */
export async function pool<T>(
  items: T[],
  limit: number,
  keepGoing: () => boolean,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  // The first error stops every worker from starting another item (a Claude limit would fail
  // them all alike); the items already started finish, then the error is thrown.
  let failure: { error: unknown } | null = null;
  const worker = async () => {
    while (!failure && next < items.length && keepGoing()) {
      const item = items[next];
      next += 1;
      if (item === undefined) continue;
      try {
        await work(item);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failure) throw (failure as { error: unknown }).error;
}

/**
 * Why a run stopped at a Claude limit, as the runs list shows it. The jobs found so far are kept,
 * and the jobs not drafted yet lose no draft attempt: the next run or hourly knock drafts them.
 */
export const RUN_STOPPED_BY_LIMIT: Record<ClaudeLimitKind, string> = {
  rate_limited:
    'Stopped: Claude was handling too many requests. The jobs found are kept; the rest are drafted on the next run.',
  overloaded:
    'Stopped: Claude was overloaded. The jobs found are kept; the rest are drafted on the next run.',
  spend_limit:
    'Stopped: the Claude usage limit is reached. The jobs found are kept; drafting resumes when the limit resets or is raised.',
};

export type RunResult =
  { kind: 'done'; runId: string } | { kind: 'already_running' } | { kind: 'unavailable' };

/**
 * One search: every saved query through web search, each new job read from its board and sorted,
 * then drafting until `deadline` (what is left is drafted by the next call). A rejected Anthropic
 * key stops the run as failed.
 */
export async function runJobSearch(
  deps: JobSearchDeps,
  owner: { userId: string; timeZone: string },
  profile: JobSearchProfile,
  trigger: 'schedule' | 'manual',
  deadline: number,
): Promise<RunResult> {
  const { db, clock } = deps;
  const now = clock.now();
  const runId = await startRun(db, owner.userId, trigger, localDateIn(now, owner.timeZone), now);
  if (!runId) return { kind: 'already_running' };
  const currentRun: string = runId;

  let searches = 0;
  // Progress is written in order (one write at a time), so a slow write never overtakes a newer one.
  const queries = searchQueries(profile);
  const progress: RunProgress = { ...EMPTY_PROGRESS, queriesTotal: queries.length };
  let writing: Promise<void> = Promise.resolve();
  const report = (patch: Partial<RunProgress>) => {
    Object.assign(progress, patch);
    const snapshot = { ...progress };
    writing = writing.then(() => setRunProgress(db, runId, snapshot)).catch(() => {});
    return writing;
  };
  try {
    await report({});
    const seen = await seenJobKeys(db, owner.userId);
    const refs: JobRef[] = [];
    const queryTerms: string[] = [];
    /** The search result's title and age per job, for jobs whose page cannot be read. */
    const fromSearch = new Map<string, { title: string; pageAge: string | null }>();
    for (const query of queries) {
      const parsed = parseQuery(query);
      queryTerms.push(...parsed.terms);
      // Out of time: the queries left are not searched; the run keeps what it found.
      if (Date.now() >= deadline) continue;
      const found = await deps.claude.search(
        query,
        parsed.sources,
        profile.timeframeDays,
        profile.usOnly,
        deadline,
      );
      searches += found.searches;
      for (const [link, result] of Object.entries(found.results ?? {})) {
        const ref = jobRefOf(link);
        if (ref) fromSearch.set(`${ref.source}:${ref.board}:${ref.jobId}`, result);
      }
      for (const ref of uniqueJobRefs(found.links)) {
        const key = `${ref.source}:${ref.board}:${ref.jobId}`;
        if (seen.has(key) || !parsed.sources.includes(ref.source)) continue;
        seen.add(key);
        refs.push(ref);
      }
      await report({ queriesDone: progress.queriesDone + 1 });
    }

    // Fresh jobs from the boards of every company found so far (this run's first): the search
    // finds companies, their own lists say what is open and new.
    const boardKeys = new Set<string>();
    const boards: WatchedBoard[] = [
      ...refs.map((ref) => ({ source: ref.source, board: ref.board })),
      ...(await watchedBoards(db, owner.userId, MAX_BOARDS_PER_SWEEP, BOARD_SOURCES)),
    ].filter((entry) => {
      const key = `${entry.source}:${entry.board}`;
      if (boardKeys.has(key)) return false;
      boardKeys.add(key);
      return true;
    });
    const outcomes: { source: string; board: string; error: string | null }[] = [];
    const swept = await sweepBoards(
      boards,
      {
        wanted: profile.includeTitles.length > 0 ? profile.includeTitles : queryTerms,
        skipped: profile.skipTitles,
        timeframeDays: profile.timeframeDays,
        now,
      },
      deps.fetchBoard,
      () => Date.now() < deadline,
      (done, total) => void report({ step: 'sweeping', boardsDone: done, boardsTotal: total }),
      { onBoard: (board, error) => outcomes.push({ ...board, error }) },
    );
    await markBoardsSwept(db, owner.userId, outcomes, clock.now());
    const fresh: JobRef[] = [];
    for (const ref of swept) {
      const key = `${ref.source}:${ref.board}:${ref.jobId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      fresh.push(ref);
    }
    // Fresh jobs first: they are the point of a run; search hits fill what room is left.
    refs.unshift(...fresh);

    const toRead = refs.slice(0, MAX_NEW_JOBS_PER_RUN);
    await report({ step: 'reading', jobsRead: 0, jobsTotal: toRead.length });
    await readAndSaveJobs(deps, owner, profile, currentRun, toRead, {
      queryTerms,
      fromSearch,
      now,
      deadline,
      onRead: (read) => void report({ jobsRead: read }),
    });

    await report({ step: 'drafting' });
    await draftPending(
      deps,
      owner.userId,
      profile,
      deadline,
      (done, total) => void report({ drafted: done, draftsTotal: total }),
    );
    await report({ step: 'done' });
    await finishRun(db, runId, { status: 'done', searches, error: null }, clock.now());
    return { kind: 'done', runId };
  } catch (error) {
    const unavailable = error instanceof AnalyzerUnavailableError;
    await finishRun(
      db,
      runId,
      {
        status: 'failed',
        searches,
        error: unavailable
          ? 'The Anthropic API key was rejected'
          : error instanceof ClaudeLimitError
            ? RUN_STOPPED_BY_LIMIT[error.kind]
            : 'The search stopped with an error',
      },
      clock.now(),
    );
    if (unavailable) return { kind: 'unavailable' };
    // A Claude limit is thrown on: the caller answers 503 (a manual run) or stops (the schedule).
    throw error;
  }
}

/**
 * Reads each new job from its board, sorts it and saves it under the run, a few at a time until
 * the jobs or the time run out. Each job's board joins the boards watched.
 */
async function readAndSaveJobs(
  deps: JobSearchDeps,
  owner: { userId: string },
  profile: JobSearchProfile,
  runId: string,
  toRead: JobRef[],
  context: {
    queryTerms: string[];
    /** The search result's title and age per job, for jobs whose page cannot be read. */
    fromSearch: Map<string, { title: string; pageAge: string | null }>;
    now: Date;
    deadline: number;
    onRead?: (read: number) => void;
  },
): Promise<void> {
  const { db, clock } = deps;
  const { now, fromSearch } = context;
  const findTracked = trackedMatcher(await listTrackedApplications(db, owner.userId));
  const rules = {
    includeTitles: profile.includeTitles,
    skipTitles: profile.skipTitles,
    queryTerms: context.queryTerms,
    workModes: profile.workModes,
    timeframeDays: profile.timeframeDays,
    usOnly: profile.usOnly,
    salaryFloor: profile.salaryFloor,
    commuteArea: profile.commuteArea,
    homeState: profile.state,
    now,
  };
  let read = 0;
  await pool(
    toRead,
    READ_CONCURRENCY,
    () => Date.now() < context.deadline,
    async (ref) => {
      try {
        await readAndSave(ref);
      } finally {
        read += 1;
        context.onRead?.(read);
      }
    },
  );

  async function readAndSave(ref: JobRef): Promise<void> {
    let job: JobDetails;
    let fromResult = false;
    try {
      job = await readJob(ref, deps.fetchPage, deps.fetchBoard);
    } catch (error) {
      // A job the board says is gone is closed: never kept. Only where the page cannot be read
      // for other reasons (Workable's rate limit, account-only sites' pages) does the search
      // result's title stand in for it.
      const gone = !(error instanceof JobReadError) || error.gone;
      const result = fromSearch.get(`${ref.source}:${ref.board}:${ref.jobId}`);
      const fallback =
        result && !gone && SEARCH_RESULT_SOURCES.includes(ref.source)
          ? jobFromSearchResult(ref, result, now)
          : null;
      if (!fallback) return;
      job = fallback;
      fromResult = true;
    }
    const tracked = findTracked({
      links: [ref.link, job.applyLink],
      company: job.company,
      role: job.role,
    });
    const sorted = sortJob(
      {
        source: ref.source,
        title: job.role,
        text: job.text,
        workMode: job.workMode,
        postedAt: job.postedAt,
        postedDayOnly: job.postedDayOnly ?? false,
        alreadyTracked: tracked !== null,
        trackedStatus: tracked?.status ?? null,
        location: job.location,
        country: job.country,
        salary: job.salary,
      },
      rules,
    );
    const reason = fromResult ? `${sorted.reason} (from the search result only)` : sorted.reason;
    await insertHit(
      db,
      owner.userId,
      {
        runId,
        source: ref.source,
        board: ref.board,
        jobId: ref.jobId,
        jobLink: ref.link,
        applyLink: job.applyLink,
        company: job.company,
        role: job.role,
        location: job.location,
        workMode: job.workMode,
        postedAt: job.postedAt,
        kind: sorted.kind,
        reason,
        questions: job.questions,
      },
      clock.now(),
    );
    // The company's board is watched from now on: its own list shows what it posts next. A
    // Workday board is named by its host and site, which only the link gives.
    const board = ref.source === 'workday' ? workdayBoardOf(ref.link) : ref.board;
    if (board)
      await watchBoard(db, owner.userId, { source: ref.source, board }, 'search', clock.now());
  }
}

/** Boards read in one hourly sweep, and the time it may take. */
export const MAX_BOARDS_PER_HOURLY_SWEEP = 400;
export const MAX_WORKDAY_BOARDS_PER_SWEEP = 100;
const WORKDAY_CONCURRENCY = 4;
export const SWEEP_BUDGET_MS = 60_000;

/**
 * The hourly sweep: reads the watched boards (the ones read longest ago first, as many as fit in
 * the time), and saves the new jobs on them under a 'sweep' run. No run is recorded when nothing
 * new is found, and no model is called here: drafting follows as for any waiting job. Returns how
 * many new jobs were saved.
 */
export async function sweepNewJobs(
  deps: JobSearchDeps,
  owner: { userId: string; timeZone: string },
  profile: JobSearchProfile,
  deadline: number,
): Promise<number> {
  const { db, clock } = deps;
  const now = clock.now();
  const stopAt = Math.min(deadline, Date.now() + SWEEP_BUDGET_MS);
  const boards = await watchedBoards(db, owner.userId, MAX_BOARDS_PER_HOURLY_SWEEP, BOARD_SOURCES);
  const queryTerms = searchQueries(profile).flatMap((query) => parseQuery(query).terms);
  const outcomes: { source: string; board: string; error: string | null }[] = [];
  const rules = {
    wanted: profile.includeTitles.length > 0 ? profile.includeTitles : queryTerms,
    skipped: profile.skipTitles,
    timeframeDays: profile.timeframeDays,
    now,
  };
  const swept = await sweepBoards(
    boards,
    rules,
    deps.fetchBoard,
    () => Date.now() < stopAt,
    () => {},
    {
      limit: MAX_BOARDS_PER_HOURLY_SWEEP,
      onBoard: (board, error) => outcomes.push({ ...board, error }),
    },
  );
  // Workday sites, each asked for its newest postings; what the list says about a job stands in
  // for its page when that cannot be read.
  const fromSearch = new Map<string, { title: string; pageAge: string | null }>();
  const workday = (
    await watchedBoards(db, owner.userId, MAX_WORKDAY_BOARDS_PER_SWEEP, ['workday'])
  ).filter((board) => workdayAddresses(board.board) !== null);
  await pool(
    workday,
    WORKDAY_CONCURRENCY,
    () => Date.now() < stopAt,
    async (board) => {
      try {
        for (const { ref, result } of await readWorkdayBoard(board.board, rules, deps.fetchBoard)) {
          swept.push(ref);
          fromSearch.set(`${ref.source}:${ref.board}:${ref.jobId}`, result);
        }
        outcomes.push({ source: 'workday', board: board.board, error: null });
      } catch (error) {
        outcomes.push({
          source: 'workday',
          board: board.board,
          error: error instanceof Error ? error.message : 'Could not be read',
        });
      }
    },
  );
  await markBoardsSwept(db, owner.userId, outcomes, clock.now());
  const seen = await seenJobKeys(db, owner.userId);
  const fresh = uniqueJobRefs(swept.map((ref) => ref.link)).filter(
    (ref) => !seen.has(`${ref.source}:${ref.board}:${ref.jobId}`),
  );
  if (fresh.length === 0) return 0;
  const runId = await startRun(db, owner.userId, 'sweep', localDateIn(now, owner.timeZone), now);
  if (!runId) return 0; // A search is running: it reads the boards itself.
  const toRead = fresh.slice(0, MAX_NEW_JOBS_PER_RUN);
  try {
    await setRunProgress(db, runId, {
      ...EMPTY_PROGRESS,
      step: 'reading',
      boardsDone: outcomes.length,
      boardsTotal: outcomes.length,
      jobsTotal: toRead.length,
    });
    await readAndSaveJobs(deps, owner, profile, runId, toRead, {
      queryTerms,
      fromSearch,
      now,
      deadline,
    });
    await setRunProgress(db, runId, {
      ...EMPTY_PROGRESS,
      step: 'done',
      boardsDone: outcomes.length,
      boardsTotal: outcomes.length,
      jobsRead: toRead.length,
      jobsTotal: toRead.length,
    });
    await finishRun(db, runId, { status: 'done', searches: 0, error: null }, clock.now());
  } catch (error) {
    await finishRun(
      db,
      runId,
      { status: 'failed', searches: 0, error: 'The board check stopped with an error' },
      clock.now(),
    );
    throw error;
  }
  return toRead.length;
}

/** Drafts one job: profile answers by code, the rest by the model. Returns false if it failed. */
export async function draftHit(
  deps: Pick<JobSearchDeps, 'db' | 'clock' | 'claude' | 'fetchPage' | 'fetchBoard'>,
  userId: string,
  profile: JobSearchProfile,
  hitId: string,
  resumeText: string,
): Promise<boolean> {
  const hit = await getHit(deps.db, userId, hitId);
  if (!hit) return false;
  const questions = hit.questions ?? [];
  // The posting's text is read again rather than stored: it is long and only needed here.
  let postingText = '';
  const ref = jobRefOf(hit.jobLink);
  try {
    if (ref) postingText = (await readJob(ref, deps.fetchPage, deps.fetchBoard)).text;
  } catch {
    // Drafting still works from the title and the questions.
  }
  const model = await deps.claude.draft({
    resumeText,
    company: hit.company,
    role: hit.role,
    postingText,
    questions: questionsForModel(questions, profile),
  });
  if (!model) {
    await saveDraft(
      deps.db,
      userId,
      hitId,
      { error: 'The draft did not finish' },
      deps.clock.now(),
    );
    return false;
  }
  // The board did not say how the job is worked, and the posting does: a job that turns out to
  // be on-site somewhere else leaves the queue here, before it is ever shown as ready.
  if (hit.state === 'new' && !hit.workMode && model.workMode !== 'unknown') {
    const stated = model.location.trim() || null;
    const problem = workModeProblem(model.workMode, stated ?? hit.location, {
      workModes: profile.workModes,
      commuteArea: profile.commuteArea,
      homeState: profile.state,
    });
    await savePostingRead(
      deps.db,
      userId,
      hitId,
      {
        workMode: model.workMode,
        location: stated,
        skipReason: problem ? `${problem} (read in the posting)` : null,
      },
      deps.clock.now(),
    );
    if (problem) return false;
  }
  await saveDraft(
    deps.db,
    userId,
    hitId,
    assembleDraft(questions, profile, model),
    deps.clock.now(),
  );
  return true;
}

/** Drafts waiting jobs until `deadline`, at most MAX_DRAFTS_PER_RUN. Returns how many it drafted. */
export async function draftPending(
  deps: JobSearchDeps,
  userId: string,
  profile: JobSearchProfile,
  deadline: number,
  /** Told how many jobs wait, then after each draft (done or failed). */
  onProgress: (done: number, total: number) => void = () => {},
): Promise<number> {
  const resume = await getResumeText(deps.db, userId);
  if (!resume) {
    onProgress(0, 0);
    return 0;
  }
  const waiting = await listUndrafted(deps.db, userId, MAX_DRAFTS_PER_RUN);
  let drafted = 0;
  let tried = 0;
  onProgress(0, waiting.length);
  await pool(
    waiting,
    DRAFT_CONCURRENCY,
    () => Date.now() < deadline,
    async (hit) => {
      if (await draftHit(deps, userId, profile, hit.id, resume.text)) drafted += 1;
      tried += 1;
      onProgress(tried, waiting.length);
    },
  );
  return drafted;
}

/**
 * A job from its search result alone: the title as the role (without "Job Application for" and
 * the site's name after a dash or bar), the company from the board name, and the age when the
 * search engine gave one.
 */
export function jobFromSearchResult(
  ref: JobRef,
  result: { title: string; pageAge: string | null },
  now: Date,
): JobDetails | null {
  const role = result.title
    .replace(/^job application for\s+/i, '')
    .split(/\s+(?:[|–—-]|at)\s+/)[0]
    ?.trim()
    .slice(0, 200);
  if (!role) return null;
  return {
    company: companyFromSlug(ref.board),
    role,
    location: null,
    workMode: null,
    postedAt: pageAgeToDate(result.pageAge, now),
    postedDayOnly: true,
    country: null,
    applyLink: ref.link,
    salary: null,
    text: '',
    questions: null,
  };
}

/** "3 days ago", "1 week ago" or a date, as search engines give a page's age. */
export function pageAgeToDate(pageAge: string | null, now: Date): Date | null {
  if (!pageAge) return null;
  const relative = /^(\d+)\s+(minute|hour|day|week|month)s?\s+ago$/i.exec(pageAge.trim());
  if (relative) {
    const unit = {
      minute: 60e3,
      hour: 3600e3,
      day: 86400e3,
      week: 7 * 86400e3,
      month: 30 * 86400e3,
    };
    const ms =
      Number(relative[1]) * unit[(relative[2] ?? 'day').toLowerCase() as keyof typeof unit];
    return new Date(now.getTime() - ms);
  }
  const parsed = Date.parse(pageAge);
  return Number.isFinite(parsed) ? new Date(parsed) : null;
}
