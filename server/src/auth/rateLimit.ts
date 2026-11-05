import { createHash } from 'node:crypto';
import type { Queryable } from '../db/types';

export interface RateLimitRule {
  /** Names the limit ("demo-login"), so different limits never share a counter. */
  name: string;
  /** Attempts allowed per window. */
  limit: number;
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** Seconds until the current window ends (for the Retry-After header). */
  retryAfterSeconds: number;
}

const MAX_KEY_LENGTH = 200;

/** `name:subject`, with an over-long subject replaced by its hash so the key always fits. */
export function rateLimitKey(name: string, subject: string): string {
  const key = `${name}:${subject}`;
  if (key.length <= MAX_KEY_LENGTH) return key;
  return `${name}:sha256:${createHash('sha256').update(subject).digest('hex')}`;
}

/**
 * Counts one attempt in a fixed window and says whether it is allowed. The
 * count is a single atomic upsert, so concurrent requests (and concurrent
 * serverless instances) cannot both squeeze under the limit.
 *
 * Fixed windows allow a burst of up to twice the limit across a window
 * boundary; that is acceptable for abuse protection and keeps this to one write.
 */
export async function consumeRateLimit(
  db: Queryable,
  key: string,
  rule: RateLimitRule,
  now: Date,
): Promise<RateLimitResult> {
  if (!Number.isInteger(rule.limit) || rule.limit < 1)
    throw new RangeError('limit must be a positive integer');
  if (!Number.isInteger(rule.windowMs) || rule.windowMs < 1000)
    throw new RangeError('windowMs must be at least 1000');

  const windowStartMs = Math.floor(now.getTime() / rule.windowMs) * rule.windowMs;
  const result = await db.query<{ count: number }>(
    `insert into rate_limits (key, window_start, count) values ($1, $2, 1)
     on conflict (key, window_start) do update set count = rate_limits.count + 1
     returning count`,
    [key, new Date(windowStartMs)],
  );
  const count = result.rows[0]?.count ?? rule.limit + 1;
  return {
    allowed: count <= rule.limit,
    remaining: Math.max(0, rule.limit - count),
    retryAfterSeconds: Math.max(
      1,
      Math.ceil((windowStartMs + rule.windowMs - now.getTime()) / 1000),
    ),
  };
}

/** Housekeeping: drops windows older than `keepForMs` (default one day). Returns how many. */
export async function deleteExpiredRateLimits(
  db: Queryable,
  now: Date,
  keepForMs: number = 24 * 60 * 60 * 1000,
): Promise<number> {
  const result = await db.query('delete from rate_limits where window_start < $1', [
    new Date(now.getTime() - keepForMs),
  ]);
  return result.rowCount;
}
