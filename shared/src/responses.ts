import { z } from 'zod';
import { SOURCES, STATUSES } from './constants';

/**
 * What the API returns. These are strict: an unexpected field (a leaked
 * `user_id`, a raw column name) fails the contract tests, so the response shape
 * can only change on purpose. The web app uses the inferred types.
 */

const instant = z.iso.datetime({ offset: true });
const calendarDate = z.iso.date();

export const ACTORS = ['user', 'gmail', 'system'] as const;

export const HistoryEntrySchema = z.strictObject({
  id: z.uuid(),
  fromStatus: z.enum(STATUSES).nullable(),
  toStatus: z.enum(STATUSES),
  occurredAt: instant,
  actor: z.enum(ACTORS),
});
export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;

export const ApplicationSchema = z.strictObject({
  id: z.uuid(),
  company: z.string(),
  role: z.string(),
  status: z.enum(STATUSES),
  dateApplied: calendarDate.nullable(),
  source: z.enum(SOURCES),
  salaryMin: z.number().int().nullable(),
  salaryMax: z.number().int().nullable(),
  salaryCurrency: z.string().nullable(),
  jobLink: z.string().nullable(),
  contact: z.string().nullable(),
  nextStep: z.string().nullable(),
  nextStepDate: calendarDate.nullable(),
  notes: z.string(),
  createdAt: instant,
  updatedAt: instant,
  lastActivityAt: instant,
  version: z.number().int().min(1),
  /** Computed per request in the user's time zone; never stored. */
  needsFollowUp: z.boolean(),
  isClosed: z.boolean(),
});
export type Application = z.infer<typeof ApplicationSchema>;

export const ApplicationDetailSchema = ApplicationSchema.extend({
  history: z.array(HistoryEntrySchema),
});
export type ApplicationDetail = z.infer<typeof ApplicationDetailSchema>;

export const UserSchema = z.strictObject({
  id: z.uuid(),
  email: z.string(),
  name: z.string().nullable(),
  pictureUrl: z.string().nullable(),
  timeZone: z.string(),
  isDemo: z.boolean(),
});
export type User = z.infer<typeof UserSchema>;

/** Every 4xx/5xx body. `issues` lists field problems for validation errors. */
export const ErrorSchema = z.strictObject({
  error: z.string().min(1),
  message: z.string().optional(),
  issues: z.array(z.strictObject({ path: z.string(), message: z.string() })).optional(),
});
export type ApiErrorBody = z.infer<typeof ErrorSchema>;

export const HealthSchema = z.strictObject({ status: z.enum(['ok', 'unavailable']) });

/** `{ user }`, returned by sign-in and the profile routes. */
export const UserEnvelopeSchema = z.strictObject({ user: UserSchema });

/** `GET /api/applications`: every matching application (at most the per-user cap, so no paging). */
export const ApplicationListSchema = z.strictObject({
  items: z.array(ApplicationSchema),
  total: z.number().int().min(0),
});
export type ApplicationList = z.infer<typeof ApplicationListSchema>;

/** `GET /api/pipeline`: a count for every stage (all seven, in order), plus follow-up. */
export const PipelineSchema = z.strictObject({
  stages: z
    .array(z.strictObject({ status: z.enum(STATUSES), count: z.number().int().min(0) }))
    .length(STATUSES.length),
  followUpCount: z.number().int().min(0),
  total: z.number().int().min(0),
});
export type Pipeline = z.infer<typeof PipelineSchema>;

const count = z.number().int().min(0);
const stageCounts = {
  total: count,
  applied: count,
  responded: count,
  interviewing: count,
  offers: count,
  responseRate: z.number().min(0).max(1).nullable(),
};

/** `GET /api/stats`: how far applications from each source got (all six sources, in order). */
export const StatsSchema = z.strictObject({
  sources: z
    .array(z.strictObject({ source: z.enum(SOURCES), ...stageCounts }))
    .length(SOURCES.length),
  totals: z.strictObject(stageCounts),
});
export type Stats = z.infer<typeof StatsSchema>;

export const IMPORT_VERDICT_KINDS = [
  'application_confirmation',
  'rejection',
  'interview_invite',
  'assessment',
  'offer',
  'not_job_related',
] as const;

/** Visible outcomes of one imported email ('pending' is internal and never returned). */
export const IMPORT_OUTCOMES = [
  'created',
  'status_changed',
  'needs_review',
  'ignored',
  'undone',
  'dismissed',
] as const;

/** One email from a Gmail import and what it led to. The email body is never stored. */
export const ImportItemSchema = z.strictObject({
  id: z.uuid(),
  emailFrom: z.string(),
  emailSubject: z.string(),
  emailDate: instant.nullable(),
  verdictKind: z.enum(IMPORT_VERDICT_KINDS).nullable(),
  confidence: z.enum(['high', 'medium', 'low']).nullable(),
  company: z.string().nullable(),
  role: z.string().nullable(),
  summary: z.string(),
  reason: z.string(),
  outcome: z.enum(IMPORT_OUTCOMES),
  proposedStatus: z.enum(STATUSES).nullable(),
  applicationId: z.uuid().nullable(),
  fromStatus: z.enum(STATUSES).nullable(),
  toStatus: z.enum(STATUSES).nullable(),
});
export type ImportItem = z.infer<typeof ImportItemSchema>;

export const ImportRunSchema = z.strictObject({
  id: z.uuid(),
  startedAt: instant,
  finishedAt: instant.nullable(),
  emailsScanned: z.number().int().min(0),
  status: z.enum(['running', 'finished', 'failed']),
});

/** `GET /api/import/runs/:id`. */
export const ImportRunDetailSchema = z.strictObject({
  run: ImportRunSchema,
  items: z.array(ImportItemSchema),
});
export type ImportRunDetail = z.infer<typeof ImportRunDetailSchema>;

/** `GET /api/import/runs`: recent imports, newest first, with how their emails turned out. */
export const ImportRunListSchema = z.strictObject({
  items: z.array(
    ImportRunSchema.extend({
      changed: z.number().int().min(0),
      needsReview: z.number().int().min(0),
      skipped: z.number().int().min(0),
    }),
  ),
});
export type ImportRunList = z.infer<typeof ImportRunListSchema>;

/** `GET /api/import/status`: whether this user may import from Gmail. */
export const ImportStatusSchema = z.strictObject({ available: z.boolean() });

/** `GET /api/me/export`: everything the app holds about the user. */
export const DataExportSchema = z.strictObject({
  exportedAt: instant,
  user: UserSchema,
  applications: z.array(ApplicationDetailSchema),
  /** Gmail imports: which emails were read and what each led to (never the email body). */
  imports: z.strictObject({ runs: z.array(ImportRunSchema), items: z.array(ImportItemSchema) }),
});
export type DataExport = z.infer<typeof DataExportSchema>;
