export const STATUSES = [
  'Saved',
  'Applied',
  'Screening',
  'Interviewing',
  'Offer',
  'Rejected',
  'Withdrawn',
] as const;
export type Status = (typeof STATUSES)[number];

export const SOURCES = [
  'LinkedIn',
  'Indeed',
  'Referral',
  'Company site',
  'Recruiter',
  'Other',
] as const;
export type Source = (typeof SOURCES)[number];

/** "Closed" = Rejected or Withdrawn. */
export const CLOSED_STATUSES = ['Rejected', 'Withdrawn'] as const satisfies readonly Status[];

/** Only these statuses can need a follow-up. */
export const FOLLOW_UP_STATUSES = [
  'Applied',
  'Screening',
  'Interviewing',
] as const satisfies readonly Status[];

/**
 * Reaching any of these for the first time fills `dateApplied` (when empty).
 * Withdrawn is excluded: an application can be withdrawn before it was ever sent.
 */
export const DATE_APPLIED_STATUSES = [
  'Applied',
  'Screening',
  'Interviewing',
  'Offer',
  'Rejected',
] as const satisfies readonly Status[];

/** An application needs a follow-up after this many calendar days without activity. */
export const FOLLOW_UP_AFTER_DAYS = 7;

export const SORTS = ['updated_desc', 'applied_desc', 'company_asc'] as const;
export type Sort = (typeof SORTS)[number];

export const DEFAULT_TIME_ZONE = 'UTC';

/** Field and quota limits, shared so the API enforces what the UI displays. */
export const LIMITS = {
  applicationsPerUser: 500,
  applicationsPerDemoUser: 30,
  company: 200,
  role: 200,
  contact: 200,
  nextStep: 500,
  jobLink: 2000,
  notes: 10_000,
  search: 200,
  salaryMax: 100_000_000,
  leadsPerUser: 500,
  leadsPerDemoUser: 30,
  notesPerLead: 200,
  leadName: 200,
  leadCompany: 200,
  email: 320,
  phone: 50,
  profileLink: 2000,
  leadNote: 5000,
  interviewsPerApplication: 20,
  interviewLabel: 200,
  interviewNotes: 5000,
} as const;

export function isClosed(status: Status): boolean {
  return (CLOSED_STATUSES as readonly Status[]).includes(status);
}

export function isFollowUpStatus(status: Status): boolean {
  return (FOLLOW_UP_STATUSES as readonly Status[]).includes(status);
}
