import {
  COVER_LETTER_LENGTHS,
  COVER_LETTER_TONES,
  DEFAULT_COVER_LETTER_LENGTH,
  DEFAULT_COVER_LETTER_TONE,
  type ApplicationCoverLetter,
  type CoverLetterLength,
  type CoverLetterTone,
} from '@jat/shared';
import type { Queryable } from '../db/types';

/**
 * All SQL for an application's cover letter (table `application_cover_letters`, Phase 23). One
 * letter per application: drafting again replaces it (as an unsaved draft), saving keeps the
 * text as edited. Never touches the application row, so its version and follow-up clock stay.
 */

interface CoverLetterRow {
  letter: string;
  posting_text: string | null;
  steer: string | null;
  length: string;
  tone: string;
  resume_sha256: string | null;
  drafted_at: Date;
  saved_at: Date | null;
}

export interface StoredCoverLetter {
  text: string;
  postingText: string | null;
  steer: string;
  length: CoverLetterLength;
  tone: CoverLetterTone;
  resumeSha256: string | null;
  draftedAt: Date;
  savedAt: Date | null;
}

const isLength = (value: string): value is CoverLetterLength =>
  (COVER_LETTER_LENGTHS as readonly string[]).includes(value);
const isTone = (value: string): value is CoverLetterTone =>
  (COVER_LETTER_TONES as readonly string[]).includes(value);

function toStored(row: CoverLetterRow): StoredCoverLetter {
  return {
    text: row.letter,
    postingText: row.posting_text,
    steer: row.steer ?? '',
    length: isLength(row.length) ? row.length : DEFAULT_COVER_LETTER_LENGTH,
    tone: isTone(row.tone) ? row.tone : DEFAULT_COVER_LETTER_TONE,
    resumeSha256: row.resume_sha256,
    draftedAt: row.drafted_at,
    savedAt: row.saved_at,
  };
}

const COLUMNS = 'letter, posting_text, steer, length, tone, resume_sha256, drafted_at, saved_at';

export async function getCoverLetter(
  db: Queryable,
  userId: string,
  applicationId: string,
): Promise<StoredCoverLetter | null> {
  const result = await db.query<CoverLetterRow>(
    `select ${COLUMNS} from application_cover_letters where user_id = $1 and application_id = $2`,
    [userId, applicationId],
  );
  const row = result.rows[0];
  return row ? toStored(row) : null;
}

/**
 * Stores a new draft, replacing the letter (saved or not) as an unsaved draft. The posting is
 * kept for drafting again; a draft made without one keeps the stored posting.
 */
export async function saveDraft(
  db: Queryable,
  userId: string,
  applicationId: string,
  input: {
    text: string;
    postingText: string | null;
    steer: string;
    length: CoverLetterLength;
    tone: CoverLetterTone;
    resumeSha256: string;
  },
  now: Date,
): Promise<void> {
  await db.query(
    `insert into application_cover_letters
        (application_id, user_id, letter, posting_text, steer, length, tone, resume_sha256,
         drafted_at, saved_at, created_at, updated_at)
      values ($2, $1, $3, $4, $5, $6, $7, $8, $9, null, $9, $9)
      on conflict (application_id) do update set
        letter = excluded.letter,
        posting_text = coalesce(excluded.posting_text, application_cover_letters.posting_text),
        steer = excluded.steer, length = excluded.length, tone = excluded.tone,
        resume_sha256 = excluded.resume_sha256, drafted_at = excluded.drafted_at,
        saved_at = null, updated_at = excluded.updated_at
      where application_cover_letters.user_id = $1`,
    [
      userId,
      applicationId,
      input.text,
      input.postingText,
      input.steer || null,
      input.length,
      input.tone,
      input.resumeSha256,
      now,
    ],
  );
}

/**
 * Saves the letter as edited. With no draft yet (a letter written by hand), it is stored with the
 * default length and tone and no resume.
 */
export async function saveLetter(
  db: Queryable,
  userId: string,
  applicationId: string,
  text: string,
  now: Date,
): Promise<void> {
  await db.query(
    `insert into application_cover_letters
        (application_id, user_id, letter, length, tone, drafted_at, saved_at, created_at,
         updated_at)
      values ($2, $1, $3, $4, $5, $6, $6, $6, $6)
      on conflict (application_id) do update set
        letter = excluded.letter, saved_at = excluded.saved_at, updated_at = excluded.updated_at
      where application_cover_letters.user_id = $1`,
    [userId, applicationId, text, DEFAULT_COVER_LETTER_LENGTH, DEFAULT_COVER_LETTER_TONE, now],
  );
}

/** Removes the letter, its stored posting included. */
export async function removeCoverLetter(
  db: Queryable,
  userId: string,
  applicationId: string,
): Promise<void> {
  await db.query(
    'delete from application_cover_letters where user_id = $1 and application_id = $2',
    [userId, applicationId],
  );
}

/**
 * As the API shows it. A letter with no resume behind it (written by hand, or from the queue)
 * is never flagged as out of date.
 */
export function presentCoverLetter(
  stored: StoredCoverLetter | null,
  hasPostingText: boolean,
  currentResumeSha256: string | null,
): ApplicationCoverLetter {
  return {
    coverLetter: stored
      ? {
          text: stored.text,
          length: stored.length,
          tone: stored.tone,
          steer: stored.steer,
          draftedAt: stored.draftedAt.toISOString(),
          savedAt: stored.savedAt?.toISOString() ?? null,
          resumeChanged:
            stored.resumeSha256 !== null && stored.resumeSha256 !== currentResumeSha256,
        }
      : null,
    hasPostingText,
  };
}

/** Every cover letter of the user, for the data export (the posting text included). */
export async function exportCoverLetters(
  db: Queryable,
  userId: string,
): Promise<
  { applicationId: string; postingText: string | null; coverLetter: ApplicationCoverLetter }[]
> {
  const result = await db.query<CoverLetterRow & { application_id: string }>(
    `select application_id, ${COLUMNS} from application_cover_letters where user_id = $1
      order by created_at, application_id`,
    [userId],
  );
  return result.rows.map((row) => {
    const stored = toStored(row);
    return {
      applicationId: row.application_id,
      postingText: stored.postingText,
      coverLetter: presentCoverLetter(stored, stored.postingText !== null, stored.resumeSha256),
    };
  });
}
