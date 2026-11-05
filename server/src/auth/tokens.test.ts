import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { generateSessionToken, hashSessionToken, isPlausibleToken } from './tokens';

describe('generateSessionToken', () => {
  it('is 43 URL-safe characters (256 bits, unpadded base64url)', () => {
    for (let index = 0; index < 50; index += 1) {
      expect(generateSessionToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }
  });

  it('never repeats', () => {
    const tokens = new Set(Array.from({ length: 5000 }, () => generateSessionToken()));

    expect(tokens.size).toBe(5000);
  });

  it('is always accepted by its own shape check', () => {
    expect(isPlausibleToken(generateSessionToken())).toBe(true);
  });
});

describe('hashSessionToken', () => {
  it('is a deterministic 32-byte SHA-256 digest', () => {
    const token = generateSessionToken();

    expect(hashSessionToken(token)).toHaveLength(32);
    expect(hashSessionToken(token).equals(hashSessionToken(token))).toBe(true);
  });

  it('matches a known SHA-256 vector, so it is the algorithm the schema expects', () => {
    expect(hashSessionToken('abc').toString('hex')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('differs for different tokens and never contains the token itself', () => {
    const first = generateSessionToken();
    const second = generateSessionToken();

    expect(hashSessionToken(first).equals(hashSessionToken(second))).toBe(false);
    expect(hashSessionToken(first).includes(Buffer.from(first))).toBe(false);
  });

  it('is sensitive to a single changed character (property)', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), fc.string({ minLength: 1 }), (a, b) => {
        fc.pre(a !== b);
        expect(hashSessionToken(a).equals(hashSessionToken(b))).toBe(false);
      }),
    );
  });
});

describe('isPlausibleToken', () => {
  it.each([
    ['empty', ''],
    ['too short', 'a'.repeat(42)],
    ['too long', 'a'.repeat(44)],
    ['padding character', `${'a'.repeat(42)}=`],
    ['plus sign', `${'a'.repeat(42)}+`],
    ['slash', `${'a'.repeat(42)}/`],
    ['space', `${'a'.repeat(42)} `],
    ['newline', `${'a'.repeat(42)}\n`],
    ['sql', "' or '1'='1' --"],
    ['unicode', `${'a'.repeat(42)}é`],
  ])('rejects %s', (_label, value) => {
    expect(isPlausibleToken(value)).toBe(false);
  });

  it('accepts the exact shape', () => {
    expect(isPlausibleToken('A'.repeat(43))).toBe(true);
    expect(isPlausibleToken(`${'a-_Z9'.repeat(8)}abc`)).toBe(true);
  });
});
