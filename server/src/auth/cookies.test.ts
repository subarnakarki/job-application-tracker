import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  parseCookies,
  readSessionToken,
  serializeClearedSessionCookie,
  serializeSessionCookie,
  SESSION_COOKIE,
} from './cookies';
import { generateSessionToken } from './tokens';

const TOKEN = 'A'.repeat(43);

describe('serializeSessionCookie', () => {
  it('sets every attribute a __Host- cookie needs, and nothing that would break the prefix', () => {
    const header = serializeSessionCookie(TOKEN, 2_592_000);

    expect(header.startsWith(`__Host-session=${TOKEN};`)).toBe(true);
    expect(header).toContain('Path=/');
    expect(header).toContain('Secure');
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Lax');
    expect(header).toContain('Max-Age=2592000');
    expect(header).not.toMatch(/Domain=/i);
  });

  it('never allows a negative or fractional lifetime', () => {
    expect(serializeSessionCookie(TOKEN, -5)).toContain('Max-Age=0');
    expect(serializeSessionCookie(TOKEN, 90.9)).toContain('Max-Age=90');
  });
});

describe('serializeClearedSessionCookie', () => {
  it('expires the cookie immediately with the same attributes, so browsers accept the removal', () => {
    const header = serializeClearedSessionCookie();

    expect(header.startsWith('__Host-session=;')).toBe(true);
    expect(header).toContain('Max-Age=0');
    expect(header).toContain('Expires=Thu, 01 Jan 1970');
    expect(header).toContain('Path=/');
    expect(header).toContain('Secure');
    expect(header).toContain('HttpOnly');
  });
});

describe('parseCookies', () => {
  it('reads several cookies in order and trims whitespace', () => {
    expect(parseCookies('a=1; b=2 ;  c=3')).toEqual([
      ['a', '1'],
      ['b', '2'],
      ['c', '3'],
    ]);
  });

  it('keeps an equals sign inside a value and strips surrounding quotes', () => {
    expect(parseCookies('token=abc==; q="quoted value"')).toEqual([
      ['token', 'abc=='],
      ['q', 'quoted value'],
    ]);
  });

  it.each([[undefined], [''], [';;;'], ['novalue'], ['=nameless'], ['  ']])(
    'returns nothing for %j',
    (header) => {
      expect(parseCookies(header)).toEqual([]);
    },
  );

  it('skips malformed pieces and keeps the good ones', () => {
    expect(parseCookies('bad; ok=1; =x; also=2')).toEqual([
      ['ok', '1'],
      ['also', '2'],
    ]);
  });
});

describe('readSessionToken', () => {
  it('finds the token among other cookies', () => {
    expect(readSessionToken(`theme=dark; ${SESSION_COOKIE}=${TOKEN}; lang=en`)).toBe(TOKEN);
  });

  it.each([
    ['no header', undefined],
    ['no cookie of that name', 'theme=dark'],
    ['empty value', `${SESSION_COOKIE}=`],
    ['wrong shape', `${SESSION_COOKIE}=not-a-token`],
    ['a similarly named cookie', `session=${TOKEN}`],
    ['the name without the prefix', `Host-session=${TOKEN}`],
    ['a lookalike suffix', `${SESSION_COOKIE}x=${TOKEN}`],
  ])('returns null for %s', (_label, header) => {
    expect(readSessionToken(header)).toBeNull();
  });

  it('rejects a request that carries the cookie twice (cookie tossing)', () => {
    const other = 'B'.repeat(43);

    expect(readSessionToken(`${SESSION_COOKIE}=${TOKEN}; ${SESSION_COOKIE}=${other}`)).toBeNull();
    expect(
      readSessionToken(`${SESSION_COOKIE}=${other}; theme=x; ${SESSION_COOKIE}=${TOKEN}`),
    ).toBeNull();
  });

  it('round-trips any generated token through the Set-Cookie value (property)', () => {
    fc.assert(
      fc.property(fc.constant(null), () => {
        const token = generateSessionToken();
        const setCookie = serializeSessionCookie(token, 60);
        const cookieHeader = setCookie.split(';')[0] ?? '';

        expect(readSessionToken(cookieHeader)).toBe(token);
      }),
      { numRuns: 200 },
    );
  });
});
