import { describe, expect, it } from 'vitest';
import { FetchError } from '../postings/fetchPage';
import { verdictOf } from './check';
import { JobReadError } from './readJob';

describe('verdictOf: what one read of the board says about a job', () => {
  it('is open when the board answers', () => {
    expect(verdictOf(null)).toBe('open');
  });

  it('is closed only when the board says the job is gone', () => {
    expect(verdictOf(new JobReadError('http_status: 404', true))).toBe('closed');
    expect(verdictOf(new JobReadError('greenhouse: no such job', true))).toBe('closed');
  });

  it('says nothing (unknown) for a timeout, a rate limit or anything else', () => {
    expect(verdictOf(new JobReadError('timeout: slow board'))).toBe('unknown');
    expect(verdictOf(new JobReadError('http_status: 429'))).toBe('unknown');
    expect(verdictOf(new FetchError('http_status', '404'))).toBe('unknown');
    expect(verdictOf(new Error('boom'))).toBe('unknown');
  });
});
