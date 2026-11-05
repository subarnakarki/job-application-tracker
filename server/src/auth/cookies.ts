import { isPlausibleToken } from './tokens';

/**
 * The `__Host-` prefix makes browsers refuse the cookie unless it is Secure,
 * has Path=/ and carries no Domain attribute. That blocks a sibling subdomain
 * from planting or overwriting a session cookie.
 */
export const SESSION_COOKIE = '__Host-session';

const ATTRIBUTES = 'Path=/; Secure; HttpOnly; SameSite=Lax';

export function serializeSessionCookie(token: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE}=${token}; ${ATTRIBUTES}; Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`;
}

/** Tells the browser to drop the cookie. Same attributes, or browsers may ignore it. */
export function serializeClearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; ${ATTRIBUTES}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

/** All cookies in a Cookie header, in order. Malformed pieces are skipped. */
export function parseCookies(header: string | undefined): [name: string, value: string][] {
  if (!header) return [];
  const cookies: [string, string][] = [];
  for (const piece of header.split(';')) {
    const separator = piece.indexOf('=');
    if (separator <= 0) continue;
    const name = piece.slice(0, separator).trim();
    let value = piece.slice(separator + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"'))
      value = value.slice(1, -1);
    if (name) cookies.push([name, value]);
  }
  return cookies;
}

/**
 * The session token from a Cookie header, or null. A request that carries the
 * cookie twice is rejected outright: duplicates are the signature of cookie
 * tossing, and picking one would let an attacker choose which wins.
 */
export function readSessionToken(header: string | undefined): string | null {
  const matches = parseCookies(header).filter(([name]) => name === SESSION_COOKIE);
  if (matches.length !== 1) return null;
  const value = matches[0]?.[1] ?? '';
  return isPlausibleToken(value) ? value : null;
}
