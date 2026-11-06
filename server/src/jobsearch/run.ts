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
import { readJob, type JobDetails } from './readJob';

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
    for (const query of profile.queries) {
      const parsed = parseQuery(query);
      queryTerms.push(...parsed.terms);
      const found = await deps.claude.search(query, parsed.sources, profile.timeframeDays);
      searches += found.searches;
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
      now,
    };
    await pool(
      refs.slice(0, MAX_NEW_JOBS_PER_RUN),
      READ_CONCURRENCY,
      () => Date.now() < deadline,
      async (ref) => {
        let job: JobDetails;
        try {
          job = await readJob(ref, deps.fetchPage, deps.fetchBoard);
        } catch {
          // A job that cannot be read (closed, or the board is down) is left for another day.
          return;
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
            alreadyTracked,
          },
          rules,
        );
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
            reason: sorted.reason,
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
