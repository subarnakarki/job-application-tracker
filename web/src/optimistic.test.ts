import { STATUSES, type Application, type ApplicationList, type Pipeline } from '@jat/shared';
import { describe, expect, it } from 'vitest';
import { moveInList, moveInPipeline } from './optimistic';

const NOW = '2026-11-06T10:00:00.000Z';

function app(id: string, overrides: Partial<Application> = {}): Application {
  return {
    id,
    company: `Company ${id}`,
    role: 'SDET',
    status: 'Applied',
    dateApplied: '2026-10-01',
    source: 'LinkedIn',
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: null,
    jobLink: null,
    contact: null,
    nextStep: null,
    nextStepDate: null,
    notes: '',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    lastActivityAt: '2026-10-01T00:00:00.000Z',
    version: 3,
    needsFollowUp: true,
    isClosed: false,
    leadId: null,
    leadName: null,
    interviewCount: 0,
    nextInterviewOn: null,
    ...overrides,
  };
}

const list = (...items: Application[]): ApplicationList => ({ items, total: items.length });

describe('moveInList', () => {
  it('moves the application to the top with its new status, as a fresh edit', () => {
    const result = moveInList(list(app('a'), app('b')), 'b', 'Rejected', {}, NOW);
    expect(result.items.map((item) => item.id)).toEqual(['b', 'a']);
    expect(result.items[0]).toMatchObject({
      status: 'Rejected',
      isClosed: true,
      needsFollowUp: false,
      updatedAt: NOW,
      version: 3, // the server's answer brings the new version
    });
  });

  it('drops it from a list filtered to another stage or to needs-follow-up', () => {
    const start = list(app('a'), app('b'));
    expect(moveInList(start, 'a', 'Offer', { status: 'Applied' }, NOW)).toEqual({
      items: [start.items[1]],
      total: 1,
    });
    expect(moveInList(start, 'a', 'Offer', { followUp: true }, NOW).total).toBe(1);
  });

  it('keeps the order for other sorts, and changes nothing for a same-status move', () => {
    const start = list(app('a'), app('b'));
    const sorted = moveInList(start, 'b', 'Offer', { sort: 'company_asc' }, NOW);
    expect(sorted.items.map((item) => item.id)).toEqual(['a', 'b']);
    expect(moveInList(start, 'a', 'Applied', {}, NOW)).toBe(start);
  });
});

describe('moveInPipeline', () => {
  const pipeline: Pipeline = {
    stages: STATUSES.map((status) => ({ status, count: status === 'Applied' ? 2 : 0 })),
    followUpCount: 2,
    total: 2,
  };

  it('moves one count between stages and clears its follow-up', () => {
    const result = moveInPipeline(pipeline, 'Applied', 'Interviewing', true);
    const counts = Object.fromEntries(result.stages.map((stage) => [stage.status, stage.count]));
    expect(counts).toMatchObject({ Applied: 1, Interviewing: 1 });
    expect(result.followUpCount).toBe(1);
    expect(result.total).toBe(2);
  });
});
