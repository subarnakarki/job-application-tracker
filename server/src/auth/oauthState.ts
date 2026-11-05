import { z } from 'zod';
import { parseCookies } from './cookies';

/**
 * What the callback needs to finish a Google sign-in started in this browser: the state we
 * sent (CSRF on the callback), the PKCE verifier, the nonce, and where to go afterwards.
 * Kept in a short-lived HttpOnly `__Host-` cookie, so nothing is stored server-side and
 * another site cannot plant one. The callback always clears it (one use).
 */
export const OAUTH_COOKIE = '__Host-oauth';
const MAX_AGE_SECONDS = 10 * 60;
const ATTRIBUTES = 'Path=/; Secure; HttpOnly; SameSite=Lax';

const OAuthStateSchema = z.strictObject({
  state: z.string().min(32).max(64),
  verifier: z.string().min(43).max(128),
  nonce: z.string().min(32).max(64),
  next: z.string().max(2000),
});
export type OAuthState = z.infer<typeof OAuthStateSchema>;

export function serializeOAuthCookie(state: OAuthState): string {
  const value = Buffer.from(JSON.stringify(state)).toString('base64url');
  return `${OAUTH_COOKIE}=${value}; ${ATTRIBUTES}; Max-Age=${MAX_AGE_SECONDS}`;
}

export function serializeClearedOAuthCookie(): string {
  return `${OAUTH_COOKIE}=; ${ATTRIBUTES}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

/** The pending sign-in, or null if missing, duplicated or malformed. */
export function readOAuthCookie(header: string | undefined): OAuthState | null {
  const matches = parseCookies(header).filter(([name]) => name === OAUTH_COOKIE);
  if (matches.length !== 1) return null;
  try {
    const json: unknown = JSON.parse(Buffer.from(matches[0]?.[1] ?? '', 'base64url').toString());
    const parsed = OAuthStateSchema.safeParse(json);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Only a same-site path may be a return address, never another origin. */
export function safeNextPath(next: string | undefined): string {
  return next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\')
    ? next
    : '/';
}
