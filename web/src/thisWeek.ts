import { addDays, type Application } from '@jat/shared';

export interface WeekItem {
  key: string;
  applicationId: string;
  /** The calendar day (YYYY-MM-DD). */
  day: string;
  kind: 'interview' | 'next-step';
  /** "Interview", or what the next step is. */
  title: string;
  company: string;
}

export const WEEK_DAYS = 7;

/**
 * What is coming up in the next 7 days (today and the 6 days after it), for open applications:
 * interviews and next-step dates, soonest first. `today` is the user's own date, so the window
 * does not move with the browser's time zone.
 */
export function upcoming(applications: readonly Application[], today: string): WeekItem[] {
  const last = addDays(today, WEEK_DAYS - 1);
  const inWindow = (day: string | null): day is string =>
    day !== null && day >= today && day <= last;
  const items: WeekItem[] = [];
  for (const application of applications) {
    if (application.isClosed) continue;
    if (inWindow(application.nextInterviewOn)) {
      items.push({
        key: `${application.id}-interview`,
        applicationId: application.id,
        day: application.nextInterviewOn,
        kind: 'interview',
        title: 'Interview',
        company: application.company,
      });
    }
    if (inWindow(application.nextStepDate)) {
      items.push({
        key: `${application.id}-next-step`,
        applicationId: application.id,
        day: application.nextStepDate,
        kind: 'next-step',
        title: application.nextStep?.trim() || 'Next step',
        company: application.company,
      });
    }
  }
  return items.sort(
    (a, b) =>
      a.day.localeCompare(b.day) ||
      a.kind.localeCompare(b.kind) ||
      a.company.localeCompare(b.company),
  );
}

/** The window as a label, "Nov 6 to 12" (or "Nov 28 to Dec 4"). */
export function windowLabel(today: string): string {
  const month = new Intl.DateTimeFormat(undefined, { month: 'short', timeZone: 'UTC' });
  const at = (day: string) => new Date(`${day}T00:00:00Z`);
  const from = at(today);
  const to = at(addDays(today, WEEK_DAYS - 1));
  const sameMonth = from.getUTCMonth() === to.getUTCMonth();
  return `${month.format(from)} ${from.getUTCDate()} to ${sameMonth ? '' : `${month.format(to)} `}${to.getUTCDate()}`;
}

const WEEKDAY = new Intl.DateTimeFormat(undefined, { weekday: 'short', timeZone: 'UTC' });

/** "Wed" for a calendar day. */
export function weekdayOf(day: string): string {
  return WEEKDAY.format(new Date(`${day}T00:00:00Z`));
}

/** The day of the month, "12". */
export function dayOfMonth(day: string): string {
  return String(Number(day.slice(8, 10)));
}
