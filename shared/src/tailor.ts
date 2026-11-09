import { z } from 'zod';
import { indexText, KEYWORD_GROUPS, POSTING_KEYWORDS_MAX, type KeywordGroup } from './resume';

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
/** A word with what joins it ("CI/CD", "Node.js", "C++", "A/B"), so it is judged whole. */
const TERM = /[\p{L}\p{N}]+(?:[/.&+#-][\p{L}\p{N}]+)*[+#]*/gu;
/** Names a reader would check: acronyms, mixed case or with digits (AWS, GraphQL, k6, S3). */
const isName = (term: string) =>
  /\p{Lu}.*\p{Lu}/u.test(term) || (/\p{L}/u.test(term) && /\p{N}/u.test(term));
/** Starts a sentence (where a capital means nothing). */
const sentenceStart = (text: string, at: number) => /(^|[.!?:]\s*|\n\s*)$/.test(text.slice(0, at));
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
  // A product, company or tool: an acronym, mixed case, letters with digits, or a capital mid-sentence.
  // A skill the edit sets out to add is judged below, by its group.
  const adding = new Set(added.map((keyword) => keyword.term.toLowerCase()));
  for (const match of suggested.matchAll(TERM)) {
    const term = match[0];
    if (/^[\d,.]+%?$/.test(term) || adding.has(term.toLowerCase())) continue;
    const capitalised = /^\p{Lu}/u.test(term) && !sentenceStart(suggested, match.index);
    if ((isName(term) || capitalised) && !index.has(term)) flag(term);
  }
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

// ---------------------------------------------------------------------------------------------
// A resume tailored to one application (Phase 18c)

export const APPLICATION_TAILOR_LIMITS = {
  /** A pasted posting. */
  postingText: 20_000,
  /** The saved version, as long as a stored resume may be. */
  tailoredText: 60_000,
  /** Edits kept with a saved version (chosen suggestions and lines changed by hand). */
  savedEdits: 200,
} as const;

const PostingKeywordSchema = z.strictObject({
  term: z.string().max(100),
  group: z.enum(KEYWORD_GROUPS),
});

/**
 * What the model returns when tailoring for an application: the posting's keywords (there is no
 * draft to take them from) with the same suggestions as Phase 16, in one call.
 */
export const ApplicationTailorAnswerSchema = TailorAnswerSchema.extend({
  keywords: z
    .array(z.strictObject({ term: z.string(), group: z.enum(KEYWORD_GROUPS) }))
    .describe(
      'The 10 to 20 terms this posting asks for (skills, tools, certifications), as written in it, most important first',
    ),
});
export type ApplicationTailorAnswer = z.infer<typeof ApplicationTailorAnswerSchema>;

/** One change in a saved version: a resume line and what replaced it ('' when removed). */
export const LineEditSchema = z.strictObject({
  original: z.string().max(TAILOR_LIMITS.line * 4),
  replacement: z.string().max(TAILOR_LIMITS.line * 4),
});
export type LineEdit = z.infer<typeof LineEditSchema>;

/**
 * The changes from the resume to an edited version, line by line (longest common subsequence of
 * lines, ignoring blank lines and surrounding spaces). A run of changed lines is paired in order;
 * a line only added has an empty original, a line only removed an empty replacement. Used to place
 * the edits in the original document (18e) and to show what changed.
 */
export function lineEdits(resumeText: string, editedText: string): LineEdit[] {
  const lines = (text: string) =>
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  const before = lines(resumeText);
  const after = lines(editedText);
  // LCS table, from the end.
  const table: number[][] = Array.from({ length: before.length + 1 }, () =>
    new Array<number>(after.length + 1).fill(0),
  );
  for (let i = before.length - 1; i >= 0; i -= 1)
    for (let j = after.length - 1; j >= 0; j -= 1)
      (table[i] as number[])[j] =
        before[i] === after[j]
          ? ((table[i + 1] as number[])[j + 1] ?? 0) + 1
          : Math.max((table[i + 1] as number[])[j] ?? 0, (table[i] as number[])[j + 1] ?? 0);

  const edits: LineEdit[] = [];
  let removed: string[] = [];
  let added: string[] = [];
  const flush = () => {
    const pairs = Math.max(removed.length, added.length);
    for (let k = 0; k < pairs; k += 1)
      edits.push({ original: removed[k] ?? '', replacement: added[k] ?? '' });
    removed = [];
    added = [];
  };
  let i = 0;
  let j = 0;
  while (i < before.length || j < after.length) {
    if (i < before.length && j < after.length && before[i] === after[j]) {
      flush();
      i += 1;
      j += 1;
    } else if (
      j >= after.length ||
      (i < before.length &&
        ((table[i + 1] as number[])[j] ?? 0) >= ((table[i] as number[])[j + 1] ?? 0))
    ) {
      removed.push(before[i] as string);
      i += 1;
    } else {
      added.push(after[j] as string);
      j += 1;
    }
  }
  flush();
  return edits;
}

/** `POST /api/applications/:id/tailor`: the posting pasted when its link cannot be read. */
export const TailorApplicationSchema = z.strictObject({
  postingText: z
    .string()
    .trim()
    .min(200, 'Paste the whole posting')
    .max(APPLICATION_TAILOR_LIMITS.postingText)
    .optional(),
});
export type TailorApplicationInput = z.output<typeof TailorApplicationSchema>;

/** `PUT /api/applications/:id/tailored-resume`: the version to keep for this job. */
export const SaveTailoredResumeSchema = z.strictObject({
  text: z
    .string()
    .trim()
    .min(1, 'Required')
    .max(APPLICATION_TAILOR_LIMITS.tailoredText)
    .refine((value) => !value.includes('\u0000'), 'Must not contain NUL characters'),
});

/** An application's tailoring: the last suggestions and the saved version, if any. */
export const ApplicationTailoringSchema = z.strictObject({
  tailoring: TailoringSchema.nullable(),
  /** The posting's keywords, for the fit as the text is edited. */
  keywords: z.array(PostingKeywordSchema).max(POSTING_KEYWORDS_MAX),
  /** Whether the posting's text is stored (tailoring again needs no link or paste). */
  hasPostingText: z.boolean(),
  saved: z
    .strictObject({
      text: z.string(),
      edits: z.array(LineEditSchema).max(APPLICATION_TAILOR_LIMITS.savedEdits),
      savedAt: z.iso.datetime({ offset: true }),
      /** The resume was replaced since this version was saved. */
      resumeChanged: z.boolean(),
    })
    .nullable(),
});
export type ApplicationTailoring = z.infer<typeof ApplicationTailoringSchema>;
