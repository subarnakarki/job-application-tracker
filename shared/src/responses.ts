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

/** `GET /api/me/export`: everything the app holds about the user. */
export const DataExportSchema = z.strictObject({
  exportedAt: instant,
  user: UserSchema,
  applications: z.array(ApplicationDetailSchema),
});
export type DataExport = z.infer<typeof DataExportSchema>;

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
