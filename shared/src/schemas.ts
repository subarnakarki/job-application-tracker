import { z } from 'zod';
import { LIMITS, SORTS, SOURCES, STATUSES } from './constants';
import { isValidDate, isValidTimeZone } from './dates';

/** http(s) only, no embedded credentials. Blocks `javascript:`, `data:` and friends before they reach an href. */
export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password
    );
  } catch {
    return false;
  }
}

const statusSchema = z.enum(STATUSES);
const sourceSchema = z.enum(SOURCES);

/** No control characters (newlines, tabs, NUL...), so single-line fields stay single-line in the UI and CSV. */
const singleLine = (value: string): boolean =>
  ![...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f;
  });
const SINGLE_LINE_MESSAGE = 'Must be a single line';

const requiredText = (max: number) =>
  z.string().trim().min(1, 'Required').max(max).refine(singleLine, SINGLE_LINE_MESSAGE);

/** Optional single-line text: an empty string means "no value" and is stored as null. */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine(singleLine, SINGLE_LINE_MESSAGE)
    .transform((value) => (value === '' ? null : value))
    .nullable();

const dateOnly = z.string().refine(isValidDate, 'Must be a real date as YYYY-MM-DD');

const money = z.number().int().min(0).max(LIMITS.salaryMax);
const currency = z.string().regex(/^[A-Z]{3}$/, 'Must be a 3-letter currency code such as USD');

const jobLink = z
  .string()
  .trim()
  .max(LIMITS.jobLink)
  .transform((value) => (value === '' ? null : value))
  .nullable()
  .refine((value) => value === null || isHttpUrl(value), 'Must be an http(s) link');

/** Field definitions shared by create and patch. No defaults live here (see below). */
const fields = {
  company: requiredText(LIMITS.company),
  role: requiredText(LIMITS.role),
  status: statusSchema,
  dateApplied: dateOnly.nullable(),
  source: sourceSchema,
  salaryMin: money.nullable(),
  salaryMax: money.nullable(),
  salaryCurrency: currency.nullable(),
  jobLink,
  contact: optionalText(LIMITS.contact),
  nextStep: optionalText(LIMITS.nextStep),
  nextStepDate: dateOnly.nullable(),
  // Multi-line is fine, but Postgres cannot store NUL in text.
  notes: z
    .string()
    .max(LIMITS.notes)
    .refine((value) => !value.includes('\u0000'), 'Must not contain NUL characters'),
  /** The networking lead it came through; the API checks the lead is the user's own. */
  leadId: z.uuid('Must be a lead id').nullable(),
};

export interface SalaryIssue {
  path: 'salaryMin' | 'salaryMax' | 'salaryCurrency';
  message: string;
}

/**
 * Cross-field salary rules, reusable on a merged (current + patch) record:
 * max must not be below min, and any amount needs a currency.
 */
export function findSalaryIssues(salary: {
  salaryMin: number | null | undefined;
  salaryMax: number | null | undefined;
  salaryCurrency: string | null | undefined;
}): SalaryIssue[] {
  const issues: SalaryIssue[] = [];
  const { salaryMin, salaryMax, salaryCurrency } = salary;
  if (salaryMin != null && salaryMax != null && salaryMax < salaryMin) {
    issues.push({ path: 'salaryMax', message: 'Maximum must not be below the minimum' });
  }
  if ((salaryMin != null || salaryMax != null) && salaryCurrency == null) {
    issues.push({ path: 'salaryCurrency', message: 'Currency is required with a salary' });
  }
  return issues;
}

/** Create: only company and role are required; the rest default. Unknown keys are rejected. */
export const ApplicationInputSchema = z
  .strictObject({
    company: fields.company,
    role: fields.role,
    status: fields.status.default('Saved'),
    dateApplied: fields.dateApplied.default(null),
    source: fields.source.default('Other'),
    salaryMin: fields.salaryMin.default(null),
    salaryMax: fields.salaryMax.default(null),
    salaryCurrency: fields.salaryCurrency.default(null),
    jobLink: fields.jobLink.default(null),
    contact: fields.contact.default(null),
    nextStep: fields.nextStep.default(null),
    nextStepDate: fields.nextStepDate.default(null),
    notes: fields.notes.default(''),
    leadId: fields.leadId.default(null),
  })
  .superRefine((value, context) => {
    for (const issue of findSalaryIssues(value)) {
      context.addIssue({ code: 'custom', path: [issue.path], message: issue.message });
    }
  });
export type ApplicationInput = z.output<typeof ApplicationInputSchema>;
export type ApplicationFormValues = z.input<typeof ApplicationInputSchema>;

/**
 * Patch: every field optional. An absent key leaves the value unchanged and
 * `null` clears it (company, role, status, source and notes cannot be null;
 * clear notes with ''). Salary pairing against stored values is checked by the
 * API on the merged record with `findSalaryIssues`; here only a min and max
 * given together can be compared.
 */
export const ApplicationPatchSchema = z
  .strictObject({
    company: fields.company.optional(),
    role: fields.role.optional(),
    status: fields.status.optional(),
    dateApplied: fields.dateApplied.optional(),
    source: fields.source.optional(),
    salaryMin: fields.salaryMin.optional(),
    salaryMax: fields.salaryMax.optional(),
    salaryCurrency: fields.salaryCurrency.optional(),
    jobLink: fields.jobLink.optional(),
    contact: fields.contact.optional(),
    nextStep: fields.nextStep.optional(),
    nextStepDate: fields.nextStepDate.optional(),
    notes: fields.notes.optional(),
    leadId: fields.leadId.optional(),
  })
  .superRefine((value, context) => {
    const { salaryMin, salaryMax } = value;
    if (salaryMin != null && salaryMax != null && salaryMax < salaryMin) {
      context.addIssue({
        code: 'custom',
        path: ['salaryMax'],
        message: 'Maximum must not be below the minimum',
      });
    }
  });
export type ApplicationPatch = z.output<typeof ApplicationPatchSchema>;

/** Query string of `GET /applications` (and the CSV export, which takes the same filters). */
export const ListQuerySchema = z.strictObject({
  status: statusSchema.optional(),
  followUp: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
  q: z
    .string()
    .trim()
    .max(LIMITS.search)
    // Postgres cannot hold NUL in text, and a search term is one line anyway.
    .refine(singleLine, SINGLE_LINE_MESSAGE)
    .transform((value) => (value === '' ? undefined : value))
    .optional(),
  sort: z.enum(SORTS).default('updated_desc'),
});
export type ListQuery = z.output<typeof ListQuerySchema>;

/** An IANA zone name; offsets such as "+05:00" are rejected. */
export const TimeZoneSchema = z.string().refine(isValidTimeZone, 'Unknown time zone');

/** `PATCH /api/me`: the only setting a user can change so far. */
export const UserSettingsPatchSchema = z.strictObject({ timeZone: TimeZoneSchema });
export type UserSettingsPatch = z.output<typeof UserSettingsPatchSchema>;

// ---------------------------------------------------------------------------------------------
// Networking leads: the people helping with the search, and notes from each conversation.

const noNul = (value: string) => !value.includes('\u0000');

const optionalLink = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .refine((value) => value === null || isHttpUrl(value), 'Must be an http(s) link');

const optionalEmail = z
  .string()
  .trim()
  .max(LIMITS.email)
  .transform((value) => (value === '' ? null : value))
  .nullable()
  .refine(
    (value) => value === null || /^[^@\s]+@[^@\s]+$/.test(value),
    'Must be an email address such as sam@example.com',
  );

const leadFields = {
  name: requiredText(LIMITS.leadName),
  company: optionalText(LIMITS.leadCompany),
  email: optionalEmail,
  phone: optionalText(LIMITS.phone),
  profileLink: optionalLink(LIMITS.profileLink),
};

export const LeadInputSchema = z.strictObject({
  name: leadFields.name,
  company: leadFields.company.default(null),
  email: leadFields.email.default(null),
  phone: leadFields.phone.default(null),
  profileLink: leadFields.profileLink.default(null),
});
export type LeadInput = z.output<typeof LeadInputSchema>;

/** An absent key leaves the value unchanged; `null` clears it (the name cannot be cleared). */
export const LeadPatchSchema = z.strictObject({
  name: leadFields.name.optional(),
  company: leadFields.company.optional(),
  email: leadFields.email.optional(),
  phone: leadFields.phone.optional(),
  profileLink: leadFields.profileLink.optional(),
});
export type LeadPatch = z.output<typeof LeadPatchSchema>;

const noteBody = z
  .string()
  .trim()
  .min(1, 'Required')
  .max(LIMITS.leadNote)
  .refine(noNul, 'Must not contain NUL characters');

/** A note's day: never in the future, which the API checks against the user's own today. */
export const LeadNoteInputSchema = z.strictObject({
  heldOn: dateOnly,
  body: noteBody,
});
export type LeadNoteInput = z.output<typeof LeadNoteInputSchema>;

export const LeadNotePatchSchema = z.strictObject({
  heldOn: dateOnly.optional(),
  body: noteBody.optional(),
});
export type LeadNotePatch = z.output<typeof LeadNotePatchSchema>;

/** Why a note's day is not acceptable, or null. Both are YYYY-MM-DD, which compare as strings. */
export function noteDateProblem(heldOn: string, today: string): string | null {
  return heldOn > today ? 'A note cannot be dated in the future' : null;
}

// ---------------------------------------------------------------------------------------------
// Interviews: past or scheduled, logged against an application.

const interviewNotes = z
  .string()
  .max(LIMITS.interviewNotes)
  .refine(noNul, 'Must not contain NUL characters');

/** Any day, past or future, so scheduled interviews can be logged ahead. */
export const InterviewInputSchema = z.strictObject({
  heldOn: dateOnly,
  /** For example "Hiring manager". */
  label: optionalText(LIMITS.interviewLabel).default(null),
  notes: interviewNotes.default(''),
});
export type InterviewInput = z.output<typeof InterviewInputSchema>;

export const InterviewPatchSchema = z.strictObject({
  heldOn: dateOnly.optional(),
  label: optionalText(LIMITS.interviewLabel).optional(),
  notes: interviewNotes.optional(),
});
export type InterviewPatch = z.output<typeof InterviewPatchSchema>;
