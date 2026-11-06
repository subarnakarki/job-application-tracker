import { FOLLOW_UP_STATUSES, followUpWindow, type FollowUpContext } from '@jat/shared';

export interface SqlFragment {
  sql: string;
  params: unknown[];
}

/** The latest interview day of the application aliased `a`. */
export const LATEST_INTERVIEW_SQL =
  '(select max(i.held_on) from interviews i where i.application_id = a.id)';

/**
 * The SQL twin of `needsFollowUp` for a table aliased `a` (columns `status`,
 * `last_activity_at`, `next_step_date`), with `latestInterview` an SQL expression for the
 * application's latest interview day (a fixed fragment, never user data). It takes the same two dates from
 * `followUpWindow` as the TypeScript rule, so both implementations are asked the
 * same question; a property test checks that they answer it the same way.
 *
 * Uses four parameters starting at `$firstParam`.
 */
export function followUpPredicate(
  context: FollowUpContext,
  firstParam = 1,
  latestInterview = LATEST_INTERVIEW_SQL,
): SqlFragment {
  const { today, staleOnOrBefore } = followUpWindow(context);
  const statuses = `$${firstParam}`;
  const zone = `$${firstParam + 1}`;
  const stale = `$${firstParam + 2}`;
  const todayParam = `$${firstParam + 3}`;
  return {
    sql:
      `(a.status = any(${statuses}::text[])` +
      ` and (a.last_activity_at at time zone ${zone}::text)::date <= ${stale}::date` +
      ` and (a.next_step_date is null or a.next_step_date < ${todayParam}::date)` +
      ` and (${latestInterview} is null or ${latestInterview} < ${todayParam}::date))`,
    params: [[...FOLLOW_UP_STATUSES], context.timeZone, staleOnOrBefore, today],
  };
}
