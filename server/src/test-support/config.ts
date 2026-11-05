import { createHash, timingSafeEqual } from 'node:crypto';

export interface TestRoutesConfig {
  secret: string;
}

const MIN_SECRET_LENGTH = 16;

/**
 * Test-only routes (synthetic sign-in, per-user clock) exist for end-to-end
 * tests and must never be reachable on a real deployment. They are registered
 * only when ALL of these hold, which makes it an allowlist rather than a
 * "not production" denylist:
 *
 * - ENABLE_TEST_ROUTES is exactly "1";
 * - the environment is a test run (NODE_ENV=test) or a Vercel preview (VERCEL_ENV=preview);
 * - it is NOT a Vercel production deployment, whatever else is set;
 * - TEST_ROUTES_SECRET is set and at least 16 characters (callers must send it).
 */
export function resolveTestRoutes(
  env: Record<string, string | undefined>,
): TestRoutesConfig | null {
  if (env['ENABLE_TEST_ROUTES'] !== '1') return null;
  if (env['VERCEL_ENV'] === 'production') return null;
  const isTestRun = env['NODE_ENV'] === 'test' || env['VERCEL_ENV'] === 'preview';
  if (!isTestRun) return null;
  const secret = env['TEST_ROUTES_SECRET'];
  if (!secret || secret.length < MIN_SECRET_LENGTH) return null;
  return { secret };
}

/** Constant-time comparison (hashing first makes the lengths equal). */
export function secretsMatch(expected: string, provided: string | undefined): boolean {
  if (provided === undefined || provided === '') return false;
  const a = createHash('sha256').update(expected).digest();
  const b = createHash('sha256').update(provided).digest();
  return timingSafeEqual(a, b);
}
