/**
 * Calendar-date helpers. A "date" here is a plain `YYYY-MM-DD` string with no
 * time and no zone, which is how `dateApplied` and `nextStepDate` are stored.
 */

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;
/** IANA-name shape. Rejects offset strings such as "+05:00", which Postgres reads with flipped signs. */
const TIME_ZONE_PATTERN = /^[A-Za-z][A-Za-z_]*(\/[A-Za-z0-9_+-]+)*$/;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    // Throws RangeError for a zone the runtime does not know.
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

export function isValidTimeZone(timeZone: string): boolean {
  if (!TIME_ZONE_PATTERN.test(timeZone)) return false;
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** The calendar date it is, at `instant`, in `timeZone`. */
export function localDateIn(instant: Date | string, timeZone: string): string {
  const date = typeof instant === 'string' ? new Date(instant) : instant;
  if (Number.isNaN(date.getTime())) {
    throw new RangeError('Invalid instant');
  }
  const parts = formatterFor(timeZone).formatToParts(date);
  const part = (type: 'year' | 'month' | 'day'): string => {
    const value = parts.find((entry) => entry.type === type)?.value;
    if (value === undefined) throw new RangeError(`Missing ${type} for ${timeZone}`);
    return value;
  };
  return `${part('year').padStart(4, '0')}-${part('month')}-${part('day')}`;
}

/** Days since 1970-01-01 for a real calendar date; throws on anything else (e.g. 2026-02-30). */
export function dayNumber(date: string): number {
  const match = DATE_PATTERN.exec(date);
  if (!match) throw new RangeError(`Invalid date: ${date}`);
  const [, year, month, day] = match;
  const ms = Date.UTC(Number(year), Number(month) - 1, Number(day));
  const roundTrip = new Date(ms).toISOString().slice(0, 10);
  if (Number(year) < 1000 || roundTrip !== date) {
    throw new RangeError(`Invalid date: ${date}`);
  }
  return ms / MS_PER_DAY;
}

export function isValidDate(date: string): boolean {
  try {
    dayNumber(date);
    return true;
  } catch {
    return false;
  }
}

export function addDays(date: string, days: number): string {
  return new Date((dayNumber(date) + days) * MS_PER_DAY).toISOString().slice(0, 10);
}

/** Whole calendar days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  return dayNumber(to) - dayNumber(from);
}
