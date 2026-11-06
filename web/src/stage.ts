import type { Status } from '@jat/shared';

/** The CSS colour of each stage: dots, bars and avatar tints (tokens in index.css). */
export const STAGE_COLOR: Record<Status, string> = {
  Saved: 'var(--color-st-saved)',
  Applied: 'var(--color-st-applied)',
  Screening: 'var(--color-st-screening)',
  Interviewing: 'var(--color-st-interviewing)',
  Offer: 'var(--color-st-offer)',
  Rejected: 'var(--color-st-rejected)',
  Withdrawn: 'var(--color-st-withdrawn)',
};

/** The stage bars: one per open stage, filled up to the current one. Closed stages fill none. */
export const BAR_COUNT = 5;

const FILL: Record<Status, number> = {
  Saved: 1,
  Applied: 2,
  Screening: 3,
  Interviewing: 4,
  Offer: 5,
  Rejected: 0,
  Withdrawn: 0,
};

export function stageFill(status: Status): number {
  return FILL[status];
}

/**
 * Up to `max` capital letters for an avatar: the first letter of the first and the last word
 * ("Sam Rivera" is "SR"), or one letter for a single word. "?" for an empty name.
 */
export function initials(name: string, max = 2): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const first = words[0];
  if (!first) return '?';
  const letter = (word: string) => Array.from(word)[0]?.toLocaleUpperCase() ?? '';
  const last = words.length > 1 ? words[words.length - 1] : undefined;
  return (max > 1 && last ? letter(first) + letter(last) : letter(first)).slice(0, max * 2);
}
