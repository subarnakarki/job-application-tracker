import {
  LIMITS,
  type Lead,
  type LeadDetail,
  type LeadInput,
  type LeadNote,
  type LeadNoteInput,
  type LeadNotePatch,
  type LeadPatch,
  type Status,
} from '@jat/shared';
import type { Db, Queryable } from '../db/types';
import { containsPattern, searchTerms } from './search';

/**
 * All SQL for networking leads and their notes. Every statement is scoped by `user_id`, so a lead
 * or note that belongs to someone else behaves exactly like one that does not exist.
 */

interface LeadRow {
  id: string;
  name: string;
  company: string | null;
  email: string | null;
  phone: string | null;
  profile_link: string | null;
  created_at: Date;
  updated_at: Date;
  note_count: number;
  latest_held_on: string | null;
  latest_body: string | null;
  application_count: number;
}

interface NoteRow {
  id: string;
  held_on: string;
  body: string;
  created_at: Date;
  updated_at: Date;
}

const LEAD_SELECT = `
  l.id, l.name, l.company, l.email, l.phone, l.profile_link, l.created_at, l.updated_at,
  (select count(*)::int from lead_notes n where n.lead_id = l.id) as note_count,
  latest.held_on as latest_held_on, latest.body as latest_body,
  (select count(*)::int from applications a where a.lead_id = l.id and a.user_id = l.user_id)
    as application_count
  from leads l
  left join lateral (
    select n.held_on, n.body from lead_notes n where n.lead_id = l.id
    order by n.held_on desc, n.created_at desc limit 1
  ) latest on true`;

const NOTE_COLUMNS = 'id, held_on, body, created_at, updated_at';

function toLead(row: LeadRow): Lead {
  return {
    id: row.id,
    name: row.name,
    company: row.company,
    email: row.email,
    phone: row.phone,
    profileLink: row.profile_link,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    noteCount: row.note_count,
    latestNote:
      row.latest_held_on !== null && row.latest_body !== null
        ? { heldOn: row.latest_held_on, body: row.latest_body }
        : null,
    applicationCount: row.application_count,
  };
}

function toNote(row: NoteRow): LeadNote {
  return {
    id: row.id,
    heldOn: row.held_on,
    body: row.body,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export function leadLimit(owner: { isDemo: boolean }): number {
  return owner.isDemo ? LIMITS.leadsPerDemoUser : LIMITS.leadsPerUser;
}

/** Every lead, by name. Each search word must match the name, company or any note. */
export async function listLeads(db: Queryable, userId: string, q?: string): Promise<Lead[]> {
  const params: unknown[] = [userId];
  const conditions = searchTerms(q).map((term) => {
    params.push(containsPattern(term));
    const p = `$${params.length}`;
    return `(lower(l.name) like ${p} escape '\\' or lower(coalesce(l.company, '')) like ${p} escape '\\'
      or exists (select 1 from lead_notes n where n.lead_id = l.id and lower(n.body) like ${p} escape '\\'))`;
  });
  const result = await db.query<LeadRow>(
    `select ${LEAD_SELECT}
      where l.user_id = $1 ${conditions.map((condition) => `and ${condition}`).join(' ')}
      order by lower(l.name), l.id`,
    params,
  );
  return result.rows.map(toLead);
}

async function findLead(db: Queryable, userId: string, id: string): Promise<Lead | null> {
  const result = await db.query<LeadRow>(
    `select ${LEAD_SELECT} where l.user_id = $1 and l.id = $2`,
    [userId, id],
  );
  const row = result.rows[0];
  return row ? toLead(row) : null;
}

export async function getLead(
  db: Queryable,
  userId: string,
  id: string,
): Promise<LeadDetail | null> {
  const lead = await findLead(db, userId, id);
  if (!lead) return null;
  const [notes, applications] = await Promise.all([
    db.query<NoteRow>(
      `select ${NOTE_COLUMNS} from lead_notes where user_id = $1 and lead_id = $2
        order by held_on desc, created_at desc`,
      [userId, id],
    ),
    db.query<{ id: string; company: string; role: string; status: Status }>(
      `select id, company, role, status from applications where user_id = $1 and lead_id = $2
        order by updated_at desc, id`,
      [userId, id],
    ),
  ]);
  return { ...lead, notes: notes.rows.map(toNote), applications: applications.rows };
}

export type CreateLeadResult =
  { kind: 'created'; value: LeadDetail } | { kind: 'limit_reached'; limit: number };

/** The owner's user row is locked first, so concurrent creates cannot race past the quota. */
export async function createLead(
  db: Db,
  owner: { userId: string; isDemo: boolean },
  input: LeadInput,
  now: Date,
): Promise<CreateLeadResult> {
  return db.transaction(async (tx) => {
    await tx.query('select 1 from users where id = $1 for update', [owner.userId]);
    const counted = await tx.query<{ n: number }>(
      'select count(*)::int as n from leads where user_id = $1',
      [owner.userId],
    );
    const limit = leadLimit(owner);
    if ((counted.rows[0]?.n ?? 0) >= limit) return { kind: 'limit_reached', limit };
    const inserted = await tx.query<{ id: string }>(
      `insert into leads (user_id, name, company, email, phone, profile_link, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $7) returning id`,
      [owner.userId, input.name, input.company, input.email, input.phone, input.profileLink, now],
    );
    const id = inserted.rows[0]?.id;
    const created = id ? await getLead(tx, owner.userId, id) : null;
    if (!created) throw new Error('Lead was not created');
    return { kind: 'created', value: created };
  });
}

const LEAD_COLUMN: Record<keyof LeadPatch, string> = {
  name: 'name',
  company: 'company',
  email: 'email',
  phone: 'phone',
  profileLink: 'profile_link',
};

/** Applies the given fields only. Null when there is no such lead for this user. */
export async function updateLead(
  db: Queryable,
  userId: string,
  id: string,
  patch: LeadPatch,
  now: Date,
): Promise<LeadDetail | null> {
  const entries = (Object.keys(LEAD_COLUMN) as (keyof LeadPatch)[]).filter(
    (key) => patch[key] !== undefined,
  );
  const params: unknown[] = [userId, id, now, ...entries.map((key) => patch[key])];
  const sets = entries.map((key, index) => `${LEAD_COLUMN[key]} = $${index + 4}`);
  const result = await db.query(
    `update leads set ${[...sets, 'updated_at = $3'].join(', ')} where user_id = $1 and id = $2`,
    params,
  );
  return result.rowCount ? getLead(db, userId, id) : null;
}

/** Its notes go with it; its applications stay, unlinked (see migration 0005). */
export async function deleteLead(db: Queryable, userId: string, id: string): Promise<boolean> {
  const result = await db.query('delete from leads where user_id = $1 and id = $2', [userId, id]);
  return (result.rowCount ?? 0) > 0;
}

export type NoteResult =
  | { kind: 'saved'; value: LeadNote }
  | { kind: 'not_found' }
  | { kind: 'limit_reached'; limit: number };

/** Adds a note. The lead row is locked first, so concurrent adds cannot race past the cap. */
export async function addLeadNote(
  db: Db,
  userId: string,
  leadId: string,
  input: LeadNoteInput,
  now: Date,
): Promise<NoteResult> {
  return db.transaction(async (tx) => {
    const lead = await tx.query('select 1 from leads where user_id = $1 and id = $2 for update', [
      userId,
      leadId,
    ]);
    if (!lead.rowCount) return { kind: 'not_found' };
    const counted = await tx.query<{ n: number }>(
      'select count(*)::int as n from lead_notes where lead_id = $1',
      [leadId],
    );
    if ((counted.rows[0]?.n ?? 0) >= LIMITS.notesPerLead)
      return { kind: 'limit_reached', limit: LIMITS.notesPerLead };
    const inserted = await tx.query<NoteRow>(
      `insert into lead_notes (lead_id, user_id, held_on, body, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $5) returning ${NOTE_COLUMNS}`,
      [leadId, userId, input.heldOn, input.body, now],
    );
    await tx.query('update leads set updated_at = $2 where id = $1', [leadId, now]);
    const row = inserted.rows[0];
    if (!row) throw new Error('Note was not created');
    return { kind: 'saved', value: toNote(row) };
  });
}

export async function updateLeadNote(
  db: Db,
  userId: string,
  leadId: string,
  noteId: string,
  patch: LeadNotePatch,
  now: Date,
): Promise<LeadNote | null> {
  return db.transaction(async (tx) => {
    const result = await tx.query<NoteRow>(
      `update lead_notes set held_on = coalesce($4, held_on), body = coalesce($5, body), updated_at = $6
        where user_id = $1 and lead_id = $2 and id = $3 returning ${NOTE_COLUMNS}`,
      [userId, leadId, noteId, patch.heldOn ?? null, patch.body ?? null, now],
    );
    const row = result.rows[0];
    if (!row) return null;
    await tx.query('update leads set updated_at = $2 where id = $1', [leadId, now]);
    return toNote(row);
  });
}

export async function deleteLeadNote(
  db: Queryable,
  userId: string,
  leadId: string,
  noteId: string,
): Promise<boolean> {
  const result = await db.query(
    'delete from lead_notes where user_id = $1 and lead_id = $2 and id = $3',
    [userId, leadId, noteId],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Every lead with its notes and linked applications, for the data export (three queries in all). */
export async function listAllLeadDetails(db: Queryable, userId: string): Promise<LeadDetail[]> {
  const leads = await listLeads(db, userId);
  const [notes, applications] = await Promise.all([
    db.query<NoteRow & { lead_id: string }>(
      `select lead_id, ${NOTE_COLUMNS} from lead_notes where user_id = $1
        order by held_on desc, created_at desc`,
      [userId],
    ),
    db.query<{ lead_id: string; id: string; company: string; role: string; status: Status }>(
      `select lead_id, id, company, role, status from applications
        where user_id = $1 and lead_id is not null order by updated_at desc, id`,
      [userId],
    ),
  ]);
  return leads.map((lead) => ({
    ...lead,
    notes: notes.rows.filter((row) => row.lead_id === lead.id).map(toNote),
    applications: applications.rows
      .filter((row) => row.lead_id === lead.id)
      .map(({ id, company, role, status }) => ({ id, company, role, status })),
  }));
}

export type LeadMessageResult =
  | { kind: 'saved'; value: LeadNote }
  | { kind: 'not_found' }
  | { kind: 'limit_reached'; limit: number };

/**
 * A LinkedIn message marked sent: a dated note on the lead, the lead linked to the application,
 * and the application marked edited (activity resets the follow-up clock). The same note sent
 * twice on one day (a double click) is saved once and changes nothing more.
 */
export async function recordLeadMessage(
  db: Db,
  userId: string,
  applicationId: string,
  leadId: string,
  input: LeadNoteInput,
  now: Date,
): Promise<LeadMessageResult> {
  return db.transaction(async (tx) => {
    const lead = await tx.query('select 1 from leads where user_id = $1 and id = $2 for update', [
      userId,
      leadId,
    ]);
    const application = await tx.query(
      'select 1 from applications where user_id = $1 and id = $2 for update',
      [userId, applicationId],
    );
    if (!lead.rowCount || !application.rowCount) return { kind: 'not_found' };
    const same = await tx.query<NoteRow>(
      `select ${NOTE_COLUMNS} from lead_notes
        where user_id = $1 and lead_id = $2 and held_on = $3 and body = $4 limit 1`,
      [userId, leadId, input.heldOn, input.body],
    );
    const already = same.rows[0];
    if (already) return { kind: 'saved', value: toNote(already) };
    const counted = await tx.query<{ n: number }>(
      'select count(*)::int as n from lead_notes where lead_id = $1',
      [leadId],
    );
    if ((counted.rows[0]?.n ?? 0) >= LIMITS.notesPerLead)
      return { kind: 'limit_reached', limit: LIMITS.notesPerLead };
    const inserted = await tx.query<NoteRow>(
      `insert into lead_notes (lead_id, user_id, held_on, body, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $5) returning ${NOTE_COLUMNS}`,
      [leadId, userId, input.heldOn, input.body, now],
    );
    await tx.query('update leads set updated_at = $2 where id = $1', [leadId, now]);
    await tx.query(
      `update applications
          set lead_id = $3, updated_at = $4, last_activity_at = $4, version = version + 1
        where user_id = $1 and id = $2`,
      [userId, applicationId, leadId, now],
    );
    const row = inserted.rows[0];
    if (!row) throw new Error('Note was not created');
    return { kind: 'saved', value: toNote(row) };
  });
}
