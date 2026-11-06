import { isValidDate, LIMITS, type WorkMode } from '@jat/shared';

/**
 * What a job posting says, as far as this app keeps it. Every part may be missing. Read from
 * schema.org JSON-LD on a page or from a job board's public API; filled into empty fields only.
 */
export interface Details {
  company: string | null;
  role: string | null;
  salary: { min: number; max: number; currency: string } | null;
  location: string | null;
  workMode: WorkMode | null;
  /** YYYY-MM-DD. */
  postedOn: string | null;
}

export const EMPTY: Details = {
  company: null,
  role: null,
  salary: null,
  location: null,
  workMode: null,
  postedOn: null,
};

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
export function salaryRange(min: unknown, max: unknown, currency: unknown): Details['salary'] {
  const low = amount(min ?? max);
  const high = amount(max ?? min);
  const code = typeof currency === 'string' ? currency.trim().toUpperCase() : '';
  if (low === null || high === null || high < low || !/^[A-Z]{3}$/.test(code)) return null;
  return { min: low, max: high, currency: code };
}

/** One salary only when every range given is the same; several (by region or level) are not guessed between. */
export function onlySalary(salaries: Details['salary'][]): Details['salary'] {
  const found = salaries.filter((salary) => salary !== null);
  const distinct = new Set(found.map((salary) => `${salary.min}-${salary.max}-${salary.currency}`));
  return distinct.size === 1 ? (found[0] ?? null) : null;
}

const SYMBOLS: Record<string, string> = { $: 'USD', '€': 'EUR', '£': 'GBP' };
const RANGE =
  /([$€£])\s?(\d{1,3}(?:,\d{3})+|\d{4,7})(?:\.\d{1,2})?\s*(?:-|–|—|to)\s*\1?\s?(\d{1,3}(?:,\d{3})+|\d{4,7})(?:\.\d{1,2})?/g;

/**
 * A yearly salary written in a posting's text ("Salary Range: $139,800.00 - $223,700.00"). The
 * range labelled as the salary or pay range wins; otherwise only one that every range agrees on
 * (ranges by state or level are not guessed between). Figures under 10,000 are not yearly.
 */
export function salaryInText(html: string): Details['salary'] {
  const plain = html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#x?[0-9a-f]+;|&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ');
  const yearly = (match: RegExpMatchArray): Details['salary'] => {
    const range = salaryRange(match[2], match[3], SYMBOLS[match[1] ?? '']);
    return range && range.min >= 10_000 ? range : null;
  };
  const labelled = /\b(?:salary|pay|compensation) range\b[^$€£]{0,60}/i.exec(plain);
  if (labelled) {
    const first = [...plain.slice(labelled.index).matchAll(RANGE)][0];
    if (first && first.index === labelled[0].length) return yearly(first);
  }
  return onlySalary([...plain.matchAll(RANGE)].map(yearly));
}

/**
 * A posting date as YYYY-MM-DD: an ISO date or timestamp keeps its own calendar day (no time zone
 * shift), "2026-01-02 14:22:42 UTC" too, and a number is milliseconds since 1970.
 */
export function dayOf(value: unknown): string | null {
  let day: string | null = null;
  if (typeof value === 'string') {
    day = /^\d{4}-\d{2}-\d{2}/.exec(value.trim())?.[0] ?? null;
  } else if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value);
    day = Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
  }
  return day && isValidDate(day) && day >= '2000-01-01' ? day : null;
}

/** "remote", "TELECOMMUTE", "Hybrid", "OnSite", "on-site", "In office"... as one of the three modes. */
export function workModeOf(value: unknown): WorkMode | null {
  if (typeof value !== 'string') return null;
  const key = value.toLowerCase().replace(/[^a-z]/g, '');
  if (key === 'remote' || key === 'telecommute' || key === 'fullyremote') return 'Remote';
  if (key === 'hybrid') return 'Hybrid';
  if (key === 'onsite' || key === 'inoffice' || key === 'office' || key === 'inperson')
    return 'On-site';
  return null;
}

/** Up to three distinct places, then "+N more", within the field's limit. */
export function locationOf(places: unknown[]): string | null {
  const names = [
    ...new Set(
      places
        .map((place) => cleanText(place, LIMITS.location))
        .filter((name): name is string => name !== null),
    ),
  ];
  if (names.length === 0) return null;
  const shown = names.slice(0, 3).join('; ');
  const more = names.length > 3 ? ` (+${names.length - 3} more)` : '';
  return cleanText(`${shown}${more}`, LIMITS.location);
}

/** One property of a JSON value, if it is an object. */
export function fieldOf(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

export const asArray = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The first non-empty value of each part, in order: what one source lacks, the next may have. */
export function merge(...parts: Partial<Details>[]): Details {
  const pick = <K extends keyof Details>(key: K): Details[K] =>
    parts.find((part) => part[key] !== undefined && part[key] !== null)?.[key] ?? null;
  return {
    company: pick('company'),
    role: pick('role'),
    salary: pick('salary'),
    location: pick('location'),
    workMode: pick('workMode'),
    postedOn: pick('postedOn'),
  };
}

export const isEmpty = (details: Details): boolean =>
  Object.values(details).every((value) => value === null);
