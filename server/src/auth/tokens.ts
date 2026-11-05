import { createHash, randomBytes } from 'node:crypto';

const TOKEN_BYTES = 32;
/** 32 random bytes as unpadded base64url. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** A fresh, unguessable session token (256 bits from the OS CSPRNG). */
export function generateSessionToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/**
 * Only this hash is stored. A leaked database dump therefore cannot be replayed
 * as session cookies. SHA-256 is enough because the input is 256 random bits,
 * not a human-chosen password, so there is nothing to brute-force.
 */
export function hashSessionToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

/** Cheap shape check before touching the database with attacker-supplied input. */
export function isPlausibleToken(value: string): boolean {
  return TOKEN_PATTERN.test(value);
}
