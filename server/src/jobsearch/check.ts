import { belowSalaryFloor, CHECKABLE_SOURCES, jobRefOf, type QueueCheckResult } from '@jat/shared';
import type { Clock } from '../clock';
import type { Queryable } from '../db/types';
import type { PageFetcher } from '../postings/fetchPage';
import { listToCheck, markBelowFloor, markChecked } from '../repo/jobSearch';
import { JobReadError, readJob } from './readJob';
import { pool } from './run';

/** Jobs checked per call: each is one read of the board, a second or two. */
export const MAX_CHECKS_PER_CALL = 60;
/** The scheduled check reads a job again once this long has passed (about once a day). */
export const SCHEDULED_CHECK_AGE_MS = 20 * 60 * 60 * 1000;
/** A check by hand skips jobs checked in the last few minutes (a double press costs nothing). */
export const MANUAL_CHECK_AGE_MS = 5 * 60 * 1000;
const CHECK_CONCURRENCY = 4;

export interface CheckDeps {
  db: Queryable;
  clock: Clock;
  fetchPage: PageFetcher;
  fetchBoard: PageFetcher;
}

export type CheckVerdict = 'open' | 'closed' | 'unknown';

/**
 * What one read of the board says. Only a clear "gone" (404/410, or missing from the board's own
 * list) closes a job: a timeout, a rate limit or a changed page says nothing about the job.
 */
export function verdictOf(error: unknown): CheckVerdict {
  if (error === null) return 'open';
  return error instanceof JobReadError && error.gone ? 'closed' : 'unknown';
}

/**
 * Reads waiting jobs again on their boards and closes the ones that are gone, and skips the open
 * ones whose posted pay is under the salary floor (so raising the floor cleans the queue). A job
 * that could not be read is left as it was and not marked checked, so the next check tries it again.
 */
export async function checkOpenJobs(
  deps: CheckDeps,
  userId: string,
  options: { maxAgeMs: number; deadline: number; limit?: number; salaryFloor: number | null },
): Promise<QueueCheckResult> {
  const now = deps.clock.now();
  const hits = await listToCheck(
    deps.db,
    userId,
    CHECKABLE_SOURCES,
    new Date(now.getTime() - options.maxAgeMs),
    options.limit ?? MAX_CHECKS_PER_CALL,
  );
  const result: QueueCheckResult = { checked: 0, closed: 0, unknown: 0, belowFloor: 0 };
  await pool(
    hits,
    CHECK_CONCURRENCY,
    () => Date.now() < options.deadline,
    async (hit) => {
      const ref = jobRefOf(hit.jobLink);
      let verdict: CheckVerdict = 'unknown';
      let underFloor: string | null = null;
      if (ref) {
        try {
          const job = await readJob(ref, deps.fetchPage, deps.fetchBoard);
          verdict = verdictOf(null);
          underFloor = belowSalaryFloor(job.salary, options.salaryFloor);
        } catch (error) {
          verdict = verdictOf(error);
        }
      }
      if (verdict === 'unknown') {
        result.unknown += 1;
        return;
      }
      result.checked += 1;
      if (underFloor) {
        await markBelowFloor(deps.db, userId, hit.id, underFloor, deps.clock.now());
        result.belowFloor += 1;
        return;
      }
      await markChecked(deps.db, userId, hit.id, verdict === 'closed', deps.clock.now());
      if (verdict === 'closed') result.closed += 1;
    },
  );
  return result;
}
