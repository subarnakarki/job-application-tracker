import { describe, expect, it } from 'vitest';
import { fallbackFor, isHaiku } from './fallback';

describe('fallbackFor', () => {
  it('asks for the default server-side fallback on Sonnet and Opus', () => {
    for (const model of ['claude-sonnet-5-5', 'claude-opus-5-5']) {
      expect(fallbackFor(model)).toEqual({
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      });
    }
  });

  it('sends no fallback on Haiku, which has none', () => {
    expect(fallbackFor('claude-haiku-5-5')).toEqual({});
  });
});

describe('isHaiku', () => {
  it('matches Haiku ids only', () => {
    expect(isHaiku('claude-haiku-5-5')).toBe(true);
    expect(isHaiku('claude-sonnet-5-5')).toBe(false);
  });
});
