import { describe, expect, it } from 'vitest';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { GoogleSignInError, pkceChallenge, verifyIdToken } from './google';

const CLIENT_ID = 'client-123.apps.googleusercontent.com';
const NONCE = 'n'.repeat(43);
const NOW = new Date('2026-11-05T12:00:00Z');

const { publicKey, privateKey } = await generateKeyPair('RS256');
const keys = createLocalJWKSet({
  keys: [{ ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' }],
});
const other = await generateKeyPair('RS256');

async function token(claims: JWTPayload = {}, key = privateKey) {
  const iat = Math.floor(NOW.getTime() / 1000);
  return new SignJWT({
    iss: 'https://accounts.google.com',
    aud: CLIENT_ID,
    sub: '1234567890',
    email: 'ada@example.com',
    email_verified: true,
    name: 'Ada',
    nonce: NONCE,
    iat,
    exp: iat + 3600,
    ...claims,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .sign(key);
}

const verify = async (idToken: string) =>
  verifyIdToken(idToken, { keys, clientId: CLIENT_ID, nonce: NONCE, currentDate: NOW });

describe('verifyIdToken', () => {
  it('accepts a valid Google ID token and returns the profile', async () => {
    await expect(verify(await token())).resolves.toEqual({
      subject: '1234567890',
      email: 'ada@example.com',
      name: 'Ada',
      pictureUrl: null,
    });
  });

  it.each<[string, JWTPayload]>([
    ['another app (audience)', { aud: 'someone-else' }],
    ['another issuer', { iss: 'https://evil.example' }],
    ['a replayed sign-in (nonce)', { nonce: 'x'.repeat(43) }],
    ['an unverified email', { email_verified: false }],
    ['an expired token', { exp: Math.floor(NOW.getTime() / 1000) - 3600 }],
  ])('rejects %s', async (_case, claims) => {
    await expect(verify(await token(claims))).rejects.toBeInstanceOf(GoogleSignInError);
  });

  it('rejects a token not signed by Google', async () => {
    await expect(verify(await token({}, other.privateKey))).rejects.toBeInstanceOf(
      GoogleSignInError,
    );
  });

  it('computes the RFC 7636 PKCE challenge', () => {
    // Test vector from RFC 7636, appendix B.
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });
});
