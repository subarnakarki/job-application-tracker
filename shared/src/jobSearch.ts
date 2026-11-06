import { z } from 'zod';
import { LIMITS, WORK_MODES, type WorkMode } from './constants';
import { localDateIn } from './dates';
import { indexText } from './resume';
import { isHttpUrl } from './schemas';

/**
 * Phase 15, scheduled job search: the saved profile, the Google-style query, which job links the
 * search keeps, how jobs are sorted, when a run is due, and which screening questions are answered
 * from the profile by code (never by the model). Pure (no I/O).
 */

// ---------------------------------------------------------------------------------------------
// Job boards the search covers

export const SEARCH_SOURCES = ['greenhouse', 'lever', 'ashby', 'workday'] as const;
export type SearchSource = (typeof SEARCH_SOURCES)[number];

/** Hosts per board, as `site:` and the web search tool's `allowed_domains` take them. */
export const SOURCE_HOSTS: Record<SearchSource, readonly string[]> = {
  greenhouse: ['job-boards.greenhouse.io', 'boards.greenhouse.io'],
  lever: ['jobs.lever.co'],
  ashby: ['jobs.ashbyhq.com'],
  workday: ['myworkdayjobs.com'],
};

export const SOURCE_LABELS: Record<SearchSource, string> = {
  greenhouse: 'Greenhouse',
  lever: 'Lever',
  ashby: 'Ashby',
  workday: 'Workday',
};

/** Workday needs an account at each company, so its jobs are always finished by hand. */
export const FILLABLE_SOURCES: readonly SearchSource[] = ['greenhouse', 'lever', 'ashby'];

export const DEFAULT_QUERY = 'site:job-boards.greenhouse.io "product manager"';

// ---------------------------------------------------------------------------------------------
// The query

export interface ParsedQuery {
  /** Boards named by `site:`, or every board when the query names none. */
  sources: SearchSource[];
  /** Quoted phrases and bare words, in order, without operators. */
  terms: string[];
  /** Words after a minus sign. */
  excluded: string[];
}

function sourceOfHost(host: string): SearchSource | null {
  const clean = host.toLowerCase().replace(/^\*\./, '').replace(/\/.*$/, '');
  for (const source of SEARCH_SOURCES)
    if (SOURCE_HOSTS[source].some((known) => clean === known || clean.endsWith(`.${known}`)))
      return source;
  return null;
}

/**
 * Reads a query in Google's syntax: `site:` hosts, "quoted phrases", bare words, `-excluded` words,
 * and `OR` (which is dropped: every term is a candidate title word either way).
 */
export function parseQuery(query: string): ParsedQuery {
  const sources = new Set<SearchSource>();
  const terms: string[] = [];
  const excluded: string[] = [];
  for (const match of query.matchAll(/(-?)(?:site:(\S+)|"([^"]*)"|(\S+))/gi)) {
    const [, minus, site, phrase, word] = match;
    if (site !== undefined) {
      const source = sourceOfHost(site);
      if (source && !minus) sources.add(source);
      continue;
    }
    const term = (phrase ?? word ?? '').trim();
    if (!term || /^(or|and|\|)$/i.test(term) || /^[a-z]+:/i.test(term)) continue;
    (minus ? excluded : terms).push(term);
  }
  return {
    sources: sources.size > 0 ? [...sources] : [...SEARCH_SOURCES],
    terms,
    excluded,
  };
}

/** The same query as a Google search link, with the time filter, for a manual cross-check. */
export function googleSearchUrl(query: string, timeframeDays: number): string {
  const tbs = timeframeDays <= 1 ? 'qdr:d' : timeframeDays <= 7 ? `qdr:d${timeframeDays}` : 'qdr:w';
  return `https://www.google.com/search?q=${encodeURIComponent(query)}&tbs=${tbs}`;
}

// ---------------------------------------------------------------------------------------------
// Job links the search keeps

export interface JobRef {
  source: SearchSource;
  /** The company's name on the board (Greenhouse board token, Lever/Ashby company, Workday tenant). */
  board: string;
  jobId: string;
  /** The posting, normalised: one link per job, however the search found it. */
  link: string;
}

const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Which job a link is, for the boards the search covers; null for anything else (a board's home
 * page, a search page, another site). Greenhouse embeds on company sites carry `gh_jid` and the
 * board in `for=`.
 */
export function jobRefOf(raw: string): JobRef | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split('/').filter(Boolean);

  if (/^(job-boards|boards)(\.eu)?\.greenhouse\.io$/.test(host)) {
    const embedFor = url.searchParams.get('for');
    const embedId = url.searchParams.get('token') ?? url.searchParams.get('gh_jid');
    const [board, kind, id] =
      parts[0] === 'embed' && embedFor && embedId ? [embedFor, 'jobs', embedId] : parts;
    if (board && kind === 'jobs' && id && SLUG.test(board) && /^\d{1,20}$/.test(id))
      return {
        source: 'greenhouse',
        board: board.toLowerCase(),
        jobId: id,
        link: `https://job-boards.greenhouse.io/${board.toLowerCase()}/jobs/${id}`,
      };
    return null;
  }
  if (/^jobs(\.eu)?\.lever\.co$/.test(host)) {
    const [company, id] = parts;
    if (company && id && SLUG.test(company) && UUID.test(id))
      return {
        source: 'lever',
        board: company.toLowerCase(),
        jobId: id.toLowerCase(),
        link: `https://${host}/${company.toLowerCase()}/${id.toLowerCase()}`,
      };
    return null;
  }
  if (host === 'jobs.ashbyhq.com') {
    const [org, id] = parts;
    if (org && id && SLUG.test(org) && UUID.test(id))
      return {
        source: 'ashby',
        board: org,
        jobId: id.toLowerCase(),
        link: `https://jobs.ashbyhq.com/${org}/${id.toLowerCase()}`,
      };
    return null;
  }
  if (host.endsWith('.myworkdayjobs.com')) {
    // https://acme.wd5.myworkdayjobs.com/en-US/External/job/Boston-MA/QA-Engineer_R123
    const jobAt = parts.indexOf('job');
    const last = parts.at(-1);
    if (jobAt >= 0 && last && jobAt < parts.length - 1) {
      const tenant = host.split('.')[0] ?? host;
      return {
        source: 'workday',
        board: tenant,
        jobId: last,
        link: `https://${host}${url.pathname}`.slice(0, LIMITS.jobLink),
      };
    }
    return null;
  }
  return null;
}

/** Each job once, in the order found. */
export function uniqueJobRefs(links: string[]): JobRef[] {
  const seen = new Set<string>();
  const refs: JobRef[] = [];
  for (const link of links) {
    const ref = jobRefOf(link);
    if (!ref) continue;
    const key = `${ref.source}:${ref.board}:${ref.jobId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(ref);
  }
  return refs;
}

// ---------------------------------------------------------------------------------------------
// Sorting jobs

export const HIT_KINDS = ['target', 'keyword_only', 'finish_yourself', 'skipped'] as const;
export type HitKind = (typeof HIT_KINDS)[number];

export interface JobFacts {
  source: SearchSource;
  title: string;
  /** The posting's own text (description), when read. */
  text: string;
  workMode: WorkMode | null;
  /** When the posting went up. Day-only dates are taken as the start of that day (UTC). */
  postedAt: Date | null;
  /** Already an application in the tracker (same link, or same company and role). */
  alreadyTracked: boolean;
}

export interface SortRules {
  includeTitles: string[];
  skipTitles: string[];
  /** The query's own words, used as title words when no include list is set. */
  queryTerms: string[];
  workModes: WorkMode[];
  timeframeDays: number;
  now: Date;
}

export interface Sorted {
  kind: HitKind;
  /** Why, in a few words, for the summary. */
  reason: string;
}

const anyIn = (terms: string[], text: string): string | undefined => {
  const index = indexText(text);
  return terms.find((term) => term.trim() && index.has(term));
};

/**
 * Where a job goes: skipped (too old, already tracked, a skipped title, the wrong work mode), a
 * target role (the title has an include word), keyword-only (the word is in the posting but not
 * the title), or finish-yourself (a target on a board that needs an account).
 */
export function sortJob(job: JobFacts, rules: SortRules): Sorted {
  if (job.alreadyTracked) return { kind: 'skipped', reason: 'Already in your tracker' };
  if (job.postedAt) {
    const oldest = rules.now.getTime() - rules.timeframeDays * 24 * 60 * 60 * 1000;
    if (job.postedAt.getTime() < oldest)
      return {
        kind: 'skipped',
        reason: `Posted more than ${String(rules.timeframeDays)} day${rules.timeframeDays === 1 ? '' : 's'} ago`,
      };
  }
  const skipped = anyIn(rules.skipTitles, job.title);
  if (skipped) return { kind: 'skipped', reason: `Title has "${skipped}", which you skip` };
  if (job.workMode && rules.workModes.length > 0 && !rules.workModes.includes(job.workMode))
    return { kind: 'skipped', reason: `${job.workMode}, which you don't want` };

  const wanted = rules.includeTitles.length > 0 ? rules.includeTitles : rules.queryTerms;
  const inTitle = wanted.length === 0 || anyIn(wanted, job.title) !== undefined;
  if (!inTitle)
    return {
      kind: 'keyword_only',
      reason: anyIn(wanted, job.text)
        ? 'Mentions your keywords, but the title is a different role'
        : "The title doesn't match your titles",
    };
  if (!FILLABLE_SOURCES.includes(job.source))
    return {
      kind: 'finish_yourself',
      reason: `${SOURCE_LABELS[job.source]} needs an account at each company`,
    };
  return { kind: 'target', reason: 'Matches your titles' };
}

// ---------------------------------------------------------------------------------------------
// When a run is due

export const CADENCES = ['daily', 'weekdays', 'weekly'] as const;
export type Cadence = (typeof CADENCES)[number];

/** Day of the week (0 = Sunday) and hour in a time zone. */
export function localClock(now: Date, timeZone: string): { weekday: number; hour: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(now);
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(
    parts.find((part) => part.type === 'weekday')?.value ?? '',
  );
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? '0');
  return { weekday, hour: hour === 24 ? 0 : hour };
}

/**
 * Whether a scheduled run should start now. The schedule is checked every hour, so a run is due
 * from its hour onwards on a day it applies to, once per local day (a missed hour catches up).
 */
export function isRunDue(
  schedule: { cadence: Cadence; runHour: number; runWeekday: number },
  timeZone: string,
  now: Date,
  lastScheduledRunDay: string | null,
): boolean {
  const today = localDateIn(now, timeZone);
  if (lastScheduledRunDay === today) return false;
  const { weekday, hour } = localClock(now, timeZone);
  if (hour < schedule.runHour) return false;
  if (schedule.cadence === 'weekdays') return weekday >= 1 && weekday <= 5;
  if (schedule.cadence === 'weekly') return weekday === schedule.runWeekday;
  return true;
}

// ---------------------------------------------------------------------------------------------
// The profile

const line = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    // eslint-disable-next-line no-control-regex -- single-line check
    .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), 'Must be a single line');
const required = (max: number) => line(max).refine((value) => value.length > 0, 'Required');
const link = z
  .string()
  .trim()
  .max(LIMITS.profileLink)
  .refine((value) => value === '' || isHttpUrl(value), 'Must be an http(s) link');
const termList = z.array(required(80)).max(20);

export const JobSearchProfileSchema = z
  .strictObject({
    fullName: required(200),
    email: z.email().max(LIMITS.email),
    phone: required(LIMITS.phone),
    city: required(100),
    state: required(100),
    /** In the user's words, e.g. "US citizen" or "Green card holder". */
    workAuthorization: required(200),
    needsSponsorship: z.boolean(),
    salaryMin: z.number().int().min(0).max(LIMITS.salaryMax),
    salaryMax: z.number().int().min(0).max(LIMITS.salaryMax).nullable(),
    linkedin: link,
    portfolio: link,
    website: link,
    workModes: z.array(z.enum(WORK_MODES)).min(1).max(3),
    /** Google-style queries, e.g. site:job-boards.greenhouse.io "product manager". */
    queries: z.array(required(300)).min(1).max(3),
    includeTitles: termList,
    skipTitles: termList,
    timeframeDays: z.union([z.literal(1), z.literal(3), z.literal(7)]),
    cadence: z.enum(CADENCES),
    runHour: z.number().int().min(0).max(23),
    runWeekday: z.number().int().min(0).max(6),
    /** Scheduled runs on or off (a run can always be started by hand). */
    scheduleOn: z.boolean(),
    // Answers to the common screening questions, given once.
    willingToRelocate: required(200),
    startDate: required(200),
    howHeard: required(200),
    over18: z.boolean(),
    /** Used for every demographic or EEO question. */
    eeoAnswer: required(200),
  })
  .refine((profile) => profile.salaryMax === null || profile.salaryMax >= profile.salaryMin, {
    path: ['salaryMax'],
    message: 'Must be at least the minimum',
  });
export type JobSearchProfile = z.infer<typeof JobSearchProfileSchema>;

export const DEFAULT_EEO_ANSWER = 'Decline to self-identify';

/** What the setup form starts with. */
export const PROFILE_DEFAULTS = {
  workModes: ['Remote', 'Hybrid'] as WorkMode[],
  queries: [DEFAULT_QUERY],
  timeframeDays: 1 as const,
  cadence: 'weekdays' as const,
  runHour: 8,
  runWeekday: 1,
  scheduleOn: true,
  willingToRelocate: 'No',
  startDate: 'Two weeks after an offer',
  howHeard: 'Company careers page',
  over18: true,
  eeoAnswer: DEFAULT_EEO_ANSWER,
};

// ---------------------------------------------------------------------------------------------
// Screening questions answered by code

export type ProfileAnswerKind =
  | 'first_name'
  | 'last_name'
  | 'full_name'
  | 'email'
  | 'phone'
  | 'location'
  | 'linkedin'
  | 'portfolio'
  | 'website'
  | 'work_authorization'
  | 'sponsorship'
  | 'salary'
  | 'relocation'
  | 'start_date'
  | 'how_heard'
  | 'over_18'
  | 'eeo'
  | 'resume'
  | 'cover_letter';

/** Most specific first: "sponsorship" questions also mention authorization. */
const PROFILE_QUESTIONS: [RegExp, ProfileAnswerKind][] = [
  [
    /\b(gender|race|ethnic|hispanic|latin[oa]|veteran|disabilit|sexual orientation|transgender|pronoun|demographic|eeo)/i,
    'eeo',
  ],
  [/\b(resume|cv)\b/i, 'resume'],
  [/\bcover letter\b/i, 'cover_letter'],
  [/\b(sponsor|visa|h-?1b)/i, 'sponsorship'],
  [
    /\b(authori[sz]ed|authori[sz]ation|eligib\w* to work|legally (able|permitted))/i,
    'work_authorization',
  ],
  [/\b(salary|compensation|pay expectation|desired pay|expected pay)/i, 'salary'],
  [/\brelocat/i, 'relocation'],
  [
    /\b(start date|when can you start|available to start|notice period|availability)\b/i,
    'start_date',
  ],
  [/\bhow did you (hear|find|learn)\b|\bsource\b|\breferred by\b/i, 'how_heard'],
  [/\b(18|eighteen) years\b|\bat least 18\b|\bof legal age\b/i, 'over_18'],
  [/^first name\b/i, 'first_name'],
  [/^last name\b|^surname\b|^family name\b/i, 'last_name'],
  [/^(full |legal )?name\b|\bpreferred name\b|\bname you'?d prefer\b/i, 'full_name'],
  [/\be-?mail\b/i, 'email'],
  [/\bphone\b|\bmobile number\b/i, 'phone'],
  [/\blinkedin\b/i, 'linkedin'],
  [/\bportfolio\b|\bgithub\b/i, 'portfolio'],
  [/\bwebsite\b|\bpersonal (site|url)\b/i, 'website'],
  [/\b(city|location|where are you (based|located)|current address)\b/i, 'location'],
];

/** Which profile answer a question takes, if any. Such questions never go to the model. */
export function profileQuestionKind(label: string): ProfileAnswerKind | null {
  const text = label.trim();
  for (const [pattern, kind] of PROFILE_QUESTIONS) if (pattern.test(text)) return kind;
  return null;
}

function salaryText(profile: JobSearchProfile): string {
  const amount = (value: number) => `$${value.toLocaleString('en-US')}`;
  return profile.salaryMax === null
    ? amount(profile.salaryMin)
    : `${amount(profile.salaryMin)} to ${amount(profile.salaryMax)}`;
}

/**
 * The answer a profile question gets. Null for the resume (attached, not typed) and for an empty
 * link; a cover letter is drafted separately.
 */
export function profileAnswer(kind: ProfileAnswerKind, profile: JobSearchProfile): string | null {
  const [first, ...rest] = profile.fullName.split(/\s+/);
  const blankToNull = (value: string) => value || null;
  switch (kind) {
    case 'first_name':
      return first ?? profile.fullName;
    case 'last_name':
      return rest.join(' ') || null;
    case 'full_name':
      return profile.fullName;
    case 'email':
      return profile.email;
    case 'phone':
      return profile.phone;
    case 'location':
      return `${profile.city}, ${profile.state}`;
    case 'linkedin':
      return blankToNull(profile.linkedin);
    case 'portfolio':
      return blankToNull(profile.portfolio) ?? blankToNull(profile.website);
    case 'website':
      return blankToNull(profile.website) ?? blankToNull(profile.portfolio);
    case 'work_authorization':
      return profile.workAuthorization;
    case 'sponsorship':
      return profile.needsSponsorship ? 'Yes' : 'No';
    case 'salary':
      return salaryText(profile);
    case 'relocation':
      return profile.willingToRelocate;
    case 'start_date':
      return profile.startDate;
    case 'how_heard':
      return profile.howHeard;
    case 'over_18':
      return profile.over18 ? 'Yes' : 'No';
    case 'eeo':
      return profile.eeoAnswer;
    case 'resume':
    case 'cover_letter':
      return null;
  }
}

/** For a yes/no question with fixed options: the option matching a Yes or No answer, if any. */
export function pickOption(answer: string, options: string[]): string | null {
  if (options.length === 0) return answer;
  const exact = options.find((option) => option.toLowerCase() === answer.toLowerCase());
  if (exact) return exact;
  const yes = /^yes\b/i.test(answer);
  const no = /^no\b/i.test(answer);
  if (yes || no)
    return options.find((option) => (yes ? /^yes\b/i : /^no\b/i).test(option.trim())) ?? null;
  const decline = /decline|don'?t wish|prefer not/i;
  if (decline.test(answer)) return options.find((option) => decline.test(option)) ?? null;
  return null;
}

// ---------------------------------------------------------------------------------------------
// Application questions and drafts

export const QUESTION_KINDS = [
  'text',
  'long_text',
  'single_select',
  'multi_select',
  'file',
  'checkbox',
] as const;

export const ApplicationQuestionSchema = z.strictObject({
  label: z.string().max(1000),
  required: z.boolean(),
  kind: z.enum(QUESTION_KINDS),
  /** The choices of a select question (capped; long country lists keep the first ones). */
  options: z.array(z.string().max(300)).max(300),
});
export type ApplicationQuestion = z.infer<typeof ApplicationQuestionSchema>;

/** Where an answer came from. Profile answers are filled by code; the model drafts the rest. */
export const ANSWER_SOURCES = ['profile', 'draft', 'needs_you'] as const;

export const DraftAnswerSchema = z.strictObject({
  question: z.string().max(1000),
  answer: z.string().max(4000),
  source: z.enum(ANSWER_SOURCES),
  /** For a fixed-choice question: the exact option to pick, when one matches. */
  option: z.string().max(300).nullable(),
});
export type DraftAnswer = z.infer<typeof DraftAnswerSchema>;

export const ApplicationDraftSchema = z.strictObject({
  answers: z.array(DraftAnswerSchema).max(100),
  /** Short and specific; pasted into a cover letter box when the form has one. */
  coverLetter: z.string().max(5000),
  /** "Why this company/role", reusable for similar free-text questions on the form. */
  whyInterested: z.string().max(2000),
});
export type ApplicationDraft = z.infer<typeof ApplicationDraftSchema>;
