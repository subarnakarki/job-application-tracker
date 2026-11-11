import { z } from 'zod';
import { characterCount } from './leadMessage';

// A cover letter for one application (Phase 23). The app drafts it from the posting and the
// resume; the owner picks a length and a tone, may steer it, edits it and saves it.

export const COVER_LETTER_LENGTHS = ['short', 'standard'] as const;
export type CoverLetterLength = (typeof COVER_LETTER_LENGTHS)[number];

export const COVER_LETTER_LENGTH_LABELS: Record<CoverLetterLength, string> = {
  short: 'Short (about 150 words, for a form)',
  standard: 'Standard (about 300 words)',
};

export const COVER_LETTER_TONES = ['professional', 'warm', 'enthusiastic', 'direct'] as const;
export type CoverLetterTone = (typeof COVER_LETTER_TONES)[number];

export const COVER_LETTER_TONE_LABELS: Record<CoverLetterTone, string> = {
  professional: 'Professional',
  warm: 'Warm',
  enthusiastic: 'Enthusiastic',
  direct: 'Direct',
};

export const DEFAULT_COVER_LETTER_LENGTH: CoverLetterLength = 'standard';
export const DEFAULT_COVER_LETTER_TONE: CoverLetterTone = 'professional';

/** Lengths in characters as people see them (code points). */
export const COVER_LETTER_LIMITS = {
  /** The letter, drafted or edited. */
  letter: 5000,
  /** What the owner may add to steer the draft. */
  steer: 300,
  /** A pasted or stored posting, as for tailoring. */
  postingText: 20_000,
} as const;

/** The words a letter aims for, and past which the model is asked once more. */
export const COVER_LETTER_WORDS: Record<CoverLetterLength, { target: number; max: number }> = {
  short: { target: 150, max: 220 },
  standard: { target: 300, max: 450 },
};

export const GENERIC_GREETING = 'Dear Hiring Manager,';

/** Words as a reader counts them: runs of non-space characters. */
export function wordCount(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

/**
 * The greeting, from the application's contact when it starts with a person's name ("Jane Doe",
 * "Jane Doe, recruiter", "Jane Doe <jane@acme.com>"); otherwise the generic one. Decided by code,
 * so the model never guesses a name.
 */
export function greetingFor(contact: string | null): string {
  const head = (contact ?? '').split(/[,;|(<\n/]|\s[-–—]\s|\s@|https?:/)[0]?.trim() ?? '';
  const words = head.split(/\s+/).filter(Boolean);
  const looksLikeName =
    words.length >= 1 &&
    words.length <= 4 &&
    words.every((word) => /^\p{Lu}[\p{L}'’.-]*$/u.test(word)) &&
    !/@/.test(head);
  return looksLikeName ? `Dear ${head},` : GENERIC_GREETING;
}

/** Whether a draft is within its limits; if not, what was too long (for asking once more). */
export function coverLetterTooLong(text: string, length: CoverLetterLength): string | null {
  const characters = characterCount(text.trim());
  const words = wordCount(text);
  const problems: string[] = [];
  if (characters > COVER_LETTER_LIMITS.letter)
    problems.push(
      `it was ${String(characters)} characters (at most ${String(COVER_LETTER_LIMITS.letter)})`,
    );
  if (words > COVER_LETTER_WORDS[length].max)
    problems.push(
      `it was ${String(words)} words (aim for about ${String(COVER_LETTER_WORDS[length].target)})`,
    );
  return problems.length ? problems.join('; ') : null;
}

export type PostingSource = 'pasted' | 'stored' | 'tailoring';

/**
 * The posting a draft uses, first found of: pasted now, stored with this letter, stored by Tailor
 * my resume. Null means the job link must be read.
 */
export function pickPosting(sources: {
  pasted?: string | null;
  stored?: string | null;
  tailoring?: string | null;
}): { text: string; source: PostingSource } | null {
  if (sources.pasted) return { text: sources.pasted, source: 'pasted' };
  if (sources.stored) return { text: sources.stored, source: 'stored' };
  if (sources.tailoring) return { text: sources.tailoring, source: 'tailoring' };
  return null;
}

const singleLine = (max: number) =>
  z
    .string()
    .trim()
    .refine((value) => characterCount(value) <= max, `At most ${String(max)} characters`)
    // eslint-disable-next-line no-control-regex -- single-line check
    .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), 'Must be a single line');

/** `POST /api/applications/:id/cover-letter/draft`. */
export const DraftCoverLetterSchema = z.strictObject({
  /** The posting, when the job link cannot be read. */
  postingText: z
    .string()
    .trim()
    .min(200, 'Paste the whole posting')
    .max(COVER_LETTER_LIMITS.postingText)
    .optional(),
  /** What to stress, in a line; optional. */
  steer: singleLine(COVER_LETTER_LIMITS.steer).default(''),
  length: z.enum(COVER_LETTER_LENGTHS).default(DEFAULT_COVER_LETTER_LENGTH),
  tone: z.enum(COVER_LETTER_TONES).default(DEFAULT_COVER_LETTER_TONE),
});
export type DraftCoverLetter = z.output<typeof DraftCoverLetterSchema>;
export type DraftCoverLetterInput = z.input<typeof DraftCoverLetterSchema>;

/** `PUT /api/applications/:id/cover-letter`: the letter to keep, as edited. */
export const SaveCoverLetterSchema = z.strictObject({
  text: z
    .string()
    .trim()
    .min(1, 'Required')
    .refine(
      (value) => characterCount(value) <= COVER_LETTER_LIMITS.letter,
      `At most ${String(COVER_LETTER_LIMITS.letter)} characters`,
    )
    .refine((value) => !value.includes('\u0000'), 'Must not contain NUL characters'),
});
export type SaveCoverLetter = z.output<typeof SaveCoverLetterSchema>;

/** An application's cover letter (null until drafted or written), as the API shows it. */
export const ApplicationCoverLetterSchema = z.strictObject({
  coverLetter: z
    .strictObject({
      text: z.string(),
      length: z.enum(COVER_LETTER_LENGTHS),
      tone: z.enum(COVER_LETTER_TONES),
      steer: z.string(),
      draftedAt: z.iso.datetime({ offset: true }),
      /** Null while it is a draft the owner has not saved. */
      savedAt: z.iso.datetime({ offset: true }).nullable(),
      /** The resume was replaced since this letter was drafted. */
      resumeChanged: z.boolean(),
    })
    .nullable(),
  /** Whether a posting is stored for this job (drafting needs no link or paste). */
  hasPostingText: z.boolean(),
});
export type ApplicationCoverLetter = z.infer<typeof ApplicationCoverLetterSchema>;

/** What the model answers. */
export const CoverLetterAnswerSchema = z.strictObject({
  letter: z
    .string()
    .describe(
      'The whole letter in plain text: the given greeting line, the body paragraphs, a closing line and the candidate name',
    ),
});
export type CoverLetterAnswer = z.infer<typeof CoverLetterAnswerSchema>;
