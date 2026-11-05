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
