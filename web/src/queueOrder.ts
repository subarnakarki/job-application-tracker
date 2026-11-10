import type { JobHit } from '@jat/shared';

/** How the queue's jobs are ordered: the newest posting first (the default), or the best fit. */
export const QUEUE_ORDERS = ['newest', 'fit'] as const;
export type QueueOrder = (typeof QUEUE_ORDERS)[number];
export const QUEUE_ORDER_LABELS: Record<QueueOrder, string> = {
  newest: 'Newest first',
  fit: 'Best fit first',
};

type Dated = Pick<JobHit, 'postedAt' | 'createdAt'>;

/** When a job went up, as far as is known: its posting time, else when the search found it. */
const postedTime = (hit: Dated): number => Date.parse(hit.postedAt ?? hit.createdAt);

/**
 * The jobs with the newest posting first, so the ones to apply to early are on top. A job without
 * a posting time counts from when it was found. The order given (best fit first, from the server)
 * breaks ties, and is returned as it is for 'fit'.
 */
export function orderQueue<T extends Dated>(hits: readonly T[], order: QueueOrder): T[] {
  if (order === 'fit') return [...hits];
  return hits
    .map((hit, index) => ({ hit, index }))
    .sort((a, b) => postedTime(b.hit) - postedTime(a.hit) || a.index - b.index)
    .map((entry) => entry.hit);
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "2 hours ago", "3 days ago": how long since an instant, in the largest whole unit. */
export function ago(instant: string, now: Date): string {
  const elapsed = Math.max(0, now.getTime() - Date.parse(instant));
  const unit = (count: number, name: string) =>
    `${String(count)} ${name}${count === 1 ? '' : 's'} ago`;
  if (elapsed < HOUR)
    return elapsed < MINUTE ? 'just now' : unit(Math.floor(elapsed / MINUTE), 'minute');
  if (elapsed < DAY) return unit(Math.floor(elapsed / HOUR), 'hour');
  return unit(Math.floor(elapsed / DAY), 'day');
}
