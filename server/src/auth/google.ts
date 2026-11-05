import { createHash, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

/** Who signed in, from a verified Google ID token. */
export interface GoogleProfile {
  subject: string;
  email: string;
  name: string | null;
  pictureUrl: string | null;
}

export interface AuthorizationRequest {
  state: string;
  nonce: string;
  codeChallenge: string;
  redirectUri: string;
}

export interface CodeExchange {
  code: string;
  codeVerifier: string;
  redirectUri: string;
  nonce: string;
}

/** Injected into the app, so tests use a stub and never talk to Google. */
export interface GoogleProvider {
  authorizationUrl(request: AuthorizationRequest): string;
  /** Throws GoogleSignInError when the code or the ID token is not acceptable. */
  exchangeCode(exchange: CodeExchange): Promise<GoogleProfile>;
}

export class GoogleSignInError extends Error {}

/** 32 random bytes, base64url: used for state, nonce and the PKCE verifier. */
export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export interface VerifyOptions {
  keys: JWTVerifyGetKey;
  clientId: string;
  nonce: string;
  /** Seconds since the epoch; defaults to now. */
  currentDate?: Date;
}

/**
 * Checks a Google ID token: signature against Google's keys, issuer, audience (our client id),
 * expiry, the nonce we sent, and that Google has verified the email address.
 */
export async function verifyIdToken(
  idToken: string,
  options: VerifyOptions,
): Promise<GoogleProfile> {
  let payload;
  try {
    ({ payload } = await jwtVerify(idToken, options.keys, {
      issuer: ISSUERS,
      audience: options.clientId,
      algorithms: ['RS256'],
      clockTolerance: 60,
      ...(options.currentDate ? { currentDate: options.currentDate } : {}),
    }));
  } catch (error) {
    throw new GoogleSignInError(`ID token rejected: ${(error as Error).message}`);
  }
  if (payload['nonce'] !== options.nonce) throw new GoogleSignInError('ID token nonce mismatch');
  if (payload['email_verified'] !== true) throw new GoogleSignInError('Email address not verified');
  const { sub } = payload;
  const email = payload['email'];
  if (typeof sub !== 'string' || !sub || typeof email !== 'string' || !email)
    throw new GoogleSignInError('ID token without subject or email');
  const name = payload['name'];
  const picture = payload['picture'];
  return {
    subject: sub,
    email,
    name: typeof name === 'string' && name ? name.slice(0, 200) : null,
    pictureUrl:
      typeof picture === 'string' && /^https:\/\//i.test(picture) && picture.length <= 2000
        ? picture
        : null,
  };
}

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
}

/** The real provider, or null when the client id/secret are not configured. */
export function googleProviderFromEnv(
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch = fetch,
): GoogleProvider | null {
  const clientId = env['GOOGLE_CLIENT_ID']?.trim();
  const clientSecret = env['GOOGLE_CLIENT_SECRET']?.trim();
  if (!clientId || !clientSecret) return null;
  return createGoogleProvider(
    { clientId, clientSecret },
    createRemoteJWKSet(new URL(JWKS_URL)),
    fetchImpl,
  );
}

export function createGoogleProvider(
  config: GoogleConfig,
  keys: JWTVerifyGetKey,
  fetchImpl: typeof fetch = fetch,
): GoogleProvider {
  return {
    authorizationUrl({ state, nonce, codeChallenge, redirectUri }) {
      const url = new URL(AUTHORIZE_URL);
      url.search = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'openid email profile',
        state,
        nonce,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        prompt: 'select_account',
      }).toString();
      return url.toString();
    },

    async exchangeCode({ code, codeVerifier, redirectUri, nonce }) {
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
      if (!response.ok)
        throw new GoogleSignInError(`Token exchange failed with ${response.status}`);
      const body = (await response.json()) as { id_token?: unknown };
      if (typeof body.id_token !== 'string') throw new GoogleSignInError('No ID token in response');
      return verifyIdToken(body.id_token, { keys, clientId: config.clientId, nonce });
    },
  };
}
