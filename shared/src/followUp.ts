import { FOLLOW_UP_AFTER_DAYS, isFollowUpStatus, type Status } from './constants';
import { addDays, dayNumber, localDateIn } from './dates';

export interface FollowUpSubject {
  status: Status;
  /** When a real user edit last happened (the follow-up clock). */
  lastActivityAt: Date | string;
  /** `YYYY-MM-DD` or null. */
  nextStepDate: string | null;
  /** The day of the application's latest interview (`YYYY-MM-DD`), or null/absent for none. */
  latestInterviewOn?: string | null;
}

export interface FollowUpContext {
  now: Date | string;
  /** IANA zone of the user; "today" and "days since" are calendar days in this zone. */
  timeZone: string;
}

export interface FollowUpWindow {
  /** The user's calendar date at `now`. */
  today: string;
  /** An application whose last activity date is on or before this is stale. */
  staleOnOrBefore: string;
}

/**
 * The two dates the rule compares against. The SQL version of the filter uses
 * the same values, so both implementations answer the same question.
 */
export function followUpWindow(context: FollowUpContext): FollowUpWindow {
  const today = localDateIn(context.now, context.timeZone);
  return { today, staleOnOrBefore: addDays(today, -FOLLOW_UP_AFTER_DAYS) };
}

/**
 * "Needs follow-up" = Applied / Screening / Interviewing, with no activity for
 * 7 or more calendar days, and no upcoming next step. A next-step date of today
 * or later is upcoming; a past date is not. An interview dated today or later
 * also counts as an upcoming next step.
 *
 * Calendar-day semantics: activity at 23:59 a week ago counts the same as at
 * 00:00 that day, because only dates in the user's zone are compared.
 */
export function needsFollowUp(subject: FollowUpSubject, context: FollowUpContext): boolean {
  if (!isFollowUpStatus(subject.status)) return false;

  const { today, staleOnOrBefore } = followUpWindow(context);
  if (subject.nextStepDate !== null) dayNumber(subject.nextStepDate); // throws on a malformed date

  const lastActivityDate = localDateIn(subject.lastActivityAt, context.timeZone);
  if (lastActivityDate > staleOnOrBefore) return false; // active within the last 6 days

  const latestInterview = subject.latestInterviewOn ?? null;
  if (latestInterview !== null) dayNumber(latestInterview); // throws on a malformed date
  const hasUpcomingNextStep =
    (subject.nextStepDate !== null && subject.nextStepDate >= today) ||
    (latestInterview !== null && latestInterview >= today);
  return !hasUpcomingNextStep;
}
