import {
  assembleDraft,
  jobRefOf,
  localDateIn,
  parseQuery,
  questionsForModel,
  sortJob,
  uniqueJobRefs,
  type JobRef,
  type JobSearchProfile,
} from '@jat/shared';
import type { Clock } from '../clock';
import type { Db } from '../db/types';
import type { PageFetcher } from '../postings/fetchPage';
import {
  finishRun,
  getHit,
  insertHit,
  isTracked,
  listUndrafted,
  saveDraft,
  seenJobKeys,
  startRun,
} from '../repo/jobSearch';
import { getResumeText } from '../repo/resumes';
import { AnalyzerUnavailableError } from '../resume/analyze';
import type { JobSearchClaude } from './claude';
import { companyFromSlug, readJob, type JobDetails } from './readJob';

export interface JobSearchDeps {
  db: Db;
  clock: Clock;
  claude: JobSearchClaude;
  fetchPage: PageFetcher;
  /** For boards whose one-job read is the whole board (Ashby). */
  fetchBoard: PageFetcher;
}

/** New jobs read per run: a day's postings for a few titles, without running for ever. */
export const MAX_NEW_JOBS_PER_RUN = 40;
/** Drafts per call: each is a model call of several seconds. */
export const MAX_DRAFTS_PER_RUN = 25;
const READ_CONCURRENCY = 4;
const DRAFT_CONCURRENCY = 3;

/** Runs `work` over `items`, `limit` at a time, until the items or the time run out. */
async function pool<T>(
  items: T[],
  limit: number,
  keepGoing: () => boolean,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length && keepGoing()) {
      const item = items[next];
      next += 1;
      if (item !== undefined) await work(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

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

  let searches = 0;
  try {
    const seen = await seenJobKeys(db, owner.userId);
    const refs: JobRef[] = [];
    const queryTerms: string[] = [];
    /** The search result's title and age per job, for jobs whose page cannot be read. */
    const fromSearch = new Map<string, { title: string; pageAge: string | null }>();
    for (const query of profile.queries) {
      const parsed = parseQuery(query);
      queryTerms.push(...parsed.terms);
      const found = await deps.claude.search(
        query,
        parsed.sources,
        profile.timeframeDays,
        profile.usOnly,
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
    }

    const rules = {
      includeTitles: profile.includeTitles,
      skipTitles: profile.skipTitles,
      queryTerms,
      workModes: profile.workModes,
      timeframeDays: profile.timeframeDays,
      usOnly: profile.usOnly,
      now,
    };
    await pool(
      refs.slice(0, MAX_NEW_JOBS_PER_RUN),
      READ_CONCURRENCY,
      () => Date.now() < deadline,
      async (ref) => {
        let job: JobDetails;
        let fromResult = false;
        try {
          job = await readJob(ref, deps.fetchPage, deps.fetchBoard);
        } catch {
          // The page could not be read (closed, a board that refuses, a page drawn by script):
          // the search result's title still says what the job is. Without one, it waits.
          const result = fromSearch.get(`${ref.source}:${ref.board}:${ref.jobId}`);
          const fallback = result ? jobFromSearchResult(ref, result, now) : null;
          if (!fallback) return;
          job = fallback;
          fromResult = true;
        }
        const alreadyTracked = await isTracked(db, owner.userId, {
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
            alreadyTracked,
            location: job.location,
            country: job.country,
          },
          rules,
        );
        const reason = fromResult
          ? `${sorted.reason} (from the search result only)`
          : sorted.reason;
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
      },
    );

    await draftPending(deps, owner.userId, profile, deadline);
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
          : 'The search stopped with an error',
      },
      clock.now(),
    );
    if (unavailable) return { kind: 'unavailable' };
    throw error;
  }
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
    questions: questionsForModel(questions),
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
): Promise<number> {
  const resume = await getResumeText(deps.db, userId);
  if (!resume) return 0;
  const waiting = await listUndrafted(deps.db, userId, MAX_DRAFTS_PER_RUN);
  let drafted = 0;
  await pool(
    waiting,
    DRAFT_CONCURRENCY,
    () => Date.now() < deadline,
    async (hit) => {
      if (await draftHit(deps, userId, profile, hit.id, resume.text)) drafted += 1;
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
