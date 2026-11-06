import { BOARD_SOURCES, BOARDS, type BoardJob, type BoardSource } from './boards';
import { locationOf, merge, type Details } from './details';
import type { PageFetcher } from './fetchPage';

/** A posting found on the company's public job board that is probably the one applied for. */
export interface BoardMatch {
  source: BoardSource;
  jobLink: string;
  details: Details;
}

export interface LookupQuery {
  company: string;
  role: string;
  /** The email's From address: its domain is a good guess at the company's board name. */
  senderEmail?: string | null;
}

/** Domains that say nothing about the hiring company: job boards, ATS mailers and mail providers. */
const NOT_A_COMPANY = new Set([
  'greenhouse',
  'greenhouse-mail',
  'lever',
  'hire',
  'ashbyhq',
  'rippling',
  'smartrecruiters',
  'breezy',
  'recruitee',
  'teamtailor',
  'personio',
  'workday',
  'myworkday',
  'myworkdayjobs',
  'workable',
  'workablemail',
  'icims',
  'jobvite',
  'linkedin',
  'indeed',
  'glassdoor',
  'ziprecruiter',
  'wellfound',
  'gmail',
  'googlemail',
  'outlook',
  'hotmail',
  'yahoo',
  'icloud',
  'mail',
  'email',
  'notifications',
]);

/** Words a board name leaves out: "Acme Labs Inc." is usually just "acme" or "acmelabs". */
const LEGAL = /\b(inc|llc|ltd|limited|gmbh|ag|sa|bv|plc|corp|corporation|co|company)\b\.?/g;

/** Up to three likely board names: the company squashed, hyphenated, and the sender's domain. */
export function slugsFor(company: string, senderEmail?: string | null): string[] {
  const words = company
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(LEGAL, ' ')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const slugs = [words.join(''), words.join('-')];
  const domain = /@([a-z0-9.-]+)$/i.exec(senderEmail?.trim() ?? '')?.[1]?.toLowerCase();
  if (domain) {
    // The label before the public suffix: jobs.acme.co.uk -> acme, acme.com -> acme.
    const labels = domain.split('.').filter(Boolean);
    const suffix = labels.length > 2 && /^(co|com|org|net|ac)$/.test(labels.at(-2) ?? '') ? 2 : 1;
    const label = labels.at(-1 - suffix);
    if (label && !NOT_A_COMPANY.has(label)) slugs.push(label);
  }
  return [...new Set(slugs.filter((slug) => /^[a-z0-9][a-z0-9-]{1,62}$/.test(slug)))].slice(0, 3);
}

/** Gender tags such as (m/w/d), filler words and punctuation do not make two titles different. */
const FILLER = new Set(['the', 'a', 'an', 'of', 'and', 'for', 'm', 'w', 'd', 'f', 'x', 'h']);

function words(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/&/g, ' and ')
    .split(/[^a-z0-9+#]+/)
    .filter((word) => word && !FILLER.has(word));
}

/** 1 for the same title; otherwise the share of words they have in common (Jaccard). */
export function titleScore(a: string, b: string): number {
  const left = new Set(words(a));
  const right = new Set(words(b));
  if (left.size === 0 || right.size === 0) return 0;
  const shared = [...left].filter((word) => right.has(word)).length;
  return shared / (left.size + right.size - shared);
}

/** Below this, two titles are different jobs. */
export const MATCH_THRESHOLD = 0.8;

const squash = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, '');

/** A board that names its company must name this one. */
function boardIsTheCompany(jobs: BoardJob[], company: string): boolean {
  const named = jobs.map((job) => job.company).filter((name): name is string => Boolean(name));
  if (named.length === 0) return true;
  const wanted = squash(company.replace(LEGAL, ' '));
  return named.some((name) => {
    const have = squash(name.replace(LEGAL, ' '));
    return have.length > 0 && (have.includes(wanted) || wanted.includes(have));
  });
}

async function readList(
  fetchPage: PageFetcher,
  source: BoardSource,
  slug: string,
): Promise<BoardJob[]> {
  const url = BOARDS[source].listUrl(slug);
  if (!url) return [];
  try {
    return BOARDS[source].parseList((await fetchPage(url)).text, slug);
  } catch {
    // No such board, or it could not be read: simply not this one.
    return [];
  }
}

/**
 * Looks for the posting on the company's public job boards. Returns a match only when one title
 * clearly is the role (several open jobs with that same title, one per city, count as one), on a
 * board that is this company's. Never throws: a failed lookup is no match.
 */
export async function findOnBoards(
  query: LookupQuery,
  fetchPage: PageFetcher,
): Promise<BoardMatch | null> {
  const role = query.role.trim();
  if (!role || !query.company.trim()) return null;
  const slugs = slugsFor(query.company, query.senderEmail);
  const lists = await Promise.all(
    BOARD_SOURCES.flatMap((source) => slugs.map((slug) => readList(fetchPage, source, slug))),
  );
  const jobs = lists.filter((list) => boardIsTheCompany(list, query.company)).flat();

  let best = 0;
  for (const job of jobs) best = Math.max(best, titleScore(job.title, role));
  if (best < MATCH_THRESHOLD) return null;
  const top = jobs.filter((job) => titleScore(job.title, role) === best);
  if (new Set(top.map((job) => words(job.title).join(' '))).size > 1) return null;

  const [first] = top;
  if (!first) return null;
  let details = first.details;
  if (top.length > 1) {
    // The same job in several places: list the places, not just the first one.
    details = { ...details, location: locationOf(top.map((job) => job.details.location)) };
  }
  if (first.more) {
    try {
      details = merge(first.more.parse((await fetchPage(first.more.url)).text), details);
      if (top.length > 1)
        details = { ...details, location: locationOf(top.map((job) => job.details.location)) };
    } catch {
      // The extra details are a bonus; the match stands without them.
    }
  }
  return { source: first.source, jobLink: first.link, details };
}
