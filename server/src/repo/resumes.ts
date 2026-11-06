import {
  RESUME_LIMITS,
  ResumeResultSchema,
  type Resume,
  type ResumeAnalysis,
  type ResumeAnalysisSummary,
  type ResumeMediaType,
  type ResumeResult,
} from '@jat/shared';
import type { Queryable } from '../db/types';

/**
 * All SQL for the user's resume and its analyses. Every statement is scoped by `user_id`, so
 * someone else's analysis behaves exactly like one that does not exist.
 */

export interface ResumeInput {
  fileName: string | null;
  mediaType: ResumeMediaType;
  /** The original file; null for pasted text. */
  file: Buffer | null;
  text: string;
  textSha256: string;
}

interface ResumeRow {
  file_name: string | null;
  media_type: ResumeMediaType;
  characters: number;
  uploaded_at: Date;
}

const toResume = (row: ResumeRow): Resume => ({
  fileName: row.file_name,
  mediaType: row.media_type,
  characters: row.characters,
  uploadedAt: row.uploaded_at.toISOString(),
});

const RESUME_COLUMNS = 'file_name, media_type, length(text)::int as characters, uploaded_at';

/** Replaces the user's resume (there is only ever one). */
export async function saveResume(
  db: Queryable,
  userId: string,
  input: ResumeInput,
  now: Date,
): Promise<Resume> {
  const result = await db.query<ResumeRow>(
    `insert into resumes (user_id, file_name, media_type, file, text, text_sha256, uploaded_at)
      values ($1, $2, $3, $4, $5, $6, $7)
      on conflict (user_id) do update set file_name = excluded.file_name,
        media_type = excluded.media_type, file = excluded.file, text = excluded.text,
        text_sha256 = excluded.text_sha256, uploaded_at = excluded.uploaded_at
      returning ${RESUME_COLUMNS}`,
    [userId, input.fileName, input.mediaType, input.file, input.text, input.textSha256, now],
  );
  return toResume(result.rows[0] as ResumeRow);
}

export async function getResume(db: Queryable, userId: string): Promise<Resume | null> {
  const result = await db.query<ResumeRow>(
    `select ${RESUME_COLUMNS} from resumes where user_id = $1`,
    [userId],
  );
  const row = result.rows[0];
  return row ? toResume(row) : null;
}

/** The text and its hash, for analysis. Never returned by the API. */
export async function getResumeText(
  db: Queryable,
  userId: string,
): Promise<{ text: string; textSha256: string; fileName: string | null } | null> {
  const result = await db.query<{ text: string; text_sha256: string; file_name: string | null }>(
    'select text, text_sha256, file_name from resumes where user_id = $1',
    [userId],
  );
  const row = result.rows[0];
  return row ? { text: row.text, textSha256: row.text_sha256, fileName: row.file_name } : null;
}

export async function getResumeFile(
  db: Queryable,
  userId: string,
): Promise<{ fileName: string; mediaType: ResumeMediaType; file: Buffer } | null> {
  const result = await db.query<{ file_name: string; media_type: ResumeMediaType; file: Buffer }>(
    'select file_name, media_type, file from resumes where user_id = $1 and file is not null',
    [userId],
  );
  const row = result.rows[0];
  return row ? { fileName: row.file_name, mediaType: row.media_type, file: row.file } : null;
}

export async function deleteResume(db: Queryable, userId: string): Promise<boolean> {
  const result = await db.query('delete from resumes where user_id = $1', [userId]);
  return result.rowCount > 0;
}

// ---------------------------------------------------------------------------------------------
// Analyses

interface AnalysisRow {
  id: string;
  file_name: string | null;
  result: unknown;
  model: string;
  created_at: Date;
}

const ANALYSIS_COLUMNS = 'id, file_name, result, model, created_at';

/** Stored results are parsed on the way out, so a bad row is a loud error, never a bad answer. */
function toAnalysis(row: AnalysisRow): ResumeAnalysis {
  return {
    ...ResumeResultSchema.parse(row.result),
    id: row.id,
    fileName: row.file_name,
    model: row.model,
    createdAt: row.created_at.toISOString(),
  };
}

/** The newest analysis of exactly this text since `since`, to answer again without a new call. */
export async function findRecentAnalysis(
  db: Queryable,
  userId: string,
  textSha256: string,
  since: Date,
): Promise<ResumeAnalysis | null> {
  const result = await db.query<AnalysisRow>(
    `select ${ANALYSIS_COLUMNS} from resume_analyses
      where user_id = $1 and text_sha256 = $2 and created_at >= $3
      order by created_at desc limit 1`,
    [userId, textSha256, since],
  );
  const row = result.rows[0];
  return row ? toAnalysis(row) : null;
}

/** Saves an analysis and keeps only the newest few for the user. */
export async function saveAnalysis(
  db: Queryable,
  userId: string,
  input: { fileName: string | null; textSha256: string; result: ResumeResult; model: string },
  now: Date,
): Promise<ResumeAnalysis> {
  const result = await db.query<AnalysisRow>(
    `insert into resume_analyses (user_id, file_name, text_sha256, result, model, created_at)
      values ($1, $2, $3, $4, $5, $6) returning ${ANALYSIS_COLUMNS}`,
    [userId, input.fileName, input.textSha256, JSON.stringify(input.result), input.model, now],
  );
  await db.query(
    `delete from resume_analyses where user_id = $1 and id not in (
      select id from resume_analyses where user_id = $1
      order by created_at desc, id desc limit $2)`,
    [userId, RESUME_LIMITS.analysesKept],
  );
  return toAnalysis(result.rows[0] as AnalysisRow);
}

export async function listAnalyses(
  db: Queryable,
  userId: string,
): Promise<ResumeAnalysisSummary[]> {
  const result = await db.query<{
    id: string;
    file_name: string | null;
    created_at: Date;
    top_titles: string[] | null;
  }>(
    `select id, file_name, created_at,
        array(select t ->> 'title' from jsonb_array_elements(result -> 'titles') t limit 3)
          as top_titles
      from resume_analyses where user_id = $1
      order by created_at desc, id desc limit $2`,
    [userId, RESUME_LIMITS.analysesKept],
  );
  return result.rows.map((row) => ({
    id: row.id,
    fileName: row.file_name,
    createdAt: row.created_at.toISOString(),
    topTitles: row.top_titles ?? [],
  }));
}

export async function getAnalysis(
  db: Queryable,
  userId: string,
  id: string,
): Promise<ResumeAnalysis | null> {
  const result = await db.query<AnalysisRow>(
    `select ${ANALYSIS_COLUMNS} from resume_analyses where user_id = $1 and id = $2`,
    [userId, id],
  );
  const row = result.rows[0];
  return row ? toAnalysis(row) : null;
}

export async function deleteAnalysis(db: Queryable, userId: string, id: string): Promise<boolean> {
  const result = await db.query('delete from resume_analyses where user_id = $1 and id = $2', [
    userId,
    id,
  ]);
  return result.rowCount > 0;
}

/** Everything, for the data export (the resume itself is described, not included). */
export async function listAllAnalyses(db: Queryable, userId: string): Promise<ResumeAnalysis[]> {
  const result = await db.query<AnalysisRow>(
    `select ${ANALYSIS_COLUMNS} from resume_analyses where user_id = $1
      order by created_at desc, id desc`,
    [userId],
  );
  return result.rows.map(toAnalysis);
}
