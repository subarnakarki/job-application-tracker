import { describe, expect, it } from 'vitest';
import { interviewText, timeline } from './timeline';

const status = (id: string, occurredAt: string) => ({
  id,
  fromStatus: null,
  toStatus: 'Applied' as const,
  occurredAt,
  actor: 'user' as const,
});
const interview = (id: string, heldOn: string) => ({
  id,
  heldOn,
  label: null,
  notes: '',
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
});

describe('timeline', () => {
  it('merges status changes and interviews, newest first, scheduled interviews on top', () => {
    const items = timeline(
      [status('a', '2026-11-01T09:00:00.000Z'), status('b', '2026-11-03T18:00:00.000Z')],
      [interview('x', '2026-11-02'), interview('y', '2026-11-20')],
    );
    expect(items.map((item) => item.key)).toEqual(['i-y', 's-b', 'i-x', 's-a']);
  });
});

describe('interviewText', () => {
  it('names the next interview, else counts past ones, else says nothing', () => {
    expect(interviewText({ interviewCount: 2, nextInterviewOn: '2026-11-12' })).toMatch(
      /^Interview Nov 12, 2026$/,
    );
    expect(interviewText({ interviewCount: 1, nextInterviewOn: null })).toBe('1 interview');
    expect(interviewText({ interviewCount: 3, nextInterviewOn: null })).toBe('3 interviews');
    expect(interviewText({ interviewCount: 0, nextInterviewOn: null })).toBeNull();
  });
});
