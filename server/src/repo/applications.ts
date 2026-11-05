import {
  changedFields,
  findSalaryIssues,
  LIMITS,
  localDateIn,
  planStatusChange,
  resolveDateApplied,
  STATUSES,
  type ApplicationInput,
  type ApplicationPatch,
  type ListQuery,
  type Sort,
  type Source,
  type Status,
} from '@jat/shared';
import type { Db, Queryable } from '../db/types';
import type { ValidationIssue } from '../http/errors';
import { followUpPredicate } from './followUpSql';
import { containsPattern, searchTerms } from './search';

/**
 * All SQL for applications. Every statement is scoped by `user_id`, so an id
 * that belongs to someone else behaves exactly like an id that does not exist.
 */

export interface ApplicationRecord {
  id: string;
  company: string;
  role: string;
  status: Status;
  dateApplied: string | null;
  source: Source;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  jobLink: string | null;
  contact: string | null;
  nextStep: string | null;
  nextStepDate: string | null;
  notes: string;
  createdAt: Date;
  updatedAt: Date;
  lastActivityAt: Date;
  version: number;
}

export interface HistoryRecord {
  id: string;
  fromStatus: Status | null;
  toStatus: Status;
  occurredAt: Date;
  actor: 'user' | 'gmail' | 'system';
}

export interface ApplicationWithHistory {
  record: ApplicationRecord;
  history: HistoryRecord[];
}

type EditableField = keyof ApplicationPatch;

/** Field -> column. `satisfies` makes the compiler insist every editable field is mapped. */
const COLUMN = {
  company: 'company',
  role: 'role',
  status: 'status',
  dateApplied: 'date_applied',
  source: 'source',
  salaryMin: 'salary_min',
  salaryMax: 'salary_max',
  salaryCurrency: 'salary_currency',
  jobLink: 'job_link',
  contact: 'contact',
  nextStep: 'next_step',
  nextStepDate: 'next_step_date',
  notes: 'notes',
} as const satisfies Record<EditableField, string>;

const SELECT_COLUMNS = `id, company, role, status, date_applied, source, salary_min, salary_max,
  salary_currency, job_link, contact, next_step, next_step_date, notes, created_at, updated_at,
  last_activity_at, version`;

interface ApplicationRow {
  id: string;
  company: string;
  role: string;
  status: Status;
  date_applied: string | null;
  source: Source;
  salary_min: number | null;
  salary_max: number | null;
  salary_currency: string | null;
  job_link: string | null;
  contact: string | null;
  next_step: string | null;
  next_step_date: string | null;
  notes: string;
  created_at: Date;
  updated_at: Date;
  last_activity_at: Date;
  version: number;
}

function toRecord(row: ApplicationRow): ApplicationRecord {
  return {
    id: row.id,
    company: row.company,
    role: row.role,
    status: row.status,
    dateApplied: row.date_applied,
    source: row.source,
    salaryMin: row.salary_min,
    salaryMax: row.salary_max,
    salaryCurrency: row.salary_currency,
    jobLink: row.job_link,
    contact: row.contact,
    nextStep: row.next_step,
    nextStepDate: row.next_step_date,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastActivityAt: row.last_activity_at,
    version: row.version,
  };
}

interface HistoryRow {
  id: string;
  from_status: Status | null;
  to_status: Status;
  occurred_at: Date;
  actor: HistoryRecord['actor'];
}

const toHistory = (row: HistoryRow): HistoryRecord => ({
  id: row.id,
  fromStatus: row.from_status,
  toStatus: row.to_status,
  occurredAt: row.occurred_at,
  actor: row.actor,
});

async function historyOf(
  db: Queryable,
  applicationIds: string[],
): Promise<Map<string, HistoryRecord[]>> {
  const byApplication = new Map<string, HistoryRecord[]>(applicationIds.map((id) => [id, []]));
  if (applicationIds.length === 0) return byApplication;
  const result = await db.query<HistoryRow & { application_id: string }>(
    `select id, application_id, from_status, to_status, occurred_at, actor
       from status_history
      where application_id = any($1::uuid[])
      order by occurred_at, seq`,
    [applicationIds],
  );
  for (const row of result.rows) byApplication.get(row.application_id)?.push(toHistory(row));
  return byApplication;
}

async function recordHistory(
  tx: Queryable,
  applicationId: string,
  fromStatus: Status | null,
  toStatus: Status,
  now: Date,
): Promise<void> {
  await tx.query(
    `insert into status_history (application_id, from_status, to_status, occurred_at, recorded_at, actor)
     values ($1, $2, $3, $4, $4, 'user')`,
    [applicationId, fromStatus, toStatus, now],
  );
}

export interface Owner {
  userId: string;
  isDemo: boolean;
  timeZone: string;
}

export function applicationLimit(owner: Pick<Owner, 'isDemo'>): number {
  return owner.isDemo ? LIMITS.applicationsPerDemoUser : LIMITS.applicationsPerUser;
}

export type CreateResult =
  { kind: 'created'; value: ApplicationWithHistory } | { kind: 'limit_reached'; limit: number };

/**
 * Creates an application and its first history row. The owner's user row is
 * locked first, so concurrent creates for one user queue up and the quota
 * check cannot be raced past.
 */
export async function createApplication(
  db: Db,
  owner: Owner,
  input: ApplicationInput,
  now: Date,
): Promise<CreateResult> {
  return db.transaction(async (tx) => {
    await tx.query('select 1 from users where id = $1 for update', [owner.userId]);
    const counted = await tx.query<{ n: number }>(
      'select count(*)::int as n from applications where user_id = $1',
      [owner.userId],
    );
    const limit = applicationLimit(owner);
    if ((counted.rows[0]?.n ?? 0) >= limit) return { kind: 'limit_reached', limit };

    const dateApplied = resolveDateApplied({
      previousStatus: null,
      newStatus: input.status,
      dateApplied: input.dateApplied,
      today: localDateIn(now, owner.timeZone),
    });
    const inserted = await tx.query<ApplicationRow>(
      `insert into applications (user_id, company, role, status, date_applied, source, salary_min,
         salary_max, salary_currency, job_link, contact, next_step, next_step_date, notes,
         created_at, updated_at, last_activity_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $15, $15)
       returning ${SELECT_COLUMNS}`,
      [
        owner.userId,
        input.company,
        input.role,
        input.status,
        dateApplied,
        input.source,
        input.salaryMin,
        input.salaryMax,
        input.salaryCurrency,
        input.jobLink,
        input.contact,
        input.nextStep,
        input.nextStepDate,
        input.notes,
        now,
      ],
    );
    const row = inserted.rows[0];
    if (!row) throw new Error('Application was not created');
    const record = toRecord(row);
    const plan = planStatusChange(null, record.status);
    await recordHistory(tx, record.id, plan.fromStatus, plan.toStatus, now);
    const history = await historyOf(tx, [record.id]);
    return { kind: 'created', value: { record, history: history.get(record.id) ?? [] } };
  });
}

export async function getApplication(
  db: Queryable,
  userId: string,
  id: string,
): Promise<ApplicationWithHistory | null> {
  const found = await db.query<ApplicationRow>(
    `select ${SELECT_COLUMNS} from applications where id = $1 and user_id = $2`,
    [id, userId],
  );
  const row = found.rows[0];
  if (!row) return null;
  const history = await historyOf(db, [row.id]);
  return { record: toRecord(row), history: history.get(row.id) ?? [] };
}

export type UpdateResult =
  | { kind: 'not_found' }
  | { kind: 'version_conflict'; currentVersion: number }
  | { kind: 'invalid'; issues: ValidationIssue[] }
  | { kind: 'unchanged'; value: ApplicationWithHistory }
  | { kind: 'updated'; value: ApplicationWithHistory };

/**
 * Applies a patch if `expectedVersion` is still current. A patch that changes
 * nothing is a no-op: no version bump, no follow-up clock reset, no history.
 * A real edit bumps the version and the follow-up clock; a status change writes
 * one history row and may fill `dateApplied`.
 */
export async function updateApplication(
  db: Db,
  owner: Owner,
  id: string,
  expectedVersion: number,
  patch: ApplicationPatch,
  now: Date,
): Promise<UpdateResult> {
  return db.transaction(async (tx) => {
    const locked = await tx.query<ApplicationRow>(
      `select ${SELECT_COLUMNS} from applications where id = $1 and user_id = $2 for update`,
      [id, owner.userId],
    );
    const row = locked.rows[0];
    if (!row) return { kind: 'not_found' };
    const current = toRecord(row);
    if (current.version !== expectedVersion)
      return { kind: 'version_conflict', currentVersion: current.version };

    const merged: ApplicationRecord = { ...current };
    for (const field of Object.keys(patch) as EditableField[]) {
      const value = patch[field];
      if (value !== undefined) Object.assign(merged, { [field]: value });
    }
    merged.dateApplied = resolveDateApplied({
      previousStatus: current.status,
      newStatus: merged.status,
      dateApplied: merged.dateApplied,
      today: localDateIn(now, owner.timeZone),
    });

    const changes = changedFields(current, pick(merged, Object.keys(COLUMN) as EditableField[]));
    if (changes.length === 0) {
      const history = await historyOf(tx, [current.id]);
      return {
        kind: 'unchanged',
        value: { record: current, history: history.get(current.id) ?? [] },
      };
    }

    const salaryIssues = findSalaryIssues(merged);
    if (salaryIssues.length > 0) {
      return {
        kind: 'invalid',
        issues: salaryIssues.map(({ path, message }) => ({ path, message })),
      };
    }

    const assignments = changes.map(
      (field, index) => `${COLUMN[field as EditableField]} = $${index + 3}`,
    );
    const updated = await tx.query<ApplicationRow>(
      `update applications
          set ${assignments.join(', ')},
              updated_at = $${changes.length + 3},
              last_activity_at = $${changes.length + 3},
              version = version + 1
        where id = $1 and user_id = $2
        returning ${SELECT_COLUMNS}`,
      [current.id, owner.userId, ...changes.map((field) => merged[field as EditableField]), now],
    );
    const updatedRow = updated.rows[0];
    if (!updatedRow) throw new Error('Application vanished inside its own transaction');

    const plan = planStatusChange(current.status, merged.status);
    if (plan.changed) await recordHistory(tx, current.id, plan.fromStatus, plan.toStatus, now);
    const history = await historyOf(tx, [current.id]);
    return {
      kind: 'updated',
      value: { record: toRecord(updatedRow), history: history.get(current.id) ?? [] },
    };
  });
}

function pick<T extends object, K extends keyof T>(source: T, keys: K[]): Pick<T, K> {
  const result = {} as Pick<T, K>;
  for (const key of keys) result[key] = source[key];
  return result;
}

/** True if the application existed and belonged to this user. */
export async function deleteApplication(
  db: Queryable,
  userId: string,
  id: string,
): Promise<boolean> {
  const result = await db.query('delete from applications where id = $1 and user_id = $2', [
    id,
    userId,
  ]);
  return result.rowCount > 0;
}

/** Every application of one user with its history, oldest first (for the data export). */
export async function listAllWithHistory(
  db: Queryable,
  userId: string,
): Promise<ApplicationWithHistory[]> {
  const found = await db.query<ApplicationRow>(
    `select ${SELECT_COLUMNS} from applications where user_id = $1 order by created_at, id`,
    [userId],
  );
  const history = await historyOf(
    db,
    found.rows.map((row) => row.id),
  );
  return found.rows.map((row) => ({ record: toRecord(row), history: history.get(row.id) ?? [] }));
}

/** Account deletion: the user and, by cascade, every session, identity, application and history row. */
export async function deleteUser(db: Queryable, userId: string): Promise<boolean> {
  const result = await db.query('delete from users where id = $1', [userId]);
  return result.rowCount > 0;
}

/** Every sort ends with the id, so equal keys (common under a frozen clock) still come back in one stable order. */
const ORDER: Record<Sort, string> = {
  updated_desc: 'a.updated_at desc, a.id',
  applied_desc: 'a.date_applied desc nulls last, a.created_at desc, a.id',
  company_asc: 'lower(a.company), a.created_at desc, a.id',
};

/**
 * The user's applications matching the filters. Every value is a bound
 * parameter. Search: each word must appear (case-insensitively, wildcards taken
 * literally) in the company, role, contact or notes. The follow-up filter is the
 * SQL twin of needsFollowUp, evaluated in the owner's time zone at `now`.
 */
/** The WHERE clause for the user's applications matching `query` (status optional), with its parameters. */
function filterClause(
  owner: Owner,
  query: Pick<ListQuery, 'status' | 'followUp' | 'q'>,
  now: Date,
): { where: string; params: unknown[] } {
  const params: unknown[] = [owner.userId];
  const where = ['a.user_id = $1'];

  if (query.status) {
    params.push(query.status);
    where.push(`a.status = $${params.length}`);
  }
  if (query.followUp !== undefined) {
    const predicate = followUpPredicate({ now, timeZone: owner.timeZone }, params.length + 1);
    params.push(...predicate.params);
    where.push(query.followUp ? predicate.sql : `not ${predicate.sql}`);
  }
  for (const term of searchTerms(query.q)) {
    params.push(containsPattern(term));
    const p = `$${params.length}`;
    where.push(
      `(a.company ilike ${p} escape '\\' or a.role ilike ${p} escape '\\'` +
        ` or coalesce(a.contact, '') ilike ${p} escape '\\' or a.notes ilike ${p} escape '\\')`,
    );
  }
  return { where: where.join(' and '), params };
}

export async function listApplications(
  db: Queryable,
  owner: Owner,
  query: ListQuery,
  now: Date,
): Promise<ApplicationRecord[]> {
  const { where, params } = filterClause(owner, query, now);
  const result = await db.query<ApplicationRow>(
    `select ${SELECT_COLUMNS} from applications a where ${where} order by ${ORDER[query.sort]}`,
    params,
  );
  return result.rows.map(toRecord);
}

export interface PipelineCounts {
  stages: { status: Status; count: number }[];
  followUpCount: number;
  total: number;
}

/**
 * Counts per stage for the pipeline bar. They respect the search but ignore any
 * stage filter, so tapping a stage never zeroes the others.
 */
export async function pipelineCounts(
  db: Queryable,
  owner: Owner,
  q: string | undefined,
  now: Date,
): Promise<PipelineCounts> {
  const { where, params } = filterClause(owner, { q }, now);
  const predicate = followUpPredicate({ now, timeZone: owner.timeZone }, params.length + 1);
  const result = await db.query<{ status: Status; count: number; follow_up: number }>(
    `select a.status, count(*)::int as count,
            count(*) filter (where ${predicate.sql})::int as follow_up
       from applications a where ${where} group by a.status`,
    [...params, ...predicate.params],
  );
  const byStatus = new Map(result.rows.map((row) => [row.status, row]));
  const stages = STATUSES.map((status) => ({ status, count: byStatus.get(status)?.count ?? 0 }));
  return {
    stages,
    followUpCount: result.rows.reduce((sum, row) => sum + row.follow_up, 0),
    total: stages.reduce((sum, stage) => sum + stage.count, 0),
  };
}
