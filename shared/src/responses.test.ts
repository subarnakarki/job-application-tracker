import { describe, expect, it } from 'vitest';
import {
  ApplicationDetailSchema,
  ApplicationSchema,
  DataExportSchema,
  ErrorSchema,
  HistoryEntrySchema,
  UserSchema,
} from './responses';

const ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const application = {
  id: ID,
  company: 'Acme',
  role: 'SDET',
  status: 'Applied',
  dateApplied: '2026-11-01',
  source: 'Referral',
  salaryMin: 100000,
  salaryMax: null,
  salaryCurrency: 'USD',
  jobLink: null,
  contact: null,
  nextStep: null,
  nextStepDate: null,
  location: null,
  workMode: null,
  postedOn: null,
  notes: '',
  createdAt: '2026-11-01T10:00:00.000Z',
  updatedAt: '2026-11-01T10:00:00.000Z',
  lastActivityAt: '2026-11-01T10:00:00.000Z',
  version: 1,
  needsFollowUp: false,
  isClosed: false,
  leadId: null,
  leadName: null,
  interviewCount: 0,
  nextInterviewOn: null,
};
const history = {
  id: ID,
  fromStatus: null,
  toStatus: 'Applied',
  occurredAt: '2026-11-01T10:00:00.000Z',
  actor: 'user',
};
const user = {
  id: ID,
  email: 'pat@example.com',
  name: null,
  pictureUrl: null,
  timeZone: 'UTC',
  isDemo: false,
};

describe('response contracts', () => {
  it('accept the real shapes', () => {
    expect(ApplicationSchema.safeParse(application).success).toBe(true);
    expect(
      ApplicationDetailSchema.safeParse({
        ...application,
        history: [history],
        interviews: [],
        postingSuggestion: null,
      }).success,
    ).toBe(true);
    expect(HistoryEntrySchema.safeParse(history).success).toBe(true);
    expect(UserSchema.safeParse(user).success).toBe(true);
    expect(
      DataExportSchema.safeParse({
        exportedAt: '2026-11-05T12:00:00.000Z',
        user,
        applications: [
          { ...application, history: [history], interviews: [], postingSuggestion: null },
        ],
        leads: [],
        imports: { runs: [], items: [] },
        resume: null,
        resumeAnalyses: [],
        jobSearch: { profile: null, runs: [], hits: [] },
        applicationTailorings: [],
        applicationCoverLetters: [],
      }).success,
    ).toBe(true);
  });

  it.each([
    ['a leaked owner column', { ...application, user_id: ID }],
    ['a leaked owner field', { ...application, userId: ID }],
    ['a raw snake_case column', { ...application, last_activity_at: '2026-11-01T10:00:00Z' }],
    [
      'a missing computed flag',
      Object.fromEntries(Object.entries(application).filter(([key]) => key !== 'needsFollowUp')),
    ],
    ['a date with a time', { ...application, dateApplied: '2026-11-01T00:00:00Z' }],
    ['an instant without a zone', { ...application, createdAt: '2026-11-01T10:00:00' }],
    ['a version of 0', { ...application, version: 0 }],
    ['a non-uuid id', { ...application, id: '42' }],
    ['an unknown status', { ...application, status: 'Hired' }],
    ['a string salary', { ...application, salaryMin: '100000' }],
  ])('reject an application with %s', (_label, value) => {
    expect(ApplicationSchema.safeParse(value).success).toBe(false);
  });

  it('keep the detail strict too (extend does not loosen it)', () => {
    expect(
      ApplicationDetailSchema.safeParse({ ...application, history: [], extra: 1 }).success,
    ).toBe(false);
    expect(
      ApplicationDetailSchema.safeParse({
        ...application,
        history: [{ ...history, applicationId: ID }],
      }).success,
    ).toBe(false);
  });

  it('reject a user carrying session or internal fields', () => {
    expect(UserSchema.safeParse({ ...user, sessionId: ID }).success).toBe(false);
    expect(UserSchema.safeParse({ ...user, tokenHash: 'x' }).success).toBe(false);
  });
});

describe('ErrorSchema', () => {
  it('accepts the error shapes the API sends', () => {
    expect(ErrorSchema.safeParse({ error: 'internal_error' }).success).toBe(true);
    expect(
      ErrorSchema.safeParse({ error: 'not_found', message: 'Application not found' }).success,
    ).toBe(true);
    expect(
      ErrorSchema.safeParse({
        error: 'validation_error',
        message: 'x',
        issues: [{ path: 'company', message: 'Required' }],
      }).success,
    ).toBe(true);
  });

  it.each([
    ['no code', { message: 'x' }],
    ['an empty code', { error: '' }],
    [
      "Fastify's default shape",
      { statusCode: 404, error: 'Not Found', message: 'Route GET:/x not found' },
    ],
    ['a stack trace', { error: 'internal_error', stack: 'Error: at ...' }],
    ['a malformed issue', { error: 'validation_error', issues: [{ path: 'a' }] }],
  ])('rejects %s', (_label, value) => {
    expect(ErrorSchema.safeParse(value).success).toBe(false);
  });
});
