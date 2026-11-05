import { DATE_APPLIED_STATUSES, type Status } from './constants';

export interface StatusChange {
  /** False when the status stayed the same: no history row is written. */
  changed: boolean;
  /** Null when the application is being created. */
  fromStatus: Status | null;
  toStatus: Status;
}

/**
 * Creating writes `null -> initial`. Any status may move to any other status
 * (a Rejected application can be reopened). Saving the same status is a no-op.
 */
export function planStatusChange(previous: Status | null, next: Status): StatusChange {
  return { changed: previous !== next, fromStatus: previous, toStatus: next };
}

const dateAppliedStatuses: readonly Status[] = DATE_APPLIED_STATUSES;

export interface DateAppliedInput {
  /** Status before the change; null on create. */
  previousStatus: Status | null;
  newStatus: Status;
  /** `dateApplied` after applying the user's edits. */
  dateApplied: string | null;
  /** The user's calendar date. */
  today: string;
}

/**
 * Fills `dateApplied` with today when the application first reaches Applied or
 * later (including being created directly as Interviewing) and the field is
 * empty. Never overwrites a date, and never refills it on later moves between
 * those statuses, so clearing it by hand sticks.
 */
export function resolveDateApplied(input: DateAppliedInput): string | null {
  if (input.dateApplied !== null) return input.dateApplied;
  const wasApplied =
    input.previousStatus !== null && dateAppliedStatuses.includes(input.previousStatus);
  const isApplied = dateAppliedStatuses.includes(input.newStatus);
  return isApplied && !wasApplied ? input.today : null;
}
