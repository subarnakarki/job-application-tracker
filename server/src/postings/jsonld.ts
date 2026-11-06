import { LIMITS } from '@jat/shared';
import {
  asArray,
  cleanText,
  dayOf,
  fieldOf,
  locationOf,
  salaryRange,
  workModeOf,
  type Details,
} from './details';

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

const isJobPosting = (record: Record<string, unknown>) => {
  const type = record['@type'];
  return type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'));
};

/** "Boston, MA, US" from a schema.org Place (or a plain string). */
function placeName(place: unknown): string | null {
  if (typeof place === 'string') return place;
  const address = fieldOf(place, 'address') ?? place;
  if (typeof address === 'string') return address;
  const country = fieldOf(address, 'addressCountry');
  const parts = [
    fieldOf(address, 'addressLocality'),
    fieldOf(address, 'addressRegion'),
    typeof country === 'string' ? country : fieldOf(country, 'name'),
  ].filter((part): part is string => typeof part === 'string' && part.trim() !== '');
  return parts.length ? [...new Set(parts.map((part) => part.trim()))].join(', ') : null;
}

function salaryOf(posting: Record<string, unknown>): Details['salary'] {
  const base = posting['baseSalary'];
  if (!base || typeof base !== 'object') return null;
  const value = fieldOf(base, 'value');
  const currency = fieldOf(base, 'currency');
  if (value && typeof value === 'object') {
    const unitText = fieldOf(value, 'unitText');
    const unit = typeof unitText === 'string' ? unitText.toUpperCase() : 'YEAR';
    if (unit !== 'YEAR') return null;
    return salaryRange(
      fieldOf(value, 'minValue') ?? fieldOf(value, 'value'),
      fieldOf(value, 'maxValue') ?? fieldOf(value, 'value'),
      currency,
    );
  }
  return salaryRange(value, value, currency);
}

/** The details of one schema.org JobPosting object. */
export function fromJobPostingObject(posting: Record<string, unknown>): Details {
  const organization = posting['hiringOrganization'];
  const company =
    typeof organization === 'string'
      ? cleanText(organization, LIMITS.company)
      : cleanText(fieldOf(organization, 'name'), LIMITS.company);
  const remote = asArray(posting['jobLocationType']).some((type) => workModeOf(type) === 'Remote');
  const places = asArray(posting['jobLocation']).map(placeName);
  return {
    company,
    role: cleanText(posting['title'], LIMITS.role),
    salary: salaryOf(posting),
    location: locationOf(places),
    workMode: remote ? 'Remote' : null,
    postedOn: dayOf(posting['datePosted']),
  };
}

/** The first JobPosting on a page, or null when there is none. */
export function fromJobPosting(html: string): Details | null {
  const posting = jsonLdObjects(html).find(isJobPosting);
  return posting ? fromJobPostingObject(posting) : null;
}
