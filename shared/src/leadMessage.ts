import { z } from 'zod';
import { LIMITS, type Status } from './constants';

// A LinkedIn message to a lead about one application (Phase 18b). The app drafts it; the owner
// edits it, sends it on LinkedIn, then marks it sent, which logs it as a note on the lead.

export const LEAD_MESSAGE_KINDS = ['referral', 'follow_up', 'thanks', 'keep_in_touch'] as const;
export type LeadMessageKind = (typeof LEAD_MESSAGE_KINDS)[number];

export const LEAD_MESSAGE_KIND_LABELS: Record<LeadMessageKind, string> = {
  referral: 'Ask for a referral or an introduction',
  follow_up: 'A short follow-up',
  thanks: 'Thanks, or a check-in',
  keep_in_touch: 'Thanks, and keep in touch',
};

/**
 * Lengths in characters as people see them (code points). LinkedIn's invitation note is 200
 * characters on a free account (300 on Premium); a message is kept short on purpose.
 */
export const LEAD_MESSAGE_LIMITS = {
  connectionNote: 200,
  message: 1000,
  /** What the owner may add to steer the draft. */
  steer: 300,
  /** The text marked sent: the message as edited, up to LinkedIn's own message limit. */
  sent: 8000,
} as const;

/** The message kind a status suggests: before applying, ask; after, follow up or thank. */
export function suggestedMessageKind(status: Status): LeadMessageKind {
  switch (status) {
    case 'Saved':
      return 'referral';
    case 'Applied':
    case 'Screening':
      return 'follow_up';
    case 'Interviewing':
      return 'thanks';
    case 'Offer':
    case 'Rejected':
    case 'Withdrawn':
      return 'keep_in_touch';
  }
}

/** Length in characters as people see them: an emoji or an accented letter counts once. */
export function characterCount(text: string): number {
  return [...text].length;
}

/**
 * Text cut to at most `max` characters, at the end of the last whole sentence that fits, else at
 * the last whole word. Used only when a draft is still too long after the model was asked again.
 */
export function clipToLength(text: string, max: number): string {
  const trimmed = text.trim();
  const chars = [...trimmed];
  if (chars.length <= max) return trimmed;
  const head = chars.slice(0, max).join('');
  const sentence = head.match(/^[\s\S]*[.!?](?=\s|$)/)?.[0];
  if (sentence && characterCount(sentence) >= max / 2) return sentence.trim();
  const word = head.replace(/\s+\S*$/, '');
  return (word || head).trim();
}

/** Whether a lead's link is a LinkedIn page (the button then says "open profile"). */
export function isLinkedInLink(link: string | null): boolean {
  if (!link) return false;
  try {
    const host = new URL(link).hostname.toLowerCase();
    return host === 'linkedin.com' || host.endsWith('.linkedin.com');
  } catch {
    return false;
  }
}

/** The note saved on the lead when a message is marked sent. */
export function sentMessageNote(company: string, role: string, text: string): string {
  const heading = `LinkedIn message about ${role} at ${company}:`;
  return [...`${heading}\n\n${text.trim()}`].slice(0, LIMITS.leadNote).join('');
}

const singleLine = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    // eslint-disable-next-line no-control-regex -- single-line check
    .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), 'Must be a single line');

/** `POST /api/applications/:id/lead-message`: draft a message (nothing is stored). */
export const LeadMessageRequestSchema = z.strictObject({
  leadId: z.uuid(),
  kind: z.enum(LEAD_MESSAGE_KINDS),
  /** What the owner wants to say, in a line; optional. */
  steer: singleLine(LEAD_MESSAGE_LIMITS.steer).default(''),
});
export type LeadMessageRequest = z.output<typeof LeadMessageRequestSchema>;
export type LeadMessageRequestInput = z.input<typeof LeadMessageRequestSchema>;

export const LeadMessageDraftSchema = z.strictObject({
  leadId: z.uuid(),
  kind: z.enum(LEAD_MESSAGE_KINDS),
  connectionNote: z.string().max(LEAD_MESSAGE_LIMITS.connectionNote * 2),
  message: z.string().max(LEAD_MESSAGE_LIMITS.message * 2),
});
export type LeadMessageDraft = z.infer<typeof LeadMessageDraftSchema>;

/** `POST /api/applications/:id/lead-message/sent`: log the message sent. */
export const LeadMessageSentSchema = z.strictObject({
  leadId: z.uuid(),
  text: z
    .string()
    .trim()
    .min(1, 'Required')
    .refine((value) => characterCount(value) <= LEAD_MESSAGE_LIMITS.sent, 'Too long')
    .refine((value) => !value.includes('\u0000'), 'Must not contain NUL characters'),
});
export type LeadMessageSent = z.output<typeof LeadMessageSentSchema>;

/** What the model answers: both versions, in plain text. */
export const LeadMessageAnswerSchema = z.strictObject({
  connectionNote: z
    .string()
    .describe('At most 200 characters: an invitation note, first person, no greeting line needed'),
  message: z.string().describe('At most 1,000 characters: the full message, first person'),
});
export type LeadMessageAnswer = z.infer<typeof LeadMessageAnswerSchema>;
