import { FOLLOW_UP_STATUSES, followUpWindow, type FollowUpContext } from '@jat/shared';

export interface SqlFragment {
  sql: string;
  params: unknown[];
}

/**
 * The SQL twin of `needsFollowUp` for a table aliased `a` (columns `status`,
 * `last_activity_at`, `next_step_date`). It takes the same two dates from
 * `followUpWindow` as the TypeScript rule, so both implementations are asked the
 * same question; a property test checks that they answer it the same way.
 *
 * Uses four parameters starting at `$firstParam`.
 */
export function followUpPredicate(context: FollowUpContext, firstParam = 1): SqlFragment {
  const { today, staleOnOrBefore } = followUpWindow(context);
  const statuses = `$${firstParam}`;
  const zone = `$${firstParam + 1}`;
  const stale = `$${firstParam + 2}`;
  const todayParam = `$${firstParam + 3}`;
  return {
    sql:
      `(a.status = any(${statuses}::text[])` +
      ` and (a.last_activity_at at time zone ${zone}::text)::date <= ${stale}::date` +
      ` and (a.next_step_date is null or a.next_step_date < ${todayParam}::date))`,
    params: [[...FOLLOW_UP_STATUSES], context.timeZone, staleOnOrBefore, today],
  };
}
