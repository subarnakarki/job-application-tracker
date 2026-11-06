import { z } from 'zod';

/**
 * Phase 14, resume match: the shapes of a recruiter analysis and the plain-code check of which
 * keywords a resume already has. Pure (no I/O), so the server and the UI agree on every answer.
 */

export const RESUME_LIMITS = {
  /** The uploaded file, before base64. */
  fileBytes: 2 * 1024 * 1024,
  /** Text extracted from it (or pasted). Longer text is cut here, never sent whole. */
  textChars: 60_000,
  /** Less than this is almost certainly a scanned image or an empty file. */
  minTextChars: 200,
  fileName: 200,
  titles: 20,
  /** An answer with fewer titles than this is treated as a failed answer. */
  minTitles: 10,
  keywordsPerTitle: 20,
  keyword: 80,
  reason: 400,
  summary: 1000,
  notes: 10,
  note: 300,
  /** Saved analyses per user; older ones are removed. */
  analysesKept: 5,
} as const;

export const RESUME_MEDIA_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
] as const;
export type ResumeMediaType = (typeof RESUME_MEDIA_TYPES)[number];

/** How well the resume fits a title, as a recruiter would put it. */
export const FIT_LEVELS = ['strong', 'good', 'stretch'] as const;
export type FitLevel = (typeof FIT_LEVELS)[number];

export const SENIORITY_LEVELS = [
  'Entry',
  'Mid',
  'Senior',
  'Lead',
  'Manager',
  'Director',
  'Executive',
] as const;

export const KEYWORD_GROUPS = ['hard_skill', 'tool', 'certification', 'soft_skill'] as const;
export type KeywordGroup = (typeof KEYWORD_GROUPS)[number];

const text = (max: number) => z.string().trim().min(1).max(max);

/**
 * What the model is asked to return. No length rules on the arrays here: structured outputs do not
 * enforce them, so they are checked after parsing (`acceptAnswer`).
 */
export const ResumeAnswerSchema = z.strictObject({
  summary: z
    .string()
    .describe('Two or three sentences: who this candidate is, as a recruiter sees them'),
  titles: z.array(
    z.strictObject({
      title: z.string().describe('A real job title people search for, not an invented one'),
      fit: z.enum(FIT_LEVELS),
      seniority: z.enum(SENIORITY_LEVELS),
      reason: z.string().describe('One sentence, grounded in something the resume says'),
      keywords: z.array(z.strictObject({ term: z.string(), group: z.enum(KEYWORD_GROUPS) })),
    }),
  ),
  gaps: z.array(z.string()).describe('What would make the resume stronger for these titles'),
  warnings: z
    .array(z.string())
    .describe('Problems with the resume itself, such as hidden keyword stuffing or missing dates'),
});
export type ResumeAnswer = z.infer<typeof ResumeAnswerSchema>;

export const ResumeKeywordSchema = z.strictObject({
  term: text(RESUME_LIMITS.keyword),
  group: z.enum(KEYWORD_GROUPS),
  /** Decided by `keywordInText`, never by the model. */
  found: z.boolean(),
});
export type ResumeKeyword = z.infer<typeof ResumeKeywordSchema>;

export const ResumeTitleSchema = z.strictObject({
  rank: z.number().int().min(1).max(RESUME_LIMITS.titles),
  title: text(200),
  fit: z.enum(FIT_LEVELS),
  seniority: z.enum(SENIORITY_LEVELS),
  reason: text(RESUME_LIMITS.reason),
  keywords: z.array(ResumeKeywordSchema).max(RESUME_LIMITS.keywordsPerTitle),
});
export type ResumeTitle = z.infer<typeof ResumeTitleSchema>;

/** What is stored for an analysis, and what the API returns inside it. */
export const ResumeResultSchema = z.strictObject({
  summary: text(RESUME_LIMITS.summary),
  titles: z.array(ResumeTitleSchema).min(1).max(RESUME_LIMITS.titles),
  gaps: z.array(text(RESUME_LIMITS.note)).max(RESUME_LIMITS.notes),
  warnings: z.array(text(RESUME_LIMITS.note)).max(RESUME_LIMITS.notes),
});
export type ResumeResult = z.infer<typeof ResumeResultSchema>;

/** Cuts text to a length without leaving half a character. */
const clip = (value: string, max: number) => [...value.trim()].slice(0, max).join('');

/**
 * Turns the model's answer into a stored result: ranks the titles in the order given, drops empty
 * and duplicate titles and keywords, clips long text, marks each keyword found or missing in the
 * resume, and refuses an answer with too few titles. Returns null for an unusable answer.
 */
export function acceptAnswer(answer: ResumeAnswer, resumeText: string): ResumeResult | null {
  const index = indexText(resumeText);
  const seenTitles = new Set<string>();
  const titles: ResumeTitle[] = [];
  for (const candidate of answer.titles) {
    const title = clip(candidate.title, 200);
    const key = title.toLowerCase();
    if (!title || seenTitles.has(key) || !candidate.reason.trim()) continue;
    seenTitles.add(key);

    const seenTerms = new Set<string>();
    const keywords: ResumeKeyword[] = [];
    for (const keyword of candidate.keywords) {
      const term = clip(keyword.term, RESUME_LIMITS.keyword);
      const termKey = compactKey(term);
      if (!termKey || seenTerms.has(termKey)) continue;
      seenTerms.add(termKey);
      keywords.push({ term, group: keyword.group, found: index.has(term) });
      if (keywords.length === RESUME_LIMITS.keywordsPerTitle) break;
    }
    titles.push({
      rank: titles.length + 1,
      title,
      fit: candidate.fit,
      seniority: candidate.seniority,
      reason: clip(candidate.reason, RESUME_LIMITS.reason),
      keywords,
    });
    if (titles.length === RESUME_LIMITS.titles) break;
  }
  const summary = clip(answer.summary, RESUME_LIMITS.summary);
  if (titles.length < RESUME_LIMITS.minTitles || !summary) return null;

  const notes = (values: string[]) =>
    values
      .map((value) => clip(value, RESUME_LIMITS.note))
      .filter(Boolean)
      .slice(0, RESUME_LIMITS.notes);
  return { summary, titles, gaps: notes(answer.gaps), warnings: notes(answer.warnings) };
}

// ---------------------------------------------------------------------------------------------
// Keyword matching

/**
 * Names that ATS searches and recruiters treat as the same skill. Each row is one skill; a keyword
 * matches when the resume has any spelling in its row.
 */
const ALIASES: readonly (readonly string[])[] = [
  ['javascript', 'js', 'ecmascript'],
  ['typescript', 'ts'],
  ['postgresql', 'postgres', 'psql'],
  ['kubernetes', 'k8s'],
  ['amazon web services', 'aws'],
  ['google cloud platform', 'google cloud', 'gcp'],
  ['microsoft azure', 'azure'],
  ['continuous integration', 'ci'],
  ['ci/cd', 'continuous integration and delivery', 'continuous delivery'],
  ['machine learning', 'ml'],
  ['artificial intelligence', 'ai'],
  ['user experience', 'ux'],
  ['user interface', 'ui'],
  ['quality assurance', 'qa'],
  ['software development engineer in test', 'sdet'],
  ['search engine optimization', 'seo'],
  ['key performance indicators', 'kpis', 'kpi'],
  ['objectives and key results', 'okrs', 'okr'],
  ['product requirements document', 'prd', 'prds'],
  ['structured query language', 'sql'],
  ['node.js', 'node', 'nodejs'],
  ['react.js', 'react', 'reactjs'],
  ['vue.js', 'vue', 'vuejs'],
  ['next.js', 'nextjs'],
  ['golang', 'go language'],
  ['project management professional', 'pmp'],
  ['certified scrum master', 'csm'],
  ['a/b testing', 'split testing'],
];

/** Symbols that are part of a skill's name, spelled out before punctuation is removed. */
const SYMBOLS: readonly [RegExp, string][] = [
  [/c\+\+/g, ' cplusplus '],
  [/c#/g, ' csharp '],
  [/f#/g, ' fsharp '],
  [/(^|[^a-z0-9])\.net\b/g, '$1 dotnet '],
  [/&/g, ' and '],
];

/** Words as compared: lower case, accents and punctuation gone, plurals made singular. */
export function keywordTokens(value: string): string[] {
  let normal = value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
  for (const [pattern, replacement] of SYMBOLS) normal = normal.replace(pattern, replacement);
  return (
    normal
      // A dot, slash or hyphen between letters joins them ("node.js", "ci/cd", "e-mail").
      .replace(/([a-z0-9])[./-](?=[a-z0-9])/g, '$1')
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
      .map(singular)
  );
}

function singular(token: string): string {
  if (token.length <= 3 || /\d/.test(token)) return token;
  if (token.endsWith('ies') && token.length > 4) return `${token.slice(0, -3)}y`;
  if (token.endsWith('s') && !/(ss|us|sis|xis|js)$/.test(token)) return token.slice(0, -1);
  return token;
}

/** A term with every separator removed: "Front-end", "front end" and "frontend" share one key. */
function compactKey(term: string): string {
  return keywordTokens(term).join('');
}

const aliasRows = ALIASES.map((row) => row.map(compactKey));

/** Every spelling a term may appear under, as compact keys. */
function spellings(term: string): string[] {
  const key = compactKey(term);
  if (!key) return [];
  const row = aliasRows.find((keys) => keys.includes(key));
  return row ?? [key];
}

export interface TextIndex {
  /** Whether the text has the term (or a known alias of it) as whole words. */
  has(term: string): boolean;
}

/**
 * Prepares a text for many keyword checks. A term is found when its words appear in order, with or
 * without spaces between them ("front end" finds "frontend" and the other way round), never as part
 * of a longer word ("Java" is not found in "JavaScript").
 */
export function indexText(value: string): TextIndex {
  const tokens = keywordTokens(value);
  const cache = new Map<string, boolean>();
  const runHas = (key: string): boolean => {
    for (let start = 0; start < tokens.length; start += 1) {
      let joined = '';
      for (let end = start; end < tokens.length && joined.length < key.length; end += 1) {
        joined += tokens[end];
        if (joined === key) return true;
      }
    }
    return false;
  };
  return {
    has(term) {
      const options = spellings(term);
      return options.some((key) => {
        let found = cache.get(key);
        if (found === undefined) {
          found = runHas(key);
          cache.set(key, found);
        }
        return found;
      });
    },
  };
}

export function keywordInText(term: string, value: string): boolean {
  return indexText(value).has(term);
}

// ---------------------------------------------------------------------------------------------
// API shapes

const instant = z.iso.datetime({ offset: true });

/** `POST /api/resume`: a file as base64 (mutations are JSON only), or pasted text. */
export const ResumeUploadSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('file'),
    fileName: z.string().trim().min(1).max(RESUME_LIMITS.fileName),
    // 2 MB of file is at most 2,796,204 base64 characters; the exact size is checked once decoded.
    dataBase64: z
      .string()
      .min(1)
      .max(Math.ceil((RESUME_LIMITS.fileBytes * 4) / 3) + 4)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/, 'Must be base64'),
  }),
  z.strictObject({
    kind: z.literal('text'),
    text: z.string().trim().min(1).max(RESUME_LIMITS.textChars),
  }),
]);
export type ResumeUpload = z.infer<typeof ResumeUploadSchema>;

/** The current resume, without its contents. */
export const ResumeSchema = z.strictObject({
  fileName: z.string().nullable(),
  mediaType: z.enum(RESUME_MEDIA_TYPES),
  characters: z.number().int().min(1),
  uploadedAt: instant,
});
export type Resume = z.infer<typeof ResumeSchema>;

/** `GET /api/resume`: no resume yet is `null`, not a 404. */
export const ResumeEnvelopeSchema = z.strictObject({
  resume: ResumeSchema.nullable(),
  /** False when the server has no Anthropic key: the page says the feature is off. */
  analysisAvailable: z.boolean(),
});
export type ResumeEnvelope = z.infer<typeof ResumeEnvelopeSchema>;

export const ResumeAnalysisSchema = ResumeResultSchema.extend({
  id: z.uuid(),
  fileName: z.string().nullable(),
  model: z.string(),
  createdAt: instant,
});
export type ResumeAnalysis = z.infer<typeof ResumeAnalysisSchema>;

export const ResumeAnalysisSummarySchema = z.strictObject({
  id: z.uuid(),
  fileName: z.string().nullable(),
  createdAt: instant,
  topTitles: z.array(z.string()).max(3),
});
export type ResumeAnalysisSummary = z.infer<typeof ResumeAnalysisSummarySchema>;

export const ResumeAnalysisListSchema = z.strictObject({
  items: z.array(ResumeAnalysisSummarySchema).max(RESUME_LIMITS.analysesKept),
});
export type ResumeAnalysisList = z.infer<typeof ResumeAnalysisListSchema>;
