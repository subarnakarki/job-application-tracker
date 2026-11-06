/**
 * One way to show dates everywhere: "Nov 5, 2026", plus the time for events.
 * The locale is the browser's; only the shape is fixed.
 */

const DAY = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});

const WEEKDAY_DAY = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});

const WEEKDAY_DAY_YEAR = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});

const MOMENT = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

/**
 * A calendar date (`2026-11-05`). Read and shown in UTC, so it is the same day for everyone:
 * parsing it as local time would move it to the 4th west of UTC.
 */
export function formatDate(calendarDate: string): string {
  const [year, month, day] = calendarDate.split('-').map(Number);
  if (!year || !month || !day) return calendarDate;
  return DAY.format(new Date(Date.UTC(year, month - 1, day)));
}

/**
 * A calendar date with its weekday, "Wed, Nov 12". The year is added only when it is not
 * `currentYear` (this year, by default), so "Mon, Jan 4, 2027" is never mistaken for this year.
 */
export function formatWeekdayDate(
  calendarDate: string,
  currentYear: number = new Date().getFullYear(),
): string {
  const [year, month, day] = calendarDate.split('-').map(Number);
  if (!year || !month || !day) return calendarDate;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (year === currentYear ? WEEKDAY_DAY : WEEKDAY_DAY_YEAR).format(date);
}

const MONTH_SHORT = new Intl.DateTimeFormat(undefined, { month: 'short', timeZone: 'UTC' });

/** The short month of a calendar date, "Nov". */
export function formatMonthShort(calendarDate: string): string {
  const date = new Date(`${calendarDate}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? '' : MONTH_SHORT.format(date);
}

/** An instant (an ISO timestamp), in the viewer's own time zone, with the time. */
export function formatDateTime(instant: string): string {
  const date = new Date(instant);
  return Number.isNaN(date.getTime()) ? instant : MOMENT.format(date);
}

/** The day of an instant, in the viewer's own time zone. */
export function formatDay(instant: string): string {
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) return instant;
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(date);
}
