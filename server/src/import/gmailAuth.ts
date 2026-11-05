import { z } from 'zod';
import { parseCookies } from '../auth/cookies';

const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

export interface GmailAuthorizationRequest {
  state: string;
  codeChallenge: string;
  redirectUri: string;
  loginHint: string;
}

/**
 * Asks Google for read-only Gmail access for one import. Separate from sign-in:
 * different scope, no ID token, and the access token is used once and dropped.
 * Injected into the app, so tests use a stub and never talk to Google.
 */
export interface GmailAuthorizer {
  authorizationUrl(request: GmailAuthorizationRequest): string;
  /** The access token. Throws GmailAuthError if Gmail access was not granted. */
  exchangeCode(code: string, codeVerifier: string, redirectUri: string): Promise<string>;
}

export class GmailAuthError extends Error {
  constructor(
    message: string,
    /** For the redirect back into the app. */
    readonly reason: 'gmail_not_granted' | 'google_failed',
  ) {
    super(message);
  }
}

export function createGmailAuthorizer(
  config: { clientId: string; clientSecret: string },
  fetchImpl: typeof fetch = fetch,
): GmailAuthorizer {
  return {
    authorizationUrl({ state, codeChallenge, redirectUri, loginHint }) {
      const url = new URL(AUTHORIZE_URL);
      url.search = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: GMAIL_SCOPE,
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        login_hint: loginHint,
        // Online access only: no refresh token is issued, so there is nothing to keep.
        access_type: 'online',
      }).toString();
      return url.toString();
    },

    async exchangeCode(code, codeVerifier, redirectUri) {
      const response = await fetchImpl(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          code_verifier: codeVerifier,
          redirect_uri: redirectUri,
          client_id: config.clientId,
          client_secret: config.clientSecret,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        throw new GmailAuthError(`Token exchange failed with ${response.status}`, 'google_failed');
      }
      const body = (await response.json()) as { access_token?: unknown; scope?: unknown };
      if (typeof body.access_token !== 'string') {
        throw new GmailAuthError('No access token in response', 'google_failed');
      }
      // With granular consent the user can untick Gmail and still continue.
      const scopes = typeof body.scope === 'string' ? body.scope.split(' ') : [];
      if (!scopes.includes(GMAIL_SCOPE)) {
        throw new GmailAuthError('Gmail access was not granted', 'gmail_not_granted');
      }
      return body.access_token;
    },
  };
}

export function gmailAuthorizerFromEnv(
  env: Record<string, string | undefined>,
): GmailAuthorizer | null {
  // Preview URLs cannot be registered redirect URIs (see googleProviderFromEnv).
  if (env['VERCEL_ENV'] === 'preview') return null;
  const clientId = env['GOOGLE_CLIENT_ID']?.trim();
  const clientSecret = env['GOOGLE_CLIENT_SECRET']?.trim();
  return clientId && clientSecret ? createGmailAuthorizer({ clientId, clientSecret }) : null;
}

/**
 * The pending import, in a short-lived HttpOnly `__Host-` cookie like sign-in's:
 * the state (CSRF on the callback), the PKCE verifier, and who started it, so a
 * callback finished in another account's session is refused.
 */
export const IMPORT_COOKIE = '__Host-gmail-import';
const ATTRIBUTES = 'Path=/; Secure; HttpOnly; SameSite=Lax';

const ImportStateSchema = z.strictObject({
  state: z.string().min(32).max(64),
  verifier: z.string().min(43).max(128),
  userId: z.uuid(),
});
export type ImportState = z.infer<typeof ImportStateSchema>;

export function serializeImportCookie(state: ImportState): string {
  const value = Buffer.from(JSON.stringify(state)).toString('base64url');
  return `${IMPORT_COOKIE}=${value}; ${ATTRIBUTES}; Max-Age=600`;
}

export function serializeClearedImportCookie(): string {
  return `${IMPORT_COOKIE}=; ${ATTRIBUTES}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

export function readImportCookie(header: string | undefined): ImportState | null {
  const matches = parseCookies(header).filter(([name]) => name === IMPORT_COOKIE);
  if (matches.length !== 1) return null;
  try {
    const json: unknown = JSON.parse(Buffer.from(matches[0]?.[1] ?? '', 'base64url').toString());
    const parsed = ImportStateSchema.safeParse(json);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
