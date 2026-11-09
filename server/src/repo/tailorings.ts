import {
  ApplicationTailoringSchema,
  LineEditSchema,
  TailoringSchema,
  type ApplicationTailoring,
  type LineEdit,
  type Tailoring,
} from '@jat/shared';
import { z } from 'zod';
import type { Queryable } from '../db/types';

/**
 * All SQL for a resume tailored to one application (table `application_tailorings`, Phase 18c).
 * Every statement is scoped by `user_id`; the application must be the user's (the foreign key is on
 * (user_id, application_id)).
 */

interface TailoringRow {
  tailoring: unknown;
  keywords: unknown;
  has_posting_text: boolean;
  posting_text: string | null;
  tailored_text: string | null;
  edits: unknown;
  resume_sha256: string | null;
  saved_at: Date | null;
}

const KeywordsSchema = ApplicationTailoringSchema.shape.keywords;
const EditsSchema = z.array(LineEditSchema);

export interface StoredTailoring {
  tailoring: Tailoring | null;
  keywords: ApplicationTailoring['keywords'];
  postingText: string | null;
  saved: { text: string; edits: LineEdit[]; savedAt: Date; resumeSha256: string | null } | null;
}

function toStored(row: TailoringRow): StoredTailoring {
  const tailoring = TailoringSchema.nullable().safeParse(row.tailoring);
  const keywords = KeywordsSchema.safeParse(row.keywords);
  const edits = EditsSchema.safeParse(row.edits);
  return {
    tailoring: tailoring.success ? tailoring.data : null,
    keywords: keywords.success ? keywords.data : [],
    postingText: row.posting_text,
    saved:
      row.tailored_text !== null && row.saved_at !== null
        ? {
            text: row.tailored_text,
            edits: edits.success ? edits.data : [],
            savedAt: row.saved_at,
            resumeSha256: row.resume_sha256,
          }
        : null,
  };
}

const COLUMNS = `tailoring, keywords, posting_text is not null as has_posting_text, posting_text,
  tailored_text, edits, resume_sha256, saved_at`;

export async function getTailoring(
  db: Queryable,
  userId: string,
  applicationId: string,
): Promise<StoredTailoring | null> {
  const result = await db.query<TailoringRow>(
    `select ${COLUMNS} from application_tailorings where user_id = $1 and application_id = $2`,
    [userId, applicationId],
  );
  const row = result.rows[0];
  return row ? toStored(row) : null;
}

/** The newest suggestions, keywords and posting text; a saved version is kept as it is. */
export async function saveSuggestions(
  db: Queryable,
  userId: string,
  applicationId: string,
  input: {
    tailoring: Tailoring | null;
    keywords: ApplicationTailoring['keywords'];
    postingText: string | null;
  },
  now: Date,
): Promise<void> {
  await db.query(
    `insert into application_tailorings
        (application_id, user_id, tailoring, keywords, posting_text, created_at, updated_at)
      values ($2, $1, $3, $4, $5, $6, $6)
      on conflict (application_id) do update set
        tailoring = excluded.tailoring, keywords = excluded.keywords,
        posting_text = coalesce(excluded.posting_text, application_tailorings.posting_text),
        updated_at = excluded.updated_at
      where application_tailorings.user_id = $1`,
    [
      userId,
      applicationId,
      input.tailoring === null ? null : JSON.stringify(input.tailoring),
      JSON.stringify(input.keywords),
      input.postingText,
      now,
    ],
  );
}

/** Saves the version to keep for this job (replacing any earlier one). */
export async function saveVersion(
  db: Queryable,
  userId: string,
  applicationId: string,
  input: { text: string; edits: LineEdit[]; resumeSha256: string },
  now: Date,
): Promise<void> {
  await db.query(
    `insert into application_tailorings
        (application_id, user_id, tailored_text, edits, resume_sha256, saved_at, created_at,
         updated_at)
      values ($2, $1, $3, $4, $5, $6, $6, $6)
      on conflict (application_id) do update set
        tailored_text = excluded.tailored_text, edits = excluded.edits,
        resume_sha256 = excluded.resume_sha256, saved_at = excluded.saved_at,
        updated_at = excluded.updated_at
      where application_tailorings.user_id = $1`,
    [userId, applicationId, input.text, JSON.stringify(input.edits), input.resumeSha256, now],
  );
}

/** Removes the saved version; the suggestions stay. */
export async function removeVersion(
  db: Queryable,
  userId: string,
  applicationId: string,
  now: Date,
): Promise<void> {
  await db.query(
    `update application_tailorings
        set tailored_text = null, edits = null, resume_sha256 = null, saved_at = null,
            updated_at = $3
      where user_id = $1 and application_id = $2`,
    [userId, applicationId, now],
  );
}

/** As the API shows it: the saved version flagged when the resume has changed since. */
export function presentTailoring(
  stored: StoredTailoring | null,
  currentResumeSha256: string | null,
): ApplicationTailoring {
  return {
    tailoring: stored?.tailoring ?? null,
    keywords: stored?.keywords ?? [],
    hasPostingText: Boolean(stored?.postingText),
    saved: stored?.saved
      ? {
          text: stored.saved.text,
          edits: stored.saved.edits,
          savedAt: stored.saved.savedAt.toISOString(),
          resumeChanged: stored.saved.resumeSha256 !== currentResumeSha256,
        }
      : null,
  };
}

/** Every tailoring of the user, for the data export (the posting text included). */
export async function exportTailorings(
  db: Queryable,
  userId: string,
): Promise<
  { applicationId: string; postingText: string | null; tailoring: ApplicationTailoring }[]
> {
  const result = await db.query<TailoringRow & { application_id: string }>(
    `select application_id, ${COLUMNS} from application_tailorings where user_id = $1
      order by created_at, application_id`,
    [userId],
  );
  return result.rows.map((row) => {
    const stored = toStored(row);
    return {
      applicationId: row.application_id,
      postingText: stored.postingText,
      tailoring: presentTailoring(stored, stored.saved?.resumeSha256 ?? null),
    };
  });
}
