import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DATE_APPLIED_STATUSES, STATUSES, type Status } from './constants';
import { changedFields } from './patch';
import { planStatusChange, resolveDateApplied } from './status';

describe('planStatusChange', () => {
  it('records the creation as null -> initial', () => {
    expect(planStatusChange(null, 'Saved')).toEqual({
      changed: true,
      fromStatus: null,
      toStatus: 'Saved',
    });
    expect(planStatusChange(null, 'Interviewing')).toEqual({
      changed: true,
      fromStatus: null,
      toStatus: 'Interviewing',
    });
  });

  it('allows any status to move to any other status, including reopening', () => {
    for (const from of STATUSES) {
      for (const to of STATUSES) {
        const plan = planStatusChange(from, to);
        expect(plan.changed).toBe(from !== to);
        expect(plan.fromStatus).toBe(from);
        expect(plan.toStatus).toBe(to);
      }
    }
    expect(planStatusChange('Rejected', 'Interviewing').changed).toBe(true);
  });

  it('treats saving the same status as no change', () => {
    expect(planStatusChange('Applied', 'Applied').changed).toBe(false);
  });
});

describe('resolveDateApplied', () => {
  const today = '2026-11-05';
  const resolve = (
    previousStatus: Status | null,
    newStatus: Status,
    dateApplied: string | null = null,
  ) => resolveDateApplied({ previousStatus, newStatus, dateApplied, today });

  it.each([
    ['Saved -> Applied', 'Saved', 'Applied', today],
    ['Saved -> Screening (skipped Applied)', 'Saved', 'Screening', today],
    ['Saved -> Interviewing', 'Saved', 'Interviewing', today],
    ['Saved -> Offer', 'Saved', 'Offer', today],
    ['Saved -> Rejected', 'Saved', 'Rejected', today],
    ['Saved -> Withdrawn (never applied)', 'Saved', 'Withdrawn', null],
    ['Saved -> Saved', 'Saved', 'Saved', null],
    ['Withdrawn -> Applied (reapplying)', 'Withdrawn', 'Applied', today],
    ['Applied -> Screening (already applied, still empty)', 'Applied', 'Screening', null],
    ['Interviewing -> Offer', 'Interviewing', 'Offer', null],
    ['Interviewing -> Withdrawn', 'Interviewing', 'Withdrawn', null],
  ] as const)('%s', (_label, from, to, expected) => {
    expect(resolve(from, to)).toBe(expected);
  });

  it('fills when created directly in an applied-or-later status', () => {
    expect(resolve(null, 'Applied')).toBe(today);
    expect(resolve(null, 'Interviewing')).toBe(today);
    expect(resolve(null, 'Saved')).toBeNull();
    expect(resolve(null, 'Withdrawn')).toBeNull();
  });

  it('never overwrites an existing date', () => {
    expect(resolve('Saved', 'Applied', '2026-10-01')).toBe('2026-10-01');
    expect(resolve(null, 'Applied', '2026-10-01')).toBe('2026-10-01');
  });

  it('only fills when entering the applied-or-later group (property)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<Status | null>(null, ...STATUSES),
        fc.constantFrom<Status>(...STATUSES),
        (from, to) => {
          const result = resolve(from, to);
          const enters =
            DATE_APPLIED_STATUSES.includes(to as never) &&
            !(from !== null && DATE_APPLIED_STATUSES.includes(from as never));
          expect(result).toBe(enters ? today : null);
        },
      ),
    );
  });
});

describe('changedFields', () => {
  const current = { company: 'Acme', role: 'SDET', contact: null as string | null, notes: '' };

  it('returns only the keys whose values differ', () => {
    expect(changedFields(current, { company: 'Acme', role: 'QA' })).toEqual(['role']);
  });

  it('treats a patch that repeats the current values as a no-op', () => {
    expect(changedFields(current, { company: 'Acme', contact: null, notes: '' })).toEqual([]);
    expect(changedFields(current, {})).toEqual([]);
  });

  it('distinguishes clearing (null) from leaving unchanged (absent or undefined)', () => {
    const withContact: typeof current = { ...current, contact: 'Pat' };
    expect(changedFields(withContact, { contact: null })).toEqual(['contact']);
    expect(changedFields(withContact, {})).toEqual([]);
    expect(changedFields(withContact, { contact: undefined })).toEqual([]);
  });

  it('is empty when a patch is built from the current object itself (property)', () => {
    fc.assert(
      fc.property(
        fc.record({ a: fc.string(), b: fc.option(fc.integer(), { nil: null }), c: fc.boolean() }),
        (value) => {
          expect(changedFields(value, { ...value })).toEqual([]);
        },
      ),
    );
  });
});
