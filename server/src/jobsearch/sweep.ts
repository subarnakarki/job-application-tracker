import { indexText, jobRefOf, type JobRef, type SearchSource } from '@jat/shared';
import { BOARD_SOURCES, BOARDS, type BoardJob, type BoardSource } from '../postings/boards';
import type { PageFetcher } from '../postings/fetchPage';

/**
 * Fresh jobs straight from companies' own job boards. Web search mostly returns pages it indexed
 * long ago, many of them closed; a board's own list holds only open jobs, each with the day it was
 * posted. So every company the search has turned up is watched, and each run reads its whole list
 * and keeps the jobs posted within the timeframe whose title matches.
 */

export interface WatchedBoard {
  source: SearchSource;
  board: string;
}

export interface SweepRules {
  /** Title words that make a job worth reading (the include list, or the query's words). */
  wanted: string[];
  skipped: string[];
  timeframeDays: number;
  now: Date;
}

/** Boards read per run, and how many at once. */
export const MAX_BOARDS_PER_SWEEP = 40;
const SWEEP_CONCURRENCY = 4;
const DAY = 24 * 60 * 60 * 1000;

const isListable = (source: SearchSource): source is BoardSource =>
  (BOARD_SOURCES as readonly string[]).includes(source);

/** One link per job, on the board's own host, whatever the list gives (a careers-site embed). */
function refOf(job: BoardJob, board: WatchedBoard): JobRef | null {
  const direct = jobRefOf(job.link);
  if (direct?.source === board.source) return direct;
  if (board.source === 'greenhouse') {
    const id =
      /\/jobs\/(\d{1,20})\b/.exec(job.more?.url ?? '')?.[1] ??
      new URL(job.link).searchParams.get('gh_jid');
    if (id && /^\d{1,20}$/.test(id))
      return jobRefOf(`https://job-boards.greenhouse.io/${board.board}/jobs/${id}`);
  }
  return null;
}

/** Whether a board's job is worth reading: a wanted title, nothing skipped, and recent by its day. */
export function worthReading(job: BoardJob, rules: SweepRules): boolean {
  const title = indexText(job.title);
  if (rules.skipped.some((term) => term.trim() && title.has(term))) return false;
  if (rules.wanted.length > 0 && !rules.wanted.some((term) => term.trim() && title.has(term)))
    return false;
  const day = job.details.postedOn;
  // A list without dates cannot show what is new; those jobs are left to the search.
  if (!day) return false;
  const oldestDay = Math.floor((rules.now.getTime() - rules.timeframeDays * DAY) / DAY) * DAY;
  return Date.parse(`${day}T00:00:00Z`) >= oldestDay;
}

/**
 * Reads each watched board's list (at most MAX_BOARDS_PER_SWEEP, a few at a time) and returns the
 * new, wanted jobs on them. A board that cannot be read is skipped; others still count.
 */
export async function sweepBoards(
  boards: WatchedBoard[],
  rules: SweepRules,
  fetchBoard: PageFetcher,
  keepGoing: () => boolean,
  /** Told how many boards there are, then after each one is read. */
  onProgress: (done: number, total: number) => void = () => {},
): Promise<JobRef[]> {
  const listable = boards
    .filter((entry) => isListable(entry.source))
    .slice(0, MAX_BOARDS_PER_SWEEP);
  const found: JobRef[] = [];
  let next = 0;
  let done = 0;
  onProgress(0, listable.length);
  const worker = async () => {
    while (next < listable.length && keepGoing()) {
      const board = listable[next];
      next += 1;
      if (!board || !isListable(board.source)) continue;
      const spec = BOARDS[board.source];
      const url = spec.listUrl(board.board);
      if (!url) continue;
      let jobs: BoardJob[];
      try {
        jobs = spec.parseList((await fetchBoard(url)).text, board.board);
      } catch {
        done += 1;
        onProgress(done, listable.length);
        continue;
      }
      for (const job of jobs) {
        if (!worthReading(job, rules)) continue;
        const ref = refOf(job, board);
        if (ref) found.push(ref);
      }
      done += 1;
      onProgress(done, listable.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(SWEEP_CONCURRENCY, listable.length) }, worker));
  return found;
}
