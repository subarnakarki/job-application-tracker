import { siteOf } from './boards';
import { cleanText, parseJson } from './details';
import { FetchError, type PageFetcher } from './fetchPage';
import { isSignInSite, PreviewError } from './preview';

/**
 * The words of a job posting (its description, requirements and so on) as plain text, for matching
 * a resume against it. Read through the same guarded fetcher and site rules as "Fill from link".
 * Nothing is stored.
 */

/** Plenty for any posting; also caps what is sent to the model. */
export const POSTING_TEXT_MAX = 20_000;
/** Less than this is a page with no real posting on it. */
const MIN_TEXT = 200;

/** Fields that hold a posting's prose in the job boards' APIs (Greenhouse, Lever, Ashby, Workday). */
const TEXT_KEYS = new Set([
  'content',
  'description',
  'descriptionPlain',
  'descriptionHtml',
  'jobDescription',
  'additional',
  'additionalPlain',
  'qualifications',
  'responsibilities',
]);

/** Plain text from HTML, or from HTML that was itself escaped (Greenhouse's `content`). */
function plain(value: string): string {
  return cleanText(cleanText(value, POSTING_TEXT_MAX * 4) ?? '', POSTING_TEXT_MAX * 4) ?? '';
}

/** One job in a list of jobs: a whole board's list must never pass for one posting's text. */
const looksLikeJob = (value: unknown): boolean =>
  typeof value === 'object' &&
  value !== null &&
  'id' in value &&
  ('title' in value || 'name' in value);

/** Every prose field in a JSON answer, skipping lists of other jobs. */
export function proseInJson(value: unknown, depth = 0): string[] {
  if (depth > 6 || value === null || typeof value !== 'object') return [];
  if (Array.isArray(value)) {
    if (value.filter(looksLikeJob).length > 1) return [];
    return value.flatMap((item) => proseInJson(item, depth + 1));
  }
  return Object.entries(value).flatMap(([key, item]) =>
    typeof item === 'string' && TEXT_KEYS.has(key) ? [plain(item)] : proseInJson(item, depth + 1),
  );
}

const JSON_LD = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

/** The description of a schema.org JobPosting on the page, if any. */
export function jobPostingDescription(html: string): string | null {
  for (const match of html.matchAll(JSON_LD)) {
    const data: unknown = parseJson(match[1] ?? '');
    const top: unknown[] = Array.isArray(data) ? [data, ...(data as unknown[])] : [data];
    const candidates = top.flatMap((item): unknown[] => {
      const graph: unknown =
        item && typeof item === 'object' ? (item as Record<string, unknown>)['@graph'] : undefined;
      return Array.isArray(graph) ? (graph as unknown[]) : [item];
    });
    for (const item of candidates) {
      if (!item || typeof item !== 'object') continue;
      const record = item as Record<string, unknown>;
      const type = record['@type'];
      const isPosting = Array.isArray(type) ? type.includes('JobPosting') : type === 'JobPosting';
      if (isPosting && typeof record['description'] === 'string')
        return plain(record['description']);
    }
  }
  return null;
}

/** What a reader sees on a page: scripts, styles and tags removed. The last resort. */
export function visibleText(html: string): string {
  return plain(
    html
      .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<(nav|header|footer)\b[\s\S]*?<\/\1>/gi, ' '),
  );
}

/** The posting's text from one response body, best source first. */
export function textOfBody(body: string): string {
  const json = parseJson(body);
  if (json !== null && typeof json === 'object') return proseInJson(json).join('\n');
  return jobPostingDescription(body) ?? visibleText(body);
}

/** Reads a posting link's text. Throws PreviewError when it cannot be read or has no posting. */
export async function readPostingText(raw: string, fetchPage: PageFetcher): Promise<string> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PreviewError('unreadable', 'not a URL');
  }
  if (isSignInSite(url)) throw new PreviewError('unsupported_site', url.hostname);

  const site = siteOf(url);
  const page = url.toString();
  // A board's API first, then the posting's own page. Some boards' reads are the company's whole
  // job list (Breezy, Recruitee), whose text proseInJson drops, so the page is what has it.
  // Workable's list is never read: it holds the company's description, not the posting's.
  const targets =
    site.kind === 'page' || site.kind === 'workable'
      ? [page]
      : [...new Set([...site.reads.map((read) => read.url), page])];
  const texts: string[] = [];
  for (const target of targets) {
    try {
      const text = textOfBody((await fetchPage(target)).text).trim();
      // The first source with a real posting is enough; later ones would repeat it.
      if (text.length >= MIN_TEXT) {
        texts.push(text);
        break;
      }
    } catch (error) {
      if (!(error instanceof FetchError)) throw error;
    }
  }
  const text = texts.join('\n').slice(0, POSTING_TEXT_MAX).trim();
  if (text.length < MIN_TEXT) throw new PreviewError('no_posting_data', url.hostname);
  return text;
}
