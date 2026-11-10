import {
  ApplicationDraftSchema,
  ApplicationQuestionSchema,
  JobSearchProfileSchema,
  jobFit,
  TailoringSchema,
  type Tailoring,
  trackedMatcher,
  type Status,
  type TrackedApplication,
  RunProgressSchema,
  type RunProgress,
  type ApplicationDraft,
  type ApplicationQuestion,
  type HitKind,
  type HitState,
  type JobHit,
  type JobSearchProfile,
  type JobSearchRun,
  type RunCounts,
  type SearchSource,
  type WorkMode,
} from '@jat/shared';
import { z } from 'zod';
import type { Queryable } from '../db/types';
import { getResumeText } from './resumes';

/**
 * All SQL for the job search: the profile, runs and hits. Every statement is scoped by `user_id`,
 * so someone else's run or hit behaves exactly like one that does not exist.
 */

// ---------- Profile ----------

export async function getProfile(
  db: Queryable,
  userId: string,
): Promise<{ profile: JobSearchProfile; confirmedAt: Date } | null> {
  const result = await db.query<{ profile: unknown; confirmed_at: Date }>(
    'select profile, confirmed_at from job_search_profiles where user_id = $1',
    [userId],
  );
  const row = result.rows[0];
  if (!row) return null;
  // A stored profile that no longer parses (the schema grew) is treated as not set up.
  const parsed = JobSearchProfileSchema.safeParse(row.profile);
  return parsed.success ? { profile: parsed.data, confirmedAt: row.confirmed_at } : null;
}

export async function saveProfile(
  db: Queryable,
  userId: string,
  profile: JobSearchProfile,
  now: Date,
): Promise<Date> {
  const result = await db.query<{ confirmed_at: Date }>(
    `insert into job_search_profiles (user_id, profile, confirmed_at, updated_at)
      values ($1, $2, $3, $3)
      on conflict (user_id) do update set profile = excluded.profile, updated_at = excluded.updated_at
      returning confirmed_at`,
    [userId, JSON.stringify(profile), now],
  );
  return (result.rows[0] as { confirmed_at: Date }).confirmed_at;
}

// ---------- Runs ----------

interface RunRow {
  id: string;
  progress: unknown;
  trigger: 'schedule' | 'manual';
  status: 'running' | 'done' | 'failed';
  searches: number;
  error: string | null;
  started_at: Date;
  finished_at: Date | null;
  found: number;
  target: number;
  keyword_only: number;
  finish_yourself: number;
  skipped: number;
  ready: number;
  needs_you: number;
  applied: number;
  blocked: number;
  not_drafted: number;
}

const RUN_SELECT = `r.id, r.progress, r.trigger, r.status, r.searches, r.error, r.started_at, r.finished_at,
  count(h.id)::int as found,
  count(h.id) filter (where h.kind = 'target')::int as target,
  count(h.id) filter (where h.kind = 'keyword_only')::int as keyword_only,
  count(h.id) filter (where h.kind = 'finish_yourself')::int as finish_yourself,
  count(h.id) filter (where h.kind = 'skipped' or h.state = 'skipped')::int as skipped,
  count(h.id) filter (where h.state = 'ready')::int as ready,
  count(h.id) filter (where h.state = 'needs_you')::int as needs_you,
  count(h.id) filter (where h.state = 'applied')::int as applied,
  count(h.id) filter (where h.state = 'blocked')::int as blocked,
  count(h.id) filter (where h.state = 'new' and h.kind in ('target', 'finish_yourself'))::int
    as not_drafted
  from job_search_runs r left join job_search_hits h on h.run_id = r.id`;

function toRun(row: RunRow): JobSearchRun {
  const counts: RunCounts = {
    found: row.found,
    target: row.target,
    keywordOnly: row.keyword_only,
    finishYourself: row.finish_yourself,
    skipped: row.skipped,
    ready: row.ready,
    needsYou: row.needs_you,
    applied: row.applied,
    blocked: row.blocked,
    notDrafted: row.not_drafted,
  };
  return {
    id: row.id,
    trigger: row.trigger,
    status: row.status,
    searches: row.searches,
    error: row.error,
    startedAt: row.started_at.toISOString(),
    finishedAt: row.finished_at?.toISOString() ?? null,
    counts,
    progress: RunProgressSchema.nullable()
      .catch(null)
      .parse(row.progress ?? null),
  };
}

/** A run that has been running this long is dead (the function limit is 300 s). */
const STALE_RUN_MS = 10 * 60 * 1000;

/**
 * Starts a run, or returns null when one is already running. A run left running by a crash is
 * marked failed first, so it cannot block searches for ever.
 */
export async function startRun(
  db: Queryable,
  userId: string,
  trigger: 'schedule' | 'manual' | 'sweep',
  localDay: string,
  now: Date,
): Promise<string | null> {
  await db.query(
    `update job_search_runs set status = 'failed', error = 'Stopped before it finished',
      finished_at = $3
      where user_id = $1 and status = 'running' and started_at < $2`,
    [userId, new Date(now.getTime() - STALE_RUN_MS), now],
  );
  const result = await db.query<{ id: string }>(
    `insert into job_search_runs (user_id, trigger, local_day, started_at) values ($1, $2, $3, $4)
      on conflict (user_id) where status = 'running' do nothing returning id`,
    [userId, trigger, localDay, now],
  );
  return result.rows[0]?.id ?? null;
}

export async function finishRun(
  db: Queryable,
  runId: string,
  outcome: { status: 'done' | 'failed'; searches: number; error: string | null },
  now: Date,
): Promise<void> {
  await db.query(
    `update job_search_runs set status = $2, searches = $3, error = $4, finished_at = $5
      where id = $1`,
    [runId, outcome.status, outcome.searches, outcome.error?.slice(0, 500) ?? null, now],
  );
}

/**
 * The schedule's view of past runs: the last local day a scheduled run finished (a failed one does
 * not count), and how many scheduled runs started on `today` whatever their outcome.
 */
export async function scheduledRunState(
  db: Queryable,
  userId: string,
  today: string,
): Promise<{ lastDoneDay: string | null; triesToday: number }> {
  const result = await db.query<{ day: string | null; tries: number }>(
    `select to_char(max(local_day) filter (where status = 'done'), 'YYYY-MM-DD') as day,
        (count(*) filter (where local_day = $2::date))::int as tries
      from job_search_runs where user_id = $1 and trigger = 'schedule'`,
    [userId, today],
  );
  const row = result.rows[0];
  return { lastDoneDay: row?.day ?? null, triesToday: row?.tries ?? 0 };
}

export async function listRuns(db: Queryable, userId: string, limit = 10): Promise<JobSearchRun[]> {
  const result = await db.query<RunRow>(
    `select ${RUN_SELECT} where r.user_id = $1 group by r.id order by r.started_at desc limit $2`,
    [userId, limit],
  );
  return result.rows.map(toRun);
}

export async function getRun(
  db: Queryable,
  userId: string,
  id: string,
): Promise<JobSearchRun | null> {
  const result = await db.query<RunRow>(
    `select ${RUN_SELECT} where r.user_id = $1 and r.id = $2 group by r.id`,
    [userId, id],
  );
  const row = result.rows[0];
  return row ? toRun(row) : null;
}

// ---------- Hits ----------

export interface HitInput {
  runId: string;
  source: SearchSource;
  board: string;
  jobId: string;
  jobLink: string;
  applyLink: string;
  company: string;
  role: string;
  location: string | null;
  workMode: WorkMode | null;
  postedAt: Date | null;
  kind: HitKind;
  reason: string;
  questions: ApplicationQuestion[] | null;
}

interface HitRow {
  id: string;
  run_id: string;
  source: SearchSource;
  job_link: string;
  apply_link: string;
  company: string;
  role: string;
  location: string | null;
  work_mode: WorkMode | null;
  posted_at: Date | null;
  kind: HitKind;
  reason: string;
  state: HitState;
  questions: unknown;
  draft: unknown;
  draft_error: string | null;
  block_reason: string | null;
  application_id: string | null;
  created_at: Date;
  checked_at: Date | null;
  tailoring: unknown;
}

const HIT_COLUMNS = `id, run_id, source, job_link, apply_link, company, role, location, work_mode,
  posted_at, kind, reason, state, questions, draft, draft_error, block_reason, application_id,
  created_at, checked_at, tailoring`;

const QuestionsSchema = z.array(ApplicationQuestionSchema).nullable();

function toHit(row: HitRow): JobHit {
  const questions = QuestionsSchema.safeParse(row.questions);
  const draft = ApplicationDraftSchema.nullable().safeParse(row.draft);
  const tailoring = TailoringSchema.nullable().safeParse(row.tailoring);
  return {
    id: row.id,
    runId: row.run_id,
    source: row.source,
    company: row.company,
    role: row.role,
    location: row.location,
    workMode: row.work_mode,
    postedAt: row.posted_at?.toISOString() ?? null,
    jobLink: row.job_link,
    applyLink: row.apply_link,
    kind: row.kind,
    reason: row.reason,
    state: row.state,
    questions: questions.success ? questions.data : null,
    draft: draft.success ? draft.data : null,
    draftError: row.draft_error,
    blockReason: row.block_reason,
    applicationId: row.application_id,
    createdAt: row.created_at.toISOString(),
    checkedAt: row.checked_at?.toISOString() ?? null,
    fit: null,
    tailoring: tailoring.success ? tailoring.data : null,
    tracked: null,
  };
}

/** The user's applications, for spotting found jobs that are already in the tracker. */
export async function listTrackedApplications(
  db: Queryable,
  userId: string,
): Promise<TrackedApplication[]> {
  const result = await db.query<{
    id: string;
    company: string;
    role: string;
    status: Status;
    job_link: string | null;
  }>('select id, company, role, status, job_link from applications where user_id = $1', [userId]);
  return result.rows.map((row) => ({
    id: row.id,
    company: row.company,
    role: row.role,
    status: row.status,
    jobLink: row.job_link,
  }));
}

/**
 * Annotates hits as they are read, never stored: whether each is already in the tracker (the
 * application a hit created, else the same posting by link, else the same company and role), and
 * its fit with the resume as it is now.
 */
async function withTracked(db: Queryable, userId: string, hits: JobHit[]): Promise<JobHit[]> {
  if (hits.length === 0) return hits;
  const resume = hits.some((hit) => hit.draft?.keywords) ? await getResumeText(db, userId) : null;
  const scored = hits.map((hit) => ({ ...hit, fit: jobFit(hit.draft, resume?.text ?? null) }));
  return withApplications(db, userId, scored);
}

async function withApplications(db: Queryable, userId: string, hits: JobHit[]): Promise<JobHit[]> {
  const applications = await listTrackedApplications(db, userId);
  const byId = new Map(applications.map((application) => [application.id, application]));
  const find = trackedMatcher(applications);
  return hits.map((hit) => {
    const application =
      (hit.applicationId ? byId.get(hit.applicationId) : undefined) ??
      find({ links: [hit.jobLink, hit.applyLink], company: hit.company, role: hit.role });
    return application
      ? { ...hit, tracked: { applicationId: application.id, status: application.status } }
      : hit;
  });
}

/** The (source, board, job id) keys of jobs this user has already seen, to skip them early. */
export async function seenJobKeys(db: Queryable, userId: string): Promise<Set<string>> {
  const result = await db.query<{ key: string }>(
    `select source || ':' || board || ':' || job_id as key from job_search_hits where user_id = $1`,
    [userId],
  );
  return new Set(result.rows.map((row) => row.key));
}

/** Saves a found job; returns null when the user already has it (another run got there first). */
export async function insertHit(
  db: Queryable,
  userId: string,
  input: HitInput,
  now: Date,
): Promise<string | null> {
  const result = await db.query<{ id: string }>(
    `insert into job_search_hits (user_id, run_id, source, board, job_id, job_link, apply_link,
        company, role, location, work_mode, posted_at, kind, reason, state, questions, created_at,
        updated_at)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $17)
      on conflict (user_id, source, board, job_id) do nothing returning id`,
    [
      userId,
      input.runId,
      input.source,
      input.board.slice(0, 100),
      input.jobId.slice(0, 200),
      input.jobLink.slice(0, 2000),
      input.applyLink.slice(0, 2000),
      input.company.slice(0, 200),
      input.role.slice(0, 200),
      input.location?.slice(0, 200) ?? null,
      input.workMode,
      input.postedAt,
      input.kind,
      input.reason.slice(0, 300),
      input.kind === 'skipped' ? 'skipped' : 'new',
      input.questions === null ? null : JSON.stringify(input.questions),
      now,
    ],
  );
  return result.rows[0]?.id ?? null;
}

export async function getHit(db: Queryable, userId: string, id: string): Promise<JobHit | null> {
  const result = await db.query<HitRow>(
    `select ${HIT_COLUMNS} from job_search_hits where user_id = $1 and id = $2`,
    [userId, id],
  );
  const row = result.rows[0];
  return row ? ((await withTracked(db, userId, [toHit(row)]))[0] ?? null) : null;
}

export async function listRunHits(db: Queryable, userId: string, runId: string): Promise<JobHit[]> {
  const result = await db.query<HitRow>(
    `select ${HIT_COLUMNS} from job_search_hits where user_id = $1 and run_id = $2
      order by case kind when 'target' then 0 when 'finish_yourself' then 1
        when 'keyword_only' then 2 else 3 end, posted_at desc nulls last, created_at`,
    [userId, runId],
  );
  return withTracked(db, userId, result.rows.map(toHit));
}

/** Every hit still waiting on something, newest first (at most 200). */
export async function listOpenHits(db: Queryable, userId: string): Promise<JobHit[]> {
  const result = await db.query<HitRow>(
    `select ${HIT_COLUMNS} from job_search_hits
      where user_id = $1 and kind <> 'skipped' and state in ('new', 'ready', 'needs_you')
      order by posted_at desc nulls last, created_at desc limit 200`,
    [userId],
  );
  return withTracked(db, userId, result.rows.map(toHit));
}

/** Drafted jobs still waiting in the queue whose board published the questions. */
export async function listDraftedWaiting(db: Queryable, userId: string): Promise<JobHit[]> {
  const result = await db.query<HitRow>(
    `select ${HIT_COLUMNS} from job_search_hits
      where user_id = $1 and state in ('ready', 'needs_you')
        and draft is not null and questions is not null
      order by created_at, id`,
    [userId],
  );
  return result.rows.map(toHit);
}

/** Targets (and finish-yourself jobs) still waiting for a draft, oldest first. */
export async function listUndrafted(
  db: Queryable,
  userId: string,
  limit: number,
): Promise<JobHit[]> {
  const result = await db.query<HitRow>(
    `select ${HIT_COLUMNS} from job_search_hits
      where user_id = $1 and state = 'new' and kind in ('target', 'finish_yourself')
      order by created_at, id limit $2`,
    [userId, limit],
  );
  return withTracked(db, userId, result.rows.map(toHit));
}

/**
 * What the draft read in a waiting job's posting, for a job whose board did not say how it is
 * worked: the work mode, the location when the board gave none, and, when that rules the job out,
 * the reason it is skipped. Only a job not drafted yet changes.
 */
export async function savePostingRead(
  db: Queryable,
  userId: string,
  id: string,
  read: { workMode: WorkMode; location: string | null; skipReason: string | null },
  now: Date,
): Promise<void> {
  await db.query(
    `update job_search_hits set work_mode = $3, location = coalesce(location, $4),
        kind = case when $5::text is null then kind else 'skipped' end,
        state = case when $5::text is null then state else 'skipped' end,
        reason = coalesce($5, reason), updated_at = $6
      where user_id = $1 and id = $2 and state = 'new'`,
    [
      userId,
      id,
      read.workMode,
      read.location?.slice(0, 200) ?? null,
      read.skipReason?.slice(0, 300) ?? null,
      now,
    ],
  );
}

/** Failed drafts before a job stops being drafted automatically. */
export const MAX_DRAFT_ATTEMPTS = 3;
export const GAVE_UP_DRAFTING = `Couldn't draft this job after ${String(MAX_DRAFT_ATTEMPTS)} tries: answer it yourself, or press Redraft`;

export async function saveDraft(
  db: Queryable,
  userId: string,
  id: string,
  outcome: { draft: ApplicationDraft; needsYou: boolean } | { error: string },
  now: Date,
): Promise<void> {
  if ('error' in outcome) {
    // A job that keeps failing leaves the automatic batch: at MAX_DRAFT_ATTEMPTS it moves to Needs
    // you, where only Redraft tries it again. One already there (no draft yet) keeps its state.
    await db.query(
      `update job_search_hits set
          draft_attempts = draft_attempts + 1,
          state = case when state = 'new' and draft_attempts + 1 >= $5 then 'needs_you' else state end,
          draft_error = case when state = 'new' and draft_attempts + 1 < $5 then $3 else $6 end,
          updated_at = $4
        where user_id = $1 and id = $2 and (state = 'new' or (state = 'needs_you' and draft is null))`,
      [userId, id, outcome.error.slice(0, 300), now, MAX_DRAFT_ATTEMPTS, GAVE_UP_DRAFTING],
    );
    return;
  }
  // Only a job still in the queue: one marked applied or skipped meanwhile keeps its state.
  await db.query(
    `update job_search_hits set draft = $3, state = $4, draft_error = null, draft_attempts = 0,
        updated_at = $5
      where user_id = $1 and id = $2 and state in ('new', 'ready', 'needs_you')`,
    [userId, id, JSON.stringify(outcome.draft), outcome.needsYou ? 'needs_you' : 'ready', now],
  );
}

export async function setHitState(
  db: Queryable,
  userId: string,
  id: string,
  change: {
    state: HitState;
    kind?: HitKind;
    blockReason?: string | null;
    applicationId?: string | null;
  },
  now: Date,
): Promise<boolean> {
  const result = await db.query(
    `update job_search_hits set state = $3, kind = coalesce($4, kind),
        block_reason = case when $5::boolean then $6 else block_reason end,
        application_id = coalesce($7, application_id), updated_at = $8
      where user_id = $1 and id = $2`,
    [
      userId,
      id,
      change.state,
      change.kind ?? null,
      change.blockReason !== undefined,
      change.blockReason ?? null,
      change.applicationId ?? null,
      now,
    ],
  );
  return result.rowCount > 0;
}

/** Links a job to its application in the tracker, without changing its state. */
export async function linkHitApplication(
  db: Queryable,
  userId: string,
  id: string,
  applicationId: string,
  now: Date,
): Promise<void> {
  await db.query(
    `update job_search_hits set application_id = $3, updated_at = $4
      where user_id = $1 and id = $2`,
    [userId, id, applicationId, now],
  );
}

/** Everything, for the data export. */
export async function exportJobSearch(
  db: Queryable,
  userId: string,
): Promise<{ profile: JobSearchProfile | null; runs: JobSearchRun[]; hits: JobHit[] }> {
  const profile = await getProfile(db, userId);
  const runs = await listRuns(db, userId, 1000);
  const hits = await db.query<HitRow>(
    `select ${HIT_COLUMNS} from job_search_hits where user_id = $1 order by created_at`,
    [userId],
  );
  return {
    profile: profile?.profile ?? null,
    runs,
    hits: await withTracked(db, userId, hits.rows.map(toHit)),
  };
}

export interface WatchedBoardRow {
  id: string;
  source: SearchSource;
  board: string;
  addedBy: 'search' | 'user';
  lastSweptAt: Date | null;
  lastError: string | null;
}

interface BoardRow {
  id: string;
  source: SearchSource;
  board: string;
  added_by: 'search' | 'user';
  last_swept_at: Date | null;
  last_error: string | null;
}
const toBoard = (row: BoardRow): WatchedBoardRow => ({
  id: row.id,
  source: row.source,
  board: row.board,
  addedBy: row.added_by,
  lastSweptAt: row.last_swept_at,
  lastError: row.last_error,
});
const BOARD_COLUMNS = 'id, source, board, added_by, last_swept_at, last_error';

/**
 * The companies' boards this user watches (found by a search, or added by hand), the ones read
 * longest ago first (never read comes first): the next boards to sweep for fresh jobs. `sources`
 * narrows it to the boards whose lists can be read.
 */
export async function watchedBoards(
  db: Queryable,
  userId: string,
  limit: number,
  sources?: readonly string[],
): Promise<WatchedBoardRow[]> {
  const result = await db.query<BoardRow>(
    `select ${BOARD_COLUMNS} from job_search_boards
      where user_id = $1 and ($3::text[] is null or source = any($3))
      order by last_swept_at nulls first, created_at, id limit $2`,
    [userId, limit, sources ? [...sources] : null],
  );
  return result.rows.map(toBoard);
}

/** Starts watching a board; one already watched stays as it is. Returns the row either way. */
export async function watchBoard(
  db: Queryable,
  userId: string,
  board: { source: SearchSource; board: string },
  addedBy: 'search' | 'user',
  now: Date,
): Promise<WatchedBoardRow | null> {
  await db.query(
    `insert into job_search_boards (user_id, source, board, added_by, created_at)
      values ($1, $2, $3, $4, $5) on conflict (user_id, source, board) do nothing`,
    [userId, board.source, board.board.slice(0, 100), addedBy, now],
  );
  const result = await db.query<BoardRow>(
    `select ${BOARD_COLUMNS} from job_search_boards
      where user_id = $1 and source = $2 and board = $3`,
    [userId, board.source, board.board.slice(0, 100)],
  );
  const row = result.rows[0];
  return row ? toBoard(row) : null;
}

/** Stops watching a board. False when it is not this user's. */
export async function unwatchBoard(db: Queryable, userId: string, id: string): Promise<boolean> {
  const result = await db.query('delete from job_search_boards where user_id = $1 and id = $2', [
    userId,
    id,
  ]);
  return result.rowCount > 0;
}

/** Notes that boards were just read: when, and what went wrong (null when it worked). */
export async function markBoardsSwept(
  db: Queryable,
  userId: string,
  outcomes: { source: string; board: string; error: string | null }[],
  now: Date,
): Promise<void> {
  if (outcomes.length === 0) return;
  await db.query(
    `update job_search_boards b set last_swept_at = $2, last_error = o.error
      from unnest($3::text[], $4::text[], $5::text[]) as o(source, board, error)
      where b.user_id = $1 and b.source = o.source and b.board = o.board`,
    [
      userId,
      now,
      outcomes.map((outcome) => outcome.source),
      outcomes.map((outcome) => outcome.board),
      outcomes.map((outcome) => outcome.error?.slice(0, 300) ?? null),
    ],
  );
}

/** Jobs skipped only for their age, newest posting first: candidates for "older matches". */
export async function listAgeSkipped(
  db: Queryable,
  userId: string,
  limit: number,
): Promise<JobHit[]> {
  const result = await db.query<HitRow>(
    `select ${HIT_COLUMNS} from job_search_hits
      where user_id = $1 and kind = 'skipped' and state = 'skipped'
        and reason like 'Posted more than%'
      order by posted_at desc nulls last, created_at desc limit $2`,
    [userId, limit],
  );
  return withTracked(db, userId, result.rows.map(toHit));
}

/** Records how far a run has got. */
export async function setRunProgress(
  db: Queryable,
  runId: string,
  progress: RunProgress,
): Promise<void> {
  await db.query('update job_search_runs set progress = $2 where id = $1', [
    runId,
    JSON.stringify(progress),
  ]);
}

/** States in which a job is still waiting in the queue (and can be checked or closed). */
const WAITING = "('new', 'ready', 'needs_you')";

/**
 * Waiting jobs to check again on their board: on a board that can be read, not checked since
 * `checkedBefore`, never-checked and longest-unchecked first.
 */
export async function listToCheck(
  db: Queryable,
  userId: string,
  sources: readonly string[],
  checkedBefore: Date,
  limit: number,
): Promise<JobHit[]> {
  const result = await db.query<HitRow>(
    `select ${HIT_COLUMNS} from job_search_hits
      where user_id = $1 and kind <> 'skipped' and state in ${WAITING}
        and source = any($2::text[]) and (checked_at is null or checked_at < $3)
      order by checked_at nulls first, created_at, id limit $4`,
    [userId, [...sources], checkedBefore, limit],
  );
  return result.rows.map(toHit);
}

/** Records a check; a job its board says is gone is closed (only while it is still waiting). */
export async function markChecked(
  db: Queryable,
  userId: string,
  id: string,
  closed: boolean,
  now: Date,
): Promise<boolean> {
  const result = await db.query(
    `update job_search_hits set checked_at = $3,
        state = case when $4::boolean then 'closed' else state end, updated_at = $3
      where user_id = $1 and id = $2 and state in ${WAITING}`,
    [userId, id, now, closed],
  );
  return result.rowCount > 0;
}

/** Records a check that found the job's pay under the floor: skipped (only while still waiting). */
export async function markBelowFloor(
  db: Queryable,
  userId: string,
  id: string,
  reason: string,
  now: Date,
): Promise<boolean> {
  const result = await db.query(
    `update job_search_hits set checked_at = $3, state = 'skipped', kind = 'skipped', reason = $4,
        updated_at = $3
      where user_id = $1 and id = $2 and state in ${WAITING}`,
    [userId, id, now, reason],
  );
  return result.rowCount > 0;
}

/** For the queue: the latest check of any job, and jobs closed in the past week. */
export async function checkSummary(
  db: Queryable,
  userId: string,
  now: Date,
): Promise<{ lastCheckedAt: string | null; closedThisWeek: number }> {
  const result = await db.query<{ last_checked: Date | null; closed: number }>(
    `select max(checked_at) as last_checked,
        count(*) filter (where state = 'closed' and updated_at >= $2)::int as closed
      from job_search_hits where user_id = $1`,
    [userId, new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)],
  );
  const row = result.rows[0];
  return {
    lastCheckedAt: row?.last_checked?.toISOString() ?? null,
    closedThisWeek: row?.closed ?? 0,
  };
}

/** Stores the suggested resume edits for a job (tailoring again replaces them). */
export async function saveTailoring(
  db: Queryable,
  userId: string,
  id: string,
  tailoring: Tailoring,
  now: Date,
): Promise<void> {
  await db.query(
    `update job_search_hits set tailoring = $3, updated_at = $4 where user_id = $1 and id = $2`,
    [userId, id, JSON.stringify(tailoring), now],
  );
}
