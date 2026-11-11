import { z } from 'zod';
import { SOURCES, STATUSES, WORK_MODES } from './constants';
import { JobHitSchema, JobSearchProfileSchema, JobSearchRunSchema } from './jobSearch';
import { ResumeAnalysisSchema, ResumeSchema } from './resume';
import { ApplicationCoverLetterSchema } from './coverLetter';
import { ApplicationTailoringSchema } from './tailor';

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
  location: z.string().nullable(),
  workMode: z.enum(WORK_MODES).nullable(),
  postedOn: calendarDate.nullable(),
  notes: z.string(),
  createdAt: instant,
  updatedAt: instant,
  lastActivityAt: instant,
  version: z.number().int().min(1),
  /** Computed per request in the user's time zone; never stored. */
  needsFollowUp: z.boolean(),
  isClosed: z.boolean(),
  leadId: z.uuid().nullable(),
  /** The linked lead's name, for display. */
  leadName: z.string().nullable(),
  interviewCount: z.number().int().min(0),
  /** The next interview from today on, in the user's time zone, or null. */
  nextInterviewOn: calendarDate.nullable(),
});
export type Application = z.infer<typeof ApplicationSchema>;

export const InterviewSchema = z.strictObject({
  id: z.uuid(),
  heldOn: calendarDate,
  label: z.string().nullable(),
  notes: z.string(),
  createdAt: instant,
  updatedAt: instant,
});
export type Interview = z.infer<typeof InterviewSchema>;

/**
 * A posting found on the company's public job board that may be this application's (when an
 * imported email had no link). The user applies it (filling only empty fields) or dismisses it.
 */
export const PostingSuggestionSchema = z.strictObject({
  /** The job board it was found on, e.g. "greenhouse". */
  source: z.string(),
  jobLink: z.string(),
  role: z.string().nullable(),
  salaryMin: z.number().int().nullable(),
  salaryMax: z.number().int().nullable(),
  salaryCurrency: z.string().nullable(),
  location: z.string().nullable(),
  workMode: z.enum(WORK_MODES).nullable(),
  postedOn: calendarDate.nullable(),
  createdAt: instant,
});
export type PostingSuggestion = z.infer<typeof PostingSuggestionSchema>;

export const ApplicationDetailSchema = ApplicationSchema.extend({
  history: z.array(HistoryEntrySchema),
  /** Oldest first. */
  interviews: z.array(InterviewSchema),
  postingSuggestion: PostingSuggestionSchema.nullable(),
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

export const LeadNoteSchema = z.strictObject({
  id: z.uuid(),
  heldOn: calendarDate,
  body: z.string(),
  createdAt: instant,
  updatedAt: instant,
});
export type LeadNote = z.infer<typeof LeadNoteSchema>;

export const LeadSchema = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  company: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  profileLink: z.string().nullable(),
  createdAt: instant,
  updatedAt: instant,
  noteCount: z.number().int().min(0),
  /** The newest note (by day, then by when it was written), for the list. */
  latestNote: z.strictObject({ heldOn: calendarDate, body: z.string() }).nullable(),
  applicationCount: z.number().int().min(0),
});
export type Lead = z.infer<typeof LeadSchema>;

export const LeadDetailSchema = LeadSchema.extend({
  /** Newest first. */
  notes: z.array(LeadNoteSchema),
  /** The applications that came through this lead, most recently updated first. */
  applications: z.array(
    z.strictObject({
      id: z.uuid(),
      company: z.string(),
      role: z.string(),
      status: z.enum(STATUSES),
    }),
  ),
});
export type LeadDetail = z.infer<typeof LeadDetailSchema>;

/** `GET /api/leads`: every lead (at most the per-user cap, so no paging), by name. */
export const LeadListSchema = z.strictObject({
  items: z.array(LeadSchema),
  total: z.number().int().min(0),
});
export type LeadList = z.infer<typeof LeadListSchema>;

export const DataExportSchema = z.strictObject({
  exportedAt: instant,
  user: UserSchema,
  applications: z.array(ApplicationDetailSchema),
  /** Gmail imports: which emails were read and what each led to (never the email body). */
  /** Networking leads, each with its notes and linked applications. */
  leads: z.array(LeadDetailSchema),
  imports: z.strictObject({ runs: z.array(ImportRunSchema), items: z.array(ImportItemSchema) }),
  /** The stored resume, described (its file is a separate download: GET /api/resume/file). */
  resume: ResumeSchema.nullable(),
  resumeAnalyses: z.array(ResumeAnalysisSchema),
  /** The job search setup, every run and every job it found. */
  jobSearch: z.strictObject({
    profile: JobSearchProfileSchema.nullable(),
    runs: z.array(JobSearchRunSchema),
    hits: z.array(JobHitSchema),
  }),
  /** Resumes tailored to an application: suggestions, posting text and the saved version. */
  applicationTailorings: z.array(
    z.strictObject({
      applicationId: z.uuid(),
      postingText: z.string().nullable(),
      tailoring: ApplicationTailoringSchema,
    }),
  ),
  /** Cover letters, one per application, with the posting each was drafted from. */
  applicationCoverLetters: z.array(
    z.strictObject({
      applicationId: z.uuid(),
      postingText: z.string().nullable(),
      coverLetter: ApplicationCoverLetterSchema,
    }),
  ),
});
export type DataExport = z.infer<typeof DataExportSchema>;

/** What "Fill from link" found. Every field may be missing; the form fills only empty fields. */
export const PostingPreviewSchema = z.strictObject({
  jobLink: z.string(),
  company: z.string().nullable(),
  role: z.string().nullable(),
  salaryMin: z.number().int().min(0).nullable(),
  salaryMax: z.number().int().min(0).nullable(),
  salaryCurrency: z.string().nullable(),
  location: z.string().nullable(),
  workMode: z.enum(WORK_MODES).nullable(),
  postedOn: calendarDate.nullable(),
});
export type PostingPreview = z.infer<typeof PostingPreviewSchema>;
