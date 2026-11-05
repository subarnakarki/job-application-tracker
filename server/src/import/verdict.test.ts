import { describe, expect, it } from 'vitest';
import {
  decide,
  EmailVerdictSchema,
  normalizeCompany,
  type Candidate,
  type EmailVerdict,
} from './verdict';

function verdict(overrides: Partial<EmailVerdict> = {}): EmailVerdict {
  return {
    kind: 'rejection',
    company: 'Acme',
    role: 'SDET',
    confidence: 'high',
    summary: 'Acme declined.',
    ...overrides,
  };
}

const app = (overrides: Partial<Candidate> = {}): Candidate => ({
  id: 'a1',
  company: 'Acme',
  role: 'SDET',
  status: 'Applied',
  ...overrides,
});

describe('normalizeCompany', () => {
  it.each([
    ['Acme, Inc.', 'acme'],
    ['ACME', 'acme'],
    ['Acme Co', 'acme'],
    ['Société Générale', 'societe generale'],
    ['Inc', 'inc'], // a lone word is the name, not a suffix
    ['  ', ''],
  ])('%j -> %j', (input, expected) => {
    expect(normalizeCompany(input)).toBe(expected);
  });
});

describe('decide', () => {
  it('ignores emails that are not about a job, whatever else they say', () => {
    expect(decide(verdict({ kind: 'not_job_related' }), [app()]).kind).toBe('ignore');
  });

  it('creates an application from a confirmation with no match', () => {
    expect(decide(verdict({ kind: 'application_confirmation' }), [])).toEqual({
      kind: 'create',
      status: 'Applied',
    });
  });

  it('moves Saved to Applied on a confirmation, and ignores a repeat confirmation', () => {
    expect(
      decide(verdict({ kind: 'application_confirmation' }), [app({ status: 'Saved' })]),
    ).toEqual({ kind: 'change', applicationId: 'a1', from: 'Saved', to: 'Applied' });
    expect(
      decide(verdict({ kind: 'application_confirmation' }), [app({ status: 'Interviewing' })]).kind,
    ).toBe('ignore');
  });

  it.each([
    ['rejection', 'Interviewing', 'Rejected'],
    ['interview_invite', 'Applied', 'Interviewing'],
    ['assessment', 'Applied', 'Screening'],
    ['offer', 'Interviewing', 'Offer'],
  ] as const)('%s moves %s to %s', (kind, from, to) => {
    expect(decide(verdict({ kind }), [app({ status: from })])).toEqual({
      kind: 'change',
      applicationId: 'a1',
      from,
      to,
    });
  });

  it('sends anything uncertain to review, with the change it would have made', () => {
    expect(decide(verdict({ confidence: 'medium' }), [app()])).toMatchObject({
      kind: 'review',
      proposed: 'Rejected',
      applicationId: 'a1',
    });
  });

  it('never moves an application backwards or reopens a closed one on its own', () => {
    expect(decide(verdict({ kind: 'assessment' }), [app({ status: 'Offer' })]).kind).toBe('review');
    expect(decide(verdict({ kind: 'offer' }), [app({ status: 'Rejected' })])).toMatchObject({
      kind: 'review',
      reason: 'The matching application is closed',
    });
  });

  it('uses the role to pick between applications at one company, else asks', () => {
    const two = [app({ id: 'a1', role: 'SDET' }), app({ id: 'a2', role: 'Product Manager' })];
    expect(decide(verdict({ role: 'Senior SDET' }), two)).toMatchObject({
      kind: 'change',
      applicationId: 'a1',
    });
    expect(decide(verdict({ role: null }), two)).toMatchObject({
      kind: 'review',
      reason: 'Several applications match',
    });
  });

  it('sends a rejection for an untracked application to review', () => {
    expect(decide(verdict(), [])).toMatchObject({
      kind: 'review',
      reason: 'No matching application',
    });
  });
});

describe('EmailVerdictSchema', () => {
  it('accepts only the fixed fields: no ids, no actions', () => {
    expect(EmailVerdictSchema.safeParse({ ...verdict(), applicationId: 'x' }).success).toBe(false);
    expect(EmailVerdictSchema.safeParse({ ...verdict(), kind: 'delete_everything' }).success).toBe(
      false,
    );
  });
});
