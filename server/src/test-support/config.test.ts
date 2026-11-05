import { describe, expect, it } from 'vitest';
import { resolveTestRoutes, secretsMatch } from './config';

const SECRET = 'a-long-enough-secret-value';
const allowed = { ENABLE_TEST_ROUTES: '1', NODE_ENV: 'test', TEST_ROUTES_SECRET: SECRET };

describe('resolveTestRoutes: the allowlist', () => {
  it('is on in a test run with the flag and a secret', () => {
    expect(resolveTestRoutes(allowed)).toEqual({ secret: SECRET });
  });

  it('is on in a Vercel preview with the flag and a secret', () => {
    expect(
      resolveTestRoutes({
        ENABLE_TEST_ROUTES: '1',
        VERCEL_ENV: 'preview',
        NODE_ENV: 'production',
        TEST_ROUTES_SECRET: SECRET,
      }),
    ).toEqual({ secret: SECRET });
  });

  it('is off by default', () => {
    expect(resolveTestRoutes({})).toBeNull();
    expect(resolveTestRoutes({ NODE_ENV: 'test' })).toBeNull();
  });

  it.each([
    ['the flag missing', { NODE_ENV: 'test', TEST_ROUTES_SECRET: SECRET }],
    ['the flag "true"', { ...allowed, ENABLE_TEST_ROUTES: 'true' }],
    ['the flag "0"', { ...allowed, ENABLE_TEST_ROUTES: '0' }],
    ['the flag "" ', { ...allowed, ENABLE_TEST_ROUTES: '' }],
    ['no secret', { ENABLE_TEST_ROUTES: '1', NODE_ENV: 'test' }],
    ['an empty secret', { ...allowed, TEST_ROUTES_SECRET: '' }],
    ['a secret that is too short', { ...allowed, TEST_ROUTES_SECRET: 'short' }],
    ['a secret one character too short', { ...allowed, TEST_ROUTES_SECRET: 'x'.repeat(15) }],
    ['a development environment', { ...allowed, NODE_ENV: 'development' }],
    ['a production NODE_ENV and no preview', { ...allowed, NODE_ENV: 'production' }],
    ['no environment at all', { ENABLE_TEST_ROUTES: '1', TEST_ROUTES_SECRET: SECRET }],
    [
      'a Vercel development environment',
      { ENABLE_TEST_ROUTES: '1', VERCEL_ENV: 'development', TEST_ROUTES_SECRET: SECRET },
    ],
  ])('is off with %s', (_label, env) => {
    expect(resolveTestRoutes(env)).toBeNull();
  });

  it('accepts a secret of exactly 16 characters', () => {
    expect(resolveTestRoutes({ ...allowed, TEST_ROUTES_SECRET: 'x'.repeat(16) })).toEqual({
      secret: 'x'.repeat(16),
    });
  });

  describe('production is never allowed, whatever else is set', () => {
    it.each([
      ['NODE_ENV=test', { ...allowed, VERCEL_ENV: 'production' }],
      ['NODE_ENV=production', { ...allowed, NODE_ENV: 'production', VERCEL_ENV: 'production' }],
      ['everything "right" plus production', { ...allowed, VERCEL_ENV: 'production', VERCEL: '1' }],
    ])('with %s', (_label, env) => {
      expect(resolveTestRoutes(env)).toBeNull();
    });

    it('holds for every combination of the other settings (exhaustive)', () => {
      const flags = [undefined, '1', '0', 'true'];
      const nodeEnvs = [undefined, 'test', 'development', 'production'];
      const secrets = [undefined, 'short', SECRET];
      for (const ENABLE_TEST_ROUTES of flags) {
        for (const NODE_ENV of nodeEnvs) {
          for (const TEST_ROUTES_SECRET of secrets) {
            expect(
              resolveTestRoutes({
                ENABLE_TEST_ROUTES,
                NODE_ENV,
                TEST_ROUTES_SECRET,
                VERCEL_ENV: 'production',
              }),
            ).toBeNull();
          }
        }
      }
    });
  });
});

describe('secretsMatch', () => {
  it('accepts only the exact secret', () => {
    expect(secretsMatch(SECRET, SECRET)).toBe(true);
    expect(secretsMatch(SECRET, `${SECRET} `)).toBe(false);
    expect(secretsMatch(SECRET, SECRET.toUpperCase())).toBe(false);
    expect(secretsMatch(SECRET, SECRET.slice(0, -1))).toBe(false);
    expect(secretsMatch(SECRET, `${SECRET}x`)).toBe(false);
  });

  it('never accepts a missing or empty value, even against an empty expected secret', () => {
    expect(secretsMatch(SECRET, undefined)).toBe(false);
    expect(secretsMatch(SECRET, '')).toBe(false);
    expect(secretsMatch('', '')).toBe(false);
    expect(secretsMatch('', undefined)).toBe(false);
  });
});
