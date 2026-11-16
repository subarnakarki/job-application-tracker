import Anthropic from '@anthropic-ai/sdk';

/**
 * Anthropic declining a call for capacity or money rather than for the request itself:
 * - `rate_limited`: a per-minute rate limit or a ramp limit (429 with `retry-after`); seconds.
 * - `overloaded`: the API is overloaded for everyone (529); minutes.
 * - `spend_limit`: the organization's monthly spend cap (429 `enforced_spend_limit_reached`), a
 *   spend limit the owner set (400 "You have reached your specified ... API usage limits"), or a
 *   billing problem (402 `billing_error`); until the limit resets or is raised.
 * Retrying the same call now cannot help, so callers stop instead of recording a failed answer
 * (a failed draft would count against the job's draft attempts).
 */
export type ClaudeLimitKind = 'rate_limited' | 'overloaded' | 'spend_limit';

export class ClaudeLimitError extends Error {
  constructor(
    readonly kind: ClaudeLimitKind,
    /** From Anthropic's `retry-after` header, when it sent one. */
    readonly retryAfterSeconds: number | null,
  ) {
    super(`Anthropic limit: ${kind}`);
    this.name = 'ClaudeLimitError';
  }
}

/** The documented start of the 400 sent when a spend limit the owner set is reached. */
const OWN_SPEND_LIMIT = /^You have reached your specified (?:workspace )?API usage limits/;

/** Seconds from a `retry-after` header (seconds or an HTTP date), kept to 1 s .. 1 h. */
export function retryAfterSeconds(
  value: string | null | undefined,
  now = Date.now(),
): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  const seconds = /^\d+(?:\.\d+)?$/.test(trimmed)
    ? Number(trimmed)
    : (Date.parse(trimmed) - now) / 1000;
  if (!Number.isFinite(seconds)) return null;
  return Math.min(3600, Math.max(1, Math.ceil(seconds)));
}

/** The limit an SDK error stands for, or null for any other error. */
export function claudeLimitOf(error: unknown): ClaudeLimitError | null {
  if (!(error instanceof Anthropic.APIError)) return null;
  // The SDK types headers by status; for every status here they are the response's Headers.
  const headers = error.headers as Headers | undefined;
  const retryAfter = () => retryAfterSeconds(headers?.get('retry-after'));
  if (error.type === 'billing_error' || error.status === 402)
    return new ClaudeLimitError('spend_limit', null);
  if (error.type === 'rate_limit_error' || error instanceof Anthropic.RateLimitError) {
    // The monthly spend cap is a 429 too, but without retry-after: it lasts until next month.
    return error.errorCode === 'enforced_spend_limit_reached'
      ? new ClaudeLimitError('spend_limit', null)
      : new ClaudeLimitError('rate_limited', retryAfter());
  }
  if (error.type === 'overloaded_error' || error.status === 529)
    return new ClaudeLimitError('overloaded', retryAfter());
  if (error.status === 400 && OWN_SPEND_LIMIT.test(error.apiMessage ?? ''))
    return new ClaudeLimitError('spend_limit', null);
  return null;
}

/** Rethrows a limit as ClaudeLimitError; any other error is left to the caller. */
export function throwIfLimited(error: unknown): void {
  const limit = claudeLimitOf(error);
  if (limit) throw limit;
}

/** What the person is told, by kind. */
export const LIMIT_MESSAGES: Record<ClaudeLimitKind, string> = {
  rate_limited: 'Claude is handling too many requests right now. Try again in a minute.',
  overloaded: 'Claude is overloaded right now. Try again in a few minutes.',
  spend_limit:
    'This app has reached its Claude usage limit, so Claude features are paused until it resets or the limit is raised. Nothing you saved is affected.',
};

/** The API's answer for a limit: 503, with a code the web app can tell apart. */
export function limitResponse(limit: ClaudeLimitError): {
  statusCode: 503;
  code: 'claude_busy' | 'claude_limit_reached';
  message: string;
  retryAfterSeconds: number | null;
} {
  return {
    statusCode: 503,
    code: limit.kind === 'spend_limit' ? 'claude_limit_reached' : 'claude_busy',
    message: LIMIT_MESSAGES[limit.kind],
    retryAfterSeconds:
      limit.kind === 'spend_limit'
        ? null
        : (limit.retryAfterSeconds ?? (limit.kind === 'overloaded' ? 120 : 60)),
  };
}
