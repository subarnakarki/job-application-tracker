import {
  DATE_APPLIED_STATUSES,
  statsSummary,
  type SourceCounts,
  type StatsSummary,
} from '@jat/shared';
import type { Queryable } from '../db/types';
import type { Owner } from './applications';

/**
 * The SQL twin of `reachedStages` in shared/src/stats.ts, proven equal by stats.test.ts.
 * Each application's statuses are its current one plus every status it moved to.
 */
export async function statsBySource(
  db: Queryable,
  owner: Pick<Owner, 'userId'>,
): Promise<StatsSummary> {
  const result = await db.query<SourceCounts>(
    `with reached as (
       select a.source,
              bool_or(s.status = any($2::text[])) as applied,
              bool_or(s.status in ('Screening', 'Interviewing', 'Offer'))
                or (bool_or(s.status = 'Rejected') and bool_or(s.status = 'Applied')) as responded,
              bool_or(s.status in ('Interviewing', 'Offer')) as interviewing,
              bool_or(s.status = 'Offer') as offer
         from applications a
         cross join lateral (
           select a.status
           union
           select h.to_status from status_history h where h.application_id = a.id
         ) s (status)
        where a.user_id = $1
        group by a.id, a.source
     )
     select source,
            count(*)::int as total,
            count(*) filter (where applied)::int as applied,
            count(*) filter (where responded)::int as responded,
            count(*) filter (where interviewing)::int as interviewing,
            count(*) filter (where offer)::int as offers
       from reached
      group by source`,
    [owner.userId, DATE_APPLIED_STATUSES],
  );
  return statsSummary(result.rows);
}
