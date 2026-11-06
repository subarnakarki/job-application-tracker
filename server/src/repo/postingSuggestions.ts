import type { WorkMode } from '@jat/shared';
import type { Queryable } from '../db/types';

/**
 * All SQL for posting suggestions: a posting found on the company's public job board that may be
 * the one an application is for. At most one per application. Every statement is scoped by
 * `user_id`, so someone else's suggestion behaves exactly like one that does not exist.
 *
 * A suggestion is never applied by itself: the user applies it (filling only empty fields) or
 * dismisses it, and either way it is deleted.
 */

export interface SuggestionRecord {
  id: string;
  /** Which job board it was found on. */
  source: string;
  jobLink: string;
  role: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  location: string | null;
  workMode: WorkMode | null;
  postedOn: string | null;
  createdAt: Date;
}

export type SuggestionInput = Omit<SuggestionRecord, 'id' | 'createdAt'>;

interface SuggestionRow {
  id: string;
  application_id: string;
  source: string;
  job_link: string;
  role: string | null;
  salary_min: number | null;
  salary_max: number | null;
  salary_currency: string | null;
  location: string | null;
  work_mode: WorkMode | null;
  posted_on: string | null;
  created_at: Date;
}

const COLUMNS = `id, application_id, source, job_link, role, salary_min, salary_max, salary_currency,
  location, work_mode, posted_on, created_at`;

const toRecord = (row: SuggestionRow): SuggestionRecord => ({
  id: row.id,
  source: row.source,
  jobLink: row.job_link,
  role: row.role,
  salaryMin: row.salary_min,
  salaryMax: row.salary_max,
  salaryCurrency: row.salary_currency,
  location: row.location,
  workMode: row.work_mode,
  postedOn: row.posted_on,
  createdAt: row.created_at,
});

/** Each application's suggestion, or null. */
export async function suggestionsOf(
  db: Queryable,
  applicationIds: string[],
): Promise<Map<string, SuggestionRecord | null>> {
  const byApplication = new Map<string, SuggestionRecord | null>(
    applicationIds.map((id) => [id, null]),
  );
  if (applicationIds.length === 0) return byApplication;
  const result = await db.query<SuggestionRow>(
    `select ${COLUMNS} from posting_suggestions where application_id = any($1::uuid[])`,
    [applicationIds],
  );
  for (const row of result.rows) byApplication.set(row.application_id, toRecord(row));
  return byApplication;
}

/**
 * Saves (or replaces) the suggestion for one of this user's applications. Nothing is saved for an
 * application that is not theirs (the foreign key pairs it with its owner).
 */
export async function saveSuggestion(
  db: Queryable,
  userId: string,
  applicationId: string,
  input: SuggestionInput,
  now: Date,
): Promise<SuggestionRecord | null> {
  const result = await db.query<SuggestionRow>(
    `insert into posting_suggestions (application_id, user_id, source, job_link, role, salary_min,
       salary_max, salary_currency, location, work_mode, posted_on, created_at)
     select a.id, a.user_id, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
       from applications a where a.id = $1 and a.user_id = $2
     on conflict (application_id) do update set
       source = excluded.source, job_link = excluded.job_link, role = excluded.role,
       salary_min = excluded.salary_min, salary_max = excluded.salary_max,
       salary_currency = excluded.salary_currency, location = excluded.location,
       work_mode = excluded.work_mode, posted_on = excluded.posted_on,
       created_at = excluded.created_at
     returning ${COLUMNS}`,
    [
      applicationId,
      userId,
      input.source,
      input.jobLink,
      input.role,
      input.salaryMin,
      input.salaryMax,
      input.salaryCurrency,
      input.location,
      input.workMode,
      input.postedOn,
      now,
    ],
  );
  const row = result.rows[0];
  return row ? toRecord(row) : null;
}

/** Removes this user's suggestion for an application; false when there was none. */
export async function deleteSuggestion(
  db: Queryable,
  userId: string,
  applicationId: string,
): Promise<boolean> {
  const result = await db.query(
    'delete from posting_suggestions where application_id = $1 and user_id = $2',
    [applicationId, userId],
  );
  return (result.rowCount ?? 0) > 0;
}
