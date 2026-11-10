import {
  LIMITS,
  type ApplicationQuestion,
  type JobRef,
  type PostedPay,
  type WorkMode,
} from '@jat/shared';
import {
  fromAshby,
  fromGreenhouse,
  fromJobvite,
  fromLever,
  fromWorkable,
  jobviteDescription,
} from '../postings/boards';
import { asArray, cleanText, fieldOf, parseJson, salaryInText } from '../postings/details';
import { FetchError, type PageFetcher } from '../postings/fetchPage';
import { readPosting } from '../postings/preview';
import { proseInJson, POSTING_TEXT_MAX, readPostingText } from '../postings/text';

/**
 * Reads one job a search found, from its board's public API: the exact title, company, place,
 * work mode, when it was posted, where to apply, its text, and (Greenhouse only) the application
 * questions. Read through the guarded fetcher, so the SSRF rules and size caps apply.
 */

export interface JobDetails {
  company: string;
  role: string;
  location: string | null;
  workMode: WorkMode | null;
  postedAt: Date | null;
  /** Only the day is known (postedAt is its start, UTC). */
  postedDayOnly?: boolean;
  /** The country, when the board gives one (a name or a code). */
  country: string | null;
  applyLink: string;
  /** Plain text of the posting, for sorting and drafting. */
  text: string;
  /** Null when the board does not publish its questions (Lever, Ashby, Workday). */
  questions: ApplicationQuestion[] | null;
  /** The yearly pay the posting gives: the board's own field, else a pay range in its text. */
  salary: PostedPay | null;
}

/**
 * Why a job could not be read. `gone` means the board itself says the job is not there (a 404 or
 * 410, or missing from the board's own list): it is closed, and must never be kept. Anything else
 * (refused, rate-limited, timed out, a page drawn by script) says nothing about the job.
 */
export class JobReadError extends Error {
  constructor(
    message: string,
    readonly gone = false,
  ) {
    super(message);
    this.name = 'JobReadError';
  }
}

/** A board's "not found": the job was taken down. */
const isGoneStatus = (text: string) => /http_status: (404|410)\b/.test(text);

function readFailure(error: unknown): JobReadError {
  if (error instanceof FetchError) {
    const message = `${error.code}: ${error.message}`;
    return new JobReadError(message, isGoneStatus(message));
  }
  const message = error instanceof Error ? error.message : 'unreadable';
  return new JobReadError(message, isGoneStatus(message));
}

const MAX_OPTIONS = 300;

const instant = (value: unknown): Date | null => {
  const date =
    typeof value === 'number'
      ? new Date(value)
      : typeof value === 'string'
        ? new Date(value)
        : null;
  return date && Number.isFinite(date.getTime()) ? date : null;
};

/** "acme-corp" -> "Acme Corp", for boards that do not name the company. */
export function companyFromSlug(slug: string): string {
  return slug
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
    .slice(0, LIMITS.company);
}

const GREENHOUSE_KINDS: Record<string, ApplicationQuestion['kind']> = {
  input_text: 'text',
  textarea: 'long_text',
  input_file: 'file',
  multi_value_single_select: 'single_select',
  multi_value_multi_select: 'multi_select',
  input_hidden: 'text',
  boolean: 'checkbox',
};

function greenhouseQuestion(question: unknown): ApplicationQuestion | null {
  const label = cleanText(fieldOf(question, 'label'), 1000);
  const fields = asArray(fieldOf(question, 'fields'));
  const first = fields[0];
  if (!label || !first) return null;
  const type = fieldOf(first, 'type');
  const options = asArray(fieldOf(first, 'values'))
    .map((value) => cleanText(fieldOf(value, 'label'), 300))
    .filter((value): value is string => value !== null)
    .slice(0, MAX_OPTIONS);
  return {
    label,
    required: fieldOf(question, 'required') === true,
    kind: (typeof type === 'string' ? GREENHOUSE_KINDS[type] : undefined) ?? 'text',
    options,
  };
}

/**
 * A question from Greenhouse's newer demographic block, which has its own shape: a `type` and
 * `answer_options` on the question itself, instead of `fields`.
 */
function demographicQuestion(question: unknown): ApplicationQuestion | null {
  const label = cleanText(fieldOf(question, 'label'), 1000);
  if (!label) return null;
  const type = fieldOf(question, 'type');
  const options = asArray(fieldOf(question, 'answer_options'))
    .map((option) => cleanText(fieldOf(option, 'label'), 300))
    .filter((option): option is string => option !== null)
    .slice(0, MAX_OPTIONS);
  return {
    label,
    required: fieldOf(question, 'required') === true,
    kind:
      type === 'multi_value_multi_select'
        ? 'multi_select'
        : options.length > 0
          ? 'single_select'
          : 'text',
    options,
  };
}

/** The questions, then any EEO and demographic questions (answered from the profile). */
export function greenhouseQuestions(job: unknown): ApplicationQuestion[] {
  const compliance = asArray(fieldOf(job, 'compliance')).flatMap((block) =>
    asArray(fieldOf(block, 'questions')),
  );
  const demographic = asArray(fieldOf(fieldOf(job, 'demographic_questions'), 'questions'));
  return [
    ...[...asArray(fieldOf(job, 'questions')), ...compliance].map(greenhouseQuestion),
    ...demographic.map(demographicQuestion),
  ].filter((question): question is ApplicationQuestion => question !== null);
}

const textOf = (body: unknown) => proseInJson(body).join('\n').slice(0, POSTING_TEXT_MAX);

async function readJson(fetchPage: PageFetcher, url: string): Promise<unknown> {
  try {
    return parseJson((await fetchPage(url)).text);
  } catch (error) {
    if (error instanceof FetchError) throw readFailure(error);
    throw error;
  }
}

export async function readJob(
  ref: JobRef,
  fetchPage: PageFetcher,
  fetchBoard: PageFetcher = fetchPage,
): Promise<JobDetails> {
  switch (ref.source) {
    case 'greenhouse': {
      const job = await readJson(
        fetchPage,
        `https://boards-api.greenhouse.io/v1/boards/${ref.board}/jobs/${ref.jobId}?questions=true&pay_transparency=true`,
      );
      const details = fromGreenhouse(job);
      if (!details.role) throw new JobReadError('greenhouse: no such job', true);
      return {
        company: details.company ?? companyFromSlug(ref.board),
        role: details.role,
        location: details.location,
        workMode: /\bremote\b/i.test(details.location ?? '') ? 'Remote' : null,
        postedAt: instant(fieldOf(job, 'first_published')) ?? instant(fieldOf(job, 'updated_at')),
        country: null,
        // The board's own page works for every Greenhouse job, embedded on a careers site or not.
        applyLink: ref.link,
        text: textOf(job),
        questions: greenhouseQuestions(job),
        salary: details.salary ?? salaryInText(textOf(job)),
      };
    }
    case 'lever': {
      const host = new URL(ref.link).hostname.includes('.eu.') ? 'api.eu.lever.co' : 'api.lever.co';
      const posting = await readJson(
        fetchPage,
        `https://${host}/v0/postings/${ref.board}/${ref.jobId}`,
      );
      const details = fromLever(posting);
      if (!details.role) throw new JobReadError('lever: no such job', true);
      const apply = fieldOf(posting, 'applyUrl');
      return {
        company: companyFromSlug(ref.board),
        role: details.role,
        location: details.location,
        workMode: details.workMode,
        postedAt: instant(fieldOf(posting, 'createdAt')),
        country: stringOf(fieldOf(posting, 'country')),
        applyLink:
          typeof apply === 'string' && apply.startsWith('https://') ? apply : `${ref.link}/apply`,
        text: textOf(posting),
        questions: null,
        salary: details.salary ?? salaryInText(textOf(posting)),
      };
    }
    case 'ashby': {
      // Ashby has no public API for one job: the board's list has every field.
      const board = await readJson(
        fetchBoard,
        `https://api.ashbyhq.com/posting-api/job-board/${ref.board}?includeCompensation=true`,
      );
      const job = asArray(fieldOf(board, 'jobs')).find(
        (entry) => String(fieldOf(entry, 'id')).toLowerCase() === ref.jobId,
      );
      const details = job ? fromAshby(job) : null;
      if (!job || !details?.role) throw new JobReadError('ashby: no such job', true);
      const apply = fieldOf(job, 'applyUrl');
      return {
        company: companyFromSlug(ref.board),
        role: details.role,
        location: details.location,
        workMode: details.workMode,
        postedAt: instant(fieldOf(job, 'publishedAt')),
        country: stringOf(
          fieldOf(fieldOf(fieldOf(job, 'address'), 'postalAddress'), 'addressCountry'),
        ),
        applyLink:
          typeof apply === 'string' && apply.startsWith('https://')
            ? apply
            : `${ref.link}/application`,
        text: textOf(job),
        questions: null,
        salary: details.salary ?? salaryInText(textOf(job)),
      };
    }
    case 'workable':
      return readWorkable(ref, fetchBoard);
    case 'jobvite':
      return readJobvite(ref, fetchPage);
    default:
      // Workday, Rippling, SmartRecruiters, Breezy, Recruitee, Teamtailor, Personio, iCIMS, Taleo
      // and SuccessFactors: read through "Fill from link" (each board's API, else the page's
      // JobPosting data). These give the day a job was posted, not the time.
      return readThroughPosting(ref, fetchPage);
  }
}

const stringOf = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

const dayStart = (day: string | null) => (day ? new Date(`${day}T00:00:00Z`) : null);

async function readThroughPosting(ref: JobRef, fetchPage: PageFetcher): Promise<JobDetails> {
  let details;
  try {
    details = await readPosting(ref.link, fetchPage);
  } catch (error) {
    throw readFailure(error);
  }
  if (!details.role) throw new JobReadError(`${ref.source}: no title`);
  // The text is a second read; a job is still usable without it.
  const text =
    ref.source === 'workday' ? '' : await readPostingText(ref.link, fetchPage).catch(() => '');
  return {
    company: details.company ?? companyFromSlug(ref.board),
    role: details.role,
    location: details.location,
    workMode: details.workMode,
    postedAt: dayStart(details.postedOn),
    postedDayOnly: true,
    country: null,
    applyLink: ref.link,
    text,
    questions: null,
    salary: details.salary ?? (text ? salaryInText(text) : null),
  };
}

/**
 * Workable: the account's public job list has every field but the description. Workable limits
 * how often it may be read, so a refusal is common: the job then falls back to the search result.
 */
async function readWorkable(ref: JobRef, fetchBoard: PageFetcher): Promise<JobDetails> {
  const board = await readJson(
    fetchBoard,
    `https://apply.workable.com/api/v1/widget/accounts/${ref.board}`,
  );
  const job = asArray(fieldOf(board, 'jobs')).find(
    (entry) => String(fieldOf(entry, 'shortcode')).toUpperCase() === ref.jobId,
  );
  const details = job ? fromWorkable(board, job) : null;
  if (!job || !details?.role) throw new JobReadError('workable: no such job', true);
  const apply = fieldOf(job, 'application_url');
  return {
    company: details.company ?? companyFromSlug(ref.board),
    role: details.role,
    location: details.location,
    workMode: details.workMode,
    postedAt: instant(fieldOf(job, 'published_on')) ?? instant(fieldOf(job, 'created_at')),
    country: stringOf(fieldOf(job, 'country')),
    applyLink:
      typeof apply === 'string' && apply.startsWith('https://') ? apply : `${ref.link}apply/`,
    text: '',
    questions: null,
    salary: null,
  };
}

/** Jobvite: the page itself (see fromJobvite). It gives no date. */
export async function readJobvite(ref: JobRef, fetchPage: PageFetcher): Promise<JobDetails> {
  let html: string;
  try {
    html = (await fetchPage(ref.link)).text;
  } catch (error) {
    if (error instanceof FetchError) throw readFailure(error);
    throw error;
  }
  const details = fromJobvite(html);
  // A closed Jobvite job lands on the company's job list, which has no job title.
  if (!details.role) throw new JobReadError('jobvite: no title', true);
  return {
    company: details.company ?? companyFromSlug(ref.board),
    role: details.role,
    location: details.location,
    workMode: details.workMode,
    postedAt: null,
    country: null,
    applyLink: `${ref.link}/apply`,
    text: cleanText(jobviteDescription(html), POSTING_TEXT_MAX) ?? '',
    questions: null,
    salary: details.salary,
  };
}
