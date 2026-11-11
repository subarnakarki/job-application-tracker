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
