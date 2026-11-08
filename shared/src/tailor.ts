import { z } from 'zod';
import { indexText, type KeywordGroup } from './resume';

/**
 * Tailoring a resume for one job (Phase 16c): the model suggests rewording lines the resume already
 * has, so the posting's missing keywords appear where the resume supports them. Everything it says
 * is checked here, by code: an edit of a line the resume does not have is dropped, a keyword it did
 * not really add is removed, and a number or name the resume never mentions is flagged.
 */

export const TAILOR_LIMITS = { edits: 12, notCovered: 20, line: 600, why: 300 } as const;

/** What the model is asked to return. */
export const TailorAnswerSchema = z.strictObject({
  edits: z.array(
    z.strictObject({
      original: z.string().describe('One line or bullet copied exactly from the resume'),
      suggested: z.string().describe('That line reworded; the same facts, nothing invented'),
      keywordsAdded: z.array(z.string()).describe('The missing posting keywords this edit adds'),
      why: z.string().describe('One sentence: what in the resume supports the new wording'),
    }),
  ),
  notCovered: z
    .array(z.strictObject({ keyword: z.string(), why: z.string() }))
    .describe('Missing keywords the resume gives no honest basis for, each with the reason'),
});
export type TailorAnswer = z.infer<typeof TailorAnswerSchema>;

export const TailorEditSchema = z.strictObject({
  /** Exactly as it is written in the resume, so it can be replaced. */
  original: z.string().max(TAILOR_LIMITS.line),
  suggested: z.string().max(TAILOR_LIMITS.line),
  keywordsAdded: z.array(z.string().max(100)).max(20),
  why: z.string().max(TAILOR_LIMITS.why),
  /** Numbers and names in the suggestion that the resume never mentions: check before using. */
  unverified: z.array(z.string().max(100)).max(10),
});
export type TailorEdit = z.infer<typeof TailorEditSchema>;

export const TailoringSchema = z.strictObject({
  edits: z.array(TailorEditSchema).max(TAILOR_LIMITS.edits),
  notCovered: z
    .array(z.strictObject({ keyword: z.string().max(100), why: z.string().max(TAILOR_LIMITS.why) }))
    .max(TAILOR_LIMITS.notCovered),
  model: z.string().max(100),
  createdAt: z.iso.datetime({ offset: true }),
});
export type Tailoring = z.infer<typeof TailoringSchema>;

const clip = (value: string, max: number) => value.trim().slice(0, max);
const WORD = /[\p{L}\p{N}]+/gu;
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The resume's own text for a line the model quoted, ignoring case, spacing and punctuation (it
 * may drop a bullet sign or a full stop). Null when the resume has no such line: the model made it
 * up, so the edit is dropped. A very short quote is never trusted.
 */
export function findInResume(resumeText: string, quoted: string): string | null {
  const words = quoted.match(WORD) ?? [];
  if (words.length < 3) return null;
  // The line's own closing punctuation goes with it, so a replacement does not leave a stray one.
  const pattern = new RegExp(`${words.map(escape).join('[^\\p{L}\\p{N}]+')}[.;:!?]*`, 'iu');
  return pattern.exec(resumeText)?.[0] ?? null;
}

/** Digits as written, without thousands separators: "2,500" and "2500" are the same number. */
const NUMBER = /\d[\d,.]*%?/g;
/** Names a reader would check: acronyms, mixed case or with digits (AWS, GraphQL, k6, S3). */
const NAME =
  /\b(?:[A-Z]{2,}[A-Za-z0-9]*|[A-Z][a-z0-9]*[A-Z][A-Za-z0-9]*|[A-Za-z]+\d[A-Za-z0-9]*)\b/g;
/** A capitalised word in the middle of a sentence: a product, company or place (Jira, Docker). */
const PROPER = /(?<=[\p{Ll}\p{N},;:)]\s+)\p{Lu}[\p{L}\p{N}+#.-]*[\p{L}\p{N}+#]/gu;
const bareNumber = (value: string) => value.replace(/[,%]/g, '').replace(/\.$/, '');

/**
 * Numbers and names in a suggestion that the resume does not have anywhere, plus any tool or
 * certification it claims to add: the model was told not to invent them, and this makes sure the
 * reader sees it if it did.
 */
export function unverifiedIn(
  suggested: string,
  resumeText: string,
  added: { term: string; group: KeywordGroup }[],
): string[] {
  const index = indexText(resumeText);
  const resumeNumbers = new Set((resumeText.match(NUMBER) ?? []).map(bareNumber));
  const flagged: string[] = [];
  const flag = (value: string) => {
    if (!flagged.some((entry) => entry.toLowerCase() === value.toLowerCase())) flagged.push(value);
  };
  for (const number of suggested.match(NUMBER) ?? [])
    if (!resumeNumbers.has(bareNumber(number))) flag(number.replace(/[.,]$/, ''));
  for (const name of suggested.match(NAME) ?? []) if (!index.has(name)) flag(name);
  for (const name of suggested.match(PROPER) ?? []) if (!index.has(name)) flag(name);
  for (const keyword of added)
    if ((keyword.group === 'tool' || keyword.group === 'certification') && !index.has(keyword.term))
      flag(keyword.term);
  return flagged.slice(0, 10);
}

/**
 * The model's answer, made safe to show: edits only of lines really in the resume (each line once),
 * actually changed, with only the posting keywords each really adds; at most 12 edits.
 */
export function acceptTailoring(
  answer: TailorAnswer,
  resumeText: string,
  postingKeywords: { term: string; group: KeywordGroup }[],
): Pick<Tailoring, 'edits' | 'notCovered'> {
  const edits: TailorEdit[] = [];
  const used = new Set<string>();
  for (const edit of answer.edits) {
    const original = findInResume(resumeText, edit.original);
    const suggested = clip(edit.suggested, TAILOR_LIMITS.line);
    if (!original || original.length > TAILOR_LIMITS.line || !suggested) continue;
    if (used.has(original.toLowerCase())) continue;
    if (suggested.replace(/\W/g, '').toLowerCase() === original.replace(/\W/g, '').toLowerCase())
      continue;
    const before = indexText(original);
    const after = indexText(suggested);
    const added = postingKeywords.filter(
      (keyword) =>
        edit.keywordsAdded.some(
          (term) => term.trim().toLowerCase() === keyword.term.toLowerCase(),
        ) &&
        after.has(keyword.term) &&
        !before.has(keyword.term),
    );
    used.add(original.toLowerCase());
    edits.push({
      original,
      suggested,
      keywordsAdded: added.map((keyword) => keyword.term),
      why: clip(edit.why, TAILOR_LIMITS.why),
      unverified: unverifiedIn(suggested, resumeText, added),
    });
    if (edits.length === TAILOR_LIMITS.edits) break;
  }
  const notCovered = answer.notCovered
    .map((entry) => ({
      keyword: clip(entry.keyword, 100),
      why: clip(entry.why, TAILOR_LIMITS.why),
    }))
    .filter((entry) => entry.keyword)
    .slice(0, TAILOR_LIMITS.notCovered);
  return { edits, notCovered };
}

/** The resume with the chosen edits made (each replaces its line once). */
export function applyEdits(
  resumeText: string,
  edits: Pick<TailorEdit, 'original' | 'suggested'>[],
) {
  let text = resumeText;
  for (const edit of edits) {
    const at = text.indexOf(edit.original);
    if (at >= 0) text = text.slice(0, at) + edit.suggested + text.slice(at + edit.original.length);
  }
  return text;
}
