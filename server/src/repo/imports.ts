import type { Status } from '@jat/shared';
import type { Queryable } from '../db/types';
import type { VerdictKind } from '../import/verdict';

/**
 * All SQL for Gmail import runs and their items. Every statement is scoped by
 * `user_id`, like the applications repository.
 */

export const OUTCOMES = [
  'pending',
  'created',
  'status_changed',
  'needs_review',
  'ignored',
  'undone',
  'dismissed',
] as const;
export type Outcome = (typeof OUTCOMES)[number];

export interface ImportRun {
  id: string;
  startedAt: Date;
  finishedAt: Date | null;
  emailsScanned: number;
  status: 'running' | 'finished' | 'failed';
}

export interface ImportItem {
  id: string;
  runId: string;
  gmailMessageId: string;
  emailFrom: string;
  emailSubject: string;
  emailDate: Date | null;
  verdictKind: VerdictKind | null;
  confidence: 'high' | 'medium' | 'low' | null;
  company: string | null;
  role: string | null;
  summary: string;
  reason: string;
  outcome: Outcome;
  proposedStatus: Status | null;
  applicationId: string | null;
  fromStatus: Status | null;
  toStatus: Status | null;
  previousDateApplied: string | null;
  appliedVersion: number | null;
}

interface RunRow {
  id: string;
  started_at: Date;
  finished_at: Date | null;
  emails_scanned: number;
  status: ImportRun['status'];
}

interface ItemRow {
  id: string;
  run_id: string;
  gmail_message_id: string;
  email_from: string;
  email_subject: string;
  email_date: Date | null;
  verdict_kind: VerdictKind | null;
  confidence: ImportItem['confidence'];
  company: string | null;
  role: string | null;
  summary: string;
  reason: string;
  outcome: Outcome;
  proposed_status: Status | null;
  application_id: string | null;
  from_status: Status | null;
  to_status: Status | null;
  previous_date_applied: string | null;
  applied_version: number | null;
}

const RUN_COLUMNS = 'id, started_at, finished_at, emails_scanned, status';
const ITEM_COLUMNS = `id, run_id, gmail_message_id, email_from, email_subject, email_date, verdict_kind,
  confidence, company, role, summary, reason, outcome, proposed_status, application_id, from_status, to_status,
  previous_date_applied, applied_version`;

const toRun = (row: RunRow): ImportRun => ({
  id: row.id,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
  emailsScanned: row.emails_scanned,
  status: row.status,
});

const toItem = (row: ItemRow): ImportItem => ({
  id: row.id,
  runId: row.run_id,
  gmailMessageId: row.gmail_message_id,
  emailFrom: row.email_from,
  emailSubject: row.email_subject,
  emailDate: row.email_date,
  verdictKind: row.verdict_kind,
  confidence: row.confidence,
  company: row.company,
  role: row.role,
  summary: row.summary,
  reason: row.reason,
  outcome: row.outcome,
  proposedStatus: row.proposed_status,
  applicationId: row.application_id,
  fromStatus: row.from_status,
  toStatus: row.to_status,
  previousDateApplied: row.previous_date_applied,
  appliedVersion: row.applied_version,
});

export async function createRun(db: Queryable, userId: string, now: Date): Promise<string> {
  const result = await db.query<{ id: string }>(
    'insert into import_runs (user_id, started_at) values ($1, $2) returning id',
    [userId, now],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error('Import run was not created');
  return id;
}

export async function finishRun(
  db: Queryable,
  userId: string,
  runId: string,
  fields: { status: 'finished' | 'failed'; emailsScanned: number; now: Date },
): Promise<void> {
  await db.query(
    `update import_runs set status = $3, emails_scanned = $4, finished_at = $5
      where id = $1 and user_id = $2`,
    [runId, userId, fields.status, fields.emailsScanned, fields.now],
  );
}

/** When the last finished run started: the next run only looks at newer email. */
export async function lastFinishedRunStart(db: Queryable, userId: string): Promise<Date | null> {
  const result = await db.query<{ started_at: Date }>(
    `select started_at from import_runs where user_id = $1 and status = 'finished'
      order by started_at desc limit 1`,
    [userId],
  );
  return result.rows[0]?.started_at ?? null;
}

/**
 * Claims a Gmail message for this run. Null when this user's earlier (or a
 * concurrent) run already has it, so no email is ever applied twice.
 */
export async function claimMessage(
  db: Queryable,
  userId: string,
  runId: string,
  gmailMessageId: string,
  now: Date,
): Promise<string | null> {
  const result = await db.query<{ id: string }>(
    `insert into import_items (run_id, user_id, gmail_message_id, outcome, created_at)
     values ($1, $2, $3, 'pending', $4)
     on conflict (user_id, gmail_message_id) do nothing
     returning id`,
    [runId, userId, gmailMessageId, now],
  );
  return result.rows[0]?.id ?? null;
}

/** Drops this run's unfinished claims, so a later run can try those emails again. */
export async function releasePending(db: Queryable, userId: string, runId: string): Promise<void> {
  await db.query(
    `delete from import_items where run_id = $1 and user_id = $2 and outcome = 'pending'`,
    [runId, userId],
  );
}

export type ItemFields = Partial<Omit<ImportItem, 'id' | 'runId' | 'gmailMessageId'>>;

const ITEM_FIELD_COLUMNS: Record<keyof ItemFields, string> = {
  emailFrom: 'email_from',
  emailSubject: 'email_subject',
  emailDate: 'email_date',
  verdictKind: 'verdict_kind',
  confidence: 'confidence',
  company: 'company',
  role: 'role',
  summary: 'summary',
  reason: 'reason',
  outcome: 'outcome',
  proposedStatus: 'proposed_status',
  applicationId: 'application_id',
  fromStatus: 'from_status',
  toStatus: 'to_status',
  previousDateApplied: 'previous_date_applied',
  appliedVersion: 'applied_version',
};

export async function updateItem(
  db: Queryable,
  userId: string,
  itemId: string,
  fields: ItemFields,
): Promise<void> {
  const keys = (Object.keys(fields) as (keyof ItemFields)[]).filter(
    (key) => fields[key] !== undefined,
  );
  if (keys.length === 0) return;
  const assignments = keys.map((key, index) => `${ITEM_FIELD_COLUMNS[key]} = $${index + 3}`);
  await db.query(
    `update import_items set ${assignments.join(', ')} where id = $1 and user_id = $2`,
    [itemId, userId, ...keys.map((key) => fields[key])],
  );
}

/**
 * Moves an item from one of `from` to 'pending' and returns it, or null when it
 * is missing, someone else's, or not in one of those outcomes. Acts as a lock:
 * a second Undo click on the same item finds it pending and does nothing.
 */
export async function takeItem(
  db: Queryable,
  userId: string,
  itemId: string,
  from: readonly Outcome[],
): Promise<ImportItem | null> {
  const result = await db.query<ItemRow & { previous: Outcome }>(
    `with old as (
       select id, outcome from import_items
        where id = $1 and user_id = $2 and outcome = any($3::text[])
        for update
     )
     update import_items i set outcome = 'pending'
       from old where i.id = old.id
     returning i.*, old.outcome as previous`,
    [itemId, userId, from],
  );
  const row = result.rows[0];
  return row ? { ...toItem(row), outcome: row.previous } : null;
}

export async function getItem(
  db: Queryable,
  userId: string,
  itemId: string,
): Promise<ImportItem | null> {
  const result = await db.query<ItemRow>(
    `select ${ITEM_COLUMNS} from import_items where id = $1 and user_id = $2`,
    [itemId, userId],
  );
  const row = result.rows[0];
  return row ? toItem(row) : null;
}

export async function getRun(
  db: Queryable,
  userId: string,
  runId: string,
): Promise<{ run: ImportRun; items: ImportItem[] } | null> {
  const runs = await db.query<RunRow>(
    `select ${RUN_COLUMNS} from import_runs where id = $1 and user_id = $2`,
    [runId, userId],
  );
  const run = runs.rows[0];
  if (!run) return null;
  const items = await db.query<ItemRow>(
    `select ${ITEM_COLUMNS} from import_items
      where run_id = $1 and user_id = $2 and outcome <> 'pending'
      order by email_date nulls last, created_at`,
    [runId, userId],
  );
  return { run: toRun(run), items: items.rows.map(toItem) };
}

/** Every run and item of one user, for the data export. */
export async function listAllImports(
  db: Queryable,
  userId: string,
): Promise<{ runs: ImportRun[]; items: ImportItem[] }> {
  const runs = await db.query<RunRow>(
    `select ${RUN_COLUMNS} from import_runs where user_id = $1 order by started_at`,
    [userId],
  );
  const items = await db.query<ItemRow>(
    `select ${ITEM_COLUMNS} from import_items where user_id = $1 order by created_at`,
    [userId],
  );
  return { runs: runs.rows.map(toRun), items: items.rows.map(toItem) };
}
