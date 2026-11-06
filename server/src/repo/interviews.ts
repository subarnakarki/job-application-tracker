import { LIMITS, type InterviewInput, type InterviewPatch } from '@jat/shared';
import type { Db, Queryable } from '../db/types';

/**
 * All SQL for interviews. Every statement is scoped by `user_id` (and the application id), so an
 * interview of someone else's application behaves exactly like one that does not exist.
 *
 * Adding, editing or removing an interview is a real edit of its application: it bumps the
 * application's version and its follow-up clock, like any other change.
 */

export interface InterviewRecord {
  id: string;
  heldOn: string;
  label: string | null;
  notes: string;
  createdAt: Date;
  updatedAt: Date;
}

interface InterviewRow {
  id: string;
  held_on: string;
  label: string | null;
  notes: string;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = 'id, held_on, label, notes, created_at, updated_at';

const toRecord = (row: InterviewRow): InterviewRecord => ({
  id: row.id,
  heldOn: row.held_on,
  label: row.label,
  notes: row.notes,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/** The interviews of each application, oldest first (then by when they were logged). */
export async function interviewsOf(
  db: Queryable,
  applicationIds: string[],
): Promise<Map<string, InterviewRecord[]>> {
  const byApplication = new Map<string, InterviewRecord[]>(applicationIds.map((id) => [id, []]));
  if (applicationIds.length === 0) return byApplication;
  const result = await db.query<InterviewRow & { application_id: string }>(
    `select application_id, ${COLUMNS} from interviews
      where application_id = any($1::uuid[]) order by held_on, created_at, id`,
    [applicationIds],
  );
  for (const row of result.rows) byApplication.get(row.application_id)?.push(toRecord(row));
  return byApplication;
}

export type InterviewResult =
  | { kind: 'saved'; value: InterviewRecord }
  | { kind: 'not_found' }
  | { kind: 'limit_reached'; limit: number };

/** Locks the application (so the cap cannot be raced past) and marks it edited. */
async function touchApplication(
  tx: Queryable,
  userId: string,
  applicationId: string,
  now: Date,
): Promise<boolean> {
  const result = await tx.query(
    `update applications set updated_at = $3, last_activity_at = $3, version = version + 1
      where id = $1 and user_id = $2`,
    [applicationId, userId, now],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function addInterview(
  db: Db,
  userId: string,
  applicationId: string,
  input: InterviewInput,
  now: Date,
): Promise<InterviewResult> {
  return db
    .transaction(async (tx): Promise<InterviewResult> => {
      if (!(await touchApplication(tx, userId, applicationId, now))) return { kind: 'not_found' };
      const counted = await tx.query<{ n: number }>(
        'select count(*)::int as n from interviews where application_id = $1',
        [applicationId],
      );
      if ((counted.rows[0]?.n ?? 0) >= LIMITS.interviewsPerApplication) {
        // Nothing was added, so the version bump above is undone with the transaction.
        throw new InterviewLimit();
      }
      const inserted = await tx.query<InterviewRow>(
        `insert into interviews (application_id, user_id, held_on, label, notes, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $6) returning ${COLUMNS}`,
        [applicationId, userId, input.heldOn, input.label, input.notes, now],
      );
      const row = inserted.rows[0];
      if (!row) throw new Error('Interview was not created');
      return { kind: 'saved', value: toRecord(row) };
    })
    .catch((error: unknown) => {
      if (error instanceof InterviewLimit)
        return { kind: 'limit_reached', limit: LIMITS.interviewsPerApplication } as const;
      throw error;
    });
}

/** Rolls the transaction back when the cap is reached. */
class InterviewLimit extends Error {}

export async function updateInterview(
  db: Db,
  userId: string,
  applicationId: string,
  interviewId: string,
  patch: InterviewPatch,
  now: Date,
): Promise<InterviewRecord | null> {
  return db.transaction(async (tx) => {
    const sets: string[] = [];
    const params: unknown[] = [userId, applicationId, interviewId, now];
    for (const [key, column] of [
      ['heldOn', 'held_on'],
      ['label', 'label'],
      ['notes', 'notes'],
    ] as const) {
      if (patch[key] !== undefined) {
        params.push(patch[key]);
        sets.push(`${column} = $${params.length}`);
      }
    }
    const result = await tx.query<InterviewRow>(
      `update interviews set ${[...sets, 'updated_at = $4'].join(', ')}
        where user_id = $1 and application_id = $2 and id = $3 returning ${COLUMNS}`,
      params,
    );
    const row = result.rows[0];
    if (!row) return null;
    await touchApplication(tx, userId, applicationId, now);
    return toRecord(row);
  });
}

export async function deleteInterview(
  db: Db,
  userId: string,
  applicationId: string,
  interviewId: string,
  now: Date,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const result = await tx.query(
      'delete from interviews where user_id = $1 and application_id = $2 and id = $3',
      [userId, applicationId, interviewId],
    );
    if (!result.rowCount) return false;
    await touchApplication(tx, userId, applicationId, now);
    return true;
  });
}
