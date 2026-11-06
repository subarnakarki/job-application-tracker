import { LIMITS, type PostingPreview } from '@jat/shared';
import { FetchError, type PageFetcher } from './fetchPage';

/**
 * "Fill from link": the details of a job posting, from
 *  - the schema.org `JobPosting` data most career sites embed (JSON-LD), and
 *  - the public posting APIs of Greenhouse (whose pages carry no JobPosting data), Lever and Ashby
 *    (whose pages do, but without the salary).
 * Nothing is stored. Only empty form fields are filled, on the client.
 */

export type PreviewFailure = 'unsupported_site' | 'unreadable' | 'no_posting_data';

export class PreviewError extends Error {
  constructor(
    readonly code: PreviewFailure,
    detail: string,
  ) {
    super(detail);
    this.name = 'PreviewError';
  }
}

/** Sites that need a sign-in to show a posting, so a server cannot read them. */
const SIGN_IN_SITES =
  /(^|\.)(linkedin\.com|indeed\.com|glassdoor\.com|ziprecruiter\.com|wellfound\.com)$/i;

interface Details {
  company: string | null;
  role: string | null;
  salary: { min: number; max: number; currency: string } | null;
}

const EMPTY: Details = { company: null, role: null, salary: null };

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** Plain one-line text: entities decoded, tags and control characters removed, length capped. */
export function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
      if (entity[0] === '#') {
        const code =
          entity[1]?.toLowerCase() === 'x'
            ? parseInt(entity.slice(2), 16)
            : Number(entity.slice(1));
        return Number.isFinite(code) && code > 0 && code < 0x110000
          ? String.fromCodePoint(code)
          : ' ';
      }
      return ENTITIES[entity.toLowerCase()] ?? match;
    })
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text ? text.slice(0, max).trim() : null;
}

function amount(value: unknown): number | null {
  const number = typeof value === 'string' ? Number(value.replace(/[,\s]/g, '')) : value;
  if (typeof number !== 'number' || !Number.isFinite(number)) return null;
  const rounded = Math.round(number);
  return rounded >= 0 && rounded <= LIMITS.salaryMax ? rounded : null;
}

/** A yearly range only: hourly or monthly figures would be misleading in a salary field. */
function salaryRange(min: unknown, max: unknown, currency: unknown): Details['salary'] {
  const low = amount(min ?? max);
  const high = amount(max ?? min);
  const code = typeof currency === 'string' ? currency.trim().toUpperCase() : '';
  if (low === null || high === null || high < low || !/^[A-Z]{3}$/.test(code)) return null;
  return { min: low, max: high, currency: code };
}

/** Every JSON-LD object on the page, including those inside arrays and `@graph`. */
function jsonLdObjects(html: string): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  const visit = (value: unknown, depth: number) => {
    if (depth > 5 || value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) return value.forEach((entry) => visit(entry, depth + 1));
    const record = value as Record<string, unknown>;
    found.push(record);
    if (record['@graph']) visit(record['@graph'], depth + 1);
  };
  for (const match of html.matchAll(
    /<script[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    try {
      visit(JSON.parse(match[1] ?? ''), 0);
    } catch {
      // A broken block is skipped; others may still be fine.
    }
  }
  return found;
}

/** One property of a JSON value, if it is an object. */
function fieldOf(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

const isJobPosting = (record: Record<string, unknown>) => {
  const type = record['@type'];
  return type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'));
};

export function fromJobPosting(html: string): Details | null {
  const posting = jsonLdObjects(html).find(isJobPosting);
  if (!posting) return null;
  const organization = posting['hiringOrganization'];
  const company =
    typeof organization === 'string'
      ? cleanText(organization, LIMITS.company)
      : cleanText(fieldOf(organization, 'name'), LIMITS.company);

  let salary: Details['salary'] = null;
  const base = posting['baseSalary'] as Record<string, unknown> | undefined;
  if (base && typeof base === 'object') {
    const value = base['value'];
    if (value && typeof value === 'object') {
      const quantity = value as Record<string, unknown>;
      const unitText = quantity['unitText'];
      const unit = typeof unitText === 'string' ? unitText.toUpperCase() : 'YEAR';
      if (unit === 'YEAR')
        salary = salaryRange(
          quantity['minValue'] ?? quantity['value'],
          quantity['maxValue'] ?? quantity['value'],
          base['currency'],
        );
    } else {
      salary = salaryRange(value, value, base['currency']);
    }
  }
  return { company, role: cleanText(posting['title'], LIMITS.role), salary };
}

type Site =
  | { kind: 'greenhouse'; api: string }
  | { kind: 'lever'; api: string; id: string }
  | { kind: 'ashby'; api: string; id: string }
  | { kind: 'page' };

/** Links whose site has a public posting API, and where it is. Ids are validated before use. */
export function siteOf(url: URL): Site {
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split('/').filter(Boolean);
  const slug = /^[A-Za-z0-9_.-]{1,100}$/;
  if (/^(boards|job-boards)(\.eu)?\.greenhouse\.io$/.test(host) && parts[1] === 'jobs') {
    const [board, , id] = parts;
    if (board && id && slug.test(board) && /^\d{1,20}$/.test(id))
      return {
        kind: 'greenhouse',
        api: `https://boards-api.greenhouse.io/v1/boards/${board}/jobs/${id}`,
      };
  }
  const uuid = /^[0-9a-f-]{36}$/i;
  if (/^jobs(\.eu)?\.lever\.co$/.test(host)) {
    const [company, id] = parts;
    if (company && id && slug.test(company) && uuid.test(id))
      return {
        kind: 'lever',
        api: `https://api${host.includes('.eu.') ? '.eu' : ''}.lever.co/v0/postings/${company}/${id}`,
        id,
      };
  }
  if (host === 'jobs.ashbyhq.com') {
    const [org, id] = parts;
    if (org && id && slug.test(org) && uuid.test(id))
      return {
        kind: 'ashby',
        api: `https://api.ashbyhq.com/posting-api/job-board/${org}?includeCompensation=true`,
        id,
      };
  }
  return { kind: 'page' };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function fromGreenhouse(json: unknown): Details {
  const job = (json ?? {}) as Record<string, unknown>;
  return {
    company: cleanText(job['company_name'], LIMITS.company),
    role: cleanText(job['title'], LIMITS.role),
    salary: null,
  };
}

function leverSalary(json: unknown): Details['salary'] {
  const range = (json as { salaryRange?: Record<string, unknown> } | null)?.salaryRange;
  if (!range || range['interval'] !== 'per-year-salary') return null;
  return salaryRange(range['min'], range['max'], range['currency']);
}

/** Only when the posting names exactly one yearly salary; several tiers (regions) are not guessed between. */
function ashbySalary(json: unknown, id: string): Details['salary'] {
  const jobs = (json as { jobs?: Record<string, unknown>[] } | null)?.jobs ?? [];
  const job = jobs.find((entry) => entry['id'] === id);
  const tiers = ((job?.['compensation'] as Record<string, unknown> | undefined)?.[
    'compensationTiers'
  ] ?? []) as { components?: Record<string, unknown>[] }[];
  const salaries = tiers
    .flatMap((tier) => tier.components ?? [])
    .filter(
      (component) =>
        component['compensationType'] === 'Salary' && component['interval'] === '1 YEAR',
    )
    .map((component) =>
      salaryRange(component['minValue'], component['maxValue'], component['currencyCode']),
    )
    .filter((salary) => salary !== null);
  const distinct = new Set(
    salaries.map((salary) => `${salary.min}-${salary.max}-${salary.currency}`),
  );
  return distinct.size === 1 ? (salaries[0] ?? null) : null;
}

function merge(primary: Details | null, extra: Partial<Details>): Details {
  const base = primary ?? EMPTY;
  return {
    company: base.company ?? extra.company ?? null,
    role: base.role ?? extra.role ?? null,
    salary: base.salary ?? extra.salary ?? null,
  };
}

/** Normalised: no fragment, so the saved job link is the posting itself. */
function jobLinkOf(url: URL): string {
  const copy = new URL(url.toString());
  copy.hash = '';
  return copy.toString().slice(0, LIMITS.jobLink);
}

export async function previewPosting(raw: string, fetchPage: PageFetcher): Promise<PostingPreview> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PreviewError('unreadable', 'not a URL');
  }
  if (SIGN_IN_SITES.test(url.hostname)) throw new PreviewError('unsupported_site', url.hostname);

  const read = async (target: string) => {
    try {
      return (await fetchPage(target)).text;
    } catch (error) {
      if (error instanceof FetchError)
        throw new PreviewError('unreadable', `${error.code}: ${error.message}`);
      throw error;
    }
  };
  /** A failing API call only costs the salary; the page itself is what matters. */
  const tryRead = (target: string) => read(target).catch(() => '');

  const site = siteOf(url);
  let details: Details;
  if (site.kind === 'greenhouse') {
    details = fromGreenhouse(parseJson(await read(site.api)));
  } else if (site.kind === 'lever' || site.kind === 'ashby') {
    const [page, api] = await Promise.all([read(url.toString()), tryRead(site.api)]);
    const salary =
      site.kind === 'lever' ? leverSalary(parseJson(api)) : ashbySalary(parseJson(api), site.id);
    details = merge(fromJobPosting(page), { salary });
  } else {
    details = fromJobPosting(await read(url.toString())) ?? EMPTY;
  }

  if (!details.company && !details.role && !details.salary)
    throw new PreviewError('no_posting_data', url.hostname);
  return {
    jobLink: jobLinkOf(url),
    company: details.company,
    role: details.role,
    salaryMin: details.salary?.min ?? null,
    salaryMax: details.salary?.max ?? null,
    salaryCurrency: details.salary?.currency ?? null,
  };
}
