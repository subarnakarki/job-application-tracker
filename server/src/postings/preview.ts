import { LIMITS, type PostingPreview } from '@jat/shared';
import { siteOf } from './boards';
import { EMPTY, isEmpty, merge, type Details } from './details';
import { FetchError, type PageFetcher } from './fetchPage';
import { fromJobPosting } from './jsonld';

/**
 * "Fill from link": the details of a job posting, from
 *  - the schema.org `JobPosting` data most career sites embed (JSON-LD), and
 *  - the public APIs of the job boards in ./boards (Greenhouse, Rippling, SmartRecruiters, Breezy and
 *    Recruitee pages carry no usable JobPosting data; Lever and Ashby pages lack the salary).
 * Nothing is stored here. Only empty fields are filled, by the caller.
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

export { cleanText } from './details';
export { fromJobPosting } from './jsonld';
export { siteOf } from './boards';

/** Sites that need a sign-in to show a posting, so a server cannot read them. */
const SIGN_IN_SITES =
  /(^|\.)(linkedin\.com|indeed\.com|glassdoor\.com|ziprecruiter\.com|wellfound\.com|angel\.co)$/i;

export function isSignInSite(url: URL): boolean {
  return SIGN_IN_SITES.test(url.hostname);
}

/** Normalised: no fragment, so the saved job link is the posting itself. */
function jobLinkOf(url: URL): string {
  const copy = new URL(url.toString());
  copy.hash = '';
  return copy.toString().slice(0, LIMITS.jobLink);
}

export function toPreview(jobLink: string, details: Details): PostingPreview {
  return {
    jobLink,
    company: details.company,
    role: details.role,
    salaryMin: details.salary?.min ?? null,
    salaryMax: details.salary?.max ?? null,
    salaryCurrency: details.salary?.currency ?? null,
    location: details.location,
    workMode: details.workMode,
    postedOn: details.postedOn,
  };
}

/** What a posting link says. Throws PreviewError when it cannot be read or says nothing useful. */
export async function readPosting(
  raw: string,
  fetchPage: PageFetcher,
): Promise<Details & { jobLink: string }> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PreviewError('unreadable', 'not a URL');
  }
  if (isSignInSite(url)) throw new PreviewError('unsupported_site', url.hostname);

  const read = async (target: string) => {
    try {
      return (await fetchPage(target)).text;
    } catch (error) {
      if (error instanceof FetchError)
        throw new PreviewError('unreadable', `${error.code}: ${error.message}`);
      throw error;
    }
  };

  const site = siteOf(url);
  let details: Details;
  if (site.kind === 'page') {
    details = fromJobPosting(await read(url.toString())) ?? EMPTY;
  } else {
    // Optional reads only add (a salary, say): their failure is not the link's failure.
    const parts = await Promise.all(
      site.reads.map(async ({ url: target, required, parse }) => {
        const body = required ? await read(target) : await read(target).catch(() => '');
        return parse(body) ?? {};
      }),
    );
    details = merge(...parts);
  }

  if (isEmpty(details)) throw new PreviewError('no_posting_data', url.hostname);
  return { ...details, jobLink: jobLinkOf(url) };
}

export async function previewPosting(raw: string, fetchPage: PageFetcher): Promise<PostingPreview> {
  const { jobLink, ...details } = await readPosting(raw, fetchPage);
  return toPreview(jobLink, details);
}
